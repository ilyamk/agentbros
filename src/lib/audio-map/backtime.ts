// Idea of back-timing a track so its real ending lands on the end card, and of finding endings as an attack
// followed by a large drop: ext/motion-video-kit/business-motion-film/scripts/backtime-music.py (MIT). Own code.

import type { AudioMap } from "../../types/film";
import { snapCues, type CueDraft } from "./snap";

const KIND_WEIGHT: Record<string, number> = {
  "hard-stop": 1,
  impact: 0.9,
  "riser-end": 0.85,
  surge: 0.8,
  drop: 0.7,
  ending: 0.95,
};
const ENDING_SEARCH_SEC = 20;
const ENDING_DROP_DB = 6;
const DISTINCT_OFFSET_SEC = 0.4;

export type BacktimeCandidate = {
  offsetSec: number;
  anchorSec: number;
  kind: string;
  strength: number;
  landsOnFrame: number;
  cuesOnAnchors: number;
  cuesTotal: number;
  /** Seconds of film after the end card that the track no longer covers. */
  tailShortSec: number;
  score: number;
};

const levelDb = (value: number) => 20 * Math.log10(Math.max(value, 1e-3));

/** Late strong attacks that the track falls away from: how a button ending looks in a level curve. */
function endingCandidates(map: AudioMap): { timeSec: number; kind: string; strength: number }[] {
  const from = map.source.durationSec - ENDING_SEARCH_SEC;
  const mean = (start: number, end: number) => {
    const points = map.energyCurve.filter((point) => point.timeSec >= start && point.timeSec < end);
    return points.length ? points.reduce((sum, point) => sum + point.rms, 0) / points.length : 0;
  };
  return map.events
    .filter((event) => event.timeSec >= from && event.strength >= 0.5)
    .map((event) => ({
      event,
      fall: levelDb(mean(event.timeSec, event.timeSec + 0.2)) - levelDb(mean(event.timeSec + 0.4, event.timeSec + 1.9)),
    }))
    .filter(({ fall }) => fall >= ENDING_DROP_DB)
    .map(({ event, fall }) => ({
      timeSec: event.timeSec,
      kind: "ending",
      strength: Math.round(Math.min(1, event.strength * 0.5 + fall / 30) * 1000) / 1000,
    }));
}

/** Ranks the offsets that land a strong moment on the end card. A person still confirms the choice by ear. */
export function backtime(request: {
  map: AudioMap;
  filmSec: number;
  endCardFrame: number;
  fps: number;
  drafts?: CueDraft[];
  audioMapPath?: string;
  top?: number;
}): { candidates: BacktimeCandidate[]; excludedBeforeTrackStart: number; endCardSec: number } {
  const { map, filmSec, fps } = request;
  const endCardSec = request.endCardFrame / fps;
  const drafts = request.drafts ?? [];
  const moments = [...map.keyMoments, ...endingCandidates(map)];
  let excludedBeforeTrackStart = 0;
  const ranked: BacktimeCandidate[] = [];
  for (const moment of moments) {
    const offsetSec = Math.round((moment.timeSec - endCardSec) * 1000) / 1000;
    if (offsetSec < 0) {
      excludedBeforeTrackStart += 1;
      continue;
    }
    const remaining = map.source.durationSec - offsetSec;
    const tailShortSec = Math.round(Math.max(0, filmSec - remaining) * 1000) / 1000;
    const unanchored = drafts.length
      ? snapCues({ drafts, map, fps, musicOffsetSec: offsetSec, audioMapPath: request.audioMapPath ?? "" }).unanchored
          .length
      : 0;
    const cuesOnAnchors = drafts.length - unanchored;
    const fit = drafts.length ? cuesOnAnchors / drafts.length : 0;
    const score = (KIND_WEIGHT[moment.kind] ?? 0.6) * moment.strength + 0.5 * fit - 0.15 * tailShortSec;
    ranked.push({
      offsetSec,
      anchorSec: moment.timeSec,
      kind: moment.kind,
      strength: moment.strength,
      landsOnFrame: Math.round((moment.timeSec - offsetSec) * fps),
      cuesOnAnchors,
      cuesTotal: drafts.length,
      tailShortSec,
      score: Math.round(score * 1000) / 1000,
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.offsetSec - b.offsetSec);
  const unique: BacktimeCandidate[] = [];
  // Neighbouring attacks of one ending are one choice, not five.
  for (const candidate of ranked)
    if (unique.every((other) => Math.abs(other.offsetSec - candidate.offsetSec) >= DISTINCT_OFFSET_SEC))
      unique.push(candidate);
  return { candidates: unique.slice(0, request.top ?? 5), excludedBeforeTrackStart, endCardSec };
}
