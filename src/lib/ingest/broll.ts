import { verifyCategoryEvidence, searchCategoryFrames } from "./category-evidence";
import path from "node:path";
import { constants, openSync, closeSync, readFileSync, fstatSync, lstatSync, existsSync, realpathSync } from "node:fs";
import { z } from "zod";
import { SourceIndexSchema } from "../../types/source-index";
import { RationalSchema, type EditCommand } from "../../types/timeline";
import { importTranscript } from "./index";
import { sourceIndexCacheKey, verifyOcrEvidence, ocrRegularFile } from "./ocr-evidence";
import { verifyVisualEvidence, searchVisualFrames } from "./visual-evidence";
import { searchSourceIndexes, proposeSelect, type SourceSelect } from "./selects";
import { searchEmbeddings, EmbeddingPackSchema } from "./embeddings";
import { readAssetRegistry, hashFile } from "../assets/registry";
import { TimelineEditStore } from "../timeline-ir/store";
import { compileTimelineIR, clipDuration } from "../timeline-ir/compiler";
import { fraction, add, compare, numeric } from "../timeline-ir/rational";
import { stableHash } from "../longform/plans";
import { digest } from "../jobs/model-artifacts";
import { assertProjectId } from "../render-plan";
import { renderBoundary } from "../timeline-ir/render";
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const localFile = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (v) =>
      !path.isAbsolute(v) && !v.includes("\\") && v.split("/").every((p) => p !== ".." && p !== "." && p.length > 0),
    "Use project-relative files",
  );
export const BrollRequestSchema = z
  .object({
    version: z.literal(1),
    projectId: id,
    indexFile: localFile,
    retrieval: z.discriminatedUnion("method", [
      z
        .object({
          method: z.literal("lexical"),
          query: z.string().trim().min(1).max(1000),
        })
        .strict(),
      z
        .object({
          method: z.literal("native-image-distance"),
        })
        .strict(),
      z.object({ method: z.literal("native-image-category"), queryFile: localFile }).strict(),
      z
        .object({
          method: z.literal("supplied-embedding"),
          packFile: localFile,
          queryFile: localFile,
        })
        .strict(),
    ]),
    segmentId: z.string().min(1).max(160),
    contextSec: z.number().finite().min(0).max(60).default(0),
    trackId: id,
    clipId: id,
    outputStart: RationalSchema,
    expectedRevision: z.number().int().nonnegative(),
    usage: z.enum(["editorial", "advertising"]).default("editorial"),
  })
  .strict();
export const BrollReviewSchema = z
  .object({
    planHash: hash,
    assetHash: hash,
    reviewedBy: z.string().trim().min(1).max(160),
    evidence: z.string().trim().min(1).max(2000),
  })
  .strict();
