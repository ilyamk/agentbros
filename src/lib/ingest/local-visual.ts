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
import {
  VisualRuntimeSchema,
  VisualReceiptSchema,
  VisualQueryPinSchema,
  VisualFrameResultSchema,
} from "../../types/visual-search";
import { OcrFramePinSchema } from "../../types/ocr";
import { SourceIndexSchema } from "../../types/source-index";
import { readSourceIndex } from "./index";
import { sourceIndexCacheKey, ocrLocalPath, ocrRegularFile, readOcrJson } from "./ocr-evidence";
import { visualReceiptKey, visualSegments, verifyVisualEvidence, searchVisualFrames } from "./visual-evidence";
import { hashFile, readAssetRegistry } from "../assets/registry";
import { stableHash } from "../longform/plans";
import { requireProject, CliErrorObject } from "../cli";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Trusted configuration is intentionally absent from MCP/UI. Production never compiles. */
export const LocalVisualConfigSchema = z
  .object({
    engine: z.literal("apple-vision-feature-print"),
    executable: z.string().min(1),
    executableHash: hash,
    workerSource: z.string().min(1),
    workerSourceHash: hash,
    revision: z.literal(2),
    maxFrames: z.number().int().min(1).max(32).default(8),
    timeoutMs: z.number().int().min(100).max(120000).default(120000),
  })
  .strict();
