import { spawn } from "node:child_process";
import path from "node:path";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  lstatSync,
  linkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OcrRuntimeSchema, OcrReceiptSchema, OcrFramePinSchema, OcrObservationSchema } from "../../types/ocr";
import { SourceIndexSchema } from "../../types/source-index";
import { readSourceIndex } from "./index";
import {
  sourceIndexCacheKey,
  ocrReceiptKey,
  ocrLocalPath,
  ocrRegularFile,
  readOcrJson,
  ocrSegments,
  verifyOcrEvidence,
} from "./ocr-evidence";
import { hashFile } from "../assets/registry";
import { stableHash } from "../longform/plans";
import { requireProject, CliErrorObject } from "../cli";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Trusted configuration is intentionally absent from MCP/UI. Production never compiles. */
export const LocalOcrConfigSchema = z
  .object({
    engine: z.literal("apple-vision"),
    executable: z.string().min(1),
    executableHash: hash,
    workerSource: z.string().min(1),
    workerSourceHash: hash,
    revision: z.literal(3),
    languages: z
      .array(z.string().regex(/^[a-z]{2,3}-(?:[A-Z]{2}|Hans|Hant)$/))
      .min(1)
      .max(4),
    maxFrames: z.number().int().min(1).max(32).default(8),
    timeoutMs: z.number().int().min(100).max(120000).default(120000),
  })
  .strict()
  .refine((v) => new Set(v.languages).size === v.languages.length, "OCR languages must be unique");
export type LocalOcrConfig = z.input<typeof LocalOcrConfigSchema>;
const fail = (message: string, code: "VALIDATION" | "TIMEOUT" = "VALIDATION") => new CliErrorObject({ code, message });
const policy = "(version 1)(allow default)(deny network*)";
function runtimeFiles(config: z.output<typeof LocalOcrConfigSchema>) {
  for (const [file, expected, maximum] of [
    [config.executable, config.executableHash, 256 * 1024 * 1024],
    [config.workerSource, config.workerSourceHash, 1024 * 1024],
  ] as const) {
    if (!path.isAbsolute(file) || !existsSync(file)) throw fail("Prepared offline OCR runtime unavailable");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || hashFile(file) !== expected)
      throw fail("OCR runtime/source checksum or regular-file mismatch");
    // Ancestor aliases are forbidden too, even when they currently point to local bytes.
    let current = path.dirname(file);
    while (true) {
      if (lstatSync(current).isSymbolicLink()) throw fail("OCR runtime symlink forbidden");
      const parent = path.dirname(current);
      if (current === parent) break;
      current = parent;
    }
  }
}
async function execute(config: z.output<typeof LocalOcrConfigSchema>, payload: unknown, timeoutMs = config.timeoutMs) {
  const stdin = JSON.stringify(payload) + "\n";
  if (Buffer.byteLength(stdin) > 65536) throw fail("OCR request exceeds 64 KiB");
  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", policy, config.executable], {
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    });
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      settled = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        kill();
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(fail("Offline OCR timeout; no automatic retry", "TIMEOUT")), timeoutMs);
    child.on("error", (e) => finish(fail("Offline OCR unavailable: " + e.message)));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 256 * 1024) return finish(fail("OCR stdout exceeds 256 KiB"));
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > 65536) return finish(fail("OCR stderr exceeds 64 KiB"));
      stderr = Buffer.concat([stderr, chunk]);
    });
    child.on("close", (code) => {
      if (settled) return;
      try {
        if (code !== 0) throw fail("Offline OCR failed: " + stderr.toString().slice(-1000));
        const lines = stdout.toString().trim().split("\n");
        if (lines.length !== 1) throw fail("OCR worker must emit exactly one JSON line");
        finish(undefined, JSON.parse(lines[0]!));
      } catch (e) {
        finish(e instanceof Error ? e : fail(String(e)));
      }
    });
    child.stdin.end(stdin);
  });
}
const recognitionResponse = (key: string) =>
  z
    .object({
      version: z.literal(1),
      key: z.literal(key),
      runtime: OcrRuntimeSchema,
      frames: z
        .array(
          z
            .object({
              hash,
              width: z.number().int().positive().max(4096),
              height: z.number().int().positive().max(4096),
              observations: z.array(OcrObservationSchema).max(100),
            })
            .strict(),
        )
        .min(1)
        .max(32),
    })
    .strict();
