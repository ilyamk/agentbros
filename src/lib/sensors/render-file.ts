import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { CliErrorObject } from "../cli";
import type { Occurrence } from "./findings";

export type RenderProbe = {
  codec: string;
  width: number;
  height: number;
  sampleAspect: string;
  frameCount: number;
  fps: number;
};

export function probeRender(file: string): RenderProbe {
  if (!existsSync(file))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `--render file not found: ${file}` });
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_packets",
      "-show_entries",
      "stream=codec_name,width,height,sample_aspect_ratio,avg_frame_rate,nb_read_packets",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );
  const stream = result.status === 0 ? JSON.parse(result.stdout).streams?.[0] : undefined;
  if (!stream)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `No video stream in ${file}: ${result.stderr}` });
  const [numerator, denominator = 1] = String(stream.avg_frame_rate).split("/").map(Number);
  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    sampleAspect: stream.sample_aspect_ratio ?? "1:1",
    frameCount: Number(stream.nb_read_packets),
    fps: numerator! / denominator,
  };
}

export function checkRender(
  file: string,
  probe: RenderProbe,
  expected: { codec: string; width: number; height: number; fps: number; durationInFrames: number; lastFrame: number },
): Occurrence[] {
  const found: Occurrence[] = [];
  const add = (code: Occurrence["code"], message: string, fix: string) =>
    found.push({ code, frame: expected.lastFrame, key: code, message, fix });
  if (!["1:1", "0:1", "N/A"].includes(probe.sampleAspect))
    add(
      "RENDER_PIXEL_ASPECT",
      `${file} has pixel aspect ratio ${probe.sampleAspect}, so players stretch it.`,
      `Re-render without a scaling step, or set it with: ffmpeg -i ${file} -vf setsar=1 -c:a copy OUTPUT.`,
    );
  if (probe.width !== expected.width || probe.height !== expected.height)
    add(
      "RENDER_DIMENSIONS",
      `${file} is ${probe.width}x${probe.height}; the composition is ${expected.width}x${expected.height}.`,
      "Render the current composition again without a scale override.",
    );
  if (probe.codec !== expected.codec)
    add(
      "RENDER_CODEC",
      `${file} uses codec ${probe.codec}; expected ${expected.codec}.`,
      `Render with codec ${expected.codec}, or pass --codec ${probe.codec} if this is what you intended.`,
    );
  if (probe.frameCount !== expected.durationInFrames || Math.abs(probe.fps - expected.fps) > 0.01)
    add(
      "RENDER_DURATION",
      `${file} has ${probe.frameCount} frames at ${probe.fps.toFixed(3)} fps; the composition has ${expected.durationInFrames} at ${expected.fps}.`,
      "The file is stale or partial. Render the whole composition again, then rerun this check.",
    );
  return found;
}
