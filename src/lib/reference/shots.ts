import { z } from "zod";
import { sceneScoreCurve } from "../ingest";
import { ReferenceShotsSchema, ShotTransitionSchema, type ReferenceShots } from "../../types/reference";
import { runWorker } from "./worker";

export type Boundary = {
  timeSec: number;
  startSec: number;
  endSec: number;
  kind: z.infer<typeof ShotTransitionSchema>;
  confidence: number;
  measures?: Record<string, number>;
};

type WorkerShots = {
  engine: string;
  version: string;
  params: Record<string, number>;
  boundaries: Boundary[];
  candidates: ReferenceShots["candidates"];
};

const round = (value: number) => Math.round(value * 1000) / 1000;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
};

export function shotsLayer(
  referenceId: string,
  durationSec: number,
  boundaries: Boundary[],
  detector: ReferenceShots["detector"],
  status?: ReferenceShots["status"],
  candidates: ReferenceShots["candidates"] = [],
): ReferenceShots {
  const starts = boundaries.filter((row) => row.timeSec > 0.001 && row.timeSec < durationSec - 0.001);
  const shots = [undefined, ...starts].map((row, index) => {
    const startSec = row ? round(row.timeSec) : 0;
    const endSec = index < starts.length ? round(starts[index]!.timeSec) : round(durationSec);
    const gradual = row && row.endSec > row.startSec;
    return {
      id: `s${String(index + 1).padStart(3, "0")}`,
      startSec,
      endSec,
      transitionIn: row?.kind ?? ("unknown" as const),
      transitionConfidence: row?.confidence ?? 0,
      ...(gradual ? { transitionStartSec: round(row.startSec), transitionEndSec: round(row.endSec) } : {}),
      ...(row?.measures ? { transitionMeasures: row.measures } : {}),
    };
  });
  return ReferenceShotsSchema.parse({
    schemaVersion: 1,
    referenceId,
    ...(status ? { status } : {}),
    detector,
    shots,
    candidates,
    summary: {
      count: shots.length,
      medianDurationSec: round(median(shots.map((shot) => shot.endSec - shot.startSec))),
      cutsPerMinute: round(((shots.length - 1) / durationSec) * 60),
    },
  });
}

/** Peak picking over ffmpeg's per-frame scene score, relative to the film's own level so soft changes still register. */
export function pickScorePeaks(curve: { timeSec: number; score: number }[], minimumGapSec = 0.4): Boundary[] {
  if (!curve.length) return [];
  const scores = curve.map((row) => row.score);
  const centre = median(scores);
  const spread = median(scores.map((score) => Math.abs(score - centre)));
  const floor = Math.max(0.03, centre + 10 * spread);
  const found: Boundary[] = [];
  const ranked = curve
    .map((row, index) => ({ ...row, index }))
    .filter((row) => row.score >= floor)
    .sort((a, b) => b.score - a.score);
  for (const row of ranked) {
    if (found.some((other) => Math.abs(other.timeSec - row.timeSec) < minimumGapSec)) continue;
    const neighbours = [
      ...scores.slice(Math.max(0, row.index - 3), row.index),
      ...scores.slice(row.index + 1, row.index + 4),
    ];
    const sharp = row.score > 4 * Math.max(median(neighbours), 0.005);
    found.push({
      timeSec: row.timeSec,
      startSec: row.timeSec,
      endSec: row.timeSec,
      kind: sharp ? "cut" : "unknown",
      confidence: sharp ? Math.min(0.7, 0.4 + row.score) : 0.25,
      measures: { sceneScore: round(row.score) },
    });
  }
  return found.sort((a, b) => a.timeSec - b.timeSec);
}

export function detectBoundaries(media: string): {
  boundaries: Boundary[];
  candidates?: ReferenceShots["candidates"];
  detector: ReferenceShots["detector"];
  status: NonNullable<ReferenceShots["status"]>;
} {
  const worker = runWorker<WorkerShots>("shots", media);
  if (worker.ok)
    return {
      boundaries: worker.value.boundaries,
      candidates: worker.value.candidates,
      detector: { name: worker.value.engine, version: worker.value.version, params: worker.value.params },
      status: { available: true, engine: worker.value.engine },
    };
  return {
    boundaries: pickScorePeaks(sceneScoreCurve(media)),
    detector: {
      name: "ffmpeg-scene-score",
      params: { relativeFloor: "median + 10 MAD, minimum 0.03", minimumGapSec: 0.4 },
    },
    status: {
      available: true,
      engine: "ffmpeg-scene-score",
      unavailableReason: `Fell back from PySceneDetect, so gradual transitions are not classified. ${worker.reason}`,
      fix: worker.fix,
    },
  };
}

export function analyseShots(referenceId: string, media: string, durationSec: number): ReferenceShots {
  try {
    const { boundaries, candidates, detector, status } = detectBoundaries(media);
    return shotsLayer(referenceId, durationSec, boundaries, detector, status, candidates);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return shotsLayer(
      referenceId,
      durationSec,
      [],
      { name: "none", params: {} },
      {
        available: false,
        unavailableReason: `Shot detection failed: ${reason}`,
        fix: "Install ffmpeg (brew install ffmpeg) and uv, then rerun ref:analyze --layers shots.",
      },
    );
  }
}
