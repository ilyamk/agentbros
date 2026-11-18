import { execFileSync } from "node:child_process";
import type { TimelineEntry } from "./timeline";

/** Extract exactly the owned speech interval, never a dissolve-padded window. */
export function extractPresenterAudio(
  source: string,
  output: string,
  entry: Pick<TimelineEntry, "sourceStartFrame" | "durationInFrames">,
  fps = 30,
): void {
  if (
    !Number.isFinite(fps) ||
    fps <= 0 ||
    !Number.isInteger(entry.sourceStartFrame) ||
    entry.sourceStartFrame < 0 ||
    !Number.isInteger(entry.durationInFrames) ||
    entry.durationInFrames <= 0
  )
    throw new Error("Invalid presenter audio interval");
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source,
      "-ss",
      String(entry.sourceStartFrame / fps),
      "-t",
      String(entry.durationInFrames / fps),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      output,
    ],
    { stdio: "pipe" },
  );
}