export type BrollRequest = z.input<typeof BrollRequestSchema>;
/** Reject symlink aliases, including aliases to another project inside the workspace. */
function local(root: string, project: string, relative: string) {
  const full = path.resolve(project, relative);
  if (full !== project && !full.startsWith(project + path.sep)) throw new Error("B-roll path escapes project");
  let current = full;
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("B-roll symlink path is forbidden");
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("B-roll path outside workspace");
    current = parent;
  }
  return full;
}
function json(file: string, limit = 16 * 1024 * 1024) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("B-roll JSON must be a bounded regular file");
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || bytes.length > limit) throw new Error("B-roll JSON changed during read");
    return {
      value: JSON.parse(bytes.toString()),
      hash: digest(bytes),
    };
  } finally {
    closeSync(fd);
  }
}
/** Read-only source evidence checks, matching canonical index cache/transcript identity. */
function indexed(root: string, project: string, projectId: string, file: string) {
  const document = json(local(root, project, file));
  const index = SourceIndexSchema.parse(document.value);
  if (index.projectId !== projectId || index.cacheKey !== sourceIndexCacheKey(index))
    throw new Error("B-roll source index identity changed");
  const publicFile = (ref: string) => local(root, project, path.relative(project, path.resolve(root, "public", ref)));
  for (const row of [
    {
      path: index.source.path,
      hash: index.sourceHash,
    },
    ...(index.proxy ? [index.proxy] : []),
    ...index.thumbnails,
    ...(index.transcript ? [index.transcript] : []),
  ]) {
    const file = publicFile(row.path);
    if (index.ocrAnalysis || index.visualAnalysis || index.categoryAnalysis) ocrRegularFile(file);
    if (hashFile(file) !== row.hash) throw new Error("B-roll indexed original/evidence changed");
  }
  if (index.transcript) {
    const expected = importTranscript(
      json(publicFile(index.transcript.path)).value,
      index.transcript.source,
      index.transcript.hash,
      index.source.durationSec,
      index.localAnalysis ? "local-asr" : "supplied-transcript",
      index.localAnalysis?.segmentation === "sentence-boundaries-v1",
    );
    const supplied = index.segments.filter((s) =>
      s.evidence.some((e) => e.kind === (index.localAnalysis ? "local-asr" : "supplied-transcript")),
    );
    if (JSON.stringify(expected) !== JSON.stringify(supplied)) throw new Error("B-roll transcript evidence changed");
  }
  const categoryBase = verifyCategoryEvidence(index, publicFile);
  const checkedBase = categoryBase.visualAnalysis
    ? verifyVisualEvidence(categoryBase, publicFile, readAssetRegistry(projectId, root))
    : categoryBase;
  verifyOcrEvidence(checkedBase, publicFile);
  return {
    index,
    indexHash: document.hash,
    publicFile,
  };
}
export function planBroll(
  raw: unknown,
  options: {
    rootDir?: string;
    scopeRoot?: string;
  } = {},
) {
  const request = BrollRequestSchema.parse(raw);
  assertProjectId(request.projectId);
  const root = realpathSync(options.rootDir ?? process.cwd());
  if (options.scopeRoot) {
    const scope = realpathSync(options.scopeRoot);
    if (root !== scope && !root.startsWith(scope + path.sep)) throw new Error("B-roll root outside scope");
  }
  const project = local(root, path.join(root, "public/projects", request.projectId), "");
  json(local(root, project, "project.json"));
  const { index, indexHash, publicFile } = indexed(root, project, request.projectId, request.indexFile);
  if (
    index.source.kind !== "video" ||
    !index.source.fps ||
    index.source.variableFrameRate ||
    Math.abs(index.source.originSec) > 0.001
  )
    throw new Error("B-roll requires zero-origin CFR video; review normalization first");
  const registry = readAssetRegistry(request.projectId, root),
    asset = registry.assets.find((a) => a.id === index.assetId);
  if (
    !asset ||
    asset.kind !== "video" ||
    asset.hash !== index.sourceHash ||
    asset.files.original !== index.source.path ||
    hashFile(publicFile(asset.files.original)) !== asset.hash
  )
    throw new Error("B-roll must use its registered immutable video original");
  if (
    asset.media.frameRate !== `${index.source.fps.num}/${index.source.fps.den}` ||
    Math.abs(asset.media.durationSec! - index.source.durationSec) > 0.001
  )
    throw new Error("B-roll index differs from registered source timing");
  if (
    !asset.rights.licence.trim() ||
    asset.rights.licence.trim().toLowerCase() === "unknown" ||
    !asset.rights.checkedAsOf ||
    asset.rights.attributionRequired === "unknown" ||
    (asset.rights.attributionRequired && !asset.rights.attribution?.trim()) ||
    (request.usage === "advertising" && asset.rights.commercialAllowed !== true)
  )
    throw new Error("B-roll usage needs supplied checked rights and required credits");
  const searchPins: {
    file: string;
    hash: string;
  }[] = [];
  let hits: {
    segmentId: string;
    cacheKey: string;
  }[];
  if (request.retrieval.method === "lexical") hits = searchSourceIndexes([index], request.retrieval.query, 100);
  else if (request.retrieval.method === "native-image-distance") {
    hits = searchVisualFrames(index, publicFile, registry, 100);
    searchPins.push({
      file: path.relative(project, publicFile(index.visualAnalysis!.receipt.path)),
      hash: index.visualAnalysis!.receipt.hash,
    });
  } else if (request.retrieval.method === "native-image-category") {
    const query = json(local(root, project, request.retrieval.queryFile), 65536);
    hits = searchCategoryFrames(index, publicFile, query.value, 100);
    searchPins.push(
      { file: request.retrieval.queryFile, hash: query.hash },
      {
        file: path.relative(project, publicFile(index.categoryAnalysis!.receipt.path)),
        hash: index.categoryAnalysis!.receipt.hash,
      },
    );
  } else {
    const pack = json(local(root, project, request.retrieval.packFile)),
      query = json(local(root, project, request.retrieval.queryFile));
    searchPins.push(
      {
        file: request.retrieval.packFile,
        hash: pack.hash,
      },
      {
        file: request.retrieval.queryFile,
        hash: query.hash,
      },
    );
    const parsedPack = EmbeddingPackSchema.parse(pack.value);
    const keys = [...new Set(parsedPack.items.map((item) => item.cacheKey))];
    if (keys.length > 64) throw new Error("B-roll corpus exceeds 64 indexed sources");
    const corpus = keys.map((key) => {
      if (key === index.cacheKey) return index;
      const file = `pipeline/source-index/${key}/index.json`;
      const other = indexed(root, project, request.projectId, file);
      if (other.index.cacheKey !== key) throw new Error("B-roll corpus index path identity changed");
      searchPins.push({
        file,
        hash: other.indexHash,
      });
      return other.index;
    });
    hits = searchEmbeddings(corpus, parsedPack, query.value, 100);
  }
  const hit = hits.find((h) => h.segmentId === request.segmentId && h.cacheKey === index.cacheKey);
  if (!hit) throw new Error("B-roll selected segment is absent from reproducible retrieval results");
  const selection = proposeSelect(
    index,
    {
      ...hit,
      cacheKey: index.cacheKey,
      assetId: index.assetId,
      sourceHash: index.sourceHash,
    } as SourceSelect,
    request.contextSec,
  );
  const fps = index.source.fps;
  const source = {
    start: fraction(Math.floor(selection.startSec * numeric(fps) + 1e-6)),
    end: fraction(Math.ceil(selection.endSec * numeric(fps) - 1e-6)),
    timebase: fps,
  };
  if (
    numeric(source.end) / numeric(fps) > index.source.durationSec + 0.001 ||
    numeric(source.end) / numeric(fps) > asset.media.durationSec! + 0.001
  )
    throw new Error("B-roll outward-rounded source exceeds original");
  const store = new TimelineEditStore(local(root, project, "pipeline/timeline-edit.json")),
    before = store.read();
  if (before.timeline.projectId !== request.projectId || before.revision !== request.expectedRevision)
    throw new Error("B-roll timeline project/revision changed");
  if (before.timeline.tracks.some((t) => t.id === request.trackId || t.clips.some((c) => c.id === request.clipId)))
    throw new Error("B-roll track/clip identity already exists");
  const clip = {
    id: request.clipId,
    assetId: asset.id,
    start: request.outputStart,
    source,
    rate: fraction(1),
    transition: {
      kind: "cut" as const,
    },
    captions: [],
  };
  const end = add(clip.start, clipDuration(clip, before.timeline.timebase)),
    duration = compileTimelineIR(before.timeline).duration;
  if (compare(clip.start, fraction(0)) < 0 || compare(end, duration) > 0)
    throw new Error("B-roll placement must stay inside the current master");
  if (renderBoundary(end, before.timeline.timebase, 30) <= renderBoundary(clip.start, before.timeline.timebase, 30))
    throw new Error("B-roll placement is shorter than one rendered frame");
  const command: EditCommand = {
    type: "add-track",
    track: {
      id: request.trackId,
      kind: "visual",
      clips: [clip],
    },
  };
  const preview = store.dryRun(command, request.expectedRevision);
  if (stableHash(preview.timeline.tracks.slice(0, -1)) !== stableHash(before.timeline.tracks))
    throw new Error("B-roll would change original tracks");
  const identity = {
    version: 1 as const,
    request,
    indexHash,
    assetHash: asset.hash,
    assetMetadataHash: stableHash(asset),
    searchPins,
    timelineHash: stableHash(before.timeline),
    selection,
    command,
    outputEnd: end,
  };
  return {
    ...identity,
    planHash: stableHash(identity),
    reviewRequired: true as const,
    productionApproved: false as const,
    sourceAudio: "muted-visual-track" as const,
    retrieval: hit,
    originalTracksPreserved: true as const,
  };
}
/** Apply only an explicitly supplied, hash-bound review. This is not authentication of a human review. */
export function applyBroll(
  planInput: unknown,
  reviewInput: unknown,
  options: {
    rootDir?: string;
    scopeRoot?: string;
    dryRun?: boolean;
  } = {},
) {
  const supplied = planInput as ReturnType<typeof planBroll>;
  const plan = planBroll(supplied?.request, options);
  const review = BrollReviewSchema.parse(reviewInput);
  if (
    stableHash(supplied) !== stableHash(plan) ||
    review.planHash !== plan.planHash ||
    review.assetHash !== plan.assetHash
  )
    throw new Error("B-roll plan/review pins changed");
  const root = realpathSync(options.rootDir ?? process.cwd()),
    project = path.join(root, "public/projects", plan.request.projectId);
  const store = new TimelineEditStore(local(root, project, "pipeline/timeline-edit.json"));
  const command: EditCommand = {
    type: "add-track",
    track: {
      ...plan.command.track,
      clips: plan.command.track.clips.map((c) => ({
        ...c,
        payload: {
          broll: {
            planHash: plan.planHash,
            selectionId: plan.selection.id,
            indexHash: plan.indexHash,
            retrievalPins: plan.searchPins,
            review,
            sourceAudio: "muted",
          },
        },
      })),
    },
  };
  const result = options.dryRun
    ? store.dryRun(command, plan.request.expectedRevision)
    : store.apply(command, plan.request.expectedRevision);
  if (
    stableHash({
      ...result.timeline,
      tracks: result.timeline.tracks.slice(0, -1),
    }) !== plan.timelineHash
  )
    throw new Error("B-roll readback original tracks changed");
  return {
    ...result,
    dryRun: options.dryRun ?? false,
    planHash: plan.planHash,
    reviewRequired: true,
    productionApproved: false,
    providerSpendUsd: 0,
  };
}
