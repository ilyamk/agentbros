import {
  ReferenceSyncSchema,
  type ReferenceAudio,
  type ReferenceMotion,
  type ReferenceShots,
  type ReferenceSpeechText,
  type ReferenceSync,
} from "../../types/reference";

export const SYNC_TOLERANCE_SEC = 0.08;
/** Text without a frame-refined onset is known only to half a 2 fps sampling interval. */
const SAMPLED_TEXT_TOLERANCE_SEC = 0.25;
const SPEECH_GAP_SEC = 0.3;

type Kind = ReferenceSync["events"][number]["kinds"][number];
const round = (value: number) => Math.round(value * 1000) / 1000;

const onGrid = (time: number, grid: number[], tolerance: number) => grid.some((at) => Math.abs(at - time) <= tolerance);

export function hitRatio(times: number[], grid: number[], tolerance: number): number | undefined {
  if (!times.length || !grid.length) return undefined;
  return round(times.filter((time) => onGrid(time, grid, tolerance)).length / times.length);
}

/** The share of the timeline within tolerance of the grid: what random times would score. */
export function chanceRatio(grid: number[], tolerance: number, durationSec: number): number | undefined {
  if (!grid.length || durationSec <= 0) return undefined;
  let covered = 0;
  let reach = 0;
  for (const at of [...grid].sort((a, b) => a - b)) {
    const start = Math.max(reach, at - tolerance);
    const end = Math.min(durationSec, at + tolerance);
    if (end > start) covered += end - start;
    reach = Math.max(reach, end);
  }
  return round(Math.min(1, covered / durationSec));
}

const defined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

/** How many times chance a ratio is; undefined when chance is zero or either is missing. */
export function lift(ratio: number | undefined, chance: number | undefined): number | undefined {
  if (ratio === undefined || chance === undefined || chance <= 0) return undefined;
  return Math.round((ratio / chance) * 100) / 100;
}

/** Median signed distance from each time to its nearest grid point: negative when times come early. */
export function signedMedianOffset(times: number[], grid: number[]): number | undefined {
  if (!times.length || !grid.length) return undefined;
  const offsets = times
    .map((time) => grid.reduce((best, at) => (Math.abs(time - at) < Math.abs(best) ? time - at : best), Infinity))
    .sort((a, b) => a - b);
  const middle = Math.floor(offsets.length / 2);
  return round(offsets.length % 2 ? offsets[middle]! : (offsets[middle - 1]! + offsets[middle]!) / 2);
}

/** Beat-to-pulse drift over a section beyond this reads as the tracker's phase slipping. */
export const PHASE_SLIP_SEC = 0.1;
const MIN_PHASE_BEATS = 8;
const MIN_PHASE_MATCHES = 3;

/**
 * Where the beat grid slides against the sound's own pulse: per section (or the whole film), each beat's offset to its
 * nearest onset within half a beat, compared between the section's first and last third. Numbers are left unchanged;
 * the warning says not to trust the grid there. Dense onsets (hats) hide a slip, so silence here is not proof.
 */
export function phaseSlips(
  beats: number[],
  onsets: number[],
  sections: { startSec: number; endSec: number; label?: string }[],
  durationSec: number,
): string[] {
  if (beats.length < MIN_PHASE_BEATS || !onsets.length) return [];
  const spans = sections.length ? sections : [{ startSec: 0, endSec: durationSec, label: "the film" }];
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const warnings: string[] = [];
  for (const span of spans) {
    const inside = beats.filter((beat) => beat >= span.startSec && beat < span.endSec);
    if (inside.length < MIN_PHASE_BEATS) continue;
    const period = median(inside.slice(1).map((beat, index) => beat - inside[index]!));
    const offsets = inside.map((beat) => {
      const nearest = onsets.reduce(
        (best, onset) => (Math.abs(onset - beat) < Math.abs(best - beat) ? onset : best),
        Infinity,
      );
      return Math.abs(nearest - beat) <= period / 2 ? nearest - beat : undefined;
    });
    const third = Math.floor(inside.length / 3);
    const early = offsets.slice(0, third).filter((value): value is number => value !== undefined);
    const late = offsets.slice(-third).filter((value): value is number => value !== undefined);
    if (early.length < MIN_PHASE_MATCHES || late.length < MIN_PHASE_MATCHES) continue;
    const slip = median(late) - median(early);
    if (Math.abs(slip) > PHASE_SLIP_SEC)
      warnings.push(
        `Beat grid phase slips ${round(slip)} s against the onsets over ${span.label ?? "a section"} (${round(span.startSec)}-${round(span.endSec)} s): beats ${slip > 0 ? "run ahead of" : "fall behind"} the pulse. Do not read cut-on-beat numbers there without looking.`,
      );
  }
  return warnings;
}

