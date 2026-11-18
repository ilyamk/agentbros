// Pure: block cues → placed sound events. Shared by <CueSounds> (Remotion) and `sfx:cues` (audio:mix plan).
import type { Cue, SfxKind } from "../../motion/library/types";
import type { SynthSfxKind } from "./sfx-synth";

/**
 * A block cue, or a decision from the cue sheet. `decided` cues replace the sounds of undecided cues of the same family
 * (cut; or reveal, hit, land) within 2 frames; `silent` places nothing and is recorded; `layers` add sounds to a hero cue.
 */
export type PlannedCue = Cue & {
  decided?: boolean;
  silent?: { reason: string };
  layers?: Exclude<SfxKind, "none">[];
  /** A sound chosen for this cue (sfx:audition): placed instead of the library pick when its kind and pre-roll fit. */
  sound?: LibrarySound;
};

/** One block on the film timeline, with the cues its `cues(props)` returned. */
export type PlacedBlock = { blockId: string; startFrame: number; cues: PlannedCue[] };

/** What the planner needs from a pack entry (see `pack.json`). */
export type PackSound = {
  kind: SynthSfxKind;
  file: string;
  alignSec: number;
  durationSec: number;
  lengthFrames?: number;
};

/**
 * A measured sound from the SFX index (`sfx:index`), as the planner needs it. Pure data, so the
 * planner stays pure; `librarySounds()` in sfx-index.ts builds these from an index.
 */
export type LibrarySound = {
  kind: Exclude<SfxKind, "none">;
  /** Path under `public/`. */
  file: string;
  durationSec: number;
  onsetSec: number;
  peakSec: number;
  /** Explicit measured phase for a selected generated take; absent preserves the library default. */
  alignSec?: number;
  tailSec: number;
  dynamics: "impulse" | "swell" | "sweep" | "sustain" | "texture";
  /** Measured loudness; the gain is trimmed towards the synth pack's level (-20 LUFS), within 0.5x to 1.6x. */
  integratedLufs?: number | null;
};

const LIBRARY_REFERENCE_LUFS = -20;
const loudnessTrim = (sound: LibrarySound | undefined) =>
  sound?.integratedLufs == null
    ? 1
    : Math.min(1.6, Math.max(0.5, 10 ** ((LIBRARY_REFERENCE_LUFS - sound.integratedLufs) / 20)));

export type SoundEvent = {
  id: string;
  blockId: string;
  sfx: SynthSfxKind;
  weight: "hero" | "support";
  /** Film frame of the picture event the sound belongs to. */
  cueFrame: number;
  /** Film frame the file starts on: `cueFrame` minus the file's own alignment (the riser's whole length). */
  startFrame: number;
  durationInFrames: number;
  fileDurationSec: number;
  /** Path under `public/`, for `staticFile()`. */
  file: string;
  gain: number;
  label?: string;
  /** "library" when picked from the measured index, "synth" for the pack. */
  origin?: "library" | "synth";
  /** Seconds into the file placed on the cue frame. */
  alignSec?: number;
  /** Seconds into the file where its attack starts, when the sound was measured (library or Earshot take). */
  onsetSec?: number;
  /** A layer of a hero cue: the id of the cue's primary event, and its role in the stack. */
  layerOf?: string;
  layer?: LayerRole;
};

export type DroppedCue = { id: string; blockId: string; cueFrame: number; sfx: SfxKind; reason: string };
/** A deliberate silence: no sound, kept so sensors can tell it from a forgotten cue. */
export type SilentCue = {
  id: string;
  blockId: string;
  cueFrame: number;
  kind: Cue["kind"];
  reason: string;
  label?: string;
};

