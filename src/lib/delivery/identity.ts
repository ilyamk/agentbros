import { captureVizDependencies } from "../viz/usage";
import { captureLocalProvenance } from "../apple/provenance";
import { captureVorkProvenance } from "../vork/provenance";
import { captureIconResources } from "../icon-resources/usage";
import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import path from "node:path";
import { assertRecordingEvidence } from "../workflows/recording-evidence";
import { planProjectRender } from "../render-plan";
import { hashFile } from "../assets/registry";
import { assertPathWithin } from "../cli";
import { generationInputHash } from "../jobs/runner";
import { RenderIdentitySchema, type RenderIdentity } from "../../types/delivery";
import { prepareRenderFontContext, readRenderFontContext } from "../font-resources/render-context";
import { SceneSchema, type VideoFormat } from "../../types/video";
const stable = (value: unknown) => generationInputHash(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
let codeReadCache: Map<string, RenderIdentity["sources"]> | undefined;
/** One synchronous read scope only; never retain source evidence across worker awaits. */
export function withRenderIdentityReadCache<T>(read: () => T): T {
  if (codeReadCache) return read();
  codeReadCache = new Map();
  try {
    return read();
  } finally {
    codeReadCache = undefined;
  }
}
/** Used by renderer before/after capture and by release QA: no mutable gate/job timestamps. */
export function captureRenderIdentity(
  projectId: string,
  format: VideoFormat,
  options: {
    rootDir?: string;
    timeline?: boolean;
    audioMaster?: string;
    captions?: "on" | "off";
    fontContext?: string;
    fontCaptureFiles?: string[];
    fontContextMode?: "prepare" | "existing";
  } = {},
): RenderIdentity {
  const rootDir = path.resolve(options.rootDir ?? process.cwd()),
    project = path.join(rootDir, "public/projects", projectId);
  assertPathWithin(path.join(rootDir, "public/projects"), project);
  const job = planProjectRender(projectId, format, rootDir, options).jobs[0]!;
  const sources = new Map<string, RenderIdentity["sources"][number]>();
  const capturedLocal = new Set<string>();
  const add = (file: string, role: RenderIdentity["sources"][number]["role"]) => {
    const absolute = path.resolve(file);
    assertPathWithin(rootDir, absolute);
    if (!existsSync(absolute) || !statSync(absolute).isFile())
      throw new Error(`Delivery source missing: ${path.relative(rootDir, absolute)}`);
    const key = path.relative(rootDir, absolute).split(path.sep).join("/");
    sources.set(key, { path: key, sha256: hashFile(absolute), role });
    if (!capturedLocal.has(absolute)) {
      capturedLocal.add(absolute);
      captureLocalProvenance(absolute, rootDir, add);
      captureVorkProvenance(absolute, rootDir, add);
    }
  };
  const tree = (directory: string, role: RenderIdentity["sources"][number]["role"]) => {
    const cacheKey = `${rootDir}:${directory}`,
      cacheable =
        role === "code" && [path.join(rootDir, "src"), path.join(rootDir, "public/fonts")].includes(directory),
      cached = cacheable ? codeReadCache?.get(cacheKey) : undefined;
    if (cached) {
      for (const source of cached) sources.set(source.path, source);
      return;
    }
    if (!existsSync(directory)) return;
    assertPathWithin(rootDir, directory);
    const before = cacheable && codeReadCache ? new Set(sources.keys()) : undefined;
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (lstatSync(file).isSymbolicLink()) {
        assertPathWithin(rootDir, file);
        if (statSync(file).isDirectory()) throw new Error("Source directory symlinks are not permitted");
      }
      if (statSync(file).isDirectory()) tree(file, role);
      else add(file, role);
    }
    if (before && codeReadCache)
      codeReadCache.set(
        cacheKey,
        [...sources.values()].filter(
          (source) =>
            source.path.startsWith(path.relative(rootDir, directory).split(path.sep).join("/") + "/") ||
            !before.has(source.path),
        ),
      );
  };
  add(path.join(project, "project.json"), "config");
  captureIconResources(rootDir, projectId, job.props, add);
  captureVizDependencies(rootDir, projectId, job.props, add);
  const recording = assertRecordingEvidence(project, projectId, true);
  if (recording) {
    add(recording.originalFile, "asset");
    add(recording.registryFile, "creative");
  }
  const creative = [
    "brief",
    "script",
    "design",
    "characters",
    "storyboard",
    "asset-plan",
    "narrator-direction",
    "caption-edit",
    "rhythm",
    "audio-mix",
  ];
  for (const stem of creative) {
    const file = path.join(project, "pipeline", `${stem}.json`);
    assertPathWithin(project, file);
    if (existsSync(file)) add(file, "creative");
  }
  // Scenario treatment, claims and source selections are authored story inputs too.
  for (const stem of [
    "workflow-render",
    "workflow-request",
    "workflow-claims",
    "product-ad-evidence",
    "education",
    "chapters",
    "recording-edit",
    "recording-edit-original-timeline",
    "recording-edit-transcript",
    "shorts-series-binding",
  ]) {
    const file = path.join(project, "pipeline", `${stem}.json`);
    assertPathWithin(project, file);
    if (existsSync(file)) add(file, "creative");
  }
  tree(path.join(project, "pipeline/evidence"), "creative");
  tree(path.join(project, "assets/evidence"), "creative");
  const walkProps = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0 && !/^https?:\/\//.test(value)) {
      const file = path.resolve(rootDir, "public", value);
      assertPathWithin(path.join(rootDir, "public"), file);
      add(file, /\.words(?:\.edited)?\.json$/.test(value) ? "caption" : "asset");
    } else if (typeof value === "string" && /^https?:\/\//.test(value))
      throw new Error("Remote render sources must be imported and hashed before delivery");
    else if (Array.isArray(value)) value.forEach(walkProps);
    else if (value && typeof value === "object") Object.values(value).forEach(walkProps);
  };
  // Strings in prose can be URLs; inspect only actual media-bearing props, not script text.
  // Timeline scene payloads are the actual renderer input. Canonical scenes may be stale after an edit.
  const activeScenes = job.props.timeline
    ? job.props.timeline.tracks.flatMap((track) =>
        track.kind === "visual"
          ? track.clips
              .filter((clip) => clip.assetId.startsWith("scene:"))
              .map((clip) => SceneSchema.parse(clip.payload?.scene))
          : [],
      )
    : job.props.scenes;
  for (const scene of activeScenes) {
    walkProps(scene.imageUrl);
    walkProps(scene.leftPanel && "imageUrl" in scene.leftPanel ? scene.leftPanel.imageUrl : undefined);
    walkProps(scene.leftPanel && "videoUrl" in scene.leftPanel ? scene.leftPanel.videoUrl : undefined);
    walkProps(scene.leftPanel && "avatarUrl" in scene.leftPanel ? scene.leftPanel.avatarUrl : undefined);
    if (!scene.imageUrl && scene.template && "imageUrl" in scene.template.props)
      walkProps(scene.template.props.imageUrl);
  }
  if (!job.props.timeline && job.props.talkingHead?.enabled) walkProps(job.props.talkingHead.presenterVideo);
  for (const asset of Object.values(job.props.timelineAssets ?? {})) walkProps(asset.source);
  if (job.props.audioMaster) {
    walkProps(job.props.audioMaster.source);
    if (options.audioMaster) add(path.resolve(rootDir, options.audioMaster), "config");
  }
  if (!job.props.timeline)
    for (const scene of job.props.scenes)
      for (const suffix of [".mp3", ".words.json", ".words.edited.json"]) {
        const file = path.join(project, "voiceover", `${scene.id}${suffix}`);
        assertPathWithin(project, file);
        if (existsSync(file)) add(file, suffix.endsWith(".json") ? "caption" : "asset");
      }
  if (!job.props.timeline && job.props.musicVolume > 0 && !job.props.audioMaster)
    add(path.join(project, "music/bg.mp3"), "asset");
  let editRevision: number | null = null;
  if (options.timeline) {
    const file = path.join(project, "pipeline/timeline-edit.json");
    add(file, "edit");
    editRevision = (JSON.parse(readFileSync(file, "utf8")) as { revision: number }).revision;
  }
  // Active code/fonts can change pixels without changing props. No credentials/provider responses are collected.
  for (const name of ["package.json", "pnpm-lock.yaml", "remotion.config.ts"]) {
    const file = path.join(rootDir, name);
    if (existsSync(file)) add(file, "code");
  }
  if (options.fontContext) assertPathWithin(rootDir, path.join(rootDir, ".cache/font-contexts"));
  const font = options.fontContext
    ? (options.fontContextMode === "existing" ? readRenderFontContext : prepareRenderFontContext)(
        projectId,
        path.resolve(rootDir, options.fontContext),
        job.props,
        rootDir,
      )
    : undefined;
  if (font) add(font.contextFile, "config");
  for (const file of [...(font?.captureFiles ?? []), ...(options.fontCaptureFiles ?? [])])
    add(path.resolve(rootDir, file), /\.(?:ttf|otf|woff2?)$/i.test(file) ? "asset" : "code");
  tree(path.join(rootDir, "src"), "code");
  tree(path.join(rootDir, "public/fonts"), "code");
  const sorted = [...sources.values()].sort((a, b) => a.path.localeCompare(b.path));
  const storyHash = stable({
    project: JSON.parse(readFileSync(path.join(project, "project.json"), "utf8")),
    creative: sorted.filter((s) => s.role === "creative" || s.role === "edit"),
  });
  const base = {
    version: 1 as const,
    projectId,
    format,
    captions: options.captions ?? "on",
    compositionId: job.compositionId,
    durationInFrames: job.durationInFrames,
    propsHash: stable(job.props),
    storyHash,
    editRevision,
    sources: sorted,
  };
  return RenderIdentitySchema.parse({ ...base, sourceSnapshotHash: stable(base) });
}
