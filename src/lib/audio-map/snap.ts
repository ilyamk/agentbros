import { readFileSync } from "node:fs";
import { z } from "zod";
import { CliErrorObject, requireFile } from "../cli";
import { leadFrame, type LeadOverrides } from "./leads";
import {
  CueKindSchema,
  CueSheetSchema,
  CueSilenceSchema,
  CueSnapSchema,
  SfxKindSchema,
  type AudioMap,
  type CueSheet,
} from "../../types/film";

export const CueDraftSchema = z.object({
  id: z.string().min(1),
  kind: CueKindSchema,
  intentSec: z.number().finite().nonnegative(),
  snap: CueSnapSchema.optional(),
  shotId: z.string().optional(),
  sfx: z.string().optional(),
  silent: CueSilenceSchema.optional(),
  layers: z
    .array(SfxKindSchema.exclude(["none"]))
    .min(1)
    .optional(),
  weight: z.enum(["hero", "support"]).optional(),
});
export type CueDraft = z.infer<typeof CueDraftSchema>;

type CueKind = z.infer<typeof CueKindSchema>;
type Snap = z.infer<typeof CueSnapSchema>;
type SheetCue = CueSheet["cues"][number];

export const STRONG_TOLERANCE_SEC = 0.15;
export const SMALL_TOLERANCE_SEC = 0.1;
const STRONG_KINDS: readonly CueKind[] = ["cut", "transition", "reveal", "stop"];
const HARD_KINDS: readonly CueKind[] = ["cut", "transition"];
const STRONG_EVENT = 0.5;
const USABLE_EVENT = 0.3;

type Anchor = { sec: number; snap: Exclude<Snap, "none">; kind: string; rank: number };

/** Phrase and section starts of the music's form, when the map has one. */
function structureAnchors(map: AudioMap) {
  const structure = map.structure;
  if (!structure) return [];
  return [
    ...structure.phrases
      .filter((phrase) => phrase.startSec > 0)
      .map((phrase) => ({ sec: phrase.startSec, snap: "phrase" as const, kind: "phrase-start", rank: 2 })),
    ...structure.sections
      .filter((section) => section.startSec > 0)
      .map((section) => ({ sec: section.startSec, snap: "phrase" as const, kind: `${section.label}-start`, rank: 2 })),
  ];
}

/** Every anchor of a map in film seconds. Anything before the film's first frame is out of reach. */
function collectAnchors(map: AudioMap, offsetSec: number) {
  const film = (trackSec: number) => trackSec - offsetSec;
  const make = (list: { sec: number; snap: Anchor["snap"]; kind: string; rank: number }[]) =>
    list.map((item) => ({ ...item, sec: film(item.sec) })).filter((item) => item.sec >= 0);
  return {
    keyMoments: make(
      map.keyMoments.map((moment) => ({
        sec: moment.timeSec,
        snap: "key-moment" as const,
        kind: moment.kind,
        rank: 0,
      })),
    ),
    downbeats: make(map.downbeatsSec.map((sec) => ({ sec, snap: "downbeat" as const, kind: "downbeat", rank: 1 }))),
    beats: make(map.beatsSec.map((sec) => ({ sec, snap: "beat" as const, kind: "beat", rank: 4 }))),
    phrases: make([
      ...map.phrases.map((phrase) => ({
        sec: phrase.startSec,
        snap: "phrase" as const,
        kind: "phrase-start",
        rank: 2,
      })),
      ...map.sections.map((section) => ({
        sec: section.startSec,
        snap: "phrase" as const,
        kind: "section-start",
        rank: 2,
      })),
      ...structureAnchors(map),
    ]),
    strongHits: make(
      map.events
        .filter(
          (event) =>
            (event.kind === "kick" || event.kind === "snare") &&
            event.strength >= STRONG_EVENT &&
            (event.metric === "beat" || event.metric === "downbeat"),
        )
        .map((event) => ({ sec: event.timeSec, snap: "event" as const, kind: event.kind, rank: 3 })),
    ),
    events: make(
      map.events
        .filter((event) => event.strength >= USABLE_EVENT)
        .map((event) => ({ sec: event.timeSec, snap: "event" as const, kind: event.kind, rank: 5 })),
    ),
    silenceStarts: make(
      map.silences.map((silence) => ({
        sec: silence.startSec,
        snap: "key-moment" as const,
        kind: "silence-start",
        rank: 1,
      })),
    ),
  };
}

