import { inspectAsset } from "../assets/inspect";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { probeBlender, runLocalProcess, type ProcessRunner } from "./probe";
import { digest, immutableWrite } from "../jobs/model-artifacts";
export const BlenderCaptureSchema = z
  .object({
    width: z.number().int().min(16).max(4096).default(512),
    height: z.number().int().min(16).max(4096).default(512),
    fps: z.number().int().min(1).max(120).default(30),
    frames: z
      .array(z.number().int().min(0).max(36000))
      .min(1)
      .max(100)
      .refine((v) => new Set(v).size === v.length, "Duplicate capture frames"),
    radiansPerSecond: z.number().finite().min(-10).max(10).default(0.5),
    color: z
      .tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
      .default([0.2, 0.5, 0.9]),
  })
  .strict();
export function captureBlender(
  input: unknown,
  outputDirectory: string,
  options: { executable?: string; runner?: ProcessRunner } = {},
): Record<string, unknown> {
  const request = BlenderCaptureSchema.parse(input);
  const runner = options.runner ?? runLocalProcess;
  const probe = probeBlender(options.executable, runner);
  if (!probe.available) return { state: "unavailable", probe, outputs: [] };
  const executable = probe.path ?? options.executable ?? "blender";
  const directory = mkdtempSync(path.join(tmpdir(), "blender-capture-"));
  try {
    const requestFile = path.join(directory, "request.json");
    immutableWrite(requestFile, JSON.stringify({ ...request, directory }));
    const worker = fileURLToPath(new URL("../../../scripts/workers/blender_capture.py", import.meta.url));
    const result = runner(executable, [
      "--background",
      "--factory-startup",
      "--disable-autoexec",
      "--python",
      worker,
      "--",
      requestFile,
    ]);
    if (result.status !== 0) throw new Error("Blender capture process failed");
    const outputs = request.frames.map((frame) => {
      const source = path.join(directory, `frame-${String(frame).padStart(6, "0")}.png`);
      const bytes = readFileSync(source);
      if (
        bytes.length < 24 ||
        bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        bytes.readUInt32BE(16) !== request.width ||
        bytes.readUInt32BE(20) !== request.height
      )
        throw new Error("Blender output PNG dimensions/signature invalid");
      const inspected = inspectAsset(source);
      if (
        inspected.kind !== "image" ||
        inspected.media.width !== request.width ||
        inspected.media.height !== request.height
      )
        throw new Error("Blender capture is not a validated image");
      const sha256 = digest(bytes);
      const target = path.resolve(
        outputDirectory,
        `${digest(JSON.stringify(request)).slice(0, 16)}-frame-${String(frame).padStart(6, "0")}.png`,
      );
      immutableWrite(target, bytes);
      return { frame, path: target, sha256 };
    });
    const receipt = path.resolve(outputDirectory, `${digest(JSON.stringify(request))}.capture.json`);
    immutableWrite(
      receipt,
      JSON.stringify(
        {
          version: 1,
          backend: "blender",
          versionProbe: probe.version,
          request,
          outputs,
          deterministicContract: "absolute frame formula, no simulation caches; inspect hashes on repeated capture",
        },
        null,
        2,
      ),
    );
    return {
      state: "published",
      probe: { ...probe, liveVerified: true },
      outputs: outputs.map((o) => o.path),
      manifest: receipt,
      frames: outputs,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
