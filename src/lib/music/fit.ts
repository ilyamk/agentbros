import type { AudioMap } from "../../types/film";
import { MusicBriefSchema, type MusicBrief, type MusicFit, type MusicHit } from "./types";

const number = (text: string | undefined) => (text === undefined ? undefined : Number(text.replace(",", ".")));

/** Reads "140 BPM, quiet intro, drop around 4 s, hard ending, 16 s" into a brief. Explicit flags win over the text. */
export function parseMusicBrief(text: string, flags: Partial<MusicBrief> = {}): MusicBrief {
  const lower = text.toLowerCase();
  const bpm = number(lower.match(/(\d{2,3}(?:[.,]\d+)?)\s*bpm/)?.[1]);
  const dropPhrase = lower.match(/(?:drop|surge|hit|kicks? in)\D{0,20}?(\d+(?:[.,]\d+)?)\s*(?:s\b|sec)/);
  const drop = number(dropPhrase?.[1]);
  const rest = dropPhrase ? lower.replace(dropPhrase[0], " ") : lower;
  const duration = number(rest.match(/(\d+(?:[.,]\d+)?)\s*(?:s|secs?|seconds?)\b/)?.[1]);
  const intro = /quiet|soft|calm|filtered|sparse|minimal/.test(lower.match(/[^,;.]*intro[^,;.]*/)?.[0] ?? "")
    ? "quiet"
    : /full|straight in|cold open/.test(lower.match(/[^,;.]*intro[^,;.]*/)?.[0] ?? "")
      ? "full"
      : undefined;
  const endingText = lower.match(/[^,;.]*(?:ending|end|finish|outro)[^,;.]*/)?.[0] ?? "";
  const ending = /hard|abrupt|button|stop|cut/.test(endingText) ? "hard" : /fade/.test(endingText) ? "fade" : undefined;
  const defined = Object.fromEntries(Object.entries(flags).filter(([, value]) => value !== undefined));
  return MusicBriefSchema.parse({
    ...(bpm ? { bpm } : {}),
    ...(drop !== undefined ? { dropAtSec: drop } : {}),
    ...(duration ? { durationSec: duration } : {}),
    ...(intro ? { intro } : {}),
    ...(ending ? { ending } : {}),
    ...defined,
  });
}

/** True when the brief asks for anything ranking can measure. */
export const briefIsMeasurable = (brief: MusicBrief) =>
  brief.bpm !== undefined ||
  brief.dropAtSec !== undefined ||
  brief.durationSec !== undefined ||
  brief.ending !== undefined ||
  brief.intro !== undefined;