export function buildSync(request: {
  referenceId: string;
  durationSec: number;
  shots?: ReferenceShots;
  audio?: ReferenceAudio;
  speechText?: ReferenceSpeechText;
  motion?: ReferenceMotion;
  toleranceSec?: number;
  fps?: number;
}): ReferenceSync {
  const tolerance = request.toleranceSec ?? SYNC_TOLERANCE_SEC;
  const cuts = (request.shots?.shots ?? []).slice(1).map((shot) => shot.startSec);
  const beats = request.audio?.tempo?.beatsSec ?? [];
  const downbeats = request.audio?.tempo?.downbeatsSec ?? [];
  const onsets = request.audio?.onsetsSec ?? [];
  const words = request.speechText?.speech.words ?? [];
  const speechStarts = words
    .filter((word, index) => index === 0 || word.startSec - words[index - 1]!.endSec >= SPEECH_GAP_SEC)
    .map((word) => word.startSec);
  const items = request.speechText?.screenText.items ?? [];
  const refined = items.length > 0 && items.every((item) => item.onsetSec !== undefined);
  const textTolerance = refined ? tolerance : SAMPLED_TEXT_TOLERANCE_SEC;
  // Lines that appear together count once; text already on the first frame was not placed on anything.
  const textOn = [...new Set(items.map((item) => round(item.onsetSec ?? item.startSec)))]
    .filter((time) => time > 0.05)
    .sort((a, b) => a - b)
    .filter((time, index, all) => index === 0 || time - all[index - 1]! > 0.05);
  const peaks = (request.motion?.shots ?? []).flatMap((shot) => (shot.peakSec === undefined ? [] : [shot.peakSec]));

  const raw: { timeSec: number; kind: Kind }[] = [
    ...cuts.map((timeSec) => ({ timeSec, kind: "cut" as const })),
    ...beats.map((timeSec) => ({ timeSec, kind: "beat" as const })),
    ...downbeats.map((timeSec) => ({ timeSec, kind: "downbeat" as const })),
    ...onsets.map((timeSec) => ({ timeSec, kind: "onset" as const })),
    ...speechStarts.map((timeSec) => ({ timeSec, kind: "speech-start" as const })),
    ...textOn.map((timeSec) => ({ timeSec, kind: "text-on" as const })),
    ...peaks.map((timeSec) => ({ timeSec, kind: "motion-peak" as const })),
  ].sort((a, b) => a.timeSec - b.timeSec);
  const events: ReferenceSync["events"] = [];
  let anchor = -Infinity;
  for (const row of raw) {
    const last = events.at(-1);
    if (last && row.timeSec - anchor <= tolerance) {
      if (!last.kinds.includes(row.kind)) last.kinds.push(row.kind);
    } else {
      anchor = row.timeSec;
      events.push({ timeSec: round(row.timeSec), kinds: [row.kind] });
    }
  }
  const distances = beats.length
    ? cuts.map((cut) => Math.min(...beats.map((beat) => Math.abs(beat - cut)))).sort((a, b) => a - b)
    : [];
  const frame = 1 / (request.fps && request.fps > 0 ? request.fps : 30);
  const beatRatio = hitRatio(cuts, beats, tolerance);
  const beatChance = cuts.length ? chanceRatio(beats, tolerance, request.durationSec) : undefined;
  const onsetRatio = hitRatio(cuts, onsets, tolerance);
  const onsetChance = cuts.length ? chanceRatio(onsets, tolerance, request.durationSec) : undefined;
  // A frame plus 1.5 ms, so a cut a whole frame off still counts after times are rounded to ms.
  const frameReach = frame + 0.0015;
  const downbeatRatio = hitRatio(cuts, downbeats, frameReach);
  const downbeatChance = cuts.length ? chanceRatio(downbeats, frameReach, request.durationSec) : undefined;
  const slips = phaseSlips(beats, onsets, request.audio?.sections ?? [], request.durationSec);
  const shotsMissing = !request.shots || request.shots.status?.available === false;
  return ReferenceSyncSchema.parse({
    schemaVersion: 1,
    referenceId: request.referenceId,
    status: shotsMissing
      ? {
          available: false,
          unavailableReason: "Sync needs shots.json with detected shots.",
          fix: "Run ref:analyze --layers shots,sync.",
        }
      : { available: true },
    toleranceSec: tolerance,
    textToleranceSec: textTolerance,
    events,
    metrics: defined({
      cutCount: cuts.length,
      cutsOnBeatRatio: beatRatio,
      cutsOnBeatChance: beatChance,
      cutsOnOnsetRatio: onsetRatio,
      cutsOnOnsetChance: onsetChance,
      textOnBeatRatio: hitRatio(textOn, beats, textTolerance),
      textOnBeatChance: textOn.length ? chanceRatio(beats, textTolerance, request.durationSec) : undefined,
      medianCutToBeatSec: distances.length ? round(distances[Math.floor(distances.length / 2)]!) : undefined,
      cutsOnBeatLift: lift(beatRatio, beatChance),
      cutsOnOnsetLift: lift(onsetRatio, onsetChance),
      frameToleranceSec: cuts.length ? round(frame) : undefined,
      cutsOnDownbeatFrameRatio: downbeatRatio,
      cutsOnDownbeatFrameChance: downbeatRatio === undefined ? undefined : downbeatChance,
      cutsOnDownbeatFrameLift: lift(downbeatRatio, downbeatChance),
      signedMedianCutToBeatSec: signedMedianOffset(cuts, beats),
    }),
    ...(slips.length ? { warnings: slips } : {}),
  });
}