type Anchors = ReturnType<typeof collectAnchors>;

export const isReliable = (map: AudioMap): boolean => map.tempo.gridTrust === "reliable";

/** What a cue may land on, and how far it may move. Without a reliable grid, beats and downbeats never enter the search. */
function candidatesFor(
  draft: CueDraft,
  anchors: Anchors,
  reliable: boolean,
): { pool: Anchor[]; tolerance: number; demoted: boolean } {
  const measured = [...anchors.keyMoments, ...anchors.phrases];
  const strong = STRONG_KINDS.includes(draft.kind);
  const stops = draft.kind === "stop" ? anchors.silenceStarts : [];
  switch (draft.snap) {
    case "key-moment":
      return { pool: [...anchors.keyMoments, ...stops], tolerance: STRONG_TOLERANCE_SEC, demoted: false };
    case "phrase":
      return { pool: anchors.phrases, tolerance: STRONG_TOLERANCE_SEC, demoted: false };
    case "event":
      return { pool: anchors.events, tolerance: SMALL_TOLERANCE_SEC, demoted: false };
    case "downbeat":
      return reliable
        ? { pool: anchors.downbeats, tolerance: STRONG_TOLERANCE_SEC, demoted: false }
        : { pool: [...measured, ...stops], tolerance: STRONG_TOLERANCE_SEC, demoted: true };
    case "beat":
      return reliable
        ? { pool: [...anchors.downbeats, ...anchors.beats], tolerance: SMALL_TOLERANCE_SEC, demoted: false }
        : { pool: measured, tolerance: SMALL_TOLERANCE_SEC, demoted: true };
    default:
      break;
  }
  if (!reliable)
    return {
      pool: [...measured, ...stops],
      tolerance: strong ? STRONG_TOLERANCE_SEC : SMALL_TOLERANCE_SEC,
      demoted: false,
    };
  if (strong)
    return {
      pool: [...measured, ...anchors.downbeats, ...anchors.strongHits, ...stops],
      tolerance: STRONG_TOLERANCE_SEC,
      demoted: false,
    };
  return {
    pool: [
      ...anchors.keyMoments,
      ...anchors.downbeats,
      ...anchors.beats,
      ...(draft.kind === "sfx" ? anchors.events : []),
    ],
    tolerance: SMALL_TOLERANCE_SEC,
    demoted: false,
  };
}

export type Unanchored = {
  id: string;
  kind: CueKind;
  intentSec: number;
  reason: string;
  nearestSec?: number;
  nearestDeltaSec?: number;
};

const roundMs = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Moves each cue to the nearest suitable anchor. The tolerance is checked on the delivered frame, so a cue never
 * moves further than promised through rounding. A cue with no anchor keeps its intent on the nearest frame with
 * `snap: "none"` and is named in `unanchored`: a cue sheet with holes is more honest than a cut on nothing.
 */
