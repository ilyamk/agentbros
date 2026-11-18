import { spawn, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  rejectedObservationCodePins,
  validateRejectedObserverOptions,
  eligibleRejectedClock,
  retainRejectedObservation,
  noteRejectedObservationUnavailable,
  type RejectedObserverOptions,
} from "./rejected-observation";
import {
  existsSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  realpathSync,
  openSync,
  closeSync,
  unlinkSync,
  constants,
  fstatSync,
  readSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { inspectLocalAudioClock } from "./local-clock";
import { NATIVE_WORD_METHOD, NativeWordEvidenceSchema, validateNativeWordOutput } from "../../types/native-word-timing";
import { CliErrorObject, requireProject, assertPathWithin } from "../cli";
import { stableHash } from "../longform/plans";
export const LocalWorkerConfigSchema = z
  .object({
    executable: z.string().min(1),
    workerFile: z.string().min(1),
    modelPath: z.string().min(1),
    model: z.string().min(1),
    revision: z.string().min(1),
    engine: z.enum(["whisper.cpp", "sentence-transformers"]),
    engineExecutable: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(100).max(600000).default(120000),
    language: z
      .string()
      .regex(/^[a-z]{2,3}$|^auto$/)
      .default("auto"),
    dimensions: z.number().int().min(1).max(16384).optional(),
    wordTimingMethod: z.literal(NATIVE_WORD_METHOD).optional(),
    threads: z.number().int().min(1).max(8).default(2),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.engine === "whisper.cpp" && !v.engineExecutable)
      ctx.addIssue({
        code: "custom",
        message: "whisper.cpp needs engineExecutable",
      });
    if (v.wordTimingMethod && v.engine !== "whisper.cpp")
      ctx.addIssue({ code: "custom", message: "Native word timing requires whisper.cpp" });
    if (v.engine === "sentence-transformers" && !v.dimensions)
      ctx.addIssue({
        code: "custom",
        message: "Embedding dimensions required",
      });
  });
export type LocalWorkerConfig = z.input<typeof LocalWorkerConfigSchema>;
const Fail = (message: string, code: "VALIDATION" | "TIMEOUT" = "VALIDATION") =>
  new CliErrorObject({
    code,
    message,
  });
const MAX_BYTES = 16 * 1024 * 1024;
export function offlineEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    SYSTEMROOT: process.env.SYSTEMROOT,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    TOKENIZERS_PARALLELISM: "false",
    OMP_NUM_THREADS: "2",
    OPENBLAS_NUM_THREADS: "2",
    MKL_NUM_THREADS: "2",
  };
}
/** Hash all regular model files; reject symlinks instead of following outside model roots. */
export function localModelHash(file: string): string {
  const rows: {
    file: string;
    hash: string;
  }[] = [];
  let total = 0;
  function visit(full: string, relative: string, depth: number) {
    const stat = lstatSync(full);
    if (stat.isSymbolicLink() || depth > 20) throw Fail("Local model contains symlinks or excessive nesting");
    if (stat.isDirectory()) {
      if (readdirSync(full).length > 10000) throw Fail("Local model directory exceeds file count limit");
      for (const name of readdirSync(full).sort()) visit(path.join(full, name), path.join(relative, name), depth + 1);
      return;
    }
    if (!stat.isFile() || stat.size > 20 * 1024 ** 3) throw Fail("Model must contain bounded regular files");
    total += stat.size;
    if (total > 20 * 1024 ** 3 || rows.length >= 10000) throw Fail("Local model exceeds 20 GiB/10000 files");
    rows.push({
      file: relative,
      hash: localWorkerFileHash(full, 20 * 1024 ** 3),
    });
  }
  visit(path.resolve(file), "", 0);
  if (!rows.length) throw Fail("Local model is empty");
  return stableHash(rows);
}
export function readBoundedLocalText(file: string, maximum = MAX_BYTES) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw Fail("Local JSON requires bounded regular file");
    const chunks: Buffer[] = [];
    let count = 0;
    const buffer = Buffer.alloc(Math.min(maximum + 1, 65536));
    while (count <= maximum) {
      const size = readSync(fd, buffer, 0, Math.min(buffer.length, maximum + 1 - count), null);
      if (!size) break;
      count += size;
      if (count > maximum) throw Fail("Local JSON exceeds byte limit");
      chunks.push(Buffer.from(buffer.subarray(0, size)));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
/** Read exactly captured bytes plus one growth probe; preserve content-only historical hashes. */
export function localWorkerFileHash(file: string, maximum = 32 * 1024 ** 3): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = fstatSync(fd);
    if (!initial.isFile() || initial.size > maximum) throw Fail("Hash requires bounded regular local file");
    const identity = (s: ReturnType<typeof fstatSync>) => JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let bytes = 0;
    while (bytes < initial.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, initial.size - bytes), null);
      if (!count) throw Fail("Local hash source changed");
      bytes += count;
      hash.update(buffer.subarray(0, count));
    }
    if (
      readSync(fd, buffer, 0, 1, null) !== 0 ||
      identity(fstatSync(fd)) !== identity(initial) ||
      identity(lstatSync(file)) !== identity(initial)
    )
      throw Fail("Local hash source changed");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
