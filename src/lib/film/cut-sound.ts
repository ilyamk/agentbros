import { spawnSync } from "node:child_process";
import type { CueSheet, FilmMeasure } from "../../types/film";
import { CliErrorObject } from "../cli";
import { analyzeRhythmPcm } from "../audio/rhythm-kernel";
import { cueDecision, needsDecision, type SoundKind } from "../audio/cut-decisions";
import { round } from "./stats";

// film:measure's cut-sound-coverage leg: every cut, transition or hero moment decided as a sound is heard on the render.

type Leg = FilmMeasure["legs"][number];

/** The rhythm kernel reads 16 kHz mono float samples in 20 ms hops. */
const ONSET_RATE = 16000;
/** A transient lands within this many frames of its cue. */
export const COVERAGE_FRAMES = 2;
/** Sounds that swell into the cue: their attack starts this far before it (a whoosh peaks on the cue, a riser ends there). */
const LEAD_SEC: Partial<Record<SoundKind, number>> = { whoosh: 0.6, riser: 4 };

/** Attack starts of the render's soundtrack, in seconds, from the shared RMS onset detector (rhythm-kernel). */
export function readRenderOnsets(media: string): number[] {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      media,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      String(ONSET_RATE),
      "-f",
      "f32le",
      "pipe:1",
    ],
    { maxBuffer: 2 * 1024 * 1024 * 1024 },
  );
  if (result.error && /ENOENT/.test(result.error.message))
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffmpeg not found. Install it with: brew install ffmpeg",
    });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Could not decode the audio of ${media}: ${result.error?.message ?? result.stderr?.toString().slice(-300)}`,
    });
  const bytes = result.stdout as Buffer;
  return analyzeRhythmPcm(bytes, bytes.length / 4 / ONSET_RATE, "").report.onsetsSec;
}

/** The placed sounds (`sfx:cues` output) as coverage reads them: where each file starts and where its attack is. */
export type PlacedSounds = {
  fps: number;
  events: { cueFrame: number; startFrame: number; onsetSec?: number }[];
};

/**
 * How far before its cue a placed sound's attack starts, measured: the earliest attack among the events placed within
 * 2 frames of the cue (a whoosh's or riser's pre-roll up to its anchor, less the file's own silent head). Undefined when
 * nothing was placed there, so the caller falls back to the family's constant.
 */
export function measuredLeadSec(placed: PlacedSounds | undefined, cueSec: number, fps: number): number | undefined {
  if (!placed) return undefined;
  const near = placed.events.filter(
    (event) => Math.abs(event.cueFrame / placed.fps - cueSec) <= COVERAGE_FRAMES / fps + 1e-6,
  );
  if (!near.length) return undefined;
  return Math.max(
    ...near.map((event) => Math.max(0, (event.cueFrame - event.startFrame) / placed.fps - (event.onsetSec ?? 0))),
  );
}

/**
 * Each decided-sound cue is covered when an onset falls from its sound's lead (2 frames for a transient) to 2 frames
 * after. The lead is measured from the placed sounds when `soundCues` is given; the family constant otherwise.
 */
export function cutSoundCoverageLeg(input: {
  cueSheet?: CueSheet;
  onsetsSec?: number[];
  fps: number;
  soundCues?: PlacedSounds;
}): Leg {
  const id = "cut-sound-coverage";
  const skip = (message: string, fix?: string): Leg => ({
    id,
    status: "skipped",
    value: null,
    message,
    ...(fix ? { fix } : {}),
    evidence: [],
  });
  if (!input.cueSheet) return skip("No cue sheet, so no cut has a decided sound to listen for.", "Pass --cue-sheet.");
  const decided = input.cueSheet.cues.filter(needsDecision).map((cue) => ({ cue, decision: cueDecision(cue) }));
  const sounding = decided.flatMap(({ cue, decision }) =>
    decision.state === "sound" ? [{ cue, kinds: [decision.sfx, ...(decision.layers ?? [])] }] : [],
  );
  const silent = decided.filter(({ decision }) => decision.state === "silent").length;
  if (!sounding.length)
    return skip(`No cue decides a sound (${silent} deliberate silence(s)), so there is nothing to hear.`);
  if (!input.onsetsSec)
    return skip(
      "The render's onsets were not read (no audio stream, or not measured).",
      "Mux the audio master and rerun film:measure.",
    );
  const frameSec = 1 / input.fps;
  const rows = sounding.map(({ cue, kinds }) => {
    const atSec = cue.frame / input.cueSheet!.fps;
    const measured = measuredLeadSec(input.soundCues, atSec, input.fps);
    const leadSec = Math.max(
      COVERAGE_FRAMES * frameSec,
      ...(measured !== undefined ? [measured] : kinds.map((kind) => LEAD_SEC[kind] ?? 0)),
    );
    const onset = input.onsetsSec!.find(
      (time) => time >= atSec - leadSec - 1e-6 && time <= atSec + COVERAGE_FRAMES * frameSec + 1e-6,
    );
    return { cue, kinds, atSec, onset, leadSec, measured: measured !== undefined };
  });
  const measuredCount = rows.filter((row) => row.measured).length;
  const missing = rows.filter((row) => row.onset === undefined);
  const share = round((rows.length - missing.length) / rows.length, 3);
  const text = `${rows.length - missing.length} of ${rows.length} decided-sound cues have an onset on the render within ${COVERAGE_FRAMES} frames (a whoosh or riser from its lead: ${measuredCount} measured from the placed sounds, ${rows.length - measuredCount} the family default); ${silent} deliberate silence(s) not listened for.`;
  if (!missing.length) return { id, status: "pass", value: share, target: { min: 1 }, message: text, evidence: [] };
  // Advisory until calibrated: on 18 degraded reference segments (design-reference/calibration.md, 2026-11-15) it caught desync on 31% of
  // pairs and blunted transients on 44%, short of the 85% a gate needs; music onsets sit within 2 frames of most cuts whatever the edit does.
  return {
    id,
    status: "warn",
    value: share,
    target: { min: 1 },
    message: `${text} Silent where a sound was decided: ${missing.map((row) => `${row.cue.id} @${round(row.atSec, 2)} s (${row.kinds.join("+")})`).join(", ")}.`,
    fix: "The decided sound is missing or buried on these cues. Rerun sfx:cues with --cue-sheet, check the events reach <CueSounds> or the mix plan, and read masking; or change the decision to silent with its reason.",
    evidence: missing.map(
      (row) =>
        `${row.cue.id}: cue ${row.cue.frame}, lead ${round(row.leadSec, 3)} s (${row.measured ? "measured" : "default"}), nearest onset ${(() => {
          const nearest = input.onsetsSec!.reduce<number | undefined>(
            (best, time) =>
              best === undefined || Math.abs(time - row.atSec) < Math.abs(best - row.atSec) ? time : best,
            undefined,
          );
          return nearest === undefined ? "none" : `${round(nearest, 3)} s`;
        })()}`,
    ),
  };
}