export function snapCues(request: {
  drafts: CueDraft[];
  map: AudioMap;
  fps: number;
  musicOffsetSec: number;
  audioMapPath: string;
  leadFrames?: LeadOverrides | false;
}): { sheet: CueSheet; unanchored: Unanchored[]; warnings: string[] } {
  const { drafts, map, fps, musicOffsetSec } = request;
  const deliver = (anchor: number, kind: CueKind) =>
    request.leadFrames === false ? anchor : leadFrame(anchor, kind, request.leadFrames);
  if (new Set(drafts.map((draft) => draft.id)).size !== drafts.length)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Cue ids must be unique." });
  const anchors = collectAnchors(map, musicOffsetSec);
  const reliable = isReliable(map);
  const halfFrame = 0.5 / fps;
  const unanchored: Unanchored[] = [];
  const warnings: string[] = [];
  const cues: SheetCue[] = [];
  let lastHardFrame = -1;
  for (const draft of [...drafts].sort((a, b) => a.intentSec - b.intentSec || a.id.localeCompare(b.id))) {
    const held = (extra: Partial<SheetCue>): SheetCue => {
      const frame = Math.round(draft.intentSec * fps);
      return {
        id: draft.id,
        kind: draft.kind,
        intentSec: draft.intentSec,
        snap: "none",
        snappedSec: frame / fps,
        frame,
        deltaSec: roundMs(frame / fps - draft.intentSec),
        ...(draft.shotId ? { shotId: draft.shotId } : {}),
        ...(draft.sfx ? { sfx: draft.sfx } : {}),
        ...(draft.silent ? { silent: draft.silent } : {}),
        ...(draft.layers ? { layers: draft.layers } : {}),
        ...(draft.weight ? { weight: draft.weight } : {}),
        ...extra,
      };
    };
    if (draft.snap === "none") {
      cues.push(held({}));
      continue;
    }
    const { pool, tolerance, demoted } = candidatesFor(draft, anchors, reliable);
    if (demoted)
      warnings.push(
        `${draft.id}: asked for ${draft.snap}, but the grid is ${map.tempo.gridTrust}; searched phrases, sections and key moments instead.`,
      );
    const hard = HARD_KINDS.includes(draft.kind);
    const fitting = pool
      .map((anchor) => {
        const frame = Math.round(anchor.sec * fps);
        return { anchor, frame, sec: frame / fps, distance: Math.abs(anchor.sec - draft.intentSec) };
      })
      .filter(
        (item) =>
          Math.abs(item.sec - draft.intentSec) <= tolerance + 1e-9 &&
          (!hard || deliver(item.frame, draft.kind) > lastHardFrame),
      )
      // Anchors on the same frame are one choice: the more meaningful one names it.
      .sort(
        (a, b) =>
          (Math.abs(a.distance - b.distance) < halfFrame ? a.anchor.rank - b.anchor.rank : a.distance - b.distance) ||
          a.frame - b.frame,
      );
    const best = fitting[0];
    if (!best) {
      const nearest = pool.reduce<number | undefined>(
        (found, anchor) =>
          found === undefined || Math.abs(anchor.sec - draft.intentSec) < Math.abs(found - draft.intentSec)
            ? anchor.sec
            : found,
        undefined,
      );
      unanchored.push({
        id: draft.id,
        kind: draft.kind,
        intentSec: draft.intentSec,
        reason: nearest === undefined ? "the map has no suitable anchor" : `no suitable anchor within ${tolerance} s`,
        ...(nearest === undefined
          ? {}
          : { nearestSec: roundMs(nearest), nearestDeltaSec: roundMs(nearest - draft.intentSec) }),
      });
      const cue = held({});
      if (hard) lastHardFrame = Math.max(lastHardFrame, cue.frame);
      cues.push(cue);
      continue;
    }
    const frame = deliver(best.frame, draft.kind);
    if (hard) lastHardFrame = frame;
    cues.push(
      held({
        snap: best.anchor.snap,
        snappedSec: best.sec,
        frame,
        deltaSec: roundMs(best.sec - draft.intentSec),
        anchorKind: best.anchor.kind,
        ...(frame === best.frame ? {} : { anchorFrame: best.frame, leadFrames: best.frame - frame }),
      }),
    );
  }
  const sheet = CueSheetSchema.parse({
    schemaVersion: 1,
    fps,
    audioMapPath: request.audioMapPath,
    musicOffsetSec,
    cues,
  });
  return { sheet, unanchored, warnings };
}

