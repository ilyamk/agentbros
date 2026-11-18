import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, openSync, closeSync, lstatSync, linkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CategoryRuntimeSchema,
  CategoryFrameResultSchema,
  CategoryScoreSchema,
  CategoryQuerySchema,
} from "../../types/category-search";
import { OcrFramePinSchema } from "../../types/ocr";
import { SourceIndexSchema } from "../../types/source-index";
import { readSourceIndex } from "./index";
import { sourceIndexCacheKey, ocrLocalPath, ocrRegularFile } from "./ocr-evidence";
import {
  categoryReceiptKey,
  categorySegments,
  verifyCategoryEvidence,
  searchCategoryFrames,
  validateCategoryRuntime,
  validateCategoryReceipt,
  CATEGORY_RECEIPT_LIMIT,
} from "./category-evidence";
import { boundedEvidenceHash, boundedEvidenceJson } from "./bounded-evidence";
import { stableHash } from "../longform/plans";
import { requireProject, CliErrorObject } from "../cli";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Trusted configuration is intentionally absent from MCP/UI. Production never compiles. */
export const LocalCategoryConfigSchema = z
  .object({
    engine: z.literal("apple-vision-classification"),
    executable: z.string().min(1),
    executableHash: hash,
    workerSource: z.string().min(1),
    workerSourceHash: hash,
    revision: z.literal(2),
    maxFrames: z.number().int().min(1).max(32).default(8),
    timeoutMs: z.number().int().min(100).max(120000).default(120000),
  })
  .strict();
