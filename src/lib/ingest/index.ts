import { verifyCategoryEvidence } from "./category-evidence";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  readdirSync,
  unlinkSync,
  statSync,
  constants,
  fstatSync,
} from "node:fs";
import path from "node:path";
import { importAsset, hashFile, readAssetRegistry } from "../assets/registry";
import { inspectAsset } from "../assets/inspect";
import { assertPathWithin, requireProject, CliErrorObject, ensureFfmpeg, emitProgress } from "../cli";
import {
  IngestOptionsSchema,
  SourceIndexSchema,
  SourceSegmentSchema,
  type SourceIndex,
  type IngestOptions,
} from "../../types/source-index";
import { sourceIndexCacheKey, verifyOcrEvidence, ocrLocalPath, ocrRegularFile } from "./ocr-evidence";
import { boundedEvidenceHash, boundedEvidenceJson } from "./bounded-evidence";
import { AssetRegistrySchema } from "../../types/assets";
import { verifyVisualEvidence } from "./visual-evidence";
const projectPath = (id: string) => {
  requireProject(id);
  return path.resolve("public/projects", id);
};
const fail = (message: string) => new CliErrorObject({ code: "VALIDATION", message });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function tool(binary: string, args: string[], timeout = 120000) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw fail(`${binary} failed: ${result.error?.message ?? result.stderr.slice(-2000)}`);
  return result;
}
function publicPath(projectId: string, file: string): string {
  const project = projectPath(projectId);
  const full = path.resolve("public", file);
  assertPathWithin(project, full);
  return full;
}
/** Times where ffmpeg's scene score exceeds a threshold. */
export function detectSceneChanges(file: string, threshold: number): number[] {
  const scenes = tool("ffmpeg", [
    "-hide_banner",
    "-i",
    file,
    "-vf",
    `setpts=PTS-STARTPTS,select=gt(scene\\,${threshold}),showinfo`,
    "-an",
    "-f",
    "null",
    "-",
  ]);
  return Array.from(scenes.stderr.matchAll(/pts_time:([\d.]+)/g), (match) => Number(match[1]));
}
/** ffmpeg's scene score for every frame after the first, for callers that pick their own peaks. */
export function sceneScoreCurve(file: string): { timeSec: number; score: number }[] {
  const log = tool(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      file,
      "-vf",
      "setpts=PTS-STARTPTS,select='gte(scene\\,0)',metadata=print:file=-",
      "-an",
      "-f",
      "null",
      "-",
    ],
    600000,
  );
  return Array.from(log.stdout.matchAll(/pts_time:([\d.]+)\s*\n?\s*lavfi\.scene_score=([\d.]+)/g), (match) => ({
    timeSec: Number(match[1]),
    score: Number(match[2]),
  }));
}
export function readSourceIndex(
  projectId: string,
  file: string,
  options: { boundedEvidence?: true } = {},
): SourceIndex {
  const root = projectPath(projectId);
  assertPathWithin(root, path.resolve(file));
  // A replaced index FIFO must fail before waiting for a writer. Regular legacy
  // index bytes/key/schema remain unchanged; read from the checked descriptor.
  const indexFd = options.boundedEvidence
    ? undefined
    : openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let index: SourceIndex;
  if (options.boundedEvidence) index = SourceIndexSchema.parse(boundedEvidenceJson(file).value);
  else
    try {
      if (!fstatSync(indexFd!).isFile()) throw fail("Source index requires a regular file");
      index = SourceIndexSchema.parse(JSON.parse(readFileSync(indexFd!, "utf8")));
    } finally {
      closeSync(indexFd!);
    }
  const expectedKey = sourceIndexCacheKey(index);
  if (expectedKey !== index.cacheKey)
    throw fail("Source analysis options/evidence no longer match its cache identity.");
  if (index.projectId !== projectId) throw fail("Source index belongs to another project.");
  for (const row of [
    { path: index.source.path, hash: index.sourceHash },
    ...(index.proxy ? [index.proxy] : []),
    ...index.thumbnails,
    ...(index.transcript ? [index.transcript] : []),
  ]) {
    if (index.ocrAnalysis || index.visualAnalysis || index.categoryAnalysis)
      ocrRegularFile(ocrLocalPath(root, publicPath(projectId, row.path)));
    if (
      (options.boundedEvidence
        ? boundedEvidenceHash(
            publicPath(projectId, row.path),
            row.path === index.transcript?.path ? 16 * 1024 * 1024 : 32 * 1024 ** 3,
          )
        : hashFile(publicPath(projectId, row.path))) !== row.hash
    )
      throw fail(`Index media checksum changed: ${row.path}`);
  }
  if (index.transcript) {
    const transcript = options.boundedEvidence
      ? boundedEvidenceJson(publicPath(projectId, index.transcript.path))
      : undefined;
    if (transcript && transcript.hash !== index.transcript.hash) throw fail("Transcript changed during canonical read");
    const expected = importTranscript(
      transcript ? transcript.value : JSON.parse(readFileSync(publicPath(projectId, index.transcript.path), "utf8")),
      index.transcript.source,
      index.transcript.hash,
      index.source.durationSec,
      index.localAnalysis ? "local-asr" : "supplied-transcript",
      index.localAnalysis?.segmentation === "sentence-boundaries-v1",
    );
    const supplied = index.segments.filter((segment) =>
      segment.evidence.some(
        (evidence) => evidence.kind === (index.localAnalysis ? "local-asr" : "supplied-transcript"),
      ),
    );
    if (JSON.stringify(expected) !== JSON.stringify(supplied))
      throw fail("Transcript segments differ from their immutable supplied evidence.");
  }
  let registry;
  if (index.visualAnalysis && options.boundedEvidence) {
    const registryFile = path.join(root, "pipeline/asset-registry.json");
    registry = AssetRegistrySchema.parse(boundedEvidenceJson(registryFile, 16 * 1024 * 1024).value);
    for (const asset of registry.assets)
      if (
        !asset.files.original.startsWith(`projects/${projectId}/assets/imported/`) ||
        asset.files.original.includes("..") ||
        asset.files.original.includes("\\")
      )
        throw fail("Invalid original registry reference");
  }
  const categoryBase = verifyCategoryEvidence(index, (ref) => ocrLocalPath(root, publicPath(projectId, ref)));
  const checkedBase = categoryBase.visualAnalysis
    ? verifyVisualEvidence(
        categoryBase,
        (ref) => ocrLocalPath(root, publicPath(projectId, ref)),
        registry ?? readAssetRegistry(projectId),
        !!options.boundedEvidence,
      )
    : categoryBase;
  verifyOcrEvidence(checkedBase, (ref) => ocrLocalPath(root, publicPath(projectId, ref)), !!options.boundedEvidence);
  return index;
}
export function listSourceIndexes(projectId: string): SourceIndex[] {
  const dir = path.join(projectPath(projectId), "pipeline/source-index");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((key) => /^[a-f0-9]{64}$/.test(key))
    .map((key) => readSourceIndex(projectId, path.join(dir, key, "index.json")));
}
/** Accept canonical spans, word alignments, Scribe word JSON or a TranscriptSchema transcript, keeping speakers. Never performs ASR. */
export function importTranscript(
  raw: unknown,
  source: string,
  hash: string,
  durationSec: number,
  evidenceKind: "supplied-transcript" | "local-asr" = "supplied-transcript",
  groupAsrSentences = false,
) {
  const object = raw as { segments?: unknown[]; words?: unknown[] };
  const rows = Array.isArray(raw) ? raw : (object?.segments ?? object?.words);
  if (!Array.isArray(rows)) throw fail("Transcript must contain a segments/words array.");
  // Zero-length rows are valid in TranscriptSchema but carry no span to index.
  const parsed = rows
    .filter((row) => {
      const item = row as {
        type?: string;
        kind?: string;
        start?: unknown;
        end?: unknown;
        startSec?: unknown;
        endSec?: unknown;
      };
      const start = item?.startSec ?? item?.start;
      return (
        item?.type !== "audio_event" &&
        item?.type !== "spacing" &&
        item?.kind !== "event" &&
        !(typeof start === "number" && start === (item.endSec ?? item.end))
      );
    })
    .map((row, i) => {
      const item = row as {
        text?: unknown;
        start?: unknown;
        end?: unknown;
        startSec?: unknown;
        endSec?: unknown;
        tags?: unknown;
        speaker?: unknown;
        speaker_id?: unknown;
      };
      const speaker = item.speaker ?? item.speaker_id;
      const segment = SourceSegmentSchema.parse({
        id: `transcript-${i}`,
        text: item.text,
        startSec: item.startSec ?? item.start,
        endSec: item.endSec ?? item.end,
        tags: item.tags ?? [],
        evidence: [{ kind: evidenceKind, source, hash }],
        ...(typeof speaker === "string" && speaker ? { speaker } : {}),
      });
      if (segment.endSec > durationSec + 0.001) throw fail("Transcript extends beyond source duration.");
      return segment;
    });
  if (
    groupAsrSentences &&
    (!parsed.length ||
      parsed.some(
        (row, i) => !row.text.trim() || row.text.length > 10000 || (i > 0 && row.startSec < parsed[i - 1]!.endSec),
      ))
  )
    throw fail("ASR sentence grouping requires nonempty bounded text and monotonic nonoverlapping spans.");
  parsed.sort((a, b) => a.startSec - b.startSec);
  // Legacy word-only exports and explicitly versioned ASR chunks become punctuation/gap groups, retaining original timing evidence.
  if (!parsed.length || (!groupAsrSentences && parsed.some((row) => row.text.trim().split(/\s+/).length > 1)))
    return parsed;
  const grouped: typeof parsed = [];
  for (const row of parsed) {
    const prior = grouped.at(-1);
    if (
      prior &&
      prior.speaker === row.speaker &&
      row.startSec - prior.endSec <= 1 &&
      !/[.!?。！？]$/.test(prior.text.trim())
    ) {
      if (groupAsrSentences && prior.text.length + row.text.length + 1 > 10000)
        throw fail("ASR sentence exceeds 10000 characters; explicit reviewed segmentation required.");
      prior.text += ` ${row.text}`;
      prior.endSec = Math.max(prior.endSec, row.endSec);
      prior.tags = [...new Set([...prior.tags, ...row.tags])];
    } else grouped.push(structuredClone(row));
  }
  return grouped;
}
export function probeOcr(): SourceIndex["ocr"] {
  const result = spawnSync("tesseract", ["--version"], { encoding: "utf8", timeout: 10000 });
  return {
    available: !result.error && result.status === 0,
    executed: false,
    ...(result.status === 0
      ? { version: (result.stdout || result.stderr).split("\n")[0] }
      : { warning: "tesseract is unavailable; no OCR evidence produced." }),
  };
}
export function ingestMedia(request: {
  projectId: string;
  sourceFile: string;
  transcriptFile?: string;
  options?: IngestOptions;
  localAnalysis?: NonNullable<SourceIndex["localAnalysis"]>;
  dryRun?: boolean;
}): { index?: SourceIndex; file: string; cacheHit: boolean; dryRun: boolean; cacheKey: string } {
  const localAnalysis = request.localAnalysis
    ? SourceIndexSchema.shape.localAnalysis.parse(request.localAnalysis)
    : undefined;
  if (localAnalysis && !request.transcriptFile) throw fail("Local ASR requires pinned transcript evidence.");
  const options = IngestOptionsSchema.parse(request.options ?? {});
  const project = projectPath(request.projectId);
  const inspected = inspectAsset(request.sourceFile);
  if (inspected.kind === "image") throw fail("Recording ingest requires video or audio.");
  const duration = inspected.media.durationSec!;
  if (options.protectedSpans.some((span) => span.endSec > duration))
    throw fail("Protected span exceeds source duration.");
  if (request.transcriptFile && statSync(request.transcriptFile).size > 16 * 1024 * 1024)
    throw fail("Transcript exceeds the 16 MiB local evidence limit.");
  const transcriptBytes = request.transcriptFile ? readFileSync(request.transcriptFile, "utf8") : undefined;
  const transcriptHash = transcriptBytes === undefined ? undefined : digest(transcriptBytes);
  const segments =
    transcriptBytes === undefined
      ? []
      : importTranscript(
          JSON.parse(transcriptBytes),
          request.transcriptFile!,
          transcriptHash!,
          duration,
          localAnalysis ? "local-asr" : "supplied-transcript",
          localAnalysis?.segmentation === "sentence-boundaries-v1",
        );
  const sourceHash = hashFile(request.sourceFile);
  const cacheKey = digest(
    JSON.stringify({ version: 1, sourceHash, options, transcriptHash, ...(localAnalysis ? { localAnalysis } : {}) }),
  );
  const directory = path.join(project, "pipeline/source-index", cacheKey),
    file = path.join(directory, "index.json");
  assertPathWithin(project, directory);
  if (existsSync(file))
    return {
      index: readSourceIndex(request.projectId, file),
      file,
      cacheHit: true,
      dryRun: !!request.dryRun,
      cacheKey,
    };
  if (request.dryRun) return { file, cacheHit: false, dryRun: true, cacheKey };
  emitProgress(`Importing recording and building local index ${cacheKey.slice(0, 12)}…`);
  ensureFfmpeg();
  const asset = importAsset({
    projectId: request.projectId,
    sourceFile: request.sourceFile,
    provenance: { origin: "manual", originalFilename: path.basename(request.sourceFile) },
  }).asset;
  if (asset.hash !== sourceHash) throw fail("Original changed during ingest; retry with a stable source file.");
  const original = publicPath(request.projectId, asset.files.original);
  mkdirSync(path.dirname(directory), { recursive: true });
  const lock = `${directory}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch {
    throw new CliErrorObject({
      code: "TIMEOUT",
      message: "Source analysis is locked. Retry after the current worker completes.",
    });
  }
  const temporary = `${directory}.${randomUUID()}.tmp`;
  mkdirSync(temporary);
  try {
    if (existsSync(file))
      return { index: readSourceIndex(request.projectId, file), file, cacheHit: true, dryRun: false, cacheKey };
    const ref = (name: string) =>
      path.relative(path.resolve("public"), path.join(directory, name)).split(path.sep).join("/");
    const ocr = probeOcr();
    const index: SourceIndex = {
      schemaVersion: 1,
      projectId: request.projectId,
      assetId: asset.id,
      sourceHash,
      cacheKey,
      createdAt: new Date().toISOString(),
      options,
      source: {
        path: asset.files.original,
        kind: inspected.kind,
        durationSec: duration,
        originSec: 0,
        variableFrameRate: false,
        timestamps: [],
      },
      thumbnails: [],
      scenes: [],
      segments,
      ocr,
      ...(localAnalysis ? { localAnalysis } : {}),
      ...(transcriptHash
        ? { transcript: { hash: transcriptHash, source: request.transcriptFile!, path: ref("transcript.json") } }
        : {}),
    };
    if (transcriptBytes !== undefined) writeFileSync(path.join(temporary, "transcript.json"), transcriptBytes);
    if (inspected.kind === "video") {
      const rate = inspected.media.frameRate?.split("/").map(Number);
      if (!rate || rate.length !== 2 || !(rate[0]! > 0) || !(rate[1]! > 0))
        throw fail("Video frame rate is unavailable.");
      index.source.fps = { num: rate[0]!, den: rate[1]! };
      const frameProbe = tool("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "json",
        original,
      ]);
      const pts = (JSON.parse(frameProbe.stdout).frames as { best_effort_timestamp_time: string }[]).map((frame) =>
        Number(frame.best_effort_timestamp_time),
      );
      if (!pts.length || pts.length > 200000 || pts.some((n, i) => !Number.isFinite(n) || (i > 0 && n <= pts[i - 1]!)))
        throw fail("Unsupported or oversized source timestamp sequence.");
      index.source.originSec = pts[0]!;
      index.source.timestamps = pts.map((n) => n - pts[0]!);
      const step = rate[1]! / rate[0]!;
      index.source.variableFrameRate = index.source.timestamps.some((n, i) => Math.abs(n - i * step) > 0.001);
      emitProgress("Building source-aligned low-resolution video proxy…");
      tool("ffmpeg", [
        "-v",
        "error",
        "-i",
        original,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        `setpts=PTS-STARTPTS,scale=w='min(${options.proxyWidth},iw)':h=-2`,
        "-af",
        `atrim=start=${pts[0]},asetpts=PTS-${pts[0]}/TB`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "28",
        "-c:a",
        "aac",
        "-fps_mode",
        "passthrough",
        path.join(temporary, "proxy.mp4"),
      ]);
      index.proxy = {
        path: ref("proxy.mp4"),
        hash: hashFile(path.join(temporary, "proxy.mp4")),
        fps: index.source.fps,
        startSec: 0,
        mapping: "same-origin-seconds",
      };
      if (Math.ceil(duration / options.thumbnailEverySec) > 500)
        throw fail("Thumbnail request exceeds 500 images; increase interval.");
      const selected: number[] = [];
      for (let t = 0, frame = 0; t < duration; t += options.thumbnailEverySec) {
        while (frame + 1 < index.source.timestamps.length && index.source.timestamps[frame + 1]! <= t) frame++;
        if (selected.at(-1) !== frame) selected.push(frame);
      }
      emitProgress(`Sampling ${selected.length} source-frame thumbnails…`);
      tool("ffmpeg", [
        "-v",
        "error",
        "-i",
        original,
        "-vf",
        `select=${selected.map((frame) => `eq(n\\,${frame})`).join("+")},scale=w='min(320,iw)':h=-2`,
        "-fps_mode",
        "vfr",
        path.join(temporary, "thumb-%d.jpg"),
      ]);
      for (const [n, frame] of selected.entries()) {
        const filename = `thumb-${n + 1}.jpg`;
        index.thumbnails.push({
          path: ref(filename),
          hash: hashFile(path.join(temporary, filename)),
          timeSec: index.source.timestamps[frame]!,
          sourceFrame: { num: frame, den: 1 },
        });
      }
      emitProgress("Detecting visual scene-change candidates…");
      const boundaries = [
        0,
        ...detectSceneChanges(original, options.sceneThreshold).filter((n) => n > 0 && n < duration),
        duration,
      ];
      index.scenes = [...new Set(boundaries)]
        .sort((a, b) => a - b)
        .slice(0, -1)
        .map((startSec, i) => ({
          startSec,
          endSec: [...new Set(boundaries)].sort((a, b) => a - b)[i + 1]!,
          evidence: {
            kind: "ffmpeg-scene-change" as const,
            source: asset.id,
            detail: `Scene-change threshold ${options.sceneThreshold}; visual candidate, not narrative interpretation.`,
          },
        }));
      if (options.ocr && ocr.available) {
        for (const [n, thumb] of index.thumbnails.entries()) {
          const text = tool(
            "tesseract",
            [path.join(temporary, `thumb-${n + 1}.jpg`), "stdout", "-l", options.ocrLanguage],
            30000,
          ).stdout.trim();
          if (text)
            index.segments.push({
              id: `ocr-${n}`,
              startSec: thumb.timeSec,
              endSec: Math.min(duration, thumb.timeSec + options.thumbnailEverySec),
              text,
              tags: [],
              evidence: [
                {
                  kind: "ocr",
                  source: thumb.path,
                  hash: thumb.hash,
                  detail: "OCR sampled frame text; occurrence within interval is unverified.",
                },
              ],
            });
        }
        index.ocr.executed = true;
      }
    }
    if (inspected.kind === "audio") {
      tool("ffmpeg", [
        "-v",
        "error",
        "-i",
        original,
        "-vn",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        path.join(temporary, "proxy.mp3"),
      ]);
      index.proxy = {
        path: ref("proxy.mp3"),
        hash: hashFile(path.join(temporary, "proxy.mp3")),
        startSec: 0,
        mapping: "same-origin-seconds",
      };
      if (options.ocr) index.ocr.warning = "Audio source has no video frames; no OCR evidence produced.";
    }
    if (options.tags.length)
      index.segments.push({
        id: "manual-tags",
        startSec: 0,
        endSec: duration,
        text: "",
        tags: options.tags,
        evidence: [{ kind: "manual-tag", source: asset.id }],
      });
    writeFileSync(path.join(temporary, "index.json"), JSON.stringify(SourceIndexSchema.parse(index), null, 2) + "\n");
    renameSync(temporary, directory);
    return { index, file, cacheHit: false, dryRun: false, cacheKey };
  } finally {
    closeSync(fd);
    unlinkSync(lock);
    if (existsSync(temporary)) rmSync(temporary, { recursive: true });
  }
}
