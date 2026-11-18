import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Detections } from "../multicam/reframe";
import { AppleVisionResultSchema } from "../../types/apple-results";
import { ensureApple } from "./tasks";
import { fileHash, invokeNative } from "./runtime";
export async function appleFrameDetections(frames: { id: string; file: string }[]) {
  await ensureApple("vision.faces");
  const pins = frames.map((f) => fileHash(f.file));
  const rows: ReturnType<typeof AppleVisionResultSchema.parse>["frames"] = [];
  for (let start = 0; start < frames.length; start += 32) {
    const batch = frames.slice(start, start + 32),
      raw = AppleVisionResultSchema.parse(
        await invokeNative("vision", "run", { frames: batch, features: ["faces", "people"] }),
      );
    if (raw.frames.length !== batch.length || raw.frames.some((r, i) => r.id !== batch[i]!.id))
      throw new Error("Vision detection frame identity mismatch");
    rows.push(...raw.frames);
  }
  if (frames.some((f, i) => fileHash(f.file) !== pins[i])) throw new Error("Detection source changed");
  return rows;
}
export function decodedDimensions(stream: { width: number; height: number; side_data_list?: { rotation?: number }[] }) {
  const rotation = stream.side_data_list?.find((row) => row.rotation !== undefined)?.rotation ?? 0;
  if (!Number.isFinite(rotation) || Math.abs(rotation / 90 - Math.round(rotation / 90)) > 0.0001)
    throw new Error("Exact crop tracking requires quarter-turn or normalised video orientation");
  return Math.abs(Math.round(rotation / 90)) % 2
    ? { width: stream.height, height: stream.width }
    : { width: stream.width, height: stream.height };
}
export async function appleVideoDetections(file: string, sampleFps: number): Promise<Detections> {
  if (!Number.isFinite(sampleFps) || sampleFps <= 0 || sampleFps > 30)
    throw new Error("Detector sample FPS must be in (0,30]");
  const input = path.resolve(file),
    original = fileHash(input, 32 * 1024 ** 3);
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate:stream_side_data=rotation:frame=best_effort_timestamp_time",
      "-show_frames",
      "-of",
      "json",
      input,
    ],
    { encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
  );
  if (probe.status !== 0) throw new Error("Cannot inspect decoded video clock");
  const raw = JSON.parse(probe.stdout) as {
    streams: { width: number; height: number; r_frame_rate: string; side_data_list?: { rotation?: number }[] }[];
    frames: { best_effort_timestamp_time: string }[];
  };
  const stream = raw.streams[0];
  if (!stream || !raw.frames.length || raw.frames.length > 200000)
    throw new Error("Invalid or excessive decoded video frame count");
  const [num, den] = stream.r_frame_rate.split("/").map(Number),
    fps = num! / den!;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("Invalid frame rate");
  const times = raw.frames.map((f) => Number(f.best_effort_timestamp_time));
  if (times.some((t, i) => !Number.isFinite(t) || (i > 0 && Math.abs(t - times[i - 1]! - 1 / fps) > 0.002)))
    throw new Error("Exact Apple crop tracking requires a constant-rate normalised source; do not invent frame times");
  const every = Math.max(1, Math.round(fps / sampleFps)),
    count = Math.ceil(times.length / every);
  if (count > 7200) throw new Error("More than 7200 detector samples; reduce --sample-fps");
  const work = mkdtempSync(path.join(tmpdir(), "avc-apple-detect-"));
  try {
    const decoded = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-i",
        input,
        "-vf",
        `select=not(mod(n\\,${every})),scale=640:640:force_original_aspect_ratio=decrease`,
        "-fps_mode",
        "passthrough",
        path.join(work, "%06d.png"),
      ],
      { encoding: "utf8", timeout: 600000, maxBuffer: 1024 * 1024 },
    );
    if (decoded.status !== 0) throw new Error("Cannot decode selected source frames");
    const frames = Array.from({ length: count }, (_, i) => ({
      id: String(i * every),
      file: path.join(work, `${String(i + 1).padStart(6, "0")}.png`),
    }));
    const rows = await appleFrameDetections(frames);
    if (fileHash(input, 32 * 1024 ** 3) !== original) throw new Error("Video changed during detection");
    return {
      ...decodedDimensions(stream),
      fps,
      frameCount: times.length,
      samples: rows.map((row) => ({ frame: Number(row.id), faces: row.faces ?? [], people: row.people ?? [] })),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
