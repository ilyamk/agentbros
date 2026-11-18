import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hashFile } from "../assets/registry";
import { CliErrorObject } from "../cli";

/**
 * The Apple Vision matte worker (scripts/workers/frame-matte.swift). Production runs only the executable that
 * `pnpm media:prepare --engines matte` compiled, after checking its hash, inside a no-network sandbox.
 */
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const LocalMatteConfigSchema = z
  .object({
    engine: z.literal("apple-vision-matte"),
    executable: z.string().min(1),
    executableHash: hash,
    workerSource: z.string().min(1),
    workerSourceHash: hash,
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(600_000),
  })
  .strict();
export type LocalMatteConfig = z.input<typeof LocalMatteConfigSchema>;

export const VisionRuntimeSchema = z
  .object({
    engine: z.literal("apple-vision-matte"),
    osVersion: z.string(),
    osMajor: z.number().int(),
    subject: z.string().nullable(),
    person: z.string().nullable(),
  })
  .strict();
export type VisionRuntime = z.infer<typeof VisionRuntimeSchema>;

const FrameResultSchema = z
  .object({
    output: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    instances: z.number().int().nonnegative(),
    coverage: z.number().min(0).max(1),
    ms: z.number().nonnegative(),
  })
  .strict();
/** `cpuFallbacks`: frames Vision ran on the CPU because the Neural Engine was busy (slower, same model). */
const MatteResponseSchema = z
  .object({
    version: z.literal(1),
    runtime: VisionRuntimeSchema,
    cpuFallbacks: z.number().int().nonnegative(),
    frames: z.array(FrameResultSchema),
  })
  .strict();
export type VisionFrameResult = z.infer<typeof FrameResultSchema>;

const fail = (message: string, code: "VALIDATION" | "TIMEOUT" = "VALIDATION") => new CliErrorObject({ code, message });
const POLICY = "(version 1)(allow default)(deny network*)";

export function checkRuntimeFiles(config: z.output<typeof LocalMatteConfigSchema>): void {
  for (const [file, expected] of [
    [config.executable, config.executableHash],
    [config.workerSource, config.workerSourceHash],
  ] as const) {
    if (!path.isAbsolute(file) || !existsSync(file)) throw fail("Prepared Vision matte runtime unavailable");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || hashFile(file) !== expected)
      throw fail(
        "Vision matte runtime/source checksum or regular-file mismatch; rerun pnpm media:prepare --engines matte",
      );
  }
}

async function execute(
  config: z.output<typeof LocalMatteConfigSchema>,
  payload: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const stdin = JSON.stringify(payload) + "\n";
  if (Buffer.byteLength(stdin) > 4 * 1024 * 1024) throw fail("Vision matte request exceeds 4 MiB");
  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", POLICY, config.executable], {
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
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
    const timer = setTimeout(() => finish(fail("Vision matte timeout", "TIMEOUT")), timeoutMs);
    child.on("error", (error) => finish(fail("Vision matte unavailable: " + error.message)));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 8 * 1024 * 1024) return finish(fail("Vision matte stdout exceeds 8 MiB"));
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-65536);
    });
    child.on("close", (code) => {
      if (settled) return;
      try {
        if (code !== 0) throw fail("Vision matte failed: " + stderr.toString().slice(-1000));
        const lines = stdout.toString().trim().split("\n");
        if (lines.length !== 1) throw fail("Vision matte worker must emit exactly one JSON line");
        finish(undefined, JSON.parse(lines[0]!));
      } catch (error) {
        finish(error instanceof Error ? error : fail(String(error)));
      }
    });
    child.stdin.end(stdin);
  });
}

export type VisionStatus =
  | { available: true; config: z.output<typeof LocalMatteConfigSchema>; runtime: VisionRuntime }
  | { available: false; reason: string };

/** Checks the prepared config at `configFile` and probes the worker. Never compiles. */
export async function probeVisionMatte(configFile: string): Promise<VisionStatus> {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    return { available: false, reason: "Apple Vision needs macOS" };
  if (!existsSync(configFile)) return { available: false, reason: `not prepared: ${configFile} is missing` };
  try {
    const config = LocalMatteConfigSchema.parse(JSON.parse(readFileSync(configFile, "utf8")));
    checkRuntimeFiles(config);
    const runtime = VisionRuntimeSchema.parse(await execute(config, { version: 1, operation: "probe" }, 20_000));
    return { available: true, config, runtime };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs one batch: each input PNG to a grey alpha PNG at its size. */
export async function runVisionMatte(
  config: z.output<typeof LocalMatteConfigSchema>,
  request: {
    kind: "subject" | "person";
    quality: "fast" | "balanced" | "accurate";
    frames: { input: string; output: string }[];
  },
): Promise<{ runtime: VisionRuntime; cpuFallbacks: number; frames: VisionFrameResult[] }> {
  checkRuntimeFiles(config);
  const raw = await execute(
    config,
    { version: 1, operation: "matte", kind: request.kind, quality: request.quality, frames: request.frames },
    config.timeoutMs,
  );
  const response = MatteResponseSchema.parse(raw);
  if (
    response.frames.length !== request.frames.length ||
    response.frames.some((frame, index) => frame.output !== request.frames[index]!.output)
  )
    throw fail("Vision matte response does not match the request");
  return response;
}