export async function probeLocalOcr(input: LocalOcrConfig) {
  const config = LocalOcrConfigSchema.parse(input);
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    return { available: false as const, reason: "Apple Vision offline OCR unavailable on this host" };
  if (![config.executable, config.workerSource].every((v) => path.isAbsolute(v) && existsSync(v)))
    return {
      available: false as const,
      reason: "Prepared offline OCR runtime unavailable; explicit preparation required",
    };
  runtimeFiles(config);
  const raw = await execute(config, { version: 1, operation: "probe" }, Math.min(config.timeoutMs, 10000));
  const runtime = OcrRuntimeSchema.parse(raw);
  if (config.languages.some((language) => !runtime.supportedLanguages.includes(language)))
    throw fail("Unsupported OCR recognition language for this installed revision");
  const identity = {
    runtime,
    executableHash: config.executableHash,
    workerSourceHash: config.workerSourceHash,
    languages: config.languages,
    recognitionLevel: "accurate" as const,
    languageCorrection: false as const,
    automaticLanguageDetection: false as const,
    cpuOnly: true as const,
  };
  return { available: true as const, offline: true as const, identity, identityHash: stableHash(identity) };
}
/** Vision reports boxes slightly outside the image for text at the frame edge. Receipts keep refusing these; this receipt-free route clips them. */
function clampObservationBoxes(raw: unknown) {
  type Row = { box?: { x: number; y: number; width: number; height: number } };
  const reply = raw as { frames?: { observations?: Row[] }[] };
  for (const frame of Array.isArray(reply?.frames) ? reply.frames : []) {
    if (!Array.isArray(frame?.observations)) continue;
    frame.observations = frame.observations.flatMap((row) => {
      const box = row?.box;
      if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) return [row];
      const x = Math.max(0, box.x),
        y = Math.max(0, box.y),
        width = Math.min(1, box.x + box.width) - x,
        height = Math.min(1, box.y + box.height) - y;
      return width > 0 && height > 0 ? [{ ...row, box: { x, y, width, height } }] : [];
    });
  }
  return raw;
}
/** Project-free frame batch under the same runtime pins, deny-network execution and response validation. Stateless: the caller owns any cache. */
export async function recogniseLocalOcrFrames(
  input: LocalOcrConfig,
  identityHash: string,
  runtime: z.infer<typeof OcrRuntimeSchema>,
  frames: { file: string; hash: string }[],
) {
  const config = LocalOcrConfigSchema.parse(input);
  if (!frames.length || frames.length > config.maxFrames) throw fail("OCR batch needs 1..maxFrames frames");
  runtimeFiles(config);
  const key = stableHash({ version: 1, identityHash, frames: frames.map((frame) => frame.hash) });
  const raw = await execute(config, {
    version: 1,
    operation: "recognize",
    key,
    revision: config.revision,
    languages: config.languages,
    frames: frames.map(({ file, hash: frameHash }) => ({ file, hash: frameHash })),
  });
  const response = recognitionResponse(key).parse(clampObservationBoxes(raw));
  if (
    stableHash(response.runtime) !== stableHash(runtime) ||
    response.frames.length !== frames.length ||
    response.frames.some((row, i) => row.hash !== frames[i]!.hash || row.width * row.height > 4000000)
  )
    throw fail("OCR response runtime/frame identity mismatch");
  runtimeFiles(config);
  return response.frames;
}
export async function ingestLocalOcr(request: { projectId: string; indexFile: string; config: LocalOcrConfig }) {
  requireProject(request.projectId);
  const project = path.resolve("public/projects", request.projectId),
    publicRoot = path.resolve("public");
  const inputFile = ocrLocalPath(project, path.resolve(request.indexFile));
  const readBase = () => {
    const raw = SourceIndexSchema.parse(readOcrJson(inputFile, 16 * 1024 * 1024).value);
    for (const row of [
      { path: raw.source.path },
      ...(raw.proxy ? [raw.proxy] : []),
      ...raw.thumbnails,
      ...(raw.transcript ? [raw.transcript] : []),
    ])
      ocrRegularFile(ocrLocalPath(project, path.resolve(publicRoot, row.path)));
    return readSourceIndex(request.projectId, inputFile);
  };
  const base = readBase();
  if (
    base.source.kind !== "video" ||
    base.categoryAnalysis ||
    base.ocrAnalysis ||
    base.visualAnalysis ||
    !base.thumbnails.length ||
    base.thumbnails.length > LocalOcrConfigSchema.parse(request.config).maxFrames
  )
    throw fail("OCR needs an original video index with 1..maxFrames sampled frames (no prior OCR pin)");
  if (base.segments.some((s) => s.evidence.some((e) => e.kind === "ocr")))
    throw fail("Legacy unpinned OCR cannot be mixed with pinned OCR; build a non-OCR base index");
  const baseIndex = {
    path: path.relative(publicRoot, inputFile).split(path.sep).join("/"),
    hash: hashFile(inputFile),
    cacheKey: base.cacheKey,
  };
  const frames = base.thumbnails.map((frame) => OcrFramePinSchema.parse(frame));
  if (
    frames.some(
      (frame) =>
        base.source.timestamps[frame.sourceFrame.num] !== frame.timeSec ||
        base.source.timestamps[frame.sourceFrame.num + 1] === undefined,
    )
  )
    throw fail("OCR sampled frame needs an exact next decoded timestamp; terminal frame extent is unverified");
  const config = LocalOcrConfigSchema.parse(request.config),
    capability = await probeLocalOcr(config);
  if (!capability.available) throw fail(capability.reason);
  const key = ocrReceiptKey(capability.identityHash, base.sourceHash, baseIndex, frames),
    directory = ocrLocalPath(project, path.join(project, "pipeline/local-ocr"));
  mkdirSync(directory, { recursive: true });
  const receiptFile = ocrLocalPath(project, path.join(directory, key + ".json"));
  const publicFile = (ref: string) => ocrLocalPath(project, path.resolve(publicRoot, ref));
  const makeIndex = () => {
    const raw = readOcrJson(receiptFile),
      receipt = OcrReceiptSchema.parse(raw.value);
    const checksumFile = ocrLocalPath(project, receiptFile + ".sha256.json");
    const checksum = z.object({ sha256: hash }).strict().parse(readOcrJson(checksumFile, 1024).value);
    if (raw.hash !== checksum.sha256) throw fail("OCR raw receipt checksum changed");
    const index = SourceIndexSchema.parse({
      ...base,
      createdAt: new Date().toISOString(),
      ocr: { available: true, executed: true, version: "Apple Vision revision 3" },
      ocrAnalysis: {
        engine: "apple-vision",
        revision: 3,
        identityHash: capability.identityHash,
        cacheKey: key,
        receipt: { path: path.relative(publicRoot, receiptFile).split(path.sep).join("/"), hash: raw.hash },
        baseCacheKey: base.cacheKey,
        occurrence: "sampled-decoded-frame-v1",
        reviewRequired: true,
      },
      segments: [...base.segments, ...ocrSegments(base, receipt, raw.hash)],
    });
    index.cacheKey = sourceIndexCacheKey(index);
    verifyOcrEvidence(index, publicFile);
    return index;
  };
  const workerCacheHit = existsSync(receiptFile);
  if (!workerCacheHit) {
    const lock = receiptFile + ".lock";
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch {
      throw fail("Offline OCR cache locked; inspect owner before retry", "TIMEOUT");
    }
    try {
      if (!existsSync(receiptFile)) {
        const raw = await execute(config, {
          version: 1,
          operation: "recognize",
          key,
          revision: config.revision,
          languages: config.languages,
          frames: frames.map((frame) => ({ file: publicFile(frame.path), hash: frame.hash })),
        });
        const response = recognitionResponse(key).parse(raw);
        if (
          stableHash(response.runtime) !== stableHash(capability.identity.runtime) ||
          response.frames.length !== frames.length ||
          response.frames.some((row, i) => row.hash !== frames[i]!.hash || row.width * row.height > 4000000)
        )
          throw fail("OCR response runtime/frame identity mismatch");
        // Revalidate all originals and prepared runtime after the one bounded batch.
        readBase();
        if (hashFile(inputFile) !== baseIndex.hash) throw fail("OCR base index changed during recognition");
        runtimeFiles(config);
        const output = response.frames.map((frame, i) => ({
          ...frames[i]!,
          width: frame.width,
          height: frame.height,
          observations: frame.observations,
        }));
        const receipt = OcrReceiptSchema.parse({
          version: 1,
          key,
          identityHash: capability.identityHash,
          identity: capability.identity,
          sourceHash: base.sourceHash,
          baseIndex,
          frames: output,
          outputHash: stableHash(output),
        });
        const bytes = JSON.stringify(receipt) + "\n";
        if (Buffer.byteLength(bytes) > 256 * 1024) throw fail("OCR receipt exceeds 256 KiB");
        const temporary = receiptFile + "." + randomUUID() + ".tmp";
        try {
          writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
          renameSync(temporary, receiptFile);
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary);
        }
        writeFileSync(
          ocrLocalPath(project, receiptFile + ".sha256.json"),
          JSON.stringify({ sha256: hashFile(receiptFile) }) + "\n",
          { flag: "wx", mode: 0o600 },
        );
      }
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  const index = makeIndex(),
    indexDirectory = ocrLocalPath(project, path.join(project, "pipeline/source-index", index.cacheKey));
  mkdirSync(indexDirectory, { recursive: true });
  const file = path.join(indexDirectory, "index.json");
  const cacheHit = existsSync(file);
  if (!cacheHit) {
    const temporary = ocrLocalPath(project, file + "." + randomUUID() + ".tmp");
    try {
      writeFileSync(temporary, JSON.stringify(index, null, 2) + "\n", { flag: "wx" });
      try {
        linkSync(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  const verified = readSourceIndex(request.projectId, file);
  return {
    index: verified,
    file,
    receiptFile,
    cacheKey: index.cacheKey,
    cacheHit,
    workerCacheHit,
    identity: capability.identity,
    observationOnly: true,
    reviewRequired: true,
  };
}