export type LocalVisualConfig = z.input<typeof LocalVisualConfigSchema>;
const fail = (message: string, code: "VALIDATION" | "TIMEOUT" = "VALIDATION") => new CliErrorObject({ code, message });
const policy = "(version 1)(allow default)(deny network*)";
function runtimeFiles(config: z.output<typeof LocalVisualConfigSchema>) {
  for (const [file, expected, maximum] of [
    [config.executable, config.executableHash, 256 * 1024 * 1024],
    [config.workerSource, config.workerSourceHash, 1024 * 1024],
  ] as const) {
    if (!path.isAbsolute(file) || !existsSync(file)) throw fail("Prepared offline Visual runtime unavailable");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || hashFile(file) !== expected)
      throw fail("Visual runtime/source checksum or regular-file mismatch");
    // Ancestor aliases are forbidden too, even when they currently point to local bytes.
    let current = path.dirname(file);
    while (true) {
      if (lstatSync(current).isSymbolicLink()) throw fail("Visual runtime symlink forbidden");
      const parent = path.dirname(current);
      if (current === parent) break;
      current = parent;
    }
  }
}
async function execute(
  config: z.output<typeof LocalVisualConfigSchema>,
  payload: unknown,
  timeoutMs = config.timeoutMs,
) {
  const stdin = JSON.stringify(payload) + "\n";
  if (Buffer.byteLength(stdin) > 65536) throw fail("Visual request exceeds 64 KiB");
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
    const timer = setTimeout(() => finish(fail("Offline Visual timeout; no automatic retry", "TIMEOUT")), timeoutMs);
    child.on("error", (e) => finish(fail("Offline Visual unavailable: " + e.message)));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 256 * 1024) return finish(fail("Visual stdout exceeds 256 KiB"));
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > 65536) return finish(fail("Visual stderr exceeds 64 KiB"));
      stderr = Buffer.concat([stderr, chunk]);
    });
    child.on("close", (code) => {
      if (settled) return;
      try {
        if (code !== 0) throw fail("Offline Visual failed: " + stderr.toString().slice(-1000));
        const lines = stdout.toString().trim().split("\n");
        if (lines.length !== 1) throw fail("Visual worker must emit exactly one JSON line");
        finish(undefined, JSON.parse(lines[0]!));
      } catch (e) {
        finish(e instanceof Error ? e : fail(String(e)));
      }
    });
    child.stdin.end(stdin);
  });
}
export async function probeLocalVisual(input: LocalVisualConfig) {
  const config = LocalVisualConfigSchema.parse(input);
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    return { available: false as const, reason: "Apple Vision offline Visual unavailable on this host" };
  if (![config.executable, config.workerSource].every((v) => path.isAbsolute(v) && existsSync(v)))
    return {
      available: false as const,
      reason: "Prepared offline Visual runtime unavailable; explicit preparation required",
    };
  runtimeFiles(config);
  const raw = await execute(config, { version: 1, operation: "probe" }, Math.min(config.timeoutMs, 10000));
  const runtime = VisualRuntimeSchema.parse(raw);
  const identity = { runtime, executableHash: config.executableHash, workerSourceHash: config.workerSourceHash };
  return { available: true as const, offline: true as const, identity, identityHash: stableHash(identity) };
}
export async function ingestLocalVisual(request: {
  projectId: string;
  indexFile: string;
  queryAssetId: string;
  config: LocalVisualConfig;
}) {
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
    base.visualAnalysis ||
    !base.thumbnails.length ||
    base.thumbnails.length > LocalVisualConfigSchema.parse(request.config).maxFrames
  )
    throw fail("Visual needs an original video index with 1..maxFrames sampled frames (no prior Visual pin)");

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
    throw fail("Visual sampled frame needs an exact next decoded timestamp; terminal frame extent is unverified");
  const config = LocalVisualConfigSchema.parse(request.config),
    capability = await probeLocalVisual(config);
  if (!capability.available) throw fail(capability.reason);
  const registry = readAssetRegistry(request.projectId),
    asset = registry.assets.find((a) => a.id === request.queryAssetId);
  if (!asset || asset.kind !== "image") throw fail("Query must be a registered immutable image");
  const query = VisualQueryPinSchema.parse({
    assetId: asset.id,
    path: asset.files.original,
    hash: asset.hash,
    assetMetadataHash: stableHash(asset),
  });
  ocrRegularFile(ocrLocalPath(project, path.resolve(publicRoot, query.path)), 16 * 1024 * 1024);
  if (hashFile(path.resolve(publicRoot, query.path)) !== query.hash) throw fail("Visual query original changed");
  const key = visualReceiptKey(capability.identityHash, base.sourceHash, baseIndex, query, frames),
    directory = ocrLocalPath(project, path.join(project, "pipeline/local-visual"));
  mkdirSync(directory, { recursive: true });
  const receiptFile = ocrLocalPath(project, path.join(directory, key + ".json"));
  const publicFile = (ref: string) => ocrLocalPath(project, path.resolve(publicRoot, ref));
  const makeIndex = () => {
    const raw = readOcrJson(receiptFile),
      receipt = VisualReceiptSchema.parse(raw.value);
    const checksumFile = ocrLocalPath(project, receiptFile + ".sha256.json");
    const checksum = z.object({ sha256: hash }).strict().parse(readOcrJson(checksumFile, 1024).value);
    if (raw.hash !== checksum.sha256) throw fail("Visual raw receipt checksum changed");
    const index = SourceIndexSchema.parse({
      ...base,
      createdAt: new Date().toISOString(),
      visualAnalysis: {
        engine: "apple-vision-feature-print",
        revision: 2,
        identityHash: capability.identityHash,
        cacheKey: key,
        receipt: { path: path.relative(publicRoot, receiptFile).split(path.sep).join("/"), hash: raw.hash },
        baseCacheKey: base.cacheKey,
        occurrence: "sampled-decoded-frame-v1",
        reviewRequired: true,
      },
      segments: [...base.segments, ...visualSegments(base, receipt, raw.hash)],
    });
    index.cacheKey = sourceIndexCacheKey(index);
    verifyVisualEvidence(index, publicFile, readAssetRegistry(request.projectId));
    return index;
  };
  const workerCacheHit = existsSync(receiptFile);
  if (!workerCacheHit) {
    const lock = receiptFile + ".lock";
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch {
      throw fail("Offline Visual cache locked; inspect owner before retry", "TIMEOUT");
    }
    try {
      if (!existsSync(receiptFile)) {
        const raw = await execute(config, {
          version: 1,
          operation: "compare",
          key,
          revision: config.revision,
          query: { file: publicFile(query.path), hash: query.hash },
          frames: frames.map((frame) => ({ file: publicFile(frame.path), hash: frame.hash })),
        });
        const response = z
          .object({
            version: z.literal(1),
            key: z.literal(key),
            runtime: VisualRuntimeSchema,
            queryFeatureHash: hash,
            frames: z
              .array(
                z
                  .object({
                    hash,
                    width: VisualFrameResultSchema.shape.width,
                    height: VisualFrameResultSchema.shape.height,
                    featureHash: hash,
                    distance: VisualFrameResultSchema.shape.distance,
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
          throw fail("Visual response runtime/frame identity mismatch");
        // Revalidate all originals and prepared runtime after the one bounded batch.
        readBase();
        if (hashFile(inputFile) !== baseIndex.hash) throw fail("Visual base index changed during recognition");
        runtimeFiles(config);
        if (
          hashFile(publicFile(query.path)) !== query.hash ||
          stableHash(readAssetRegistry(request.projectId).assets.find((a) => a.id === query.assetId)) !==
            query.assetMetadataHash
        )
          throw fail("Visual query changed during comparison");
        const output = response.frames.map((frame, i) => ({
          ...frames[i]!,
          width: frame.width,
          height: frame.height,
          featureHash: frame.featureHash,
          distance: frame.distance,
        }));
        const receipt = VisualReceiptSchema.parse({
          version: 1,
          key,
          identityHash: capability.identityHash,
          identity: capability.identity,
          sourceHash: base.sourceHash,
          baseIndex,
          query,
          queryFeatureHash: response.queryFeatureHash,
          frames: output,
          outputHash: stableHash({ queryFeatureHash: response.queryFeatureHash, frames: output }),
        });
        const bytes = JSON.stringify(receipt) + "\n";
        if (Buffer.byteLength(bytes) > 256 * 1024) throw fail("Visual receipt exceeds 256 KiB");
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
    hits: searchVisualFrames(verified, publicFile, readAssetRegistry(request.projectId), 100),
    observationOnly: true,
    reviewRequired: true,
  };
}
