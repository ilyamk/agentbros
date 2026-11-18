import type { ReferenceEdit, ReferenceShots } from "../../types/reference";

export type CorrectedShot = {
  id: string;
  startSec: number;
  endSec: number;
  transitionIn: ReferenceShots["shots"][number]["transitionIn"];
  /** Detector shots this one overlaps: several after a merge or reject. */
  sourceShots: string[];
  split: boolean;
};

/**
 * The analyst's shot list: shots.json with edit.json corrections applied, as film:targets reads the cuts (merges and
 * rejects remove the cut at a shot's start, splits add one, moves shift one, retypes change the transition). A merge keeps its first
 * id; the parts of a split shot are `<id>.1`, `<id>.2`… Without edit.json this is the detector's list.
 */
export function correctedShots(shots: ReferenceShots, edit?: Pick<ReferenceEdit, "corrections">): CorrectedShot[] {
  const detector = shots.shots;
  if (!detector.length) return [];
  const corrections = (edit?.corrections ?? []).map((row) => row.value);
  const removed = new Set(
    corrections.flatMap((value) =>
      value.kind === "merge" ? value.shotIds.slice(1) : value.kind === "reject" ? value.shotIds : [],
    ),
  );
  removed.delete(detector[0]!.id);
  const retyped = new Map(
    corrections
      .filter((value) => value.kind === "retype" && value.transition)
      .flatMap((value) => value.shotIds.map((id) => [id, value.transition!] as const)),
  );
  const splits = corrections
    .filter((value) => value.kind === "split" && value.timeSec !== undefined)
    .map((value) => ({ timeSec: value.timeSec!, transition: value.transition }));
  const end = detector.at(-1)!.endSec;
  // A move shifts the cut before its shot; the first shot has no cut to move, and a move outside the film is ignored.
  const moved = new Map(
    corrections
      .filter((value) => value.kind === "move" && value.toSec !== undefined && value.toSec > 0 && value.toSec < end)
      .map((value) => [value.shotIds[0]!, value.toSec!] as const),
  );
  moved.delete(detector[0]!.id);
  type Edge = { timeSec: number; shot?: (typeof detector)[number]; transition?: CorrectedShot["transitionIn"] };
  const edges: Edge[] = [
    ...detector
      .filter((shot, index) => index === 0 || !removed.has(shot.id))
      .map((shot) => ({ timeSec: moved.get(shot.id) ?? shot.startSec, shot })),
    ...splits
      .filter(
        (split) =>
          split.timeSec > 0 &&
          split.timeSec < end &&
          !detector.some((shot) => Math.abs((moved.get(shot.id) ?? shot.startSec) - split.timeSec) < 1e-3),
      )
      .map((split) => ({ timeSec: split.timeSec, transition: split.transition })),
  ].sort((a, b) => a.timeSec - b.timeSec);
  const spans: {
    owner: string;
    startSec: number;
    endSec: number;
    transitionIn: CorrectedShot["transitionIn"];
    sourceShots: string[];
  }[] = [];
  edges.forEach((edge, index) => {
    const endSec = edges[index + 1]?.timeSec ?? end;
    const sourceShots = detector
      .filter((shot) => shot.startSec < endSec - 1e-9 && shot.endSec > edge.timeSec + 1e-9)
      .map((shot) => shot.id);
    // A split part belongs to the corrected shot it cuts into, which may itself be a merge.
    const owner = edge.shot?.id ?? spans.at(-1)?.owner ?? detector[0]!.id;
    spans.push({
      owner,
      startSec: edge.timeSec,
      endSec,
      transitionIn: edge.shot ? (retyped.get(edge.shot.id) ?? edge.shot.transitionIn) : (edge.transition ?? "cut"),
      sourceShots: sourceShots.length ? sourceShots : [owner],
    });
  });
  const parts = new Map<string, number>();
  for (const span of spans) parts.set(span.owner, (parts.get(span.owner) ?? 0) + 1);
  const seen = new Map<string, number>();
  return spans.map((span) => {
    const split = (parts.get(span.owner) ?? 0) > 1;
    const index = (seen.get(span.owner) ?? 0) + 1;
    seen.set(span.owner, index);
    return {
      id: split ? `${span.owner}.${index}` : span.owner,
      startSec: span.startSec,
      endSec: span.endSec,
      transitionIn: span.transitionIn,
      sourceShots: span.sourceShots,
      split,
    };
  });
}
