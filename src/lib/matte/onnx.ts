import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject, emitProgress } from "../cli";

/**
 * The cross-platform engine: BiRefNet (MIT) through onnxruntime in a uv worker (scripts/workers/frame-matte-onnx.py).
 * A Python worker rather than onnxruntime-node: it keeps a ~100 MB native npm dependency out of every install, uses
 * the same locked uv route as the other model workers, and onnxruntime ships CPU wheels for macOS, Linux and Windows.
 */
const WORKER = path.resolve(import.meta.dirname, "../../../scripts/workers/frame-matte-onnx.py");
const uvx = () => pythonUv(process.env.MATTE_UVX);
const INSTALL_UV = "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh";

const ResponseSchema = z
  .object({
    version: z.literal(1),
    runtime: z
      .object({
        engine: z.literal("onnxruntime"),
        onnxruntime: z.string(),
        provider: z.string(),
        size: z.number().int(),
        loadMs: z.number().nonnegative(),
      })
      .strict(),
    frames: z.array(
      z
        .object({
          output: z.string(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          coverage: z.number().min(0).max(1),
          ms: z.number().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type OnnxResponse = z.infer<typeof ResponseSchema>;

export const defaultThreads = () => Math.min(8, Math.max(2, cpus().length - 2));

/** The uv argument array for a request file (exported for tests). */
export function workerArgs(requestFile: string): string[] {
  return pythonArgs("matte", [WORKER, requestFile]);
}

/** One session for the whole batch: each input to a grey alpha PNG at its size. */
export async function runOnnxMatte(request: {
  model: string;
  frames: { input: string; output: string }[];
  threads?: number;
}): Promise<OnnxResponse> {
  const work = mkdtempSync(path.join(tmpdir(), "matte-onnx-"));
  const file = path.join(work, "request.json");
  writeFileSync(
    file,
    JSON.stringify({
      model: request.model,
      size: 1024,
      threads: request.threads ?? defaultThreads(),
      frames: request.frames,
    }),
  );
  try {
    const { code, stdout, stderr, error } = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      error?: Error;
    }>((resolve) => {
      const child = spawn(uvx(), workerArgs(file), {
        env: pythonEnvironment("matte"),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        err = (err + text).slice(-4000);
        for (const line of text.split("\n")) if (line.startsWith("matte ")) emitProgress(line);
      });
      child.on("error", (spawnError) => resolve({ code: null, stdout: out, stderr: err, error: spawnError }));
      child.on("close", (exit) => resolve({ code: exit, stdout: out, stderr: err }));
    });
    if (error || code !== 0) {
      const detail = error?.message ?? stderr.trim().slice(-800);
      throw new CliErrorObject({
        code: "INTERNAL",
        message: `ONNX matte worker failed: ${detail}`,
        details: {
          fix: /ENOENT|not found/i.test(detail)
            ? INSTALL_UV
            : "Check network access for the first uv package download, then rerun.",
        },
      });
    }
    const response = ResponseSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
    if (response.frames.length !== request.frames.length)
      throw new CliErrorObject({ code: "VALIDATION", message: "ONNX matte response does not match the request" });
    return response;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
