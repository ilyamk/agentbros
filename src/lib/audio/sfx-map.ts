// sfx:map: where a recording's sound effects are, by cue family, from Earshot's semantic search (prepared earshot-find).
// The merge and summary are pure; the search is injected, so tests run without the model.
import type { SfxMap, SfxMapEvent } from "../../types/sfx-map";
import type { SoundKind } from "./cut-decisions";

/** One description per cue family; fixed, so maps of different films compare. */
export const SFX_MAP_QUERIES: Readonly<Record<SoundKind, string>> = {
  whoosh: "a fast whoosh swoosh passing by",
  impact: "a heavy impact hit boom",
  riser: "a rising riser build-up swell",
  click: "a short interface click",
  pop: "a soft bubble pop",
  chime: "a bright chime ding notification",
  tick: "a single clock tick",
  glass: "a glass clink",
  "sub-drop": "a deep sub bass drop",
};
/** Segments per family Earshot returns (its bound is 20). */
export const SFX_MAP_TOP = 20;
/** Two events sharing more than this share of the shorter one are one sound: the higher z keeps it. */
export const OVERLAP_SHARE = 0.5;

export const SFX_MAP_NOTICE =
  "Candidate sound events from a semantic model, advisory: music hits can read as impacts and quiet sounds can be missed. Agents cannot hear; compare densities, not taste.";

export type FoundSegment = { start: number; end: number; z: number; verdict: string; peak_dbfs: number | null };

const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

/** Keeps strong and plausible segments; an overlap goes to the family with the higher z. Pure, ordered by time. */
export function mergeSfxSegments(found: { kind: SoundKind; segments: FoundSegment[] }[]): SfxMapEvent[] {
  const candidates = found
    .flatMap(({ kind, segments }) =>
      segments
        .filter((segment) => segment.verdict === "strong" || segment.verdict === "plausible")
        .map((segment) => ({
          kind,
          startSec: round(segment.start),
          endSec: round(segment.end),
          z: segment.z,
          verdict: segment.verdict as SfxMapEvent["verdict"],
          peakDbfs: segment.peak_dbfs,
        })),
    )
    .sort((a, b) => b.z - a.z || a.startSec - b.startSec || a.kind.localeCompare(b.kind));
  const kept: SfxMapEvent[] = [];
  for (const event of candidates) {
    const clash = kept.some((other) => {
      const shared = Math.min(other.endSec, event.endSec) - Math.max(other.startSec, event.startSec);
      const shorter = Math.min(other.endSec - other.startSec, event.endSec - event.startSec);
      return shared > 0 && shorter > 0 && shared / shorter > OVERLAP_SHARE;
    });
    if (!clash) kept.push(event);
  }
  return kept.sort((a, b) => a.startSec - b.startSec || a.kind.localeCompare(b.kind));
}

/** Counts, densities and the longest event-free stretches over the analysed range. Pure. */
export function summariseSfxMap(events: SfxMapEvent[], range: { startSec: number; endSec: number }): SfxMap["summary"] {
  const minutes = Math.max(1e-6, (range.endSec - range.startSec) / 60);
  const byKind: SfxMap["summary"]["byKind"] = {};
  for (const event of events) {
    const row = (byKind[event.kind] ??= { count: 0, perMinute: 0 });
    row.count += 1;
  }
  for (const row of Object.values(byKind)) row.perMinute = round(row.count / minutes, 2);
  const gaps: SfxMap["summary"]["longestGaps"] = [];
  let cursor = range.startSec;
  for (const event of [...events].sort((a, b) => a.startSec - b.startSec)) {
    if (event.startSec > cursor)
      gaps.push({
        startSec: round(cursor),
        endSec: round(event.startSec),
        durationSec: round(event.startSec - cursor),
      });
    cursor = Math.max(cursor, event.endSec);
  }
  if (range.endSec > cursor)
    gaps.push({ startSec: round(cursor), endSec: round(range.endSec), durationSec: round(range.endSec - cursor) });
  return {
    events: events.length,
    perMinute: round(events.length / minutes, 2),
    byKind,
    longestGaps: gaps.sort((a, b) => b.durationSec - a.durationSec || a.startSec - b.startSec).slice(0, 3),
  };
}

/** Placed sounds per minute by family (primaries only: a hero's layers are one sound event). Pure. */
export function placedDensity(
  events: { sfx: string; layerOf?: string }[],
  durationSec: number,
): { events: number; perMinute: number; byKind: Record<string, number> } {
  const primaries = events.filter((event) => !event.layerOf);
  const minutes = Math.max(1e-6, durationSec / 60);
  const byKind: Record<string, number> = {};
  for (const event of primaries) {
    const kind = event.sfx === "hit" ? "impact" : event.sfx;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return {
    events: primaries.length,
    perMinute: round(primaries.length / minutes, 2),
    byKind: Object.fromEntries(Object.entries(byKind).map(([kind, count]) => [kind, round(count / minutes, 2)])),
  };
}

/** The critic's side-by-side: the reference's candidate density beside ours, per minute and per family. */
export function sfxDensityComparison(
  reference: SfxMap,
  placed: { sfx: string; layerOf?: string }[],
  durationSec: number,
) {
  const ours = placedDensity(placed, durationSec);
  const kinds = [...new Set([...Object.keys(reference.summary.byKind), ...Object.keys(ours.byKind)])].sort();
  return {
    note: "Per minute. Reference: Earshot candidate events (advisory); ours: placed primary sounds from sound-cues.json.",
    perMinute: { reference: reference.summary.perMinute, ours: ours.perMinute },
    byKind: Object.fromEntries(
      kinds.map((kind) => [
        kind,
        { reference: reference.summary.byKind[kind]?.perMinute ?? 0, ours: ours.byKind[kind] ?? 0 },
      ]),
    ),
    referenceLongestGaps: reference.summary.longestGaps,
  };
}

/** The map from each family's search result. Pure: the caller ran Earshot `find` once per family on the same bytes. */
export function assembleSfxMap(input: {
  source: SfxMap["source"];
  analysedRange: SfxMap["analysedRange"];
  modelRevision: string;
  packageSha: string;
  found: { kind: SoundKind; segments: FoundSegment[] }[];
}): SfxMap {
  const events = mergeSfxSegments(input.found);
  return {
    version: 1,
    engine: "earshot",
    advisory: true,
    source: input.source,
    analysedRange: input.analysedRange,
    modelRevision: input.modelRevision,
    packageSha: input.packageSha,
    queries: Object.fromEntries(input.found.map(({ kind }) => [kind, SFX_MAP_QUERIES[kind]])),
    events,
    summary: summariseSfxMap(events, input.analysedRange),
    notice: SFX_MAP_NOTICE,
  };
}
