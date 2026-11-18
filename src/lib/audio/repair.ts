import { mkdtempSync, rmSync, existsSync, linkSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mixLocalAudio } from "./local-mix";
import { analyzeAudio, mediaProbe } from "./analysis";

/** One bounded local audio repair. Original video and narration remain intact. */
export function repairRenderAudio(input: string, output: string) {
  if (path.resolve(input) === path.resolve(output) || existsSync(output))
    throw new Error("Repair requires a new output path; original media is immutable");
  if (path.extname(output).toLowerCase() !== ".mp4") throw new Error("Repaired render output must be MP4");
  const probe = mediaProbe(input);
  if (
    !probe.streams.some((stream) => stream.codec_type === "video") ||
    !probe.streams.some((stream) => stream.codec_type === "audio")
  )
    throw new Error("Repair requires video and audio streams");
  const parent = path.dirname(path.resolve(output));
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, ".audio-repair-"));
  const run = (args: string[]) => {
    const result = spawnSync("ffmpeg", ["-v", "error", ...args], {
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  };
  try {
    const speech = path.join(directory, "original.wav"),
      master = path.join(directory, "master.wav"),
      video = path.join(directory, "repaired.mp4");
    run(["-i", input, "-vn", "-c:a", "pcm_s24le", speech]);
    mixLocalAudio(
      {
        version: 1,
        durationSec: Number(probe.format.duration),
        tracks: [{ source: speech, role: "speech" }],
      },
      master,
    );
    run([
      "-i",
      input,
      "-i",
      master,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      video,
    ]);
    const analysis = analyzeAudio(video);
    if (
      analysis.truePeakDb === null ||
      analysis.truePeakDb > -0.5 ||
      analysis.integratedLufs === null ||
      Math.abs(analysis.integratedLufs + 16) > 1
    )
      throw new Error("Repaired AAC delivery failed measurements; original preserved");
    linkSync(video, output);
    return { output, analysis, attempts: 1, apiCalls: 0 };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
