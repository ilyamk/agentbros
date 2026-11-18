import { VizDerivedManifestSchema } from "../../types/viz";
import { captureVizDependencies, collectActiveViz } from "../viz/usage";
import { planDerivedViz, writeDerivedVizFiles } from "../viz/derive";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  realpathSync,
  lstatSync,
  statSync,
  copyFileSync,
  openSync,
  closeSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ShortsSeriesRequestSchema, ShortsEpisodeBindingSchema } from "../../types/workflow-shorts-series";
import { ChapterManifestSchema } from "../../types/longform";
import { ProjectConfigSchema } from "../../types/video";
import { AssetRecordSchema, AssetRegistrySchema, type AssetRecord } from "../../types/assets";
import { TimelineEditStore } from "../timeline-ir/store";
import { compileTimelineIR, validateTimeline, clipDuration } from "../timeline-ir/compiler";
import { numeric, add, compare } from "../timeline-ir/rational";
import { workflowClaims, WorkflowClaimsArtifactSchema } from "./claims";
import { renderBoundary } from "../timeline-ir/render";
import { compileShort, stableHash, planChapters } from "../longform/plans";
import { hashFile, readAssetRegistry } from "../assets/registry";
import { inspectAsset } from "../assets/inspect";
import { planProjectRender, assertProjectId, validatePublicAsset } from "../render-plan";
import { assertPathWithin } from "../cli";
import { compileEntityBindings, EntityShotBindingSchema } from "../entities/bindings";
import { resolveEntityReferences, getEntityVersion } from "../entities/service";
import { z } from "zod";

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const text = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function safe(base: string, file: string) {
  assertPathWithin(base, file);
  let current = path.resolve(file);
  while (current !== path.resolve(base)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error("Shorts paths cannot contain symlinks");
    current = path.dirname(current);
  }
  if (existsSync(base) && lstatSync(base).isSymbolicLink()) throw new Error("Shorts root cannot be a symlink");
  return file;
}
function projectsRoot(rootDir: string, scopeRoot?: string) {
  const root = realpathSync(rootDir);
  if (scopeRoot) assertPathWithin(realpathSync(scopeRoot), root);
  const projects = safe(root, path.join(root, "public/projects"));
  if (!existsSync(projects)) throw new Error("Existing public/projects directory required");
  return { root, projects };
}
const mediaKeys = new Set([
  "imageUrl",
  "videoUrl",
  "avatarUrl",
  "audioUrl",
  "source",
  "src",
  "presenterVideo",
  "sourceImage",
  "referenceImageUrls",
  "referenceVideoUrls",
  "referenceAudioUrls",
]);
function mapMedia(value: unknown, fn: (source: string) => string, key = ""): unknown {
  if (key === "plans" || key === "vizBinding" || key === "vizRenderVariants") return value;
  if (typeof value === "string") return mediaKeys.has(key) ? fn(value) : value;
  if (Array.isArray(value)) return value.map((item) => mapMedia(item, fn, key));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mapMedia(item, fn, name)]));
  return value;
}
/** Read-only source pin preparation. It creates no approval, journal or directory. */
export function inspectShortsSeriesSource(
  projectId: string,
  chapterFile = "pipeline/chapters.json",
  options: { rootDir?: string; scopeRoot?: string } = {},
) {
  assertProjectId(projectId);
  if (!/^pipeline\/[a-zA-Z0-9_-]+\.json$/.test(chapterFile))
    throw new Error("Chapter manifest must be a project pipeline JSON");
  const { root, projects } = projectsRoot(options.rootDir ?? process.cwd(), options.scopeRoot);
  const directory = safe(projects, path.join(projects, projectId));
  const projectFile = safe(directory, path.join(directory, "project.json")),
    journal = safe(directory, path.join(directory, "pipeline/timeline-edit.json")),
    chaptersFile = safe(directory, path.join(directory, chapterFile));
  const project = ProjectConfigSchema.parse(json(projectFile)),
    document = new TimelineEditStore(journal).read(),
    chapters = ChapterManifestSchema.parse(json(chaptersFile));
  if (document.timeline.projectId !== projectId) throw new Error("Source timeline project ownership mismatch");
  // Resolve approved source bindings before snapshotting; never generate references.
  const context: Record<string, unknown> = {};
  let resolvedProject = project;
  const bindingsFile = safe(directory, path.join(directory, "pipeline/entity-bindings.json"));
  if (existsSync(bindingsFile)) {
    const bindings = z.array(EntityShotBindingSchema).parse(json(bindingsFile));
    resolvedProject = compileEntityBindings(projectId, project, bindings, root);
    context.entityPins = bindings.map((binding) => ({
      binding,
      view: getEntityVersion(projectId, binding.entity.kind, binding.entity.entityId, {
        revision: binding.entity.revision,
        requireApproved: true,
        rootDir: root,
      }),
      resolved: resolveEntityReferences(projectId, binding.entity, root),
    }));
  }
  for (const file of [
    "campaign.json",
    "campaign-binding.json",
    "brand.json",
    "world.json",
    "design.json",
    "characters.json",
    "education.json",
    "product-ad-evidence.json",
    "workflow-claims.json",
  ]) {
    const target = safe(directory, path.join(directory, "pipeline", file));
    if (existsSync(target)) context[file] = json(target);
  }
  const claims = workflowClaims(root, projectId);
  const claimBindings = claims.map((claim) => {
    const owners = document.timeline.tracks
      .filter((track) => track.kind === "visual")
      .flatMap((track) => track.clips)
      .filter(
        (clip) =>
          clip.id === claim.sceneId || (clip.payload?.scene as { id?: string } | undefined)?.id === claim.sceneId,
      );
    if (!owners.length) throw new Error(`Claim has no owning source visual scene: ${claim.sceneId}`);
    const spans = owners.map((clip) => ({
      id: `claim-${stableHash([claim.id, clip.id]).slice(0, 24)}`,
      start: clip.start,
      end: add(clip.start, clipDuration(clip, document.timeline.timebase)),
      reason: "claim-context" as const,
      requires: [] as string[],
      note: claim.text,
    }));
    for (const span of spans) span.requires = spans.filter((other) => other.id !== span.id).map((other) => other.id);
    return { claim, ownerIds: owners.map((clip) => clip.id), spans };
  });
  const claimEvidence = claims
    .flatMap((claim) => claim.evidence)
    .map((citation) => {
      const file = safe(directory, path.resolve(root, "public", citation.path));
      if (options.scopeRoot) assertPathWithin(realpathSync(options.scopeRoot), file);
      if (!statSync(file).isFile() || hashFile(file) !== citation.sha256)
        throw new Error("Claim evidence original changed");
      return { ...citation, file };
    });
  context.claims = claims;
  planChapters(document.timeline, chapters);
  const plan = planProjectRender(projectId, "vertical", root, {
      timeline: true,
    }),
    assets = readAssetRegistry(projectId, root).assets;
  const paths = new Set<string>();
  for (const asset of Object.values(plan.jobs[0].props.timelineAssets ?? {})) paths.add(asset.source);
  mapMedia([document.timeline, resolvedProject.scenes], (source) => {
    paths.add(source);
    return source;
  });
  if (resolvedProject.talkingHead?.presenterVideo) paths.add(resolvedProject.talkingHead.presenterVideo);
  for (const active of collectActiveViz(root, projectId, document.timeline))
    if (active.renderedAssetFile) paths.add(path.relative(path.join(root, "public"), active.renderedAssetFile));
  const vizPins: Array<{ path: string; hash: string }> = [];
  captureVizDependencies(root, projectId, document.timeline, (file) =>
    vizPins.push({ path: path.relative(root, file), hash: hashFile(file) }),
  );
  const dependencies = [...paths].sort().map((source) => {
    if (/^https?:\/\//.test(source)) throw new Error("Shorts series requires local originals, no remote media");
    validatePublicAsset(source, root);
    const file = safe(root, path.resolve(root, "public", source));
    if (options.scopeRoot) assertPathWithin(realpathSync(options.scopeRoot), file);
    return {
      source,
      file,
      hash: hashFile(file),
      record: assets.find((item) => item.files.original === source),
      inspected: inspectAsset(file),
    };
  });
  const source = {
    projectId,
    projectHash: hashFile(projectFile),
    timelineRevision: document.revision,
    timelineHash: stableHash(document.timeline),
    chapterFile,
    chapterHash: hashFile(chaptersFile),
    dependenciesHash: stableHash({
      media: dependencies.map(({ source, hash }) => ({ source, hash })),
      ...(vizPins.length ? { visualisations: vizPins } : {}),
      claimEvidence: claimEvidence.map(({ path, sha256 }) => ({
        path,
        sha256,
      })),
    }),
    contextHash: stableHash(context),
  };
  return {
    source,
    approvalSourceHash: stableHash(source),
    project: resolvedProject,
    timeline: document.timeline,
    chapters,
    context,
    dependencies,
    claimBindings,
    claimEvidence,
  };
}
function fileHashes(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (base: string) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const file = safe(directory, path.join(base, entry.name));
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) result[path.relative(directory, file)] = hashFile(file);
      else throw new Error("Unexpected derivative artifact type");
    }
  };
  walk(directory);
  return result;
}
/** Shared render guard: require timeline mode, committed series marker and unchanged episode files. */
export function assertShortsSeriesReady(
  projectDirectory: string,
  options: { rootDir?: string; timeline?: boolean } = {},
) {
  if (lstatSync(projectDirectory).isSymbolicLink()) throw new Error("Shorts project cannot be a symlink");
  projectDirectory = realpathSync(projectDirectory);
  const file = path.join(projectDirectory, "pipeline/shorts-series-binding.json");
  if (!existsSync(file)) {
    const required = path.join(projectDirectory, "pipeline/workflow-render.json");
    if (existsSync(required) && json(required).workflow === "shorts-series") {
      throw new Error("Shorts series binding missing; derivative is not committed");
    }
    return;
  }
  const root = realpathSync(options.rootDir ?? process.cwd()),
    projects = path.join(root, "public/projects");
  safe(projects, projectDirectory);
  safe(projectDirectory, file);
  const binding = ShortsEpisodeBindingSchema.parse(json(file));
  if (binding.projectId !== path.basename(projectDirectory)) throw new Error("Shorts episode ownership mismatch");
  if (options.timeline !== true) throw new Error("Shorts derivative must render with --timeline");
  const seriesDirectory = safe(projects, path.join(projects, binding.seriesId)),
    commit = safe(seriesDirectory, path.join(seriesDirectory, "series-commit.json"));
  if (!existsSync(commit)) throw new Error("Shorts series is uncommitted; reconcile interrupted publication");
  const manifest = json(commit);
  if (manifest.seriesHash !== binding.seriesHash || stableHash(manifest.identity) !== binding.seriesHash)
    throw new Error("Shorts series commit identity mismatch");
  const episode = manifest.episodes.find((item: { projectId: string }) => item.projectId === binding.projectId);
  const pinnedEpisode = manifest.identity.episodes.find(
    (item: { projectId: string }) => item.projectId === binding.projectId,
  );
  if (!episode || episode.episodeHash !== binding.episodeHash || pinnedEpisode?.episodeHash !== binding.episodeHash)
    throw new Error("Shorts episode not bound to committed series");
  for (const [name, hash] of Object.entries(episode.files)) {
    const artifact = safe(projectDirectory, path.join(projectDirectory, name));
    if (!existsSync(artifact) || hashFile(artifact) !== hash)
      throw new Error(`Shorts derivative artifact changed: ${name}`);
  }
  const frozen = (name: string) => json(safe(projectDirectory, path.join(projectDirectory, name)));
  const vizManifestFile = path.join(projectDirectory, "pipeline/viz/derived-manifest.json");
  const vizManifest = existsSync(vizManifestFile) ? VizDerivedManifestSchema.parse(json(vizManifestFile)) : undefined;
  if (vizManifest && vizManifest.projectId !== binding.projectId)
    throw new Error("Derived visualisation manifest belongs to another project");
  if (vizManifest)
    for (const pin of vizManifest.files)
      if (episode.files[pin.relative] !== pin.sha256)
        throw new Error("Derived visualisation dependency differs from the approved episode");
  const authoredHash = stableHash({
    ...(vizManifest ? { visualisationFiles: vizManifest.files } : {}),
    project: frozen("project.json"),
    timeline: frozen("pipeline/timeline-edit.json").timeline,
    evidence: frozen("pipeline/shorts-evidence.json"),
    records: frozen("pipeline/asset-registry.json").assets,
    claimsArtifact: existsSync(path.join(projectDirectory, "pipeline/workflow-claims.json"))
      ? frozen("pipeline/workflow-claims.json")
      : null,
  });
  if (
    authoredHash !== binding.episodeHash ||
    stableHash(frozen("pipeline/shorts-source-context.json")) !== stableHash(manifest.identity.sourceSnapshot.context)
  ) {
    throw new Error("Shorts immutable episode content differs from approved commit");
  }
  workflowClaims(root, binding.projectId);
  return { binding, episode, manifest };
}

