import { selectVizVariants } from "./viz/timeline";
import { ChapterInspectionInputs, UnsupportedChapterInspection } from "./longform/inspection-inputs";
import { buildProjectAudioMix, readProjectAudioAutomation } from "./audio/project-mix-plan";
import { captureAudioMasterInputs, assertAudioMasterInputs } from "./audio/master-inputs";
import { readLocalJson, localInputHash } from "./audio/local-input";
import { assertWorkflowRenderMode } from "./workflows/render-guard";
import { assertShortsSeriesReady } from "./workflows/shorts-series";
import { assertLocalizationReady } from "./campaigns/localization";
import { assertCampaignReferences } from "./campaigns";
import { compileEntityBindings, EntityShotBindingSchema } from "./entities/bindings";
import { z } from "zod";
import { AudioMasterSchema } from "../types/audio-master";
import { hashFile } from "./assets/registry";
import { inspectAsset } from "./assets/inspect";
import { readAssetRegistry } from "./assets/registry";
import { parseTimelineEditDocument } from "./timeline-ir/store";
import { assertOverlayBlocks } from "./timeline-ir/overlays";
import { CATALOGUE_PATH, type Catalogue } from "./library/catalogue";
import { inspectChartQuantitySources, chartQuantityHash } from "./chart-quantity-sources";
import { readWorkflowEvidence } from "./workflows/local-evidence";
import { compileTimelineIR } from "./timeline-ir/compiler";
import { numeric } from "./timeline-ir/rational";
import { renderBoundary, freezeRenderData } from "./timeline-ir/render";
import type { TimelineIR } from "../types/timeline";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, isBespokeBrief } from "./cli";
import { ProjectConfigSchema, SceneSchema, type VideoFormat } from "../types/video";
import { compileTimeline } from "./timeline";
import { PROJECT_COMPOSITION_IDS, projectToVideoProps, type ProjectVideoProps } from "./project-props";

export function assertProjectId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "Project ID must contain only letters, numbers, underscores or hyphens and start with a letter or number.",
    });
  }
}

function isWithin(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve only local public files or explicit http(s) sources. Symlinks cannot escape public/. */
export function validatePublicAsset(source: string, rootDir: string): void {
  if (/^https?:\/\//.test(source)) return;
  const publicDir = path.resolve(rootDir, "public");
  const file = path.resolve(publicDir, source);
  if (!source || source.includes("\\") || path.isAbsolute(source) || !isWithin(publicDir, file)) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Invalid public asset path: ${source}`,
    });
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `Referenced render asset missing: ${source}`,
    });
  }
  if (!isWithin(realpathSync(publicDir), realpathSync(file))) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Asset symlink escapes public/: ${source}`,
    });
  }
}

export type RenderJob = {
  format: VideoFormat;
  compositionId: string;
  outputFile: string;
  durationInFrames: number;
  props: ProjectVideoProps;
  command: string;
  args: string[];
};