/** Where a layer sits in a hero stack: the attack, the body after it, the tail under it, or a lead that ends on the cue. */
export type LayerRole = "transient" | "body" | "tail" | "lead";
const LAYER_ROLE: Record<SynthSfxKind, LayerRole> = {
  tick: "transient",
  click: "transient",
  pop: "transient",
  glass: "transient",
  hit: "transient",
  whoosh: "body",
  chime: "body",
  "sub-drop": "tail",
  riser: "lead",
};
/** The transient lands on the frame; body and tail one frame later, so the attack reads first. */
export const LAYER_OFFSET_FRAMES: Record<LayerRole, number> = { transient: 0, body: 1, tail: 1, lead: 0 };
/** Layer gain as a share of the hero gain, capped at the support ceiling so the primary stays the loudest. */
export const LAYER_GAIN: Record<LayerRole, number> = { transient: 0.6, body: 0.55, tail: 0.65, lead: 0.5 };
const LAYER_CEILING = 0.2;
const DECISION_REACH_FRAMES = 2;
const cueFamily = (kind: Cue["kind"]) =>
  kind === "cut" ? "cut" : kind === "reveal" || kind === "hit" || kind === "land" ? "moment" : undefined;

export const SFX_TO_SYNTH: Readonly<Record<Exclude<SfxKind, "none">, SynthSfxKind>> = {
  click: "click",
  pop: "pop",
  whoosh: "whoosh",
  impact: "hit",
  chime: "chime",
  riser: "riser",
  "sub-drop": "sub-drop",
  tick: "tick",
  glass: "glass",
};

/** Hero sounds sit at 0.25–0.35, support at 0.08–0.2; small sounds sit lower in each band. */
export const HERO_GAIN = 0.3;
const SUPPORT_GAIN: Record<SynthSfxKind, number> = {
  "sub-drop": 0.18,
  hit: 0.18,
  riser: 0.15,
  whoosh: 0.14,
  chime: 0.12,
  glass: 0.12,
  pop: 0.12,
  click: 0.1,
  tick: 0.08,
};
const HERO_BY_KIND: Partial<Record<SynthSfxKind, number>> = { tick: 0.25, click: 0.25 };
/** Kinds limited to one per budget window: one riser, and one sub-drop or impact. */
const BUDGETS: { name: string; kinds: SynthSfxKind[] }[] = [
  { name: "riser", kinds: ["riser"] },
  { name: "impact", kinds: ["sub-drop", "hit"] },
];

export type CueSoundOptions = {
  fps: number;
  durationInFrames: number;
  pack: PackSound[];
  /** Directory of the pack under `public/`. Default "shared/sfx/synth". */
  packBase?: string;
  /** One riser and one impact per this many seconds. Default 15. */
  budgetWindowSec?: number;
  /** Gain multipliers, e.g. { hero: 0.9 } for a quieter film. */
  trim?: { hero?: number; support?: number };
  /** Two support sounds closer than this are one: the later is dropped. Default 2 frames. */
  minGapFrames?: number;
  /** Measured sounds to pick from first; the synth pack is the fallback. */
  library?: LibrarySound[];
  /** Seed for the choice among equally fitting sounds. Default 1. */
  seed?: number;
  /** Project the fix hints name. */
  project?: string;
};

/** sfx:synth's shortest riser (--length-frames). */
const MIN_RISER_FRAMES = 2;

/**
 * Why no take of a swelling sound fits a cue too early in the film, and the fix: a longer riser is synthesised to the
 * cue's length; any other kind (a whoosh peaks after its pre-roll) needs the cue moved later, or a transient instead.
 */
export function preRollHint(kind: SynthSfxKind, frame: number, preRollFrames: number, project = "<id>"): string {
  if (kind === "riser" && frame >= MIN_RISER_FRAMES)
    return `no riser short enough to end on frame ${frame}: run sfx:synth --project ${project} --kind riser --length-frames ${frame}`;
  return `a ${kind} needs ${preRollFrames} frame(s) before its peak and the cue is on frame ${frame}, so it would start before the film: shift the cue (or the block's start) to frame ${preRollFrames} or later, or decide a transient (impact, hit, tick) there`;
}

/** Deterministic 32-bit hash (FNV-1a) of a string, mixed with a seed. */
function hash(text: string, seed: number): number {
  let value = 2166136261 ^ seed;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return value >>> 0;
}

