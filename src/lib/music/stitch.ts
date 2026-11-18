import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";

export type StitchPlan = {
  source: string;
  output: string;
  durationSec: number;
  dropAtSec: number;
  bpm?: number;
  ending: "hard" | "fade";
  introCutoffHz?: number;
  introGain?: number;
  startSec?: number;
};

/** Whole beats, so the drop lands on the loop's own downbeat when the loop starts on one. */
export function snapToBeats(seconds: number, bpm: number | undefined): number {
  if (!bpm) return seconds;
  const beat = 60 / bpm;
  return Math.max(beat, Math.round(seconds / beat) * beat);
}

/**
 * Builds a cue from a loop with ffmpeg alone: the loop low-passed and lowered until the drop, then the loop
 * from its start at full level, repeated to length, ending on a 30 ms cut or a fade. Not a composition:
 * the result is marked stitched and keeps its source's licence.
 */
export function stitchCue(plan: StitchPlan) {
  const dropAt = snapToBeats(plan.dropAtSec, plan.bpm);
  const total = plan.durationSec;
  if (dropAt >= total)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `The drop (${dropAt.toFixed(2)} s) must come before the end (${total} s).`,
    });
  const cutoff = plan.introCutoffHz ?? 450,
    gain = plan.introGain ?? 0.55;
  const tail =
    plan.ending === "hard"
      ? `afade=t=out:st=${(total - 0.03).toFixed(3)}:d=0.03`
      : `afade=t=out:st=${Math.max(dropAt, total - 1.5).toFixed(3)}:d=${Math.min(1.5, total - dropAt).toFixed(3)}`;
  const filter = [
    `[0:a]atrim=0:${dropAt.toFixed(4)},asetpts=PTS-STARTPTS,lowpass=f=${cutoff},lowpass=f=${cutoff},volume=${gain},afade=t=in:d=${Math.min(0.5, dropAt / 2).toFixed(3)}[intro]`,
    `[1:a]atrim=0:${(total - dropAt).toFixed(4)},asetpts=PTS-STARTPTS[main]`,
    `[intro][main]concat=n=2:v=0:a=1,${tail}[out]`,
  ].join(";");
  const start = plan.startSec ? ["-ss", String(plan.startSec)] : [];
  mkdirSync(path.dirname(plan.output), { recursive: true });
  const args = [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-stream_loop",
    "-1",
    ...start,
    "-i",
    plan.source,
    "-stream_loop",
    "-1",
    ...start,
    "-i",
    plan.source,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-t",
    String(total),
    "-ar",
    "44100",
    "-ac",
    "2",
    "-c:a",
    "libmp3lame",
    "-q:a",
    "2",
    plan.output,
  ];
  const result = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 300_000 });
  if (result.error && /ENOENT/.test(result.error.message))
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffmpeg not found. Install it with: brew install ffmpeg",
    });
  if (result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffmpeg could not stitch the cue: ${result.stderr.trim().slice(-300)}`,
    });
  const record = {
    schemaVersion: 1,
    stitched: true,
    method: "ffmpeg: looped source, low-passed intro, drop at the loop's start, cut or fade at the end",
    source: plan.source,
    output: plan.output,
    durationSec: total,
    dropAtSec: Math.round(dropAt * 1000) / 1000,
    ...(plan.bpm ? { bpm: plan.bpm } : {}),
    ending: plan.ending,
    intro: { lowpassHz: cutoff, gain },
    ...(plan.startSec ? { startSec: plan.startSec } : {}),
    note: "An edit of a third-party loop: the source's licence and credit still apply. Agents cannot hear; the user judges the result by ear.",
  };
  const recordPath = plan.output.replace(/\.[^.]+$/, ".stitch.json");
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, recordPath };
}