export function planProjectRender(
  projectId: string,
  format?: VideoFormat,
  rootDir = process.cwd(),
  options: {
    timeline?: boolean;
    audioMaster?: string;
    captions?: "on" | "off";
    /** Internal local inspection only; never exposed by CLI/API request schemas. */
    readonlyInspection?: ChapterInspectionInputs;
  } = {},
): {
  projectId: string;
  name: string;
  jobs: RenderJob[];
  chartQuantities: ReturnType<typeof inspectChartQuantitySources>;
} {
  assertProjectId(projectId);
  const projectDir = path.resolve(rootDir, "public", "projects", projectId);
  const configPath = path.join(projectDir, "project.json");
  const inspection = options.readonlyInspection;
  if (inspection) {
    if (!(inspection instanceof ChapterInspectionInputs) || options.timeline !== true || options.audioMaster)
      throw new UnsupportedChapterInspection("Readonly inspection requires plain timeline without master");
    for (const file of [
      "workflow-render.json",
      "product-ad-evidence.json",
      "education.json",
      "recording-edit.json",
      "shorts-series-binding.json",
      "localization.json",
      "campaign-snapshot.json",
      "campaign-binding.json",
      "entity-bindings.json",
      "workflow-claims.json",
      "evidence/chart-quantity-bindings.json",
    ])
      inspection.absent(path.join(projectDir, "pipeline", file), projectDir);
  }
  if (!existsSync(configPath))
    throw new CliErrorObject({
      code: "PROJECT_NOT_FOUND",
      message: isBespokeBrief(path.join(projectDir, "pipeline", "brief.json"))
        ? `${projectId} is a bespoke film (film chain): it has no project.json for the template renderer. Render it with film:render --project ${projectId} --composition <build.json's composition>; delivery.ts takes it on its bespoke route (out/${projectId}/film.mp4 and its receipt, docs/delivery.md).`
        : `Project not found: ${projectId}`,
    });
  if (!isWithin(realpathSync(path.resolve(rootDir, "public", "projects")), realpathSync(configPath))) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Project configuration symlink escapes projects/.",
    });
  }
  let raw: unknown;
  let configInput: ReturnType<typeof readWorkflowEvidence>;
  try {
    configInput = inspection
      ? inspection.read(configPath, projectDir, 8 * 1024 * 1024)
      : readWorkflowEvidence(configPath, projectDir, 8 * 1024 * 1024);
    raw = JSON.parse(configInput.text);
  } catch {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Invalid project JSON: ${configPath}`,
    });
  }
  const parsed = ProjectConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Invalid project configuration: ${parsed.error.message}`,
    });
  try {
    if (!inspection) {
      assertWorkflowRenderMode(projectDir, projectId, options.timeline);
      assertShortsSeriesReady(projectDir, { rootDir, timeline: options.timeline });
      assertLocalizationReady(projectDir);
      assertCampaignReferences(projectDir, rootDir);
    }
  } catch (error) {
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const bindingsFile = path.join(projectDir, "pipeline", "entity-bindings.json");
  if (existsSync(bindingsFile) && !isWithin(realpathSync(projectDir), realpathSync(bindingsFile)))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Entity bindings escape project.",
    });
  const project =
    existsSync(bindingsFile) && !options.timeline
      ? compileEntityBindings(
          projectId,
          parsed.data,
          z.array(EntityShotBindingSchema).parse(JSON.parse(readFileSync(bindingsFile, "utf8"))),
          rootDir,
        )
      : parsed.data;
  if (project.scenes.length === 0 || project.formats.length === 0)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Project needs at least one scene and output format.",
    });
  const formats = format ? [format] : [...new Set(project.formats)];
  if (formats.some((f) => !Object.hasOwn(PROJECT_COMPOSITION_IDS, f)))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Unsupported output format.",
    });
  let timeline: TimelineIR | undefined;
  let timelineInput: ReturnType<typeof readWorkflowEvidence> | undefined;
  let timelineAssets: ProjectVideoProps["timelineAssets"];
  if (options.timeline) {
    const journal = path.join(projectDir, "pipeline", "timeline-edit.json");
    if (!existsSync(journal))
      throw new CliErrorObject({
        code: "FILE_NOT_FOUND",
        message: "Initialize timeline-edit.json before rendering with --timeline",
      });
    if (!isWithin(realpathSync(projectDir), realpathSync(journal)))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Timeline journal symlink escapes project",
      });
    try {
      timelineInput = inspection
        ? inspection.read(journal, projectDir, 8 * 1024 * 1024)
        : readWorkflowEvidence(journal, projectDir, 8 * 1024 * 1024);
      timeline = parseTimelineEditDocument(JSON.parse(timelineInput.text)).timeline;
      if (timeline.projectId !== projectId)
        throw new Error("Timeline project binding does not match requested project");
      const snapshot = compileTimelineIR(timeline);
      const registry = readAssetRegistry(projectId, rootDir, inspection);
      timelineAssets = {};
      const formatSnapshots = [snapshot, ...formats.map((fmt) => compileTimelineIR(selectVizVariants(timeline!, fmt)))];
      for (const track of formatSnapshots.flatMap((s) => s.tracks))
        for (const clip of track.clips) {
          if (renderBoundary(clip.end, snapshot.timebase, 30) <= renderBoundary(clip.start, snapshot.timebase, 30))
            throw new Error(`Clip too short at output fps: ${clip.id}`);
          const transform = clip.payload?.transform as Record<string, unknown> | undefined;
          if (transform)
            for (const [key, value] of Object.entries(transform)) {
              if (
                !["scale", "x", "y", "rotation"].includes(key) ||
                typeof value !== "number" ||
                !Number.isFinite(value) ||
                (key === "scale" && value <= 0)
              )
                throw new Error(`Invalid clip transform: ${clip.id}`);
            }
          if (
            clip.payload?.volume !== undefined &&
            (typeof clip.payload.volume !== "number" || clip.payload.volume < 0 || clip.payload.volume > 1)
          )
            throw new Error(`Invalid clip volume: ${clip.id}`);
          if (track.kind === "captions") continue;
          if (clip.assetId.startsWith("scene:") && track.kind === "visual") {
            const scene = ProjectConfigSchema.shape.scenes.element.parse(clip.payload?.scene);
            if (scene.imageUrl) validatePublicAsset(scene.imageUrl, rootDir);
            if (scene.leftPanel && "imageUrl" in scene.leftPanel)
              validatePublicAsset(scene.leftPanel.imageUrl, rootDir);
            if (scene.leftPanel && "videoUrl" in scene.leftPanel)
              validatePublicAsset(scene.leftPanel.videoUrl, rootDir);
            if (scene.leftPanel && "avatarUrl" in scene.leftPanel && scene.leftPanel.avatarUrl)
              validatePublicAsset(scene.leftPanel.avatarUrl, rootDir);
            if (
              scene.template &&
              "imageUrl" in scene.template.props &&
              scene.template.props.imageUrl &&
              !scene.imageUrl
            )
              validatePublicAsset(scene.template.props.imageUrl, rootDir);
            continue;
          }
          const asset = registry.assets.find((item) => item.id === clip.assetId);
          if (clip.assetId.startsWith("sha256:") && !asset)
            throw new Error(`Unregistered timeline asset: ${clip.assetId}`);
          const source = asset?.files.original ?? clip.assetId;
          validatePublicAsset(source, rootDir);
          if (
            asset &&
            (inspection
              ? inspection.hash(path.resolve(rootDir, "public", source), rootDir)
              : ["voiceover", "music", "sfx", "presenter"].includes(track.kind)
                ? localInputHash(path.resolve(rootDir, "public", source))
                : hashFile(path.resolve(rootDir, "public", source))) !== asset.hash
          )
            throw new Error(`Immutable timeline asset checksum mismatch: ${clip.assetId}`);
          const extension = path.extname(source).toLowerCase();
          const kind =
            asset?.kind ??
            ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)
              ? "image"
              : [".mp4", ".webm", ".mov", ".mkv"].includes(extension)
                ? "video"
                : "audio");
          if (kind !== "image" && kind !== "video" && kind !== "audio")
            throw new Error(`Asset kind ${kind} cannot be placed on a timeline track: ${clip.id}`);
          if (
            (track.kind === "visual" && kind === "audio") ||
            (track.kind === "presenter" && kind !== "video") ||
            (["voiceover", "music", "sfx"].includes(track.kind) && kind !== "audio")
          )
            throw new Error(`Asset kind does not match track: ${clip.id}`);
          if (
            asset?.media.durationSec &&
            clip.payload?.loop !== true &&
            numeric(clip.source.end) / numeric(clip.source.timebase) > asset.media.durationSec + 0.001
          )
            throw new Error(`Source interval exceeds asset duration: ${clip.id}`);
          timelineAssets[clip.assetId] = {
            source,
            kind,
            durationSec: asset?.media.durationSec,
            hasAudio: asset?.media.hasAudio,
          };
        }
      if (snapshot.durationInFrames <= 0) throw new Error("Timeline must contain visible or audible clips");
      if (timeline.overlays) {
        const catalogueFile = path.resolve(import.meta.dirname, "../..", CATALOGUE_PATH);
        if (!existsSync(catalogueFile)) throw new Error(`${CATALOGUE_PATH} is missing; run pnpm library:catalogue`);
        assertOverlayBlocks(timeline, (JSON.parse(readFileSync(catalogueFile, "utf8")) as Catalogue).items);
      }
    } catch (error) {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const ids = new Set<string>();
  for (const scene of timeline ? [] : project.scenes) {
    assertProjectId(scene.id);
    if (ids.has(scene.id))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Duplicate scene ID: ${scene.id}`,
      });
    ids.add(scene.id);
    if (
      scene.durationInFrames !== undefined &&
      (!Number.isInteger(scene.durationInFrames) || scene.durationInFrames < 1)
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Scene ${scene.id} duration must be a positive integer.`,
      });
    if (scene.imageUrl) validatePublicAsset(scene.imageUrl, rootDir);
    const panel = scene.leftPanel;
    if (panel && "imageUrl" in panel) validatePublicAsset(panel.imageUrl, rootDir);
    if (panel && "videoUrl" in panel) validatePublicAsset(panel.videoUrl, rootDir);
    if (panel && "avatarUrl" in panel && panel.avatarUrl) validatePublicAsset(panel.avatarUrl, rootDir);
  }
  if (!timeline)
    for (const scene of project.scenes) {
      const instance = scene.template;
      if (instance && "imageUrl" in instance.props && instance.props.imageUrl && !scene.imageUrl)
        validatePublicAsset(instance.props.imageUrl, rootDir);
    }
  if (!timeline && project.talkingHead?.enabled) validatePublicAsset(project.talkingHead.presenterVideo, rootDir);
  const embedded = project.talkingHead?.enabled && project.talkingHead.audioSource === "embedded";
  const voiceFiles = project.scenes.map((s) => path.join(projectDir, "voiceover", `${s.id}.mp3`));
  const voiceoverEnabled = !embedded && voiceFiles.some((f) => existsSync(f));
  if (!timeline && voiceoverEnabled)
    for (const file of voiceFiles) validatePublicAsset(path.relative(path.join(rootDir, "public"), file), rootDir);
  if (!timeline && project.musicVolume > 0) validatePublicAsset(`projects/${projectId}/music/bg.mp3`, rootDir);
  const audioMaster = options.audioMaster
    ? AudioMasterSchema.parse(readLocalJson(path.resolve(rootDir, options.audioMaster)))
    : undefined;
  if (audioMaster) {
    if (/^https?:/.test(audioMaster.source))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Measured audio master must be a local public asset.",
      });
    validatePublicAsset(audioMaster.source, rootDir);
    const sourceFile = path.resolve(rootDir, "public", audioMaster.source);
    if (localInputHash(sourceFile) !== audioMaster.sourceSha256)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Measured audio master checksum mismatch.",
      });
    const media = inspectAsset(sourceFile);
    if (media.kind !== "audio" || Math.abs(media.media.durationSec! - audioMaster.durationSec) > 1 / 30)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Audio master media does not match its measured duration.",
      });
  }
  let chartQuantities: ReturnType<typeof inspectChartQuantitySources> | undefined;
  try {
    chartQuantities = inspectChartQuantitySources(rootDir, projectId, {
      timeline: options.timeline,
      readonlyInspection: inspection,
    });
    const inspected = chartQuantities;
    const inputPin = (input: ReturnType<typeof readWorkflowEvidence>) =>
      inspected.inputs.find(
        (p) => p.path === path.relative(path.resolve(rootDir), input.path).split(path.sep).join("/"),
      )?.sha256;
    if (
      inputPin(configInput!) !== configInput!.sha256 ||
      (timelineInput && inputPin(timelineInput) !== timelineInput.sha256)
    )
      throw new Error("Chart inspection consumed different project/timeline bytes from the render plan");
    const activeScenes = timeline
      ? compileTimelineIR(timeline)
          .tracks.filter((t) => t.kind === "visual")
          .flatMap((t) =>
            t.clips.filter((c) => c.assetId.startsWith("scene:")).map((c) => SceneSchema.parse(c.payload?.scene)),
          )
      : project.scenes;
    const activeCharts = activeScenes
      .filter((s) => project.talkingHead?.enabled && s.leftPanel?.kind === "chart")
      .map((s) => ({
        sceneId: s.id,
        chartHash: chartQuantityHash(s.leftPanel as Extract<NonNullable<typeof s.leftPanel>, { kind: "chart" }>),
      }));
    if (JSON.stringify(activeCharts) !== JSON.stringify(chartQuantities.activeCharts))
      throw new Error("Chart inspection does not match effective render chart payloads");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliErrorObject({
      code: "VALIDATION",
      message,
      details: chartQuantities
        ? {
            chartQuantities: {
              ...chartQuantities,
              status: "blocked",
              findings: [
                ...chartQuantities.findings,
                { code: "CHART_SOURCE_MISMATCH", severity: "error", path: [], message },
              ],
            },
          }
        : undefined,
    });
  }
  if (chartQuantities.status === "blocked")
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Chart declaration/source correspondence blocks rendering",
      details: { chartQuantities },
    });
  const jobs = formats.map((fmt) => {
    const props = freezeRenderData({
      ...projectToVideoProps(project, projectId, fmt, voiceoverEnabled),
      timeline: timeline ? selectVizVariants(timeline, fmt) : undefined,
      timelineAssets,
      audioMaster,
      captionsEnabled: options.captions !== "off",
    });
    let durationInFrames: number;
    try {
      durationInFrames = timeline
        ? renderBoundary(compileTimelineIR(timeline).duration, timeline.timebase, 30)
        : compileTimeline(props.scenes, {
            fps: 30,
            talkingHead: !!props.talkingHead?.enabled,
          }).durationInFrames;
    } catch (error) {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (audioMaster?.projectInputs) {
      if (!timeline || audioMaster.projectInputs.projectId !== projectId)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Project-generated audio master requires its original project timeline mode",
        });
      try {
        const plan = buildProjectAudioMix(
          props,
          durationInFrames,
          rootDir,
          readProjectAudioAutomation(projectId, rootDir),
        );
        assertAudioMasterInputs(
          audioMaster.projectInputs,
          captureAudioMasterInputs(projectId, plan, timeline, rootDir, props.talkingHead?.audioSource === "embedded"),
        );
      } catch (error) {
        throw new CliErrorObject({
          code: "VALIDATION",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (audioMaster && Math.abs(audioMaster.durationSec - durationInFrames / 30) > 1 / 30 + 1e-8)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Audio master must match the compiled video duration within one frame.",
      });
    const outputFile = path.join("out", projectId, options.captions === "off" ? `${fmt}-clean.mp4` : `${fmt}.mp4`);
    const compositionId = PROJECT_COMPOSITION_IDS[fmt];
    return {
      format: fmt,
      compositionId,
      outputFile,
      durationInFrames,
      props,
      command: "pnpm",
      args: ["exec", "remotion", "render", compositionId, outputFile, "--props", JSON.stringify(props)],
    };
  });
  return { projectId, name: project.name, jobs, chartQuantities };
}