export function regular(file: string, maximum: number) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
    throw Fail("Worker inputs require bounded regular files");
  return realpathSync(file);
}
export function probeLocalWorker(input: LocalWorkerConfig) {
  const config = LocalWorkerConfigSchema.parse(input);
  const unavailable = [
    config.executable,
    config.workerFile,
    config.modelPath,
    ...(config.engineExecutable ? [config.engineExecutable] : []),
  ].find((file) => !path.isAbsolute(file) || !existsSync(file));
  if (unavailable)
    return {
      available: false as const,
      offline: true as const,
      reason: `Installed engine/model unavailable: ${unavailable}`,
      engine: config.engine,
    };
  regular(config.executable, 256 * 1024 * 1024);
  regular(config.workerFile, 1024 * 1024);
  if (config.engineExecutable) regular(config.engineExecutable, 256 * 1024 * 1024);
  const probe = spawnSync(config.executable, [config.workerFile, "--probe"], {
    input:
      JSON.stringify({
        config,
      }) + "\n",
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 65536,
    env: offlineEnvironment(),
  });
  if (probe.error || probe.status !== 0)
    return {
      available: false as const,
      offline: true as const,
      filesReady: true,
      reason: "Installed engine runtime unavailable: " + String(probe.stderr || probe.error?.message).slice(-1000),
      engine: config.engine,
    };
  if (probe.stdout.trim().split("\n").length !== 1) throw Fail("Runtime probe must emit one JSON line");
  const runtime = z
    .object({
      available: z.literal(true),
      engine: z.literal(config.engine),
      versions: z.record(z.string(), z.string().min(1)),
    })
    .strict()
    .parse(JSON.parse(probe.stdout));
  const identity = {
    runtime,
    engine: config.engine,
    model: config.model,
    revision: config.revision,
    modelHash: localModelHash(config.modelPath),
    executableHash: localWorkerFileHash(config.executable, 256 * 1024 * 1024),
    workerHash: localWorkerFileHash(config.workerFile, 1024 * 1024),
    ...(config.engineExecutable
      ? {
          engineHash: localWorkerFileHash(config.engineExecutable, 256 * 1024 * 1024),
        }
      : {}),
    language: config.language,
    threads: config.threads,
    ...(config.wordTimingMethod ? { wordTimingMethod: config.wordTimingMethod } : {}),
    ...(config.dimensions
      ? {
          dimensions: config.dimensions,
        }
      : {}),
  };
  return {
    available: true as const,
    offline: true as const,
    engine: config.engine,
    identity,
    identityHash: stableHash(identity),
  };
}
const AsrSchema = z
  .object({
    wordTimings: NativeWordEvidenceSchema.optional(),
    segments: z
      .array(
        z
          .object({
            text: z.string().min(1).max(10000),
            startSec: z.number().finite().nonnegative(),
            endSec: z.number().finite().positive(),
          })
          .strict()
          .refine((v) => v.endSec > v.startSec),
      )
      .min(1)
      .max(20000),
  })
  .strict();
const EmbedSchema = z
  .object({
    vectors: z.array(z.array(z.number().finite()).min(1).max(16384)).min(1).max(1000),
  })
  .strict();