export function runShortsSeriesWorkflow(
  raw: unknown,
  options: { action: "plan" | "create"; rootDir?: string; scopeRoot?: string },
): { outputs: string[]; metadata: Record<string, unknown> } {
  if (!["plan", "create"].includes(options.action)) throw new Error("Invalid shorts action");
  const request = ShortsSeriesRequestSchema.parse(raw),
    { root, projects } = projectsRoot(options.rootDir ?? process.cwd(), options.scopeRoot);
  const inspected = inspectShortsSeriesSource(request.source.projectId, request.source.chapterFile, {
    rootDir: root,
    scopeRoot: options.scopeRoot,
  });
  if (stableHash(request.source) !== stableHash(inspected.source))
    throw new Error("Stale source pin: project, timeline, chapters, originals or world/brand changed");
  if (request.seriesId === request.source.projectId) throw new Error("Series cannot overwrite its source project");
  const ids = new Set<string>();
  const drafts = request.episodes.map((episode) => {
    if (ids.has(episode.selection.id)) throw new Error("Duplicate short selection ID");
    ids.add(episode.selection.id);
    if (new Set(episode.formats).size !== episode.formats.length || !episode.formats.includes("vertical"))
      throw new Error("Each short needs vertical and optional square");
    if (episode.approvedSourceHash !== inspected.approvalSourceHash)
      throw new Error("Selection approval is not bound to the reviewed source snapshot");
    const selectedSource = structuredClone(inspected.timeline);
    for (const pin of (inspected.context.entityPins ?? []) as {
      binding: { sceneId: string; target: string };
    }[]) {
      const canonical = inspected.project.scenes.find((scene) => scene.id === pin.binding.sceneId)!;
      for (const track of selectedSource.tracks)
        for (const clip of track.clips) {
          const scene = clip.payload?.scene as Record<string, unknown> | undefined;
          if (scene?.id !== pin.binding.sceneId) continue;
          if (pin.binding.target === "imageUrl") scene.imageUrl = canonical.imageUrl;
          else
            (scene.leftPanel as Record<string, unknown>).imageUrl = (
              canonical.leftPanel as { imageUrl: string }
            ).imageUrl;
        }
    }
    const compiled = compileShort(selectedSource, episode.selection, [
        ...inspected.chapters.protectedSpans,
        ...inspected.claimBindings.flatMap((binding) => binding.spans),
      ]),
      projectId = `${request.seriesId}-${episode.selection.id}`;
    assertProjectId(projectId);
    if (projectId.length > 64) throw new Error("Derived project ID exceeds 64 characters");
    if (projectId === request.source.projectId) throw new Error("Episode cannot overwrite its source");
    const records: AssetRecord[] = inspected.dependencies.map((dependency) =>
      AssetRecordSchema.parse({
        ...dependency.record,
        schemaVersion: 1,
        id: `sha256:${dependency.hash}`,
        hash: dependency.hash,
        revision: 1,
        createdAt: dependency.record?.createdAt ?? episode.selection.approval.approvedAt,
        kind: dependency.inspected.kind,
        media: dependency.inspected.media,
        files: {
          original: `projects/${projectId}/assets/imported/${dependency.hash}${path.extname(dependency.file).toLowerCase()}`,
          bytes: statSync(dependency.file).size,
          mime: dependency.inspected.mime,
        },
        provenance: dependency.record?.provenance ?? {
          origin: "manual",
          tool: "shorts-series-original-copy",
          model: "unknown",
          billing: { status: "unknown" },
        },
        rights: dependency.record?.rights ?? {},
        entityLinks: dependency.record?.entityLinks ?? [],
        status: "candidate",
      }),
    );
    const bySource = new Map(inspected.dependencies.map((dependency, index) => [dependency.source, records[index]]));
    const rewrite = (source: string) => {
      const asset = bySource.get(source);
      if (!asset) throw new Error(`Unbound derivative media path: ${source}`);
      return asset.files.original;
    };
    let timeline = mapMedia(compiled.timeline, rewrite) as typeof compiled.timeline;
    timeline.projectId = projectId;
    for (const track of timeline.tracks)
      for (const clip of track.clips) {
        if (clip.assetId.startsWith("scene:") || track.kind === "captions") continue;
        const original = inspected.dependencies.find(
          (dependency) => dependency.source === clip.assetId || dependency.record?.id === clip.assetId,
        );
        if (!original) throw new Error(`Unbound timeline original: ${clip.assetId}`);
        clip.assetId = `sha256:${original.hash}`;
      }
    const derivedViz = planDerivedViz(root, request.source.projectId, projectId, timeline, episode.formats);
    timeline = derivedViz.timeline as typeof timeline;
    records.push(...derivedViz.assets);
    const parsedTimeline = validateTimeline(timeline),
      snapshot = compileTimelineIR(parsedTimeline);
    for (const track of parsedTimeline.tracks)
      for (const clip of track.clips) {
        const record = records.find((asset) => asset.id === clip.assetId);
        if (
          record?.media.durationSec &&
          clip.payload?.loop !== true &&
          numeric(clip.source.end) / numeric(clip.source.timebase) > record.media.durationSec + 0.001
        )
          throw new Error("Selected source interval exceeds actual original duration");
        if (renderBoundary(clipDuration(clip, parsedTimeline.timebase), parsedTimeline.timebase, 30) < 1)
          throw new Error("Selected clip is too short for the output frame rate");
      }

    const visual = parsedTimeline.tracks.filter((track) => track.kind === "visual").flatMap((track) => track.clips);
    if (!visual.length) throw new Error("Short needs a selected visual track");
    const timedWords = snapshot.tracks
      .filter((track) => ["voiceover", "presenter", "captions"].includes(track.kind))
      .flatMap((track) => track.clips.flatMap((clip) => clip.captions));
    const scenes = visual.map((clip) => {
      const duration = renderBoundary(clipDuration(clip, parsedTimeline.timebase), parsedTimeline.timebase, 30);
      const finish = add(clip.start, clipDuration(clip, parsedTimeline.timebase));
      const spoken = [
        ...new Map(
          timedWords
            .filter((word) => compare(word.start, finish) < 0 && compare(word.end, clip.start) > 0)
            .sort((a, b) => compare(a.start, b.start))
            .map((word) => [stableHash([word.text, word.start, word.end]), word]),
        ).values(),
      ]
        .map((word) => word.text)
        .join(" ");
      return clip.payload?.scene
        ? {
            ...(clip.payload.scene as Record<string, unknown>),
            id: clip.id,
            text: spoken || (clip.payload.scene as { text?: string }).text || "",
            durationInFrames: duration,
          }
        : {
            id: clip.id,
            text: spoken,
            headline: "",
            visualType: records.find((asset) => asset.id === clip.assetId)!.kind === "image" ? "photo" : "video",
            imageUrl: records.find((asset) => asset.id === clip.assetId)!.files.original,
            durationInFrames: duration,
          };
    });
    const project = ProjectConfigSchema.parse({
      ...(mapMedia(inspected.project, rewrite) as Record<string, unknown>),
      name: episode.selection.purpose,
      formats: episode.formats,
      scenes,
    });
    const inheritedClaims = inspected.claimBindings.flatMap(({ claim, ownerIds, spans }) => {
      // Whole owning scene protection above forbids partial claim/caveat statements.
      const selected = episode.selection.ranges.some((range) =>
        spans.some((span) => compare(range.start, span.end) < 0 && compare(range.end, span.start) > 0),
      );
      if (!selected) return [];
      return visual
        .filter((clip) =>
          ownerIds.some((id) =>
            episode.selection.ranges.some((_, i) => clip.id === `${episode.selection.id}-${i}-${id}`),
          ),
        )
        .map((clip) => ({
          ...claim,
          id: `${claim.id}:${clip.id}`,
          sceneId: clip.id,
          evidence: claim.evidence.map((citation) => ({
            ...citation,
            path: `projects/${projectId}/pipeline/evidence/${citation.sha256}.txt`,
          })),
        }));
    });
    if (
      inheritedClaims.length <
      inspected.claimBindings.filter(({ spans }) =>
        episode.selection.ranges.some((range) =>
          spans.some((span) => compare(range.start, span.end) < 0 && compare(range.end, span.start) > 0),
        ),
      ).length
    ) {
      throw new Error("Selected claims cannot be mapped to derived scenes");
    }
    const claimsArtifact = inheritedClaims.length
      ? WorkflowClaimsArtifactSchema.parse({
          version: 1,
          projectId,
          claims: inheritedClaims,
        })
      : null;
    const evidence = {
      ...compiled,
      timeline: parsedTimeline,
      snapshot,
      sourcePin: request.source,
      approvedSourceHash: episode.approvedSourceHash,
    };
    const uniqueRecords = [...new Map(records.map((record) => [record.id, record])).values()];
    const episodeHash = stableHash({
      project,
      timeline: parsedTimeline,
      evidence,
      records: uniqueRecords,
      claimsArtifact,
      ...(derivedViz.files.length
        ? { visualisationFiles: derivedViz.files.map((f) => ({ relative: f.relative, sha256: f.sha256 })) }
        : {}),
    });
    return {
      projectId,
      project,
      timeline: parsedTimeline,
      evidence,
      episodeHash,
      visualisationFiles: derivedViz.files,
      claimsArtifact,
      records: [...new Map(records.map((record) => [record.id, record])).values()],
    };
  });
  const identity = {
    version: 1,
    request,
    sourceSnapshot: {
      project: inspected.project,
      timeline: inspected.timeline,
      chapters: inspected.chapters,
      context: inspected.context,
    },
    episodes: drafts.map((draft) => ({
      projectId: draft.projectId,
      episodeHash: draft.episodeHash,
    })),
  };
  const seriesHash = stableHash(identity),
    seriesDirectory = safe(projects, path.join(projects, request.seriesId));
  const metadata = {
    workflow: "shorts-series",
    seriesId: request.seriesId,
    seriesHash,
    sourcePin: request.source,
    approvalSourceHash: inspected.approvalSourceHash,
    episodes: drafts.map((draft) => ({
      projectId: draft.projectId,
      episodeHash: draft.episodeHash,
      durationInFrames: compileTimelineIR(draft.timeline).durationInFrames,
      formats: draft.project.formats,
      render: `pnpm render -- --project ${draft.projectId} --timeline`,
    })),
    nextAction:
      "Render independent derivatives with --timeline, then explicit human visual/caption/context review and rights/delivery approvals",
  };
  if (options.action === "plan") return { outputs: [], metadata: { ...metadata, state: "planned" } };
  if (existsSync(seriesDirectory)) {
    const marker = path.join(seriesDirectory, "series-commit.json");
    if (!existsSync(marker)) throw new Error("Existing uncommitted series: reconcile interrupted transaction");
    const committed = json(marker);
    if (committed.seriesHash !== seriesHash)
      throw new Error("Existing series differs: choose a new reviewed series ID");
    for (const draft of drafts)
      assertShortsSeriesReady(path.join(projects, draft.projectId), {
        rootDir: root,
        timeline: true,
      });
    return {
      outputs: committed.outputs,
      metadata: { ...metadata, state: "committed", idempotent: true },
    };
  }
  const lock = path.join(projects, ".shorts-publication.lock");
  let descriptor: number;
  try {
    descriptor = openSync(lock, "wx");
  } catch {
    throw new Error("Shorts publication busy; no projects written");
  }
  const staging = path.join(projects, `.shorts-${randomUUID()}`),
    published: string[] = [];
  let stagingOwned = false;
  try {
    for (const id of [request.seriesId, ...drafts.map((draft) => draft.projectId)])
      if (existsSync(safe(projects, path.join(projects, id))))
        throw new Error(`Refusing to overwrite existing project: ${id}`);
    mkdirSync(staging);
    stagingOwned = true;
    const episodes = [];
    const outputs: string[] = [];
    for (const draft of drafts) {
      const directory = path.join(staging, draft.projectId);
      mkdirSync(path.join(directory, "pipeline"), { recursive: true });
      mkdirSync(path.join(directory, "assets/imported"), { recursive: true });
      writeFileSync(path.join(directory, "project.json"), text(draft.project));
      writeFileSync(
        path.join(directory, "pipeline/workflow-render.json"),
        text({
          version: 1,
          workflow: "shorts-series",
          projectId: draft.projectId,
          timelineRequired: true,
        }),
      );
      writeFileSync(
        path.join(directory, "pipeline/timeline-edit.json"),
        text({
          version: 1,
          revision: 0,
          timeline: draft.timeline,
          undo: [],
          redo: [],
        }),
      );
      writeFileSync(
        path.join(directory, "pipeline/asset-registry.json"),
        text(
          AssetRegistrySchema.parse({
            schemaVersion: 1,
            revision: 1,
            assets: draft.records,
          }),
        ),
      );
      writeFileSync(path.join(directory, "pipeline/shorts-evidence.json"), text(draft.evidence));
      writeFileSync(path.join(directory, "pipeline/shorts-source-context.json"), text(inspected.context));
      writeFileSync(
        path.join(directory, "pipeline/shorts-series-binding.json"),
        text({
          version: 1,
          workflow: "shorts-series",
          seriesId: request.seriesId,
          projectId: draft.projectId,
          seriesHash,
          episodeHash: draft.episodeHash,
        }),
      );
      if (draft.claimsArtifact) {
        mkdirSync(path.join(directory, "pipeline/evidence"));
        writeFileSync(path.join(directory, "pipeline/workflow-claims.json"), text(draft.claimsArtifact));
        for (const claim of draft.claimsArtifact.claims)
          for (const citation of claim.evidence) {
            const original = inspected.claimEvidence.find((item) => item.sha256 === citation.sha256)!;
            const destination = path.join(directory, "pipeline/evidence", `${citation.sha256}.txt`);
            if (!existsSync(destination)) copyFileSync(original.file, destination);
            if (hashFile(destination) !== citation.sha256) throw new Error("Claim source changed during copy");
          }
      }
      writeDerivedVizFiles(directory, draft.visualisationFiles);
      for (const record of draft.records) {
        const dependency = inspected.dependencies.find((item) => item.hash === record.hash);
        const destination = path.join(directory, "assets/imported", path.basename(record.files.original));
        if (dependency) copyFileSync(dependency.file, destination);
        else if (
          !draft.visualisationFiles.some(
            (file) =>
              file.relative === `assets/imported/${path.basename(record.files.original)}` &&
              file.sha256 === record.hash,
          )
        )
          throw new Error("Derived asset has no pinned source");
        if (hashFile(destination) !== record.hash) throw new Error("Original changed during immutable copy");
      }
      episodes.push({
        projectId: draft.projectId,
        episodeHash: draft.episodeHash,
        files: fileHashes(directory),
      });
      outputs.push(
        path.join(projects, draft.projectId, "project.json"),
        path.join(projects, draft.projectId, "pipeline/timeline-edit.json"),
      );
    }
    // Reinspect all source dependencies immediately before publication.
    if (
      stableHash(
        inspectShortsSeriesSource(request.source.projectId, request.source.chapterFile, {
          rootDir: root,
          scopeRoot: options.scopeRoot,
        }).source,
      ) !== stableHash(request.source)
    )
      throw new Error("Source changed during transaction; no derivative published");
    const hub = path.join(staging, request.seriesId);
    mkdirSync(hub);
    outputs.push(path.join(seriesDirectory, "series-commit.json"));
    writeFileSync(path.join(hub, "series-commit.json"), text({ version: 1, seriesHash, identity, episodes, outputs }));
    for (const draft of drafts) {
      const final = safe(projects, path.join(projects, draft.projectId));
      if (existsSync(final)) throw new Error("Publication destination appeared; refusing overwrite");
      // Exclusive directory creation prevents replacing even an empty racing destination.
      mkdirSync(final);
      published.push(final);
      const staged = path.join(staging, draft.projectId);
      // Publish binding/required-mode guard before canonical project becomes discoverable.
      for (const name of ["pipeline", "assets", "project.json"]) {
        renameSync(path.join(staged, name), path.join(final, name));
      }
    }
    mkdirSync(seriesDirectory);
    published.push(seriesDirectory);
    renameSync(path.join(hub, "series-commit.json"), path.join(seriesDirectory, "series-commit.json"));
    return {
      outputs,
      metadata: { ...metadata, state: "committed", idempotent: false },
    };
  } catch (error) {
    for (const directory of published.reverse()) rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (stagingOwned) rmSync(staging, { recursive: true, force: true });
    closeSync(descriptor!);
    rmSync(lock, { force: true });
  }
}
