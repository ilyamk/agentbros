import { boundedEvidenceJson } from "./bounded-evidence";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SourceIndexSchema } from "../../types/source-index";
import { validateNativeWordOutput } from "../../types/native-word-timing";
import { readSourceIndex } from "./index";
import { regular, localWorkerFileHash } from "./local-worker";
import { requireProject, assertPathWithin } from "../cli";
/** Read pinned native evidence; return a proposal, never apply/approve any edit. */
export function sourceWordProposal(projectId: string, indexFile: string, frames = false) {
  requireProject(projectId);
  const project = path.resolve("public/projects", projectId);
  assertPathWithin(project, path.resolve(indexFile));
  const indexHash = localWorkerFileHash(indexFile, 16 * 1024 * 1024);
  const preview = SourceIndexSchema.parse(boundedEvidenceJson(indexFile).value);
  const resolve = (ref: string) => {
    const file = path.resolve("public", ref);
    assertPathWithin(project, file);
    regular(file, 32 * 1024 ** 3);
    return file;
  };
  for (const ref of [
    preview.source.path,
    ...(preview.proxy ? [preview.proxy.path] : []),
    ...preview.thumbnails.map((r) => r.path),
    ...(preview.transcript ? [preview.transcript.path] : []),
  ])
    resolve(ref);
  const index = readSourceIndex(projectId, indexFile, { boundedEvidence: true });
  if (!index.transcript || index.localAnalysis?.wordTimingMethod !== "native-word-segments-v1")
    throw new Error("Source index has no requested native word evidence; old segment-only indexes remain supported");
  const transcriptFile = resolve(index.transcript.path);
  const raw = boundedEvidenceJson(transcriptFile).value as {
    segments: Array<{ text: string; startSec: number; endSec: number }>;
    wordTimings: unknown;
  };
  const result = validateNativeWordOutput(raw.wordTimings, index.source.durationSec, raw.segments);
  if (result.evidence.status !== "available")
    throw new Error("Native word alignment unavailable: " + result.evidence.reason);
  const fps = index.source.fps;
  if (
    frames &&
    (index.source.kind !== "video" || !fps || index.source.variableFrameRate || index.source.originSec !== 0)
  )
    throw new Error("Frame export requires a verified zero-origin CFR video clock; use source seconds for audio/VFR");
  if (frames) {
    const file = resolve(index.source.path),
      probe = spawnSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-select_streams",
          "v:0",
          "-show_streams",
          "-show_frames",
          "-show_entries",
          "stream=r_frame_rate,avg_frame_rate:frame=best_effort_timestamp_time",
          "-of",
          "json",
          file,
        ],
        { encoding: "utf8", timeout: 30000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 },
      );
    if (probe.error || probe.status !== 0) throw new Error("Source frame clock probe failed");
    const actual = JSON.parse(probe.stdout),
      rate = `${fps!.num}/${fps!.den}`;
    const pts = (actual.frames ?? []).map((f: { best_effort_timestamp_time: string }) =>
      Number(f.best_effort_timestamp_time),
    );
    if (
      actual.streams?.[0]?.r_frame_rate !== rate ||
      actual.streams?.[0]?.avg_frame_rate !== rate ||
      !pts.length ||
      pts.length > 200000 ||
      pts.length !== index.source.timestamps.length ||
      pts.some(
        (t: number, i: number) =>
          !Number.isFinite(t) ||
          Math.abs(t - index.source.timestamps[i]) > 0.000001 ||
          Math.abs(t - (i * fps!.den) / fps!.num) > 0.001,
      )
    )
      throw new Error("Stored source frame clock differs from immutable original; no inferred frame mapping");
    if (localWorkerFileHash(file) !== index.sourceHash)
      throw new Error("Original changed during frame clock verification");
  }
  const words = result.words.map((word) => {
    if (!frames) return word;
    const startFrame = Math.round((word.startSec * fps!.num) / fps!.den),
      endFrame = Math.round((word.endSec * fps!.num) / fps!.den);
    if (startFrame >= endFrame)
      throw new Error("Native word collapses on actual source frame clock; review seconds instead of stretching it");
    return { ...word, startFrame, endFrame };
  });
  if (frames)
    for (let i = 1; i < words.length; i++) {
      const current = words[i],
        previous = words[i - 1];
      if ("startFrame" in current && "endFrame" in previous && current.startFrame < previous.endFrame)
        throw new Error("Native words overlap on source frame clock");
    }
  if (
    localWorkerFileHash(indexFile, 16 * 1024 * 1024) !== indexHash ||
    localWorkerFileHash(transcriptFile, 16 * 1024 * 1024) !== index.transcript.hash ||
    localWorkerFileHash(resolve(index.source.path)) !== index.sourceHash
  )
    throw new Error("Source/index/word evidence changed during proposal");
  return {
    version: 1,
    kind: "native-word-proposal",
    method: result.evidence.method,
    estimated: true,
    reviewRequired: true,
    approved: false,
    sourceHash: index.sourceHash,
    sourceIndexHash: indexHash,
    sourceCacheKey: index.cacheKey,
    evidenceHash: index.transcript.hash,
    identityHash: index.localAnalysis.identityHash,
    modelHash: index.localAnalysis.modelHash,
    workerCacheKey: index.localAnalysis.cacheKey,
    clock: frames ? "source-frames" : "source-seconds",
    ...(frames ? { fps } : {}),
    words,
  };
}