export const WorkerPayloadSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("asr"),
      sourceFile: z.string(),
      sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
      durationSec: z.number().finite().positive().max(7200),
    })
    .strict(),
  z
    .object({
      operation: z.literal("embed"),
      texts: z.array(z.string().min(1).max(20000)).min(1).max(1000),
      sourcePins: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000),
    })
    .strict(),
]);
export type WorkerPayload = z.infer<typeof WorkerPayloadSchema>;
function validateOutput(payload: WorkerPayload, raw: unknown, dimensions?: number, method?: typeof NATIVE_WORD_METHOD) {
  if (payload.operation === "asr") {
    const output = AsrSchema.parse(raw);
    if (method) {
      if (!output.wordTimings) throw Fail("Requested native word timing unavailable");
      validateNativeWordOutput(output.wordTimings, payload.durationSec, output.segments);
    } else if (output.wordTimings) throw Fail("Unrequested native word timing output");
    let previous = 0;
    for (const s of output.segments) {
      if (s.startSec < previous || s.endSec > payload.durationSec + 0.001)
        throw Fail("ASR spans overlap or exceed original source clock");
      previous = s.endSec;
    }
    return output;
  }
  const output = EmbedSchema.parse(raw);
  if (
    output.vectors.length !== payload.texts.length ||
    output.vectors.some((v) => v.length !== dimensions || !Number.isFinite(Math.hypot(...v)) || Math.hypot(...v) === 0)
  )
    throw Fail("Embedding count/dimensions/norm mismatch");
  return output;
}
/** Literal argv, bounded protocol, no provider fallback. Caller explicitly supplies installed local worker. */
export async function runLocalWorker(
  configInput: LocalWorkerConfig,
  payloadInput: WorkerPayload,
  scope: string | { cacheDirectory: string },
  observer?: RejectedObserverOptions,
) {
  const projectId = typeof scope === "string" ? scope : undefined;
  if (projectId) requireProject(projectId);
  else if (observer) throw Fail("Rejected observation retention requires a project");
  const config = LocalWorkerConfigSchema.parse(configInput),
    payload = WorkerPayloadSchema.parse(payloadInput),
    capability = probeLocalWorker(config);
  if (!capability.available) throw Fail(capability.reason);
  if (payload.operation === "asr") {
    regular(payload.sourceFile, 32 * 1024 ** 3);
    if (localWorkerFileHash(payload.sourceFile) !== payload.sourceHash) throw Fail("Local ASR original changed");
    const clock = inspectLocalAudioClock(payload.sourceFile, payload.durationSec);
    if (payload.durationSec > clock.durationSec + 0.001) payload.durationSec = clock.durationSec;
  }
  if ((payload.operation === "asr") !== (config.engine === "whisper.cpp"))
    throw Fail("Worker operation does not match configured engine");
  const observationOptions = observer ? validateRejectedObserverOptions(observer, payload) : undefined;
  const observationPins = observationOptions ? rejectedObservationCodePins(fileURLToPath(import.meta.url)) : undefined;
  const key = stableHash({
      version: 1,
      identity: capability.identityHash,
      payload,
    }),
    directory = projectId
      ? path.resolve("public/projects", projectId, "pipeline/local-analysis")
      : path.resolve((scope as { cacheDirectory: string }).cacheDirectory);
  if (projectId) assertPathWithin(path.resolve("public/projects", projectId), directory);
  mkdirSync(directory, {
    recursive: true,
  });
  const file = path.join(directory, `${key}.json`);
  const parse = (raw: unknown) => {
    const row = z
      .object({
        version: z.literal(1),
        key: z.literal(key),
        identityHash: z.literal(capability.identityHash),
        output: z.unknown(),
        outputHash: z.string(),
      })
      .strict()
      .parse(raw);
    if (stableHash(row.output) !== row.outputHash) throw Fail("Local worker cache checksum changed");
    return validateOutput(payload, row.output, config.dimensions, config.wordTimingMethod);
  };
  if (existsSync(file)) {
    regular(file, MAX_BYTES);
    return {
      output: parse(JSON.parse(readBoundedLocalText(file))),
      cacheHit: true,
      file,
      key,
      capability,
    };
  }
  const request = {
    version: 1,
    key,
    offline: true,
    config,
    payload,
  };
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw Fail("Worker request exceeds 16 MiB");
  const lock = file + ".lock";
  let lockFd: number;
  try {
    lockFd = openSync(lock, "wx", 0o600);
  } catch {
    throw Fail("Local analysis locked; inspect stale lock before retry", "TIMEOUT");
  }
  try {
    if (existsSync(file))
      return {
        output: parse(JSON.parse(readBoundedLocalText(file))),
        cacheHit: true,
        file,
        key,
        capability,
      };
    let rejected: { stdout: Buffer; error: Error } | undefined;
    let output: unknown;
    try {
      output = await new Promise<unknown>((resolve, reject) => {
        const child = spawn(config.executable, [config.workerFile], {
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env: offlineEnvironment(),
        });
        let stdout = Buffer.alloc(0),
          stderr = Buffer.alloc(0),
          settled = false;
        const kill = () => {
          try {
            if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
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
        const timer = setTimeout(
          () => finish(Fail("Local worker timeout; no automatic inference retry", "TIMEOUT")),
          config.timeoutMs,
        );
        child.on("error", (e) => finish(Fail(`Local worker unavailable: ${e.message}`)));
        child.stdin.on("error", () => {});
        child.stdout.on("data", (chunk: Buffer) => {
          if (stdout.length + chunk.length > MAX_BYTES) return finish(Fail("Worker stdout exceeds 16 MiB"));
          stdout = Buffer.concat([stdout, chunk]);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length + chunk.length > MAX_BYTES) return finish(Fail("Worker stderr exceeds 16 MiB"));
          stderr = Buffer.concat([stderr, chunk]);
        });
        child.on("close", (code) => {
          if (settled) return;
          try {
            if (code !== 0) throw Fail(`Local worker unavailable/failed: ${stderr.toString().slice(-1000)}`);
            const lines = stdout.toString().trim().split("\n");
            if (lines.length !== 1) throw Fail("Worker must emit one JSON line");
            const reply = z
              .object({
                version: z.literal(1),
                key: z.literal(key),
                offline: z.literal(true),
                output: z.unknown(),
              })
              .strict()
              .parse(JSON.parse(lines[0]!));
            try {
              finish(undefined, validateOutput(payload, reply.output, config.dimensions, config.wordTimingMethod));
            } catch (error) {
              if (
                observationOptions &&
                payload.operation === "asr" &&
                error instanceof Error &&
                eligibleRejectedClock(error.message) &&
                AsrSchema.safeParse(reply.output).success
              )
                rejected = { stdout: Buffer.from(stdout), error };
              throw error;
            }
          } catch (e) {
            finish(e instanceof Error ? e : Fail(String(e)));
          }
        });
        child.stdin.end(serialized + "\n");
      });
    } catch (error) {
      if (rejected && observationOptions) {
        try {
          if (payload.operation !== "asr" || localWorkerFileHash(payload.sourceFile) !== payload.sourceHash)
            throw Fail("Original changed during rejected ASR");
          const after = probeLocalWorker(config);
          if (!after.available || after.identityHash !== capability.identityHash)
            throw Fail("Model/engine changed during rejected inference");
          retainRejectedObservation({
            projectId: projectId!,
            options: observationOptions,
            payload,
            workerKey: key,
            identityHash: capability.identityHash,
            identity: capability.identity,
            serializedRequest: serialized,
            stdout: rejected.stdout,
            error: rejected.error,
            runnerFile: fileURLToPath(import.meta.url),
            codePins: observationPins!,
          });
        } catch (retentionError) {
          noteRejectedObservationUnavailable(
            rejected.error,
            retentionError instanceof Error ? retentionError.message : String(retentionError),
          );
        }
      }
      throw error;
    }
    if (payload.operation === "asr" && localWorkerFileHash(payload.sourceFile) !== payload.sourceHash)
      throw Fail("Original changed during ASR");
    const after = probeLocalWorker(config);
    if (!after.available || after.identityHash !== capability.identityHash)
      throw Fail("Model/engine changed during inference");
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temp,
        JSON.stringify({
          version: 1,
          key,
          identityHash: capability.identityHash,
          output,
          outputHash: stableHash(output),
        }) + "\n",
        {
          flag: "wx",
        },
      );
      renameSync(temp, file);
    } finally {
      if (existsSync(temp)) rmSync(temp);
    }
    return {
      output: parse(JSON.parse(readBoundedLocalText(file))),
      cacheHit: false,
      file,
      key,
      capability,
    };
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}