/** Half and double tempo are the same pulse to an editor, so they count with a penalty. */
export function bpmFit(
  value: number | undefined,
  brief: MusicBrief,
): { score: number; relation?: "exact" | "half" | "double" | "off" } {
  if (!brief.bpm || !value) return { score: 0 };
  const tolerance = Math.max(brief.bpmTolerance, 0.5);
  const options = [
    { relation: "exact" as const, distance: Math.abs(value - brief.bpm), weight: 1 },
    { relation: "half" as const, distance: Math.abs(value * 2 - brief.bpm), weight: 0.6 },
    { relation: "double" as const, distance: Math.abs(value / 2 - brief.bpm), weight: 0.6 },
  ].map((item) => ({ ...item, score: Math.max(0, 1 - item.distance / (tolerance * 2)) * item.weight }));
  const best = options.sort((a, b) => b.score - a.score)[0]!;
  return best.distance <= tolerance ? { score: best.score, relation: best.relation } : { score: -0.5, relation: "off" };
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

function meanLevel(
  curve: AudioMap["energyCurve"],
  start: number,
  end: number,
  key: "rms" | "low" = "rms",
): number | undefined {
  const values = curve.filter((point) => point.timeSec >= start && point.timeSec < end).map((point) => point[key]);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

/** A track's own ending, read only when the map covers the whole track. */
function trackEnding(map: AudioMap, wholeTrack: boolean): "hard-stop" | "fade" | "unmeasured" {
  if (!wholeTrack) return "unmeasured";
  const length = map.source.durationSec;
  if (map.keyMoments.some((moment) => moment.kind === "hard-stop" && moment.timeSec >= length - 2)) return "hard-stop";
  const last = meanLevel(map.energyCurve, length - 1, length + 1) ?? 0,
    before = meanLevel(map.energyCurve, length - 5, length - 2) ?? 0;
  if (before > 0.05 && last < before * 0.45) return "fade";
  return last >= before * 0.7 ? "hard-stop" : "fade";
}

/**
 * Finds the start offset that best meets the brief in one measured map: the window where a quiet stretch of
 * `dropAtSec` is followed by a rise in level, a measured tempo near the target, and a cut on a downbeat at the end.
 * `wholeTrack` says whether the map covers the whole track, so its own ending can be judged.
 */
export function fitFromAudioMap(
  map: AudioMap,
  brief: MusicBrief,
  options: { wholeTrack: boolean; trackLengthSec?: number },
): MusicFit {
  const notes: string[] = [];
  const length = options.trackLengthSec ?? map.source.durationSec;
  const analysedLength = map.source.durationSec;
  const tempo = bpmFit(map.tempo.bpm, brief);
  let score = tempo.score * 4;
  if (brief.bpm && map.tempo.bpm) notes.push(`measured ${round(map.tempo.bpm, 1)} BPM (${tempo.relation})`);
  if (map.tempo.gridTrust === "reliable") score += 0.5;
  else notes.push(`beat grid ${map.tempo.gridTrust}`);

  const cueLength = brief.durationSec ?? Math.min(analysedLength, 30);
  const dropAt = brief.dropAtSec;
  let offset = 0,
    surge: number | undefined,
    introLevel: number | undefined,
    afterLevel: number | undefined,
    contrast: number | undefined;
  if (dropAt !== undefined) {
    // Candidate drops: measured surges and section rises, then every quarter second as a fallback.
    const marks = new Set<number>();
    for (const moment of map.keyMoments)
      if (["surge", "riser-end", "impact"].includes(moment.kind)) marks.add(moment.timeSec);
    for (const section of map.sections) marks.add(section.startSec);
    for (let t = 0; t < analysedLength; t += 0.25) marks.add(round(t, 2));
    let best = -Infinity;
    for (const mark of marks) {
      if (mark < dropAt || mark > analysedLength - 2) continue;
      const before = meanLevel(map.energyCurve, mark - dropAt, mark),
        after = meanLevel(map.energyCurve, mark, Math.min(mark + 4, analysedLength));
      const lowBefore = meanLevel(map.energyCurve, mark - dropAt, mark, "low"),
        lowAfter = meanLevel(map.energyCurve, mark, Math.min(mark + 4, analysedLength), "low");
      if (before === undefined || after === undefined) continue;
      const rise = after - before + 0.5 * ((lowAfter ?? 0) - (lowBefore ?? 0));
      const measured = map.keyMoments.some(
        (moment) => moment.kind === "surge" && Math.abs(moment.timeSec - mark) < 0.15,
      )
        ? 0.08
        : 0;
      const onDownbeat = map.downbeatsSec.some((beat) => Math.abs(beat - mark) < 0.08) ? 0.04 : 0;
      // A late start costs a little, since an early answer keeps the cue's material near the track's own intro.
      const value = rise + measured + onDownbeat - mark * 0.0005;
      if (value > best) [best, surge, introLevel, afterLevel, contrast] = [value, mark, before, after, after - before];
    }
    if (surge !== undefined) {
      offset = surge - dropAt;
      score += Math.max(-1, Math.min(1, (contrast ?? 0) * 3)) * 3;
      if (brief.intro === "quiet" && introLevel !== undefined) score += (1 - introLevel) * 1.5;
      notes.push(
        `surge at ${round(surge)} s of the track; start at ${round(offset)} s puts it at ${round(dropAt)} s (level ${round(introLevel ?? 0)} to ${round(afterLevel ?? 0)})`,
      );
      if ((contrast ?? 0) < 0.1) notes.push("no clear rise: the level is flat around the drop");
    } else notes.push("no drop position fits inside the analysed audio");
  }

  const loop = length < cueLength + offset - 0.05;
  if (loop) {
    score -= 2;
    notes.push(`only ${round(length, 1)} s long: repeat or stitch it to reach ${cueLength} s`);
  }
  if (brief.durationSec && !loop) score += 0.5;

  const cutAt = offset + cueLength;
  const nearest = map.downbeatsSec.reduce<number | undefined>(
    (found, beat) => (found === undefined || Math.abs(beat - cutAt) < Math.abs(found - cutAt) ? beat : found),
    undefined,
  );
  const onDownbeat = nearest !== undefined && Math.abs(nearest - cutAt) <= 0.12 && map.tempo.gridTrust !== "none";
  const ending = {
    track: trackEnding(map, options.wholeTrack),
    ...(cutAt <= analysedLength ? { cueCutSec: round(cutAt), cueCutOnDownbeat: onDownbeat } : {}),
  };
  if (brief.ending === "hard") {
    if (ending.track === "hard-stop" && Math.abs(length - cutAt) < 1) score += 1.5;
    else if (onDownbeat) {
      score += 0.75;
      notes.push("hard end by an editor's cut on a downbeat");
    }
  } else if (brief.ending === "fade" && ending.track === "fade") score += 0.5;

  const energy: number[] = [];
  for (let second = 0; second < Math.ceil(cueLength); second++)
    energy.push(round(meanLevel(map.energyCurve, offset + second, offset + second + 1) ?? 0));

  return {
    analysed: true,
    bpm: {
      ...(map.tempo.bpm ? { value: round(map.tempo.bpm, 1) } : {}),
      source: map.tempo.bpm ? "measured" : "none",
      ...(tempo.relation ? { relation: tempo.relation } : {}),
      gridTrust: map.tempo.gridTrust,
    },
    ...(dropAt !== undefined && surge !== undefined
      ? {
          offsetSec: round(offset),
          surgeSec: round(surge),
          dropAtCueSec: dropAt,
          introLevel: round(introLevel ?? 0),
          afterLevel: round(afterLevel ?? 0),
          contrast: round(contrast ?? 0),
        }
      : { offsetSec: 0 }),
    ending,
    energy,
    lengthSec: round(length, 1),
    loop,
    score: round(score),
    notes,
  };
}

/** Before any audio is read: the host's stated tempo and the length, so analysis is spent on likely tracks. */
export function fitFromMetadata(hit: Pick<MusicHit, "metadataBpm" | "durationSec">, brief: MusicBrief): MusicFit {
  const tempo = bpmFit(hit.metadataBpm, brief);
  const notes: string[] = [];
  let score = tempo.score * 3;
  if (brief.bpm && hit.metadataBpm) notes.push(`host states ${hit.metadataBpm} BPM (${tempo.relation})`);
  else if (brief.bpm) {
    score -= 0.5;
    notes.push("no stated tempo");
  }
  const loop = brief.durationSec !== undefined && hit.durationSec !== undefined && hit.durationSec < brief.durationSec;
  if (loop) {
    score -= 2;
    notes.push(`only ${round(hit.durationSec!, 1)} s long`);
  }
  if (hit.durationSec && hit.durationSec > 600) {
    score -= 1.5;
    notes.push("long mix");
  }
  return {
    analysed: false,
    bpm: {
      ...(hit.metadataBpm ? { value: hit.metadataBpm } : {}),
      source: hit.metadataBpm ? "metadata" : "none",
      ...(tempo.relation ? { relation: tempo.relation } : {}),
    },
    energy: [],
    ...(hit.durationSec ? { lengthSec: round(hit.durationSec, 1) } : {}),
    loop,
    score: round(score),
    notes,
  };
}