export type LocalCategoryConfig = z.input<typeof LocalCategoryConfigSchema>;
const fail = (message: string, code: "VALIDATION" | "TIMEOUT" = "VALIDATION") => new CliErrorObject({ code, message });
const policy = "(version 1)(allow default)(deny network*)";
function runtimeFiles(config: z.output<typeof LocalCategoryConfigSchema>) {
  for (const [file, expected, maximum] of [
    [config.executable, config.executableHash, 256 * 1024 * 1024],
    [config.workerSource, config.workerSourceHash, 1024 * 1024],
  ] as const) {
    if (!path.isAbsolute(file) || !existsSync(file)) throw fail("Prepared offline Category runtime unavailable");
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > maximum ||
      boundedEvidenceHash(file, maximum) !== expected
    )
      throw fail("Category runtime/source checksum or regular-file mismatch");
    // Ancestor aliases are forbidden too, even when they currently point to local bytes.
    let current = path.dirname(file);
    while (true) {
      if (lstatSync(current).isSymbolicLink()) throw fail("Category runtime symlink forbidden");
      const parent = path.dirname(current);
      if (current === parent) break;
      current = parent;
    }
  }
}
export async function executeCategoryWorker(
  config: z.output<typeof LocalCategoryConfigSchema>,
  payload: unknown,
  timeoutMs = config.timeoutMs,
) {
  config = LocalCategoryConfigSchema.parse(config);
  runtimeFiles(config);
  const stdin = JSON.stringify(payload) + "\n";
  if (Buffer.byteLength(stdin) > 65536) throw fail("Category request exceeds 64 KiB");
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
      kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(fail("Offline Category timeout; no automatic retry", "TIMEOUT")), timeoutMs);
    child.on("error", (e) => finish(fail("Offline Category unavailable: " + e.message)));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > CATEGORY_RECEIPT_LIMIT) return finish(fail("Category stdout exceeds 8 MiB"));
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > 65536) return finish(fail("Category stderr exceeds 64 KiB"));
      stderr = Buffer.concat([stderr, chunk]);
    });
    child.on("close", (code) => {
      if (settled) return;
      try {
        if (code !== 0) throw fail("Offline Category failed: " + stderr.toString().slice(-1000));
        const lines = stdout.toString().trim().split("\n");
        if (lines.length !== 1) throw fail("Category worker must emit exactly one JSON line");
        finish(undefined, JSON.parse(lines[0]!));
      } catch (e) {
        finish(e instanceof Error ? e : fail(String(e)));
      }
    });
    child.stdin.end(stdin);
  });
}
export async function probeLocalCategory(input: LocalCategoryConfig) {
  const config = LocalCategoryConfigSchema.parse(input);
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    return { available: false as const, reason: "Apple Vision offline Category unavailable on this host" };
  if (![config.executable, config.workerSource].every((v) => path.isAbsolute(v) && existsSync(v)))
    return {
      available: false as const,
      reason: "Prepared offline Category runtime unavailable; explicit preparation required",
    };
  runtimeFiles(config);
  const raw = await executeCategoryWorker(
    config,
    { version: 1, operation: "probe" },
    Math.min(config.timeoutMs, 10000),
  );
  const runtime = validateCategoryRuntime(raw);
  runtimeFiles(config);
  const identity = { runtime, executableHash: config.executableHash, workerSourceHash: config.workerSourceHash };
  return { available: true as const, offline: true as const, identity, identityHash: stableHash(identity) };
}
export async function ingestLocalCategory(request: {
  projectId: string;
  indexFile: string;
  query: unknown;
  config: LocalCategoryConfig;
}) {
  requireProject(request.projectId);
  const project = path.resolve("public/projects", request.projectId),
    publicRoot = path.resolve("public");
  const inputFile = ocrLocalPath(project, path.resolve(request.indexFile));
  const readBase = () => {
    const raw = SourceIndexSchema.parse(boundedEvidenceJson(inputFile, 16 * 1024 * 1024).value);
    for (const row of [
      { path: raw.source.path },
      ...(raw.proxy ? [raw.proxy] : []),
      ...raw.thumbnails,
      ...(raw.transcript ? [raw.transcript] : []),
    ])
      ocrRegularFile(ocrLocalPath(project, path.resolve(publicRoot, row.path)));
    return readSourceIndex(request.projectId, inputFile, { boundedEvidence: true });
  };
  const base = readBase();
  if (
    base.source.kind !== "video" ||
    base.categoryAnalysis ||
    !base.thumbnails.length ||
    base.thumbnails.length > LocalCategoryConfigSchema.parse(request.config).maxFrames
  )
    throw fail("Category needs an original video index with 1..maxFrames sampled frames (no prior Category pin)");

  const baseIndex = {
    path: path.relative(publicRoot, inputFile).split(path.sep).join("/"),
    hash: boundedEvidenceHash(inputFile, 16 * 1024 * 1024),
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
    throw fail("Category sampled frame needs an exact next decoded timestamp; terminal frame extent is unverified");
  const config = LocalCategoryConfigSchema.parse(request.config),
    capability = await probeLocalCategory(config);
  if (!capability.available) throw fail(capability.reason);
  const query = CategoryQuerySchema.parse(request.query);
  if (
    query.taxonomyHash !== capability.identity.runtime.taxonomy.hash ||
    !capability.identity.runtime.taxonomy.identifiers.includes(query.identifier)
  )
    throw fail("Exact supported category ID/taxonomy hash required");
  const key = categoryReceiptKey(capability.identityHash, base.sourceHash, baseIndex, frames),
    directory = ocrLocalPath(project, path.join(project, "pipeline/local-category"));
  mkdirSync(directory, { recursive: true });
  const receiptFile = ocrLocalPath(project, path.join(directory, key + ".json"));
  const publicFile = (ref: string) => ocrLocalPath(project, path.resolve(publicRoot, ref));
  const makeIndex = () => {
    const raw = boundedEvidenceJson(receiptFile, CATEGORY_RECEIPT_LIMIT),
      receipt = validateCategoryReceipt(raw.value);
    const checksumFile = ocrLocalPath(project, receiptFile + ".sha256.json");
    const checksum = z.object({ sha256: hash }).strict().parse(boundedEvidenceJson(checksumFile, 1024).value);
    if (raw.hash !== checksum.sha256) throw fail("Category raw receipt checksum changed");
    const index = SourceIndexSchema.parse({
      ...base,
      createdAt: new Date().toISOString(),
      categoryAnalysis: {
        engine: "apple-vision-classification",
        revision: 2,
        identityHash: capability.identityHash,
        cacheKey: key,
        receipt: { path: path.relative(publicRoot, receiptFile).split(path.sep).join("/"), hash: raw.hash },
        baseCacheKey: base.cacheKey,
        occurrence: "sampled-decoded-frame-v1",
        reviewRequired: true,
      },
      segments: [...base.segments, ...categorySegments(base, receipt, raw.hash)],
    });
    index.cacheKey = sourceIndexCacheKey(index);
    verifyCategoryEvidence(index, publicFile);
    return index;
  };
  const workerCacheHit = existsSync(receiptFile);
  if (!workerCacheHit) {
    const lock = receiptFile + ".lock";
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch {
      throw fail("Offline Category cache locked; inspect owner before retry", "TIMEOUT");
    }
    try {
      if (!existsSync(receiptFile)) {
        const raw = await executeCategoryWorker(config, {
          version: 1,
          operation: "classify",
          key,
          revision: config.revision,
          frames: frames.map((frame) => ({ file: publicFile(frame.path), hash: frame.hash })),
        });
        const response = z
          .object({
            version: z.literal(1),
            key: z.literal(key),
            runtime: CategoryRuntimeSchema,
            frames: z
              .array(
                z
                  .object({
                    hash,
                    width: CategoryFrameResultSchema.shape.width,
                    height: CategoryFrameResultSchema.shape.height,
                    observations: z.array(CategoryScoreSchema).min(1).max(2048),
                  })
                  .strict(),
              )
              .min(1)
              .max(32),
          })
          .strict()
          .parse(raw);
        if (
          stableHash(response.runtime) !== stableHash(capability.identity.runtime) ||
          response.frames.length !== frames.length ||
          response.frames.some((row, i) => row.hash !== frames[i]!.hash || row.width * row.height > 4000000)
        )
          throw fail("Category response runtime/frame identity mismatch");
        // Revalidate all originals and prepared runtime after the one bounded batch.
        readBase();
        if (boundedEvidenceHash(inputFile, 16 * 1024 * 1024) !== baseIndex.hash)
          throw fail("Category base index changed during recognition");
        runtimeFiles(config);
        const output = response.frames.map((frame, i) => ({
          ...frames[i]!,
          width: frame.width,
          height: frame.height,
          observations: frame.observations,
        }));
        const receipt = validateCategoryReceipt({
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
        if (Buffer.byteLength(bytes) > CATEGORY_RECEIPT_LIMIT) throw fail("Category receipt exceeds 8 MiB");
        const temporary = receiptFile + "." + randomUUID() + ".tmp";
        try {
          writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
          linkSync(temporary, receiptFile);
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary);
        }
        writeFileSync(
          ocrLocalPath(project, receiptFile + ".sha256.json"),
          JSON.stringify({ sha256: boundedEvidenceHash(receiptFile, CATEGORY_RECEIPT_LIMIT) }) + "\n",
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
  const verified = readSourceIndex(request.projectId, file, { boundedEvidence: true });
  return {
    index: verified,
    file,
    receiptFile,
    cacheKey: index.cacheKey,
    cacheHit,
    workerCacheHit,
    identity: capability.identity,
    hits: searchCategoryFrames(verified, publicFile, query, 100),
    observationOnly: true,
    reviewRequired: true,
  };
}
