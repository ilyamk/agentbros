import { rejectedObservationFor, readRejectedObservation, type RejectedObserverOptions } from "./rejected-observation";
import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EXISTING_CORPUS, CORPUS_REFERENCES } from "./corpus-fixtures";
import {
  LocalWorkerConfigSchema,
  offlineEnvironment,
  localWorkerFileHash,
  probeLocalWorker,
  runLocalWorker,
  type LocalWorkerConfig,
} from "./local-worker";
import { inspectLocalAudioClock } from "./local-clock";
import { ingestLocalMedia } from "./local-analysis";
import { sourceWordProposal } from "./word-proposal";
import { readSourceIndex } from "./index";
import { AssetRegistrySchema } from "../../types/assets";
import { SourceIndexSchema } from "../../types/source-index";
import { assertPathWithin, requireProject } from "../cli";
import { stableHash } from "../longform/plans";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const MAX_MEDIA = 10 * 1024 * 1024,
  MAX_JSON = 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
function noLinks(file: string) {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error("Corpus paths cannot traverse symlinks");
    if (path.dirname(p) === p) break;
  }
}
/** Finite captured bytes and identity; FIFO rejects at fstat before any read. */
export function captureCorpusFile(file: string, maximum = MAX_JSON) {
  noLinks(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = fstatSync(fd),
      identity = (s: typeof initial) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
    if (!initial.isFile() || initial.size > maximum) throw new Error("Corpus requires bounded regular files");
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes < initial.size) {
      const buffer = Buffer.alloc(Math.min(65536, initial.size - bytes));
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) throw new Error("Corpus file shortened during read");
      bytes += n;
      chunks.push(buffer.subarray(0, n));
    }
    if (
      readSync(fd, Buffer.alloc(1), 0, 1, null) ||
      identity(fstatSync(fd)) !== identity(initial) ||
      identity(lstatSync(file)) !== identity(initial)
    )
      throw new Error("Corpus file changed during read");
    const data = Buffer.concat(chunks);
    return { bytes: data, sha256: sha(data) };
  } finally {
    closeSync(fd);
  }
}
function immutable(file: string, bytes: Buffer | string) {
  noLinks(file);
  if (existsSync(file)) {
    if (sha(bytes) !== captureCorpusFile(file, MAX_MEDIA).sha256)
      throw new Error("Immutable corpus artifact checksum changed");
    return;
  }
  writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
}
function directory(file: string) {
  noLinks(file);
  mkdirSync(file, { recursive: true });
  return realpathSync(file);
}
function resolvedTool(name: "ffmpeg" | "ffprobe") {
  const candidate = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((p) => path.join(p, name))
    .find((p) => existsSync(p));
  if (!candidate) throw new Error(`Installed ${name} unavailable; no installation attempted`);
  const file = realpathSync(candidate);
  const sha256 = localWorkerFileHash(file, 256 * 1024 * 1024);
  const version = tool(file, ["-version"]).toString();
  return { path: file, sha256, versionSha256: sha(version) };
}
function tool(executable: string, args: string[]) {
  const r = spawnSync(executable, args, {
    encoding: "buffer",
    timeout: 20000,
    killSignal: "SIGKILL",
    maxBuffer: MAX_JSON,
    env: offlineEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `Bounded local media probe/decode failed: ${String(r.error?.message ?? r.stderr?.toString()).slice(-1000)}`,
    );
  return r.stdout;
}
const ClockSchema = z
  .object({
    originSec: z.number().finite().nonnegative().max(1),
    decodedSamples: z
      .number()
      .int()
      .positive()
      .max(192000 * 20),
    sampleRate: z.number().int().min(8000).max(192000),
    channels: z.number().int().min(1).max(2),
    durationSec: z.number().finite().positive().max(20),
    decodedDurationSec: z.number().finite().positive().max(20),
  })
  .strict();
type Clock = z.infer<typeof ClockSchema>;
export function diagnosticAudioClock(file: string, ffprobe: string): Clock {
  captureCorpusFile(file, MAX_MEDIA);
  const probe = JSON.parse(
    tool(ffprobe, [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]).toString(),
  );
  const streams = probe.streams.filter((s: { codec_type: string }) => s.codec_type === "audio");
  if (streams.length !== 1) throw new Error("Corpus needs exactly one audio stream");
  const stream = streams[0],
    rate = Number(stream.sample_rate),
    channels = Number(stream.channels),
    match = /^(\d+)\/(\d+)$/.exec(stream.time_base ?? "");
  if (!match || !Number(match[1]) || !Number(match[2]) || Number(match[1]) > 1e9 || Number(match[2]) > 1e9)
    throw new Error("Invalid bounded audio time base");
  const rows = JSON.parse(
    tool(ffprobe, [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-select_streams",
      "a:0",
      "-show_frames",
      "-show_entries",
      "frame=best_effort_timestamp,nb_samples",
      "-of",
      "json",
      file,
    ]).toString(),
  ).frames;
  return decodedCorpusClock(rows, Number(match[1]), Number(match[2]), rate, channels, Number(probe.format.duration));
}
/** Integer sample equality; timestamp rounding/gap filling is unsupported. */
export function decodedCorpusClock(
  rows: unknown,
  num: number,
  den: number,
  rate: number,
  channels: number,
  durationSec: number,
): Clock {
  if (
    ![num, den, rate].every((n) => Number.isSafeInteger(n) && n > 0) ||
    num > 1e9 ||
    den > 1e9 ||
    rate < 8000 ||
    rate > 192000 ||
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 2000
  )
    throw new Error("Bounded decoded audio clock unavailable");
  const first = Number(rows[0].best_effort_timestamp);
  if (!Number.isSafeInteger(first)) throw new Error("Invalid decoded audio origin");
  let samples = 0;
  for (const row of rows) {
    const pts = Number(row.best_effort_timestamp),
      count = Number(row.nb_samples);
    if (
      !Number.isSafeInteger(pts) ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      count > 65536 ||
      (BigInt(pts) - BigInt(first)) * BigInt(num) * BigInt(rate) !== BigInt(samples) * BigInt(den)
    )
      throw new Error("Corpus decoded audio clock is discontinuous");
    samples += count;
    if (samples > 192000 * 20) throw new Error("Bounded decoded audio samples exceeded");
  }
  return ClockSchema.parse({
    originSec: (first * num) / den,
    decodedSamples: samples,
    sampleRate: rate,
    channels,
    durationSec,
    decodedDurationSec: samples / rate,
  });
}

const ToolSchema = z.object({ path: z.string(), sha256: hash, versionSha256: hash }).strict();
const EntrySchema = z
  .object({
    id: z.string(),
    language: z.enum(["en", "ru"]),
    original: z
      .object({
        file: z.string(),
        bytes: z.number().int().positive().max(MAX_MEDIA),
        sha256: hash,
        snapshot: z.string(),
        clock: ClockSchema,
      })
      .strict(),
    reference: z
      .object({
        file: z.string(),
        sha256: hash,
        snapshot: z.string(),
        text: z.string().min(1).max(20000),
        textSha256: hash,
        kind: z.literal("intended-generation-script"),
        independentlyVerified: z.literal(false),
      })
      .strict(),
    input: z
      .object({
        path: z.string(),
        sha256: hash,
        clock: ClockSchema,
        recipe: z.enum(["original-direct", "decoded-mono-pcm16k-v1"]),
        originalClockOffsetSec: z.number().finite().nonnegative(),
        automaticOriginalTimelineMapping: z.literal(false),
      })
      .strict(),
    directOriginal: z.object({ state: z.enum(["supported", "refused"]), reason: z.string().optional() }).strict(),
    provenance: z.literal("existing-ai-or-configured-tts; exact-provider-origin-unverified"),
    commercialAllowed: z.literal("unknown"),
    approved: z.literal(false),
  })
  .strict();
export const PreparedCorpusSchema = z
  .object({
    version: z.literal(1),
    key: hash,
    sourceRoot: z.string(),
    helperSha256: hash,
    fixturesSha256: hash,
    tools: z.object({ ffmpeg: ToolSchema, ffprobe: ToolSchema }).strict(),
    entries: z.array(EntrySchema).length(6),
    providerSpendUsd: z.literal(0),
    reviewRequired: z.literal(true),
    humanGroundTruth: z.literal(false),
  })
  .strict();
type PreparedCorpus = z.infer<typeof PreparedCorpusSchema>;
const moduleFile = fileURLToPath(import.meta.url),
  fixturesFile = fileURLToPath(new URL("./corpus-fixtures.ts", import.meta.url));
function referenceText(bytes: Buffer, reference: string, scene: string) {
  const doc = JSON.parse(bytes.toString());
  const text =
    reference === "presenter"
      ? doc.nativeAudioDirection?.fullScript
      : doc.scenes?.find((s: { id: string }) => s.id === scene)?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("Pinned intended script unavailable");
  return text;
}
function confined(root: string, ref: string) {
  const file = path.resolve(root, ref);
  if (path.isAbsolute(ref)) throw new Error("Corpus artifact refs must be relative");
  assertPathWithin(root, file);
  noLinks(file);
  return file;
}
export function preparePcmDerivative(original: string, output: string, ffmpeg: string, ffprobe: string) {
  const originalPin = captureCorpusFile(original, MAX_MEDIA),
    clock = diagnosticAudioClock(original, ffprobe);
  if (clock.sampleRate !== 44100 || clock.channels !== 1 || clock.originSec <= 0)
    throw new Error("Explicit derivative expects audited nonzero-origin mono44.1k input");
  if (existsSync(output)) throw new Error("Derivative destination already exists");
  tool(ffmpeg, [
    "-nostdin",
    "-v",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    original,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-fs",
    "1048576",
    output,
  ]);
  const prepared = diagnosticAudioClock(output, ffprobe),
    pin = captureCorpusFile(output, MAX_JSON);
  if (
    prepared.originSec !== 0 ||
    prepared.sampleRate !== 16000 ||
    prepared.channels !== 1 ||
    Math.abs(prepared.decodedDurationSec - clock.decodedDurationSec) > 2 / 16000 ||
    captureCorpusFile(original, MAX_MEDIA).sha256 !== originalPin.sha256
  )
    throw new Error("Explicit decoded derivative extent/source changed");
  inspectLocalAudioClock(output, prepared.durationSec);
  return { clock: prepared, sha256: pin.sha256, originalClockOffsetSec: clock.originSec };
}
export function prepareExistingCorpus(sourceRootInput: string, outputInput: string) {
  const sourceRoot = path.resolve(sourceRootInput);
  noLinks(sourceRoot);
  const inputs = EXISTING_CORPUS.map((sample) => {
    const source = captureCorpusFile(confined(sourceRoot, sample.file), MAX_MEDIA);
    if (source.sha256 !== sample.hash || source.bytes.length !== sample.bytes)
      throw new Error(`Audited original changed: ${sample.id}`);
    const ref = CORPUS_REFERENCES[sample.reference],
      reference = captureCorpusFile(confined(sourceRoot, ref.file));
    if (reference.sha256 !== ref.hash) throw new Error(`Audited intended-script source changed: ${sample.id}`);
    return { sample, source, ref, reference, text: referenceText(reference.bytes, sample.reference, sample.scene) };
  });
  const tools = { ffmpeg: resolvedTool("ffmpeg"), ffprobe: resolvedTool("ffprobe") },
    helperSha256 = localWorkerFileHash(moduleFile, MAX_JSON),
    fixturesSha256 = localWorkerFileHash(fixturesFile, MAX_JSON);
  const key = sha(
    JSON.stringify({
      version: 1,
      sourceRoot,
      originals: EXISTING_CORPUS,
      references: CORPUS_REFERENCES,
      tools,
      helperSha256,
      fixturesSha256,
    }),
  );
  const output = directory(outputInput),
    destination = path.join(output, key),
    manifestFile = path.join(destination, "manifest.json");
  if (existsSync(destination)) {
    const manifest = readPreparedCorpus(manifestFile);
    if (manifest.key !== key || manifest.sourceRoot !== sourceRoot)
      throw new Error("Prepared cache source/key binding changed");
    return { file: manifestFile, manifest, cacheHit: true };
  }
  const temporary = mkdtempSync(path.join(output, ".corpus-preparing-"));
  try {
    mkdirSync(path.join(temporary, "originals"));
    mkdirSync(path.join(temporary, "references"));
    mkdirSync(path.join(temporary, "derived"));
    const entries = inputs.map(({ sample, source, ref, reference, text }) => {
      const snapshot = `originals/${sample.hash}${path.extname(sample.file)}`,
        referenceSnapshot = `references/${ref.hash}.json`;
      const original = confined(temporary, snapshot);
      immutable(original, source.bytes);
      immutable(confined(temporary, referenceSnapshot), reference.bytes);
      const clock = diagnosticAudioClock(original, tools.ffprobe.path);
      let directOriginal: z.infer<typeof EntrySchema>["directOriginal"];
      try {
        inspectLocalAudioClock(original, clock.durationSec);
        directOriginal = { state: "supported" };
      } catch (error) {
        directOriginal = { state: "refused", reason: (error as Error).message };
      }
      let input: z.infer<typeof EntrySchema>["input"];
      if (sample.language === "en") {
        if (directOriginal.state !== "refused") throw new Error("Audited MP3 origin refusal unexpectedly changed");
        const refPath = `derived/${sample.id}.wav`,
          derivative = preparePcmDerivative(
            original,
            confined(temporary, refPath),
            tools.ffmpeg.path,
            tools.ffprobe.path,
          );
        input = {
          path: refPath,
          ...derivative,
          recipe: "decoded-mono-pcm16k-v1",
          automaticOriginalTimelineMapping: false,
        };
      } else {
        if (directOriginal.state !== "supported") throw new Error("Audited original presenter clock unsupported");
        input = {
          path: snapshot,
          sha256: source.sha256,
          clock,
          recipe: "original-direct",
          originalClockOffsetSec: 0,
          automaticOriginalTimelineMapping: false,
        };
      }
      return {
        id: sample.id,
        language: sample.language,
        original: { file: sample.file, bytes: source.bytes.length, sha256: source.sha256, snapshot, clock },
        reference: {
          file: ref.file,
          sha256: ref.hash,
          snapshot: referenceSnapshot,
          text,
          textSha256: sha(text),
          kind: "intended-generation-script" as const,
          independentlyVerified: false as const,
        },
        input,
        directOriginal,
        provenance: "existing-ai-or-configured-tts; exact-provider-origin-unverified" as const,
        commercialAllowed: "unknown" as const,
        approved: false as const,
      };
    });
    for (const { sample } of inputs)
      if (captureCorpusFile(confined(sourceRoot, sample.file), MAX_MEDIA).sha256 !== sample.hash)
        throw new Error("Original changed during corpus preparation");
    const manifest = PreparedCorpusSchema.parse({
      version: 1,
      key,
      sourceRoot,
      helperSha256,
      fixturesSha256,
      tools,
      entries,
      providerSpendUsd: 0,
      reviewRequired: true,
      humanGroundTruth: false,
    });
    const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
    immutable(path.join(temporary, "manifest.json"), manifestBytes);
    immutable(path.join(temporary, "manifest.sha256"), sha(manifestBytes) + "\n");
    renameSync(temporary, destination);
    readPreparedCorpus(manifestFile);
    return { file: manifestFile, manifest, cacheHit: false };
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
}
/** Receipt hashes are integrity pins for caller-owned evidence, not authentication of writable caches. */
export function readPreparedCorpus(file: string, expectedSha256?: string): PreparedCorpus {
  const captured = captureCorpusFile(file),
    root = path.dirname(path.resolve(file));
  const marker = captureCorpusFile(path.join(root, "manifest.sha256"), 65).bytes.toString().trim();
  if (
    !/^[a-f0-9]{64}$/.test(marker) ||
    marker !== captured.sha256 ||
    (expectedSha256 !== undefined && expectedSha256 !== marker)
  )
    throw new Error("Prepared corpus manifest checksum changed");
  const manifest = PreparedCorpusSchema.parse(JSON.parse(captured.bytes.toString()));
  if (
    manifest.helperSha256 !== localWorkerFileHash(moduleFile, MAX_JSON) ||
    manifest.fixturesSha256 !== localWorkerFileHash(fixturesFile, MAX_JSON)
  )
    throw new Error("Prepared corpus implementation pin changed");
  const key = sha(
    JSON.stringify({
      version: 1,
      sourceRoot: manifest.sourceRoot,
      originals: EXISTING_CORPUS,
      references: CORPUS_REFERENCES,
      tools: manifest.tools,
      helperSha256: manifest.helperSha256,
      fixturesSha256: manifest.fixturesSha256,
    }),
  );
  if (manifest.key !== key) throw new Error("Prepared corpus identity changed");
  // Receipt values are data, never execution authority. Resolve both fixed trusted tools first.
  const trustedTools = { ffmpeg: resolvedTool("ffmpeg"), ffprobe: resolvedTool("ffprobe") };
  if (JSON.stringify(manifest.tools) !== JSON.stringify(trustedTools))
    throw new Error("Prepared corpus trusted tool pin changed");
  for (let i = 0; i < EXISTING_CORPUS.length; i++) {
    const expected = EXISTING_CORPUS[i]!,
      entry = manifest.entries[i]!,
      reference = CORPUS_REFERENCES[expected.reference];
    if (
      entry.id !== expected.id ||
      entry.language !== expected.language ||
      entry.original.file !== expected.file ||
      entry.original.sha256 !== expected.hash ||
      entry.original.bytes !== expected.bytes ||
      entry.reference.file !== reference.file ||
      entry.reference.sha256 !== reference.hash
    )
      throw new Error("Fixed corpus source/reference binding changed");
    if (
      captureCorpusFile(confined(manifest.sourceRoot, expected.file), MAX_MEDIA).sha256 !== expected.hash ||
      captureCorpusFile(confined(manifest.sourceRoot, reference.file)).sha256 !== reference.hash
    )
      throw new Error("Original/intended-script source changed");
    const original = confined(root, entry.original.snapshot),
      ref = captureCorpusFile(confined(root, entry.reference.snapshot));
    if (
      captureCorpusFile(original, MAX_MEDIA).sha256 !== expected.hash ||
      ref.sha256 !== reference.hash ||
      referenceText(ref.bytes, expected.reference, expected.scene) !== entry.reference.text ||
      sha(entry.reference.text) !== entry.reference.textSha256
    )
      throw new Error("Corpus snapshot or intended text changed");
    const clock = diagnosticAudioClock(original, trustedTools.ffprobe.path),
      input = confined(root, entry.input.path),
      inputClock = diagnosticAudioClock(input, trustedTools.ffprobe.path);
    if (
      JSON.stringify(clock) !== JSON.stringify(entry.original.clock) ||
      JSON.stringify(inputClock) !== JSON.stringify(entry.input.clock) ||
      captureCorpusFile(input, MAX_MEDIA).sha256 !== entry.input.sha256 ||
      entry.input.originalClockOffsetSec !== clock.originSec
    )
      throw new Error("Corpus input clock/bytes/origin lineage changed");
    let supported = true;
    try {
      inspectLocalAudioClock(original, clock.durationSec);
    } catch {
      supported = false;
    }
    if (supported !== (entry.directOriginal.state === "supported"))
      throw new Error("Original clock refusal metadata changed");
    if (expected.language === "en") {
      if (
        supported ||
        entry.input.recipe !== "decoded-mono-pcm16k-v1" ||
        inputClock.originSec !== 0 ||
        inputClock.channels !== 1 ||
        inputClock.sampleRate !== 16000 ||
        Math.abs(inputClock.decodedDurationSec - clock.decodedDurationSec) > 2 / 16000
      )
        throw new Error("Explicit MP3 derivative lineage unsupported");
    } else if (
      !supported ||
      entry.input.recipe !== "original-direct" ||
      entry.input.path !== entry.original.snapshot ||
      entry.input.sha256 !== expected.hash
    )
      throw new Error("Direct original presenter lineage changed");
    inspectLocalAudioClock(input, inputClock.durationSec);
  }
  return manifest;
}
/** Lexical distance to an intended generation script, never a verified transcription error rate. */
export function intendedScriptAgreement(reference: string, hypothesis: string) {
  const tokens = (s: string) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const a = tokens(reference),
    b = tokens(hypothesis);
  if (!a.length || a.length > 500 || b.length > 1000 || a.length * b.length > 500000)
    throw new Error("Bounded intended-script tokens required");
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + Number(a[i - 1] !== b[j - 1]));
    row = next;
  }
  return {
    referenceKind: "intended-generation-script" as const,
    independentlyVerified: false as const,
    groundTruth: false as const,
    referenceTokens: a.length,
    hypothesisTokens: b.length,
    tokenEdits: row[b.length]!,
    intendedScriptEditRate: row[b.length]! / a.length,
    normalizedExactAgreement: JSON.stringify(a) === JSON.stringify(b),
    timingAccuracy: "not-measured" as const,
  };
}
export function observedNetworkDenial() {
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      "const n=require('node:net').createServer();n.once('error',e=>process.exit(e.code==='EPERM'||e.code==='EACCES'?0:3));n.listen(0,'127.0.0.1',()=>n.close(()=>process.exit(2)));",
    ],
    { timeout: 3000, maxBuffer: 4096, env: offlineEnvironment() },
  );
  return r.status === 0;
}
function diagnosticRegistry(projectId: string) {
  const file = path.resolve("public/projects", projectId, "pipeline/asset-registry.json");
  if (!existsSync(file)) return AssetRegistrySchema.parse({ schemaVersion: 1, revision: 0, assets: [] });
  const registry = AssetRegistrySchema.parse(JSON.parse(captureCorpusFile(file, 16 * 1024 * 1024).bytes.toString()));
  if (registry.assets.some((a) => a.status !== "candidate" || a.rights.commercialAllowed !== "unknown"))
    throw new Error("Use an isolated diagnostic project; assets must remain unapproved with unknown rights");
  return registry;
}
function priorDiagnosticIndex(projectId: string, sourceHash: string, identityHash: string, options: unknown) {
  const directory = path.resolve("public/projects", projectId, "pipeline/source-index");
  noLinks(directory);
  if (!existsSync(directory)) return undefined;
  const keys = readdirSync(directory);
  if (keys.length > 64 || keys.some((k) => !/^[a-f0-9]{64}$/.test(k)))
    throw new Error("Use a bounded isolated diagnostic project index directory");
  for (const key of keys) {
    const file = path.join(directory, key, "index.json");
    const preview = SourceIndexSchema.parse(JSON.parse(captureCorpusFile(file, 16 * 1024 * 1024).bytes.toString()));
    const canonical = readSourceIndex(projectId, file, { boundedEvidence: true });
    if (
      preview.sourceHash === sourceHash &&
      canonical.localAnalysis?.identityHash === identityHash &&
      JSON.stringify(canonical.options.protectedSpans) === JSON.stringify(options)
    )
      return { index: canonical, file };
  }
  return undefined;
}
export async function runCorpusDiagnostics(request: {
  manifestFile: string;
  manifestSha256: string;
  config: LocalWorkerConfig;
  projectId: string;
  retainRejectedObservation?: boolean;
}) {
  requireProject(request.projectId);
  captureCorpusFile(path.resolve("public/projects", request.projectId, "project.json"));
  diagnosticRegistry(request.projectId);
  const manifest = readPreparedCorpus(request.manifestFile, request.manifestSha256),
    manifestRoot = path.dirname(path.resolve(request.manifestFile));
  const config = LocalWorkerConfigSchema.parse(request.config);
  if (config.engine !== "whisper.cpp" || config.wordTimingMethod !== "native-word-segments-v1")
    throw new Error("Corpus diagnostics requires explicit offline whisper native word configuration");
  const denied = observedNetworkDenial();
  const rows: Record<string, unknown>[] = [];
  for (const entry of manifest.entries) {
    if (!denied) {
      rows.push({
        id: entry.id,
        state: "unavailable",
        reason: "OS network denial not observed; no inference attempted",
        originalSha256: entry.original.sha256,
      });
      continue;
    }
    const sourceFile = confined(manifestRoot, entry.input.path),
      sampleConfig = { ...config, language: entry.language };
    const rejectedObserver: RejectedObserverOptions | undefined = request.retainRejectedObservation
      ? {
          method: "quarantined-worker-output-v1",
          binding: {
            manifestFile: path.resolve(request.manifestFile),
            manifestSha256: request.manifestSha256,
            corpusKey: manifest.key,
            entryId: entry.id,
            originalSha256: entry.original.sha256,
            inputSha256: entry.input.sha256,
          },
        }
      : undefined;
    const diagnosticObservation = (error: unknown) => {
      const descriptor = rejectedObservationFor(error);
      if (!descriptor || descriptor.state !== "quarantined" || !rejectedObserver) return descriptor;
      const observation = readRejectedObservation(
        request.projectId,
        descriptor.file,
        descriptor.sha256,
        rejectedObserver.binding,
      );
      let metrics: unknown;
      try {
        metrics = intendedScriptAgreement(entry.reference.text, observation.lexicalHypothesis);
      } catch (metricError) {
        metrics = { state: "unavailable", reason: (metricError as Error).message };
      }
      return {
        ...descriptor,
        accepted: false,
        approved: false,
        timingUse: "forbidden",
        rawKind: observation.receipt.rawKind,
        lexicalHypothesis: observation.lexicalHypothesis,
        metrics,
        intendedScript: entry.reference,
      };
    };
    const capability = probeLocalWorker(sampleConfig);
    if (!capability.available) {
      rows.push({
        id: entry.id,
        state: "unavailable",
        reason: capability.reason,
        originalSha256: entry.original.sha256,
      });
      continue;
    }
    try {
      diagnosticRegistry(request.projectId);
      const protectedSpans = [
        {
          startSec: 0,
          endSec: entry.input.clock.durationSec,
          reason: "Entire intended-script diagnostic source protected; no automatic editing",
        },
      ];
      let effectiveConfig = sampleConfig,
        effectiveCapability = capability;
      let nativeWordAttempt: unknown = { state: "requested", identityHash: capability.identityHash };
      const acquire = async (workerConfig: LocalWorkerConfig, identityHash: string) => {
        let prior;
        try {
          prior = priorDiagnosticIndex(request.projectId, entry.input.sha256, identityHash, protectedSpans);
        } catch (error) {
          throw new Error(`Corpus cached index validation failed: ${(error as Error).message}`);
        }
        return prior
          ? {
              file: prior.file,
              workerEvidence: path.resolve(
                "public/projects",
                request.projectId,
                "pipeline/local-analysis",
                prior.index.localAnalysis!.cacheKey + ".json",
              ),
              workerCacheHit: true,
            }
          : await ingestLocalMedia({
              projectId: request.projectId,
              sourceFile,
              config: workerConfig,
              options: { protectedSpans },
              rejectedObserver,
            });
      };
      const workerClock = inspectLocalAudioClock(sourceFile, entry.input.clock.durationSec);
      const workerDuration =
        entry.input.clock.durationSec > workerClock.durationSec + 0.001
          ? workerClock.durationSec
          : entry.input.clock.durationSec;
      const nativeKey = stableHash({
        version: 1,
        identity: capability.identityHash,
        payload: {
          operation: "asr",
          sourceFile: path.resolve(sourceFile),
          sourceHash: entry.input.sha256,
          durationSec: workerDuration,
        },
      });
      const nativeCacheFile = path.resolve(
        "public/projects",
        request.projectId,
        "pipeline/local-analysis",
        nativeKey + ".json",
      );
      const nativeCacheExisted = existsSync(nativeCacheFile);
      let fresh;
      try {
        fresh = await acquire(sampleConfig, capability.identityHash);
      } catch (error) {
        // Diagnostic-only lexical retry; every other failure stays refused. No word/time repair.
        if (
          (error as Error).message !== "Native word rows overlap, reverse or exceed original clock" ||
          nativeCacheExisted ||
          existsSync(nativeCacheFile)
        )
          throw error;
        nativeWordAttempt = {
          state: "refused",
          reason: (error as Error).message,
          ...(request.retainRejectedObservation ? { rejectedObservation: diagnosticObservation(error) } : {}),
          identity: capability.identity,
          identityHash: capability.identityHash,
          estimated: true,
          approved: false,
        };
        const { wordTimingMethod: _unused, ...paragraphConfig } = sampleConfig;
        effectiveConfig = paragraphConfig;
        const paragraphCapability = probeLocalWorker(paragraphConfig);
        if (!paragraphCapability.available)
          throw new Error(`Native words refused; paragraph capability unavailable: ${paragraphCapability.reason}`);
        effectiveCapability = paragraphCapability;
        try {
          fresh = await acquire(paragraphConfig, effectiveCapability.identityHash);
        } catch (paragraphError) {
          rows.push({
            id: entry.id,
            language: entry.language,
            state: "refused",
            originalSha256: entry.original.sha256,
            inputSha256: entry.input.sha256,
            nativeWordAttempt,
            paragraphAttempt: {
              state: "refused",
              reason: (paragraphError as Error).message,
              ...(request.retainRejectedObservation
                ? { rejectedObservation: diagnosticObservation(paragraphError) }
                : {}),
              identity: effectiveCapability.identity,
              identityHash: effectiveCapability.identityHash,
            },
            approved: false,
          });
          continue;
        }
      }
      const index = readSourceIndex(request.projectId, fresh.file, { boundedEvidence: true });
      const replay = await runLocalWorker(
        effectiveConfig,
        { operation: "asr", sourceFile, sourceHash: entry.input.sha256, durationSec: entry.input.clock.durationSec },
        request.projectId,
      );
      if (!replay.cacheHit || replay.key !== index.localAnalysis!.cacheKey)
        throw new Error("Corpus worker cache replay changed");
      const transcriptFile = path.resolve("public", index.transcript!.path),
        raw = JSON.parse(captureCorpusFile(transcriptFile, 16 * 1024 * 1024).bytes.toString());
      if (JSON.stringify(raw) !== JSON.stringify(replay.output))
        throw new Error("Canonical corpus transcript differs from replayed worker");
      const hypothesis = raw.segments.map((s: { text: string }) => s.text).join(" ");
      const asset = diagnosticRegistry(request.projectId).assets.find((a) => a.hash === index.sourceHash);
      if (!asset || asset.status !== "candidate" || asset.rights.commercialAllowed !== "unknown")
        throw new Error("Corpus diagnostic original must remain candidate with unknown rights");
      let words: unknown;
      try {
        words = { state: "available", proposal: sourceWordProposal(request.projectId, fresh.file) };
      } catch (error) {
        words = { state: "unavailable", estimated: true, approved: false, reason: (error as Error).message };
      }
      rows.push({
        id: entry.id,
        language: entry.language,
        state: "hypothesis",
        originalSha256: entry.original.sha256,
        inputSha256: entry.input.sha256,
        inputClock: entry.input.clock,
        nativeWordAttempt,
        lexicalFallback: !effectiveConfig.wordTimingMethod,
        workerIdentity: effectiveCapability.identity,
        workerIdentityHash: effectiveCapability.identityHash,
        workerEvidence: fresh.workerEvidence,
        workerEvidenceSha256: captureCorpusFile(fresh.workerEvidence, 16 * 1024 * 1024).sha256,
        sourceIndex: fresh.file,
        sourceIndexSha256: captureCorpusFile(fresh.file, 16 * 1024 * 1024).sha256,
        transcriptFile,
        transcriptSha256: index.transcript!.hash,
        sourceCacheKey: index.cacheKey,
        cacheReplay: true,
        initialCacheHit: fresh.workerCacheHit,
        fullHypothesis: raw,
        intendedScript: entry.reference,
        metrics: intendedScriptAgreement(entry.reference.text, hypothesis),
        words,
        assetStatus: asset.status,
        commercialAllowed: asset.rights.commercialAllowed,
        approved: false,
      });
    } catch (error) {
      rows.push({
        id: entry.id,
        language: entry.language,
        state: "refused",
        originalSha256: entry.original.sha256,
        inputSha256: entry.input.sha256,
        workerIdentity: capability.identity,
        workerIdentityHash: capability.identityHash,
        reason: (error as Error).message,
        ...(request.retainRejectedObservation ? { rejectedObservation: diagnosticObservation(error) } : {}),
        approved: false,
      });
    }
  }
  // Reread the full receipt chain before immutable publication; failures do not overwrite old reports.
  readPreparedCorpus(request.manifestFile, request.manifestSha256);
  const report = {
    version: 1,
    kind: "existing-ai-voice-corpus-diagnostics",
    sourceManifest: path.resolve(request.manifestFile),
    sourceManifestSha256: request.manifestSha256,
    corpusKey: manifest.key,
    helperSha256: manifest.helperSha256,
    observedOsNetworkDenial: denied,
    ...(request.retainRejectedObservation ? { rejectedObservationMode: "quarantined-worker-output-v1" } : {}),
    entries: rows,
    providerSpendUsd: 0,
    humanGroundTruth: false,
    reviewRequired: true,
    approved: false,
    limitations: [
      "intended-script-agreement-not-human-WER",
      "estimated-words-not-verified-alignment",
      "EN-derived-zero-clock-not-automatic-original-timeline",
      "historical-provider-origin-unverified",
      "no-human-natural-recording-acceptance",
    ],
  };
  const bytes = JSON.stringify(report, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > MAX_MEDIA)
    throw new Error("Corpus diagnostic report exceeds bounded publication limit");
  const directoryPath = directory(path.resolve("public/projects", request.projectId, "pipeline/corpus-diagnostics"));
  const file = path.join(directoryPath, `${manifest.key}-${sha(bytes)}.json`);
  immutable(file, bytes);
  return { file, sha256: sha(bytes), report };
}