// --- Starting from the music ---

/** Multipliers of a section's shot length, so that cuts never settle into one pulse. */
const RHYTHM = [1.5, 0.6, 1, 2, 0.7, 1.25, 0.5, 1.75];
const LEVEL_SHOT_SEC = { low: 3.2, mid: 2, high: 1.2 } as const;
const WEIGHT: Record<string, number> = {
  "key-moment": 1,
  downbeat: 0.9,
  phrase: 0.8,
  hit: 0.75,
  event: 0.5,
  beat: 0.4,
};

export type SuggestedSection = {
  startSec: number;
  endSec: number;
  level: string;
  density: number;
  targetShotSec: number;
  cuts: number;
};

/** Proposes cuts from the map alone: length by each section's level and density, varied, with silences left open. */
export function suggestCuts(request: {
  map: AudioMap;
  fps: number;
  musicOffsetSec: number;
  audioMapPath: string;
  filmSec?: number;
}): { sheet: CueSheet; sections: SuggestedSection[]; stats: Record<string, number> } {
  const { map, fps, musicOffsetSec } = request;
  const reliable = isReliable(map);
  const anchors = collectAnchors(map, musicOffsetSec);
  const filmEnd = Math.min(request.filmSec ?? Infinity, map.source.durationSec - musicOffsetSec);
  const minGap = Math.max(0.35, 10 / fps);
  const silences = map.silences.map((silence) => ({
    startSec: silence.startSec - musicOffsetSec,
    endSec: silence.endSec - musicOffsetSec,
  }));
  const open = (sec: number) =>
    sec >= minGap &&
    sec <= filmEnd - minGap &&
    !silences.some((silence) => sec >= silence.startSec - 0.02 && sec <= silence.endSec);
  const pool = [
    ...anchors.keyMoments.filter((anchor) => anchor.kind !== "hard-stop" && anchor.kind !== "drop"),
    ...anchors.phrases,
    ...(reliable
      ? [...anchors.downbeats, ...anchors.strongHits.map((hit) => ({ ...hit, kind: "hit" })), ...anchors.beats]
      : anchors.events.filter((event) => event.kind !== "onset")),
  ].filter((anchor) => open(anchor.sec));
  const weightOf = (anchor: Anchor) => (anchor.kind === "hit" ? WEIGHT.hit! : (WEIGHT[anchor.snap] ?? 0.4));
  const fixed = new Map<number, Anchor>();
  const keep = (anchor: Anchor | undefined) => {
    if (!anchor || !open(anchor.sec)) return;
    if ([...fixed.values()].every((other) => Math.abs(other.sec - anchor.sec) >= minGap))
      fixed.set(Math.round(anchor.sec * fps), anchor);
  };
  for (const moment of map.keyMoments
    .filter(
      (item) => item.strength >= 0.5 && (item.kind === "surge" || item.kind === "impact" || item.kind === "riser-end"),
    )
    .sort((a, b) => b.strength - a.strength || a.timeSec - b.timeSec))
    keep(anchors.keyMoments.find((anchor) => Math.abs(anchor.sec - (moment.timeSec - musicOffsetSec)) < 1e-6));
  for (const section of map.sections) {
    const start = section.startSec - musicOffsetSec;
    keep(
      pool
        .filter((anchor) => Math.abs(anchor.sec - start) <= STRONG_TOLERANCE_SEC)
        .sort((a, b) => a.rank - b.rank || Math.abs(a.sec - start) - Math.abs(b.sec - start))[0],
    );
  }

  const cuts: Anchor[] = [...fixed.values()];
  const sections: SuggestedSection[] = [];
  map.sections.forEach((section, index) => {
    const start = Math.max(0, section.startSec - musicOffsetSec);
    const end = Math.min(filmEnd, section.endSec - musicOffsetSec);
    if (end <= start) return;
    const pace = Math.min(1.4, Math.max(0.7, Math.sqrt(4 / Math.max(section.density, 0.25))));
    const shot = LEVEL_SHOT_SEC[section.level] * pace * (reliable ? 1 : 1.5);
    let cursor = start;
    let step = index * 3;
    let guard = 0;
    while (cursor < end && guard++ < 500) {
      const length = shot * RHYTHM[step++ % RHYTHM.length]!;
      const target = cursor + length;
      if (target >= end) break;
      const reach = Math.max(length * 0.3, 0.12);
      const choice = pool
        .filter(
          (anchor) =>
            anchor.sec > cursor &&
            anchor.sec < end &&
            Math.abs(anchor.sec - target) <= reach &&
            cuts.every((cut) => Math.abs(cut.sec - anchor.sec) >= minGap),
        )
        .map((anchor) => ({ anchor, score: weightOf(anchor) * (1.2 - Math.abs(anchor.sec - target) / reach) }))
        .sort((a, b) => b.score - a.score || a.anchor.sec - b.anchor.sec)[0];
      if (choice) cuts.push(choice.anchor);
      // Nothing nearby: the shot simply runs on. An invented cut would be worse than a long hold.
      cursor = choice ? choice.anchor.sec : target;
    }
    sections.push({
      startSec: section.startSec,
      endSec: section.endSec,
      level: section.level,
      density: section.density,
      targetShotSec: Math.round(shot * 100) / 100,
      cuts: 0,
    });
  });

  const seen = new Set<number>();
  const ordered = cuts
    .map((anchor) => ({ anchor, frame: Math.round(anchor.sec * fps) }))
    .sort((a, b) => a.frame - b.frame)
    .filter(({ frame }) => (seen.has(frame) ? false : (seen.add(frame), true)));
  for (const item of sections)
    item.cuts = ordered.filter(
      ({ anchor }) => anchor.sec + musicOffsetSec >= item.startSec && anchor.sec + musicOffsetSec < item.endSec,
    ).length;
  const cues: SheetCue[] = ordered.map(({ anchor, frame }, index) => ({
    id: `cut-${String(index + 1).padStart(3, "0")}`,
    kind: "cut",
    intentSec: roundMs(anchor.sec),
    snap: anchor.snap,
    snappedSec: frame / fps,
    frame,
    deltaSec: roundMs(frame / fps - anchor.sec),
    anchorKind: anchor.kind,
  }));
  const sheet = CueSheetSchema.parse({
    schemaVersion: 1,
    fps,
    audioMapPath: request.audioMapPath,
    musicOffsetSec,
    cues,
  });
  const edges = [0, ...ordered.map(({ frame }) => frame / fps), filmEnd];
  const lengths = edges
    .slice(1)
    .map((edge, index) => edge - edges[index]!)
    .sort((a, b) => a - b);
  const at = (share: number) => lengths[Math.min(lengths.length - 1, Math.floor(share * lengths.length))] ?? 0;
  const beatCount = anchors.beats.filter((beat) => open(beat.sec)).length;
  const onBeats = ordered.filter(({ anchor }) =>
    anchors.beats.some((beat) => Math.abs(beat.sec - anchor.sec) < 0.02),
  ).length;
  const stats = {
    cuts: cues.length,
    minShotSec: roundMs(lengths[0] ?? 0),
    medianShotSec: roundMs(at(0.5)),
    maxShotSec: roundMs(lengths.at(-1) ?? 0),
    shotLengthVariety: roundMs(at(0.9) / Math.max(at(0.1), 1e-3)),
    beatsUsedShare: beatCount ? roundMs(onBeats / beatCount) : 0,
  };
  return { sheet, sections, stats };
}

export function readCueDrafts(file: string): CueDraft[] {
  requireFile(file);
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : (raw as { cues?: unknown }).cues;
  if (!Array.isArray(list))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${file} must be an array of cue drafts or an object with a "cues" array.`,
    });
  return z.array(CueDraftSchema).parse(list);
}