/** Where the sound's anchor sits in the file: a riser's or whoosh's peak, otherwise its onset. */
const anchorSec = (sound: LibrarySound) =>
  sound.alignSec ?? (sound.kind === "riser" || sound.kind === "whoosh" ? sound.peakSec : sound.onsetSec);

/**
 * Fit of a library sound to its cue: a riser as long as the run-up from the previous cue (up to
 * 4 s), a whoosh short enough to sit between its neighbours, and any tail inside the room before
 * the next cue. 0..1, deterministic.
 */
export function libraryFit(sound: LibrarySound, room: { beforeSec: number; afterSec: number }): number {
  const closeness = (actual: number, wanted: number) =>
    Math.exp(-Math.abs(Math.log(Math.max(actual, 0.02) / Math.max(wanted, 0.02))) * 1.5);
  const after = sound.durationSec - anchorSec(sound);
  if (sound.kind === "riser")
    return (
      closeness(sound.peakSec, Math.min(4, Math.max(0.5, room.beforeSec))) * (sound.dynamics === "swell" ? 1 : 0.6)
    );
  const tailRoom = Math.max(0.15, room.afterSec);
  const tailFit = after <= tailRoom ? 1 : Math.max(0.05, tailRoom / after);
  if (sound.kind === "whoosh") {
    const leadRoom = Math.max(0.1, room.beforeSec);
    return (
      tailFit *
      (sound.peakSec <= leadRoom ? 1 : Math.max(0.05, leadRoom / sound.peakSec)) *
      (sound.dynamics === "sweep" ? 1 : 0.7)
    );
  }
  return tailFit * (sound.dynamics === "impulse" ? 1 : 0.7);
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Turns every block's cues into sound events. Hero cues are placed first, so the budget keeps them;
 * a support cue that would break it is dropped and named. Sound lands on the picture frame (no lead):
 * the transient on the cue, a whoosh's peak on the cue, a riser's end on the cue. A hero cue's `layers` follow its
 * primary under the same budget and gap rules (a layer that breaks them is dropped, the primary kept). A decided cue
 * replaces undecided sounds of its family within 2 frames; a silent one places nothing and is returned in `silences`.
 */
export function planCueSounds(
  blocks: PlacedBlock[],
  options: CueSoundOptions,
): { events: SoundEvent[]; dropped: DroppedCue[]; silences: SilentCue[] } {
  const { fps, durationInFrames } = options;
  const base = (options.packBase ?? "shared/sfx/synth").replace(/\/$/, "");
  const windowFrames = Math.round((options.budgetWindowSec ?? 15) * fps);
  const minGap = options.minGapFrames ?? 2;
  const dropped: DroppedCue[] = [];
  const silences: SilentCue[] = [];
  const candidates = blocks.flatMap((block) =>
    block.cues.map((cue, index) => ({
      cue,
      block,
      id: `${block.blockId}@${block.startFrame}:${cue.label ?? cue.kind}:${index}`,
      frame: block.startFrame + cue.frame,
    })),
  );
  type Candidate = (typeof candidates)[number];
  const decided = candidates.filter((item) => item.cue.decided && cueFamily(item.cue.kind));
  const decidedNear = (item: Candidate) =>
    item.cue.decided
      ? undefined
      : decided.find(
          (other) =>
            cueFamily(other.cue.kind) === cueFamily(item.cue.kind) &&
            Math.abs(other.frame - item.frame) <= DECISION_REACH_FRAMES,
        );
  const cueFrames = [
    ...new Set(
      candidates
        .filter((item) => item.cue.sfx && item.cue.sfx !== "none" && !item.cue.silent)
        .map((item) => item.frame),
    ),
  ].sort((a, b) => a - b);
  const room = (frame: number) => {
    const before = cueFrames.filter((value) => value < frame).at(-1);
    const after = cueFrames.find((value) => value > frame);
    return { beforeSec: (frame - (before ?? 0)) / fps, afterSec: ((after ?? durationInFrames) - frame) / fps };
  };
  const events: SoundEvent[] = [];
  const pickLibrary = (sfx: Exclude<SfxKind, "none">, frame: number, id: string): LibrarySound | undefined => {
    const space = room(frame);
    // Already placed neighbours of the same kind on each side: hero cues are placed first, so both sides matter.
    const same = events.filter((event) => event.origin === "library" && SFX_TO_SYNTH[sfx] === event.sfx);
    const before = same.filter((event) => event.cueFrame < frame).sort((a, b) => b.cueFrame - a.cueFrame)[0];
    const after = same.filter((event) => event.cueFrame > frame).sort((a, b) => a.cueFrame - b.cueFrame)[0];
    const taken = new Set([before?.file, after?.file]);
    const scored = (options.library ?? [])
      .filter(
        (sound) => sound.kind === sfx && frame - Math.round(anchorSec(sound) * fps) >= 0 && !taken.has(sound.file),
      )
      .map((sound) => ({ sound, fit: libraryFit(sound, space) }))
      .sort((a, b) => b.fit - a.fit || a.sound.file.localeCompare(b.sound.file));
    const best = scored[0];
    if (!best || best.fit < 0.25) return undefined;
    const close = scored.filter((item) => item.fit >= best.fit - 0.1).slice(0, 4);
    return close[hash(id, options.seed ?? 1) % close.length]!.sound;
  };
  type Spec = {
    id: string;
    blockId: string;
    sfx: Exclude<SfxKind, "none">;
    frame: number;
    weight: "hero" | "support";
    gain: (kind: SynthSfxKind) => number;
    label?: string;
    layerOf?: string;
    layer?: LayerRole;
    /** The cue's audition choice; used when its kind matches and it starts inside the film. */
    sound?: LibrarySound;
  };
  /** Places one sound; returns why it could not. */
  const place = (spec: Spec): string | undefined => {
    const { id, frame } = spec;
    const kind = SFX_TO_SYNTH[spec.sfx];
    if (frame < 0 || frame >= durationInFrames) return "outside the film";
    const selected =
      spec.sound && spec.sound.kind === spec.sfx && frame - Math.round(anchorSec(spec.sound) * fps) >= 0
        ? spec.sound
        : undefined;
    const chosen = selected ?? pickLibrary(spec.sfx, frame, id);
    // Risers: the longest take that still starts inside the film.
    const takes = options.pack.filter((sound) => sound.kind === kind).sort((a, b) => b.alignSec - a.alignSec);
    const sound = takes.find((take) => frame - Math.round(take.alignSec * fps) >= 0);
    if (!sound && !chosen)
      return takes.length
        ? preRollHint(kind, frame, Math.min(...takes.map((take) => Math.round(take.alignSec * fps))), options.project)
        : `the pack has no ${kind}`;
    const budget = BUDGETS.find((item) => item.kinds.includes(kind));
    if (
      budget &&
      events.some((event) => budget.kinds.includes(event.sfx) && Math.abs(event.cueFrame - frame) < windowFrames)
    )
      return `budget: one ${budget.name} per ${options.budgetWindowSec ?? 15} s`;
    if (events.some((event) => event.sfx === kind && Math.abs(event.cueFrame - frame) < minGap))
      return "same sound within the minimum gap";
    const alignSec = chosen ? anchorSec(chosen) : sound!.alignSec;
    const fileDurationSec = chosen ? chosen.durationSec : sound!.durationSec;
    const startFrame = frame - Math.round(alignSec * fps);
    events.push({
      id,
      blockId: spec.blockId,
      sfx: kind,
      weight: spec.weight,
      cueFrame: frame,
      startFrame,
      durationInFrames: Math.max(1, Math.min(Math.ceil(fileDurationSec * fps), durationInFrames - startFrame)),
      fileDurationSec,
      file: chosen ? chosen.file : `${base}/${sound!.file}`,
      gain: round(round(spec.gain(kind)) * loudnessTrim(chosen)),
      ...(spec.label ? { label: spec.label } : {}),
      origin: chosen ? "library" : "synth",
      alignSec: round(alignSec),
      ...(chosen ? { onsetSec: round(chosen.onsetSec) } : {}),
      ...(spec.layerOf ? { layerOf: spec.layerOf, layer: spec.layer } : {}),
    });
    return undefined;
  };
  const heroGain = (kind: SynthSfxKind) => (HERO_BY_KIND[kind] ?? HERO_GAIN) * (options.trim?.hero ?? 1);
  const ordered = [...candidates].sort(
    (a, b) =>
      Number(b.cue.weight === "hero") - Number(a.cue.weight === "hero") ||
      a.frame - b.frame ||
      a.id.localeCompare(b.id),
  );
  for (const item of ordered) {
    const { cue, block, id, frame } = item;
    const drop = (reason: string, sfx: SfxKind = cue.sfx ?? "none", dropId = id) =>
      dropped.push({ id: dropId, blockId: block.blockId, cueFrame: frame, sfx, reason });
    if (cue.silent) {
      silences.push({
        id,
        blockId: block.blockId,
        cueFrame: frame,
        kind: cue.kind,
        reason: cue.silent.reason,
        ...(cue.label ? { label: cue.label } : {}),
      });
      continue;
    }
    if (!cue.sfx || cue.sfx === "none") continue;
    const owner = decidedNear(item);
    if (owner) {
      drop(
        owner.cue.silent
          ? `decided silent at frame ${owner.frame}: ${owner.cue.silent.reason}`
          : `replaced by the decision at frame ${owner.frame} (${owner.cue.sfx})`,
      );
      continue;
    }
    const weight = cue.weight ?? "support";
    const reason = place({
      id,
      blockId: block.blockId,
      sfx: cue.sfx,
      frame,
      weight,
      gain: (kind) => (weight === "hero" ? heroGain(kind) : SUPPORT_GAIN[kind] * (options.trim?.support ?? 1)),
      label: cue.label,
      ...(cue.sound ? { sound: cue.sound } : {}),
    });
    if (reason) {
      drop(reason);
      continue;
    }
    const layers = [...new Set(cue.layers ?? [])].filter((layer) => layer !== cue.sfx);
    if (!layers.length) continue;
    if (weight !== "hero") {
      drop("layers are for hero cues", layers[0]!, `${id}:layers`);
      continue;
    }
    const primaryGain = heroGain(SFX_TO_SYNTH[cue.sfx]);
    for (const layer of layers) {
      const role = LAYER_ROLE[SFX_TO_SYNTH[layer]];
      const layerId = `${id}:layer:${layer}`;
      const why = place({
        id: layerId,
        blockId: block.blockId,
        sfx: layer,
        frame: frame + LAYER_OFFSET_FRAMES[role],
        weight: "support",
        gain: () => Math.min(LAYER_CEILING, primaryGain * LAYER_GAIN[role]),
        label: `${cue.label ?? cue.kind} (${role})`,
        layerOf: id,
        layer: role,
      });
      if (why) drop(why, layer, layerId);
    }
  }
  events.sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
  dropped.sort((a, b) => a.cueFrame - b.cueFrame || a.id.localeCompare(b.id));
  silences.sort((a, b) => a.cueFrame - b.cueFrame || a.id.localeCompare(b.id));
  return { events, dropped, silences };
}

/** Sound events as `audio:mix` tracks (role sfx). `publicDir` is where `public/` sits relative to the mix's working directory. */
export function cueSoundTracks(events: SoundEvent[], fps: number, publicDir = "public") {
  return events.map((event) => ({
    source: `${publicDir}/${event.file}`,
    role: "sfx" as const,
    startSec: round(event.startFrame / fps),
    sourceEndSec: Math.min(event.fileDurationSec, round(event.durationInFrames / fps)),
    volume: event.gain,
  }));
}
