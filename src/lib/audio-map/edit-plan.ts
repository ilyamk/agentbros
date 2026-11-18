import { z } from "zod";
import type { LibraryCategory, SfxKind } from "../../motion/library/types";
import type { AudioMap, MusicStructure } from "../../types/film";
import { leadFrame, type SheetCueKind } from "./leads";
import type { CueDraft } from "./snap";

// An edit skeleton read off the music's form: where shots start, where the picture holds, where it bursts, and how it ends.

export const EDIT_STYLES = ["calm", "punchy", "flurry"] as const;
export type EditStyle = (typeof EDIT_STYLES)[number];
export type SlotRole = "shot" | "hold" | "flurry";
type Label = MusicStructure["sections"][number]["label"];

// Measured on four reference films: their cuts sit on beats (ref-service-explainer 12 of 14 long-shot cuts), not on phrase
// lines (no film above chance). So only `calm` cuts on phrase lines; `punchy` and `flurry` keep phrase lines for sections,
// drops and the stop, and cut inside them on beats in an uneven pattern of beat counts.
const STYLE = {
  calm: { phrases: true, confidence: 0.5, minLevel: 4, maxBars: 8, pattern: [] as number[], flurryStep: 0 },
  punchy: { phrases: false, confidence: 1, minLevel: 16, maxBars: 2, pattern: [4, 2, 2, 6, 3, 5], flurryStep: 1 },
  flurry: { phrases: false, confidence: 1, minLevel: 16, maxBars: 1, pattern: [2, 1, 1, 3, 1, 2], flurryStep: 0.5 },
} as const satisfies Record<
  EditStyle,
  { phrases: boolean; confidence: number; minLevel: number; maxBars: number; pattern: number[]; flurryStep: number }
>;

const CATEGORIES: Record<Label | "flurry" | "hold" | "hero", LibraryCategory[]> = {
  intro: ["typography", "backgrounds", "camera"],
  build: ["kinetic", "typography", "ui", "data"],
  drop: ["scenes", "kinetic", "data", "ui"],
  hero: ["three", "scenes", "typography"],
  break: ["ui", "camera", "typography"],
  outro: ["finish", "typography"],
  flurry: ["kinetic", "transitions", "typography"],
  hold: ["camera", "ui", "backgrounds"],
};

export const EditPlanEventSchema = z.object({
  id: z.string(),
  kind: z.enum(["cut", "transition", "hit", "ground-swap", "hold", "flurry", "stop", "sfx"]),
  trackSec: z.number().nonnegative(),
  frame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative().optional(),
  anchor: z.string(),
  sfx: z.string().optional(),
  note: z.string().optional(),
});

export const EditPlanSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("edit-plan"),
  fps: z.number().positive(),
  style: z.enum(EDIT_STYLES),
  audioMapPath: z.string(),
  musicOffsetSec: z.number().nonnegative(),
  durationFrames: z.number().int().positive(),
  structureSource: z.enum(["structure", "legacy-phrases"]),
  /** From the map's grid: false when the downbeat is a guess, and then no cut is marked as a downbeat. */
  barKnown: z.boolean(),
  /** Shot slots: a motion plan's startFrame and durationFrames, with what the slot is for. */
  slots: z.array(
    z.object({
      id: z.string(),
      startFrame: z.number().int().nonnegative(),
      durationFrames: z.number().int().positive(),
      section: z.string(),
      role: z.enum(["shot", "hold", "flurry"]),
      entry: z.string(),
      beatSync: z.string(),
      transitionToNext: z.string().optional(),
      blockCategories: z.array(z.string()),
      sfx: z.array(z.string()),
    }),
  ),
  events: z.array(EditPlanEventSchema),
  /** Cue drafts for `edit:snap --cues`: intent on the music anchor, unleaded, since edit:snap applies the lead. */
  cues: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["cut", "transition", "reveal", "hit", "stop", "sfx"]),
      intentSec: z.number().nonnegative(),
      snap: z.enum(["downbeat", "beat", "event", "key-moment", "phrase", "none"]).optional(),
      shotId: z.string().optional(),
      sfx: z.string().optional(),
    }),
  ),
  notes: z.array(z.string()),
});
export type EditPlan = z.infer<typeof EditPlanSchema>;

type Boundary = {
  sec: number;
  anchor: string;
  kind: "cut" | "transition";
  label: Label;
  hero: boolean;
  snap: NonNullable<CueDraft["snap"]>;
};

const near = (list: number[], sec: number, tolerance: number) =>
  list.some((value) => Math.abs(value - sec) <= tolerance);

/** The form of a map made before structure analysis: its phrases and sections, labelled by level. */
function legacyStructure(map: AudioMap): MusicStructure {
  const last = map.keyMoments.find((moment) => moment.kind === "hard-stop");
  const end = map.source.durationSec;
  const labels: Record<string, Label> = { low: "intro", mid: "build", high: "drop" };
  return {
    source: "mix",
    bars: [],
    phrases: map.phrases.map((phrase) => ({
      startSec: phrase.startSec,
      endSec: phrase.endSec,
      bars: 0,
      level: 0 as const,
      confidence: 0.5,
    })),
    sections: map.sections.map((section, index) => ({
      startSec: section.startSec,
      endSec: section.endSec,
      label:
        index === map.sections.length - 1 && index > 0 && section.level === "low" ? "outro" : labels[section.level]!,
      energy: section.level === "high" ? 0.8 : section.level === "mid" ? 0.5 : 0.2,
      density: section.density,
      drums: 0.5,
      bass: 0.5,
      confidence: 0.3,
      reason: "from the map's level bands",
    })),
    fills: [],
    risers: map.risers.map((riser) => ({
      ...riser,
      boundarySec: riser.endSec,
      strength: 0.5,
      rises: ["energy" as const],
    })),
    breaks: map.silences.map((silence) => ({ ...silence, kind: "silence" as const, strength: 0.6 })),
    ending: {
      kind: last ? "hard-stop" : "fade",
      lastSoundSec: last?.timeSec ?? end,
      fadeSec: 0,
      ...(map.downbeatsSec.length
        ? { finalDownbeatSec: map.downbeatsSec.filter((sec) => sec <= (last?.timeSec ?? end) + 0.15).at(-1) }
        : {}),
    },
  };
}

function sectionAt(structure: MusicStructure, sec: number): MusicStructure["sections"][number] | undefined {
  return (
    structure.sections.find((section) => sec >= section.startSec - 1e-6 && sec < section.endSec - 1e-6) ??
    structure.sections.at(-1)
  );
}

/** Where the film should stop: the final downbeat of a hard stop, else where the sound ends. */
export function stopSec(structure: MusicStructure): { sec: number; anchor: string } {
  const { ending } = structure;
  if (
    ending.kind === "hard-stop" &&
    ending.finalDownbeatSec !== undefined &&
    ending.lastSoundSec - ending.finalDownbeatSec < 2.5
  )
    return { sec: ending.finalDownbeatSec, anchor: "final-downbeat" };
  return {
    sec: ending.kind === "hard-stop" ? ending.lastSoundSec : (ending.finalDownbeatSec ?? ending.lastSoundSec),
    anchor: ending.kind === "hard-stop" ? "hard-stop" : "final-downbeat-before-fade",
  };
}

export function planEdit(request: {
  map: AudioMap;
  fps: number;
  style?: EditStyle;
  durationFrames?: number;
  musicOffsetSec?: number;
  audioMapPath: string;
}): EditPlan {
  const { map, fps } = request;
  const style = request.style ?? "punchy";
  const offset = request.musicOffsetSec ?? 0;
  const settings = STYLE[style];
  const structure = map.structure ?? legacyStructure(map);
  const notes: string[] = [];
  if (!map.structure)
    notes.push("The map has no structure (rerun audio:map); boundaries come from its older phrases and sections.");
  const stop = stopSec(structure);
  const filmSec = request.durationFrames ? request.durationFrames / fps : stop.sec - offset;
  const durationFrames = Math.max(1, request.durationFrames ?? Math.round(filmSec * fps));
  const endTrack = offset + durationFrames / fps;
  const inFilm = (sec: number) => sec > offset + 0.2 && sec < endTrack - 0.2;
  const reliable = map.tempo.gridTrust === "reliable";
  const barKnown = map.grid?.barKnown ?? map.structure?.barKnown ?? true;
  const barSnap = barKnown ? "downbeat" : "beat";
  if (reliable && !barKnown)
    notes.push("The bar's downbeat is a guess (grid.barKnown false): cuts sit on beats, none is marked as a downbeat.");
  const holds = structure.breaks.filter(
    (item) => item.endSec - item.startSec >= 0.5 && item.endSec > offset && item.startSec < endTrack,
  );
  const inHold = (sec: number) => holds.some((item) => sec > item.startSec + 0.05 && sec < item.endSec - 0.05);
  // Hero hits are scarce: the strongest surges only, about one per drop, or they stop being heroes.
  const heroCount = Math.max(2, structure.sections.filter((section) => section.label === "drop").length + 1);
  const surges = map.keyMoments
    // The last second before the stop is the ending, never a hero hit.
    .filter(
      (moment) =>
        (moment.kind === "surge" || moment.kind === "drop" || moment.kind === "impact") &&
        moment.strength >= 0.5 &&
        moment.timeSec < stop.sec - 1,
    )
    .sort((a, b) => b.strength - a.strength)
    .slice(0, heroCount)
    .map((moment) => moment.timeSec);

  // 1. Boundaries on phrase starts and section starts; drops and surges are hero hits with a ground swap.
  const boundaries: Boundary[] = [];
  const add = (boundary: Boundary) => {
    if (!inFilm(boundary.sec) || inHold(boundary.sec)) return;
    const twin = boundaries.find((other) => Math.abs(other.sec - boundary.sec) < 0.25);
    if (twin) {
      twin.hero ||= boundary.hero;
      if (boundary.kind === "transition") twin.kind = "transition";
      return;
    }
    boundaries.push(boundary);
  };
  for (const [index, section] of structure.sections.entries()) {
    if (index === 0) continue;
    const previous = structure.sections[index - 1]!;
    const hero = section.label === "drop" || near(surges, section.startSec, 0.3);
    add({
      sec: section.startSec,
      anchor: `${section.label}-start`,
      kind: hero || previous.label === section.label ? "cut" : "transition",
      label: section.label,
      hero,
      snap: "phrase",
    });
  }
  for (const phrase of settings.phrases ? structure.phrases : []) {
    if (
      phrase.startSec <= 0 ||
      phrase.confidence < settings.confidence ||
      (phrase.level !== 0 && phrase.level < settings.minLevel)
    )
      continue;
    add({
      sec: phrase.startSec,
      anchor: phrase.level ? `phrase-${phrase.level}` : "phrase",
      kind: "cut",
      label: sectionAt(structure, phrase.startSec)?.label ?? "build",
      hero: false,
      snap: "phrase",
    });
  }
  for (const sec of surges)
    add({
      sec,
      anchor: "surge",
      kind: "cut",
      label: sectionAt(structure, sec)?.label ?? "drop",
      hero: true,
      snap: "key-moment",
    });
  for (const hold of holds)
    if (hold.endSec < endTrack - 0.2)
      add({
        sec: hold.endSec,
        anchor: `${hold.kind}-end`,
        kind: "cut",
        label: sectionAt(structure, hold.endSec)?.label ?? "build",
        hero: true,
        snap: reliable ? barSnap : "phrase",
      });
  for (const hold of holds)
    if (inFilm(hold.startSec))
      boundaries.push({
        sec: hold.startSec,
        anchor: `${hold.kind}-start`,
        kind: "cut",
        label: "break",
        hero: false,
        snap: reliable ? barSnap : "phrase",
      });
  boundaries.sort((a, b) => a.sec - b.sec);

  // 2. Inside the structural spans: calm splits long stretches on downbeats; punchy and flurry cut on beats in a pattern.
  const maxSec = structure.barSec
    ? structure.barSec * settings.maxBars
    : style === "calm"
      ? 6
      : style === "punchy"
        ? 3
        : 1.5;
  if (reliable) {
    const edges = [offset, ...boundaries.map((item) => item.sec), endTrack];
    const downbeats = new Set(map.downbeatsSec.map((sec) => Math.round(sec * 1000)));
    for (let index = 0; index < edges.length - 1; index += 1) {
      const [from, to] = [edges[index]!, edges[index + 1]!];
      if (inHold((from + to) / 2)) continue;
      if (settings.pattern.length) {
        const inFill = (sec: number) =>
          settings.flurryStep > 0 && structure.fills.some((fill) => sec >= fill.startSec - 0.05 && sec <= fill.endSec);
        const beats = map.beatsSec.filter((sec) => sec > from + 0.2 && sec < to - 0.2 && !inFill(sec));
        let step = 0;
        let at = settings.pattern[0]! - 1;
        while (at < beats.length) {
          const sec = beats[at]!;
          const onDownbeat = barKnown && downbeats.has(Math.round(sec * 1000));
          boundaries.push({
            sec,
            anchor: onDownbeat ? "downbeat" : "beat",
            kind: "cut",
            label: sectionAt(structure, sec)?.label ?? "build",
            hero: false,
            snap: onDownbeat ? "downbeat" : "beat",
          });
          step += 1;
          at += settings.pattern[step % settings.pattern.length]!;
        }
        continue;
      }
      if (to - from <= maxSec * 1.25) continue;
      const pieces = Math.ceil((to - from) / maxSec);
      for (let piece = 1; piece < pieces; piece += 1) {
        const want = from + maxSec * piece;
        const downbeat = map.downbeatsSec.reduce(
          (best, sec) => (Math.abs(sec - want) < Math.abs(best - want) ? sec : best),
          Number.POSITIVE_INFINITY,
        );
        if (Number.isFinite(downbeat) && downbeat > from + 0.4 && downbeat < to - 0.4)
          boundaries.push({
            sec: downbeat,
            anchor: barSnap,
            kind: "cut",
            label: sectionAt(structure, downbeat)?.label ?? "build",
            hero: false,
            snap: barSnap,
          });
      }
    }
    boundaries.sort((a, b) => a.sec - b.sec);
  } else {
    notes.push(
      `Grid trust is ${map.tempo.gridTrust}: no beat or downbeat cuts; shots follow phrases, sections and key moments only.`,
    );
    if (!settings.phrases)
      for (const phrase of structure.phrases)
        if (phrase.startSec > 0)
          add({
            sec: phrase.startSec,
            anchor: phrase.level ? `phrase-${phrase.level}` : "phrase",
            kind: "cut",
            label: sectionAt(structure, phrase.startSec)?.label ?? "build",
            hero: false,
            snap: "phrase",
          });
    boundaries.sort((a, b) => a.sec - b.sec);
  }

  // 3. Flurry windows on fills: a cut per beat (or half beat) inside the fill.
  const flurries: { startSec: number; endSec: number; cuts: number[] }[] = [];
  if (settings.flurryStep > 0 && reliable) {
    for (const fill of structure.fills) {
      if (!inFilm(fill.startSec) || fill.endSec > endTrack) continue;
      const beats = map.beatsSec.filter((sec) => sec >= fill.startSec - 0.03 && sec < fill.endSec - 0.05);
      const cuts =
        settings.flurryStep === 1
          ? beats
          : beats.flatMap((sec, index) => [
              sec,
              ...(beats[index + 1] !== undefined ? [(sec + beats[index + 1]!) / 2] : []),
            ]);
      if (cuts.length < 2) continue;
      flurries.push({ startSec: fill.startSec, endSec: fill.endSec, cuts });
    }
  }

  // 4. Slots between boundaries.
  type Edge = Boundary & { role: SlotRole; flurryCut?: boolean };
  const edges: Edge[] = boundaries.map((item) => ({
    ...item,
    role: holds.some((hold) => Math.abs(hold.startSec - item.sec) < 0.05) ? "hold" : "shot",
  }));
  for (const flurry of flurries) {
    for (const [index, sec] of flurry.cuts.entries()) {
      if (edges.some((edge) => Math.abs(edge.sec - sec) < 0.1)) continue;
      edges.push({
        sec,
        anchor: index === 0 ? "fill-start" : "fill-beat",
        kind: "cut",
        label: sectionAt(structure, sec)?.label ?? "build",
        hero: false,
        snap: "beat",
        role: "flurry",
        flurryCut: true,
      });
    }
  }
  edges.sort((a, b) => a.sec - b.sec);
  const toFrame = (trackSec: number) => Math.max(0, Math.round((trackSec - offset) * fps));
  const startFrames = [0, ...edges.map((edge) => leadFrame(toFrame(edge.sec), edge.kind as SheetCueKind))];
  const slots: EditPlan["slots"] = [];
  const events: EditPlan["events"] = [];
  const cues: EditPlan["cues"] = [];
  const firstSection = sectionAt(structure, offset);
  for (let index = 0; index < startFrames.length; index += 1) {
    const start = startFrames[index]!;
    const end = index + 1 < startFrames.length ? startFrames[index + 1]! : durationFrames;
    if (end - start < 1) continue;
    const edge = index ? edges[index - 1]! : undefined;
    const id = `s${String(slots.length + 1).padStart(2, "0")}`;
    const label = edge?.label ?? firstSection?.label ?? "intro";
    const role: SlotRole = edge?.role ?? "shot";
    const categories =
      role === "hold"
        ? CATEGORIES.hold
        : role === "flurry"
          ? CATEGORIES.flurry
          : edge?.hero
            ? CATEGORIES.hero
            : CATEGORIES[label];
    const sfx: SfxKind[] = [];
    if (edge?.hero) sfx.push("impact");
    else if (edge?.kind === "transition") sfx.push("whoosh");
    else if (role === "flurry") sfx.push("tick");
    const next = edges[index];
    slots.push({
      id,
      startFrame: start,
      durationFrames: end - start,
      section: label,
      role,
      entry: edge ? edge.anchor : "film-start",
      beatSync: edge
        ? `${edge.anchor} at track ${edge.sec.toFixed(3)} s (frame ${toFrame(edge.sec)}${edge.kind === "cut" || edge.kind === "transition" ? ", picture 1 frame early" : ""})`
        : "film start",
      ...(next
        ? {
            transitionToNext:
              next.kind === "transition"
                ? "transition: whoosh across the section change"
                : next.role === "hold"
                  ? "cut into a held frame for the break"
                  : "hard-cut: on the phrase",
          }
        : {}),
      blockCategories: [...categories],
      sfx,
    });
    if (edge) {
      const sheetKind = edge.kind;
      cues.push({
        id: `${id}-in`,
        kind: sheetKind,
        intentSec: round(edge.sec - offset),
        snap: edge.snap,
        shotId: id,
        ...(sfx[0] && sfx[0] !== "impact" ? { sfx: sfx[0] } : {}),
      });
      events.push({
        id: `${id}-in`,
        kind: edge.role === "flurry" ? "flurry" : edge.role === "hold" ? "hold" : sheetKind,
        trackSec: round(edge.sec),
        frame: toFrame(edge.sec),
        anchor: edge.anchor,
        ...(sfx[0] ? { sfx: sfx[0] } : {}),
      });
      if (edge.hero) {
        cues.push({
          id: `${id}-hit`,
          kind: "hit",
          intentSec: round(edge.sec - offset),
          snap: edge.snap === "key-moment" ? "key-moment" : edge.snap,
          shotId: id,
          sfx: "impact",
        });
        events.push({
          id: `${id}-swap`,
          kind: "ground-swap",
          trackSec: round(edge.sec),
          frame: toFrame(edge.sec),
          anchor: edge.anchor,
          sfx: "impact",
          note: "hero hit: swap the ground and land the hero element",
        });
      }
    }
  }
  for (const hold of holds)
    events.push({
      id: `hold-${round(hold.startSec)}`,
      kind: "hold",
      trackSec: round(hold.startSec),
      frame: toFrame(hold.startSec),
      endFrame: Math.min(durationFrames, toFrame(hold.endSec)),
      anchor: hold.kind,
      note: "hold the picture: no cuts while the music rests",
    });
  for (const flurry of flurries)
    events.push({
      id: `flurry-${round(flurry.startSec)}`,
      kind: "flurry",
      trackSec: round(flurry.startSec),
      frame: toFrame(flurry.startSec),
      endFrame: toFrame(flurry.endSec),
      anchor: "fill",
      note: `${flurry.cuts.length} cuts on the fill's beats`,
    });

  // 5. Risers end on their drop; the film stops hard on the final downbeat.
  for (const riser of structure.risers) {
    if (riser.boundarySec <= offset || riser.boundarySec > endTrack) continue;
    const startSec = Math.max(offset, riser.startSec);
    const id = `riser-${round(riser.boundarySec)}`;
    cues.push({ id, kind: "sfx", intentSec: round(startSec - offset), snap: "none", sfx: "riser" });
    events.push({
      id,
      kind: "sfx",
      trackSec: round(startSec),
      frame: toFrame(startSec),
      endFrame: toFrame(riser.boundarySec),
      anchor: "riser",
      sfx: "riser",
      note: `riser sound ending on ${riser.boundarySec.toFixed(2)} s, where the impact lands`,
    });
  }
  const stopFrame = Math.min(durationFrames, toFrame(stop.sec));
  cues.push({
    id: "stop",
    kind: "stop",
    intentSec: round(stopFrame / fps),
    snap:
      stop.anchor === "hard-stop"
        ? "key-moment"
        : reliable && near(map.downbeatsSec, stop.sec, 0.05)
          ? barSnap
          : "none",
  });
  events.push({
    id: "stop",
    kind: "stop",
    trackSec: round(stop.sec),
    frame: stopFrame,
    anchor: stop.anchor,
    note:
      structure.ending.kind === "hard-stop"
        ? "last frame on the stop, no fade"
        : `the track fades over ${structure.ending.fadeSec} s; end on the final downbeat before it`,
  });
  if (request.durationFrames && Math.abs(stopFrame - durationFrames) > 2)
    notes.push(
      `The film's ${durationFrames} frames end ${((durationFrames - toFrame(stop.sec)) / fps).toFixed(2)} s from the music's stop at ${stop.sec.toFixed(2)} s; backtime the offset with music:backtime.`,
    );
  events.sort((a, b) => a.frame - b.frame || a.id.localeCompare(b.id));
  return EditPlanSchema.parse({
    schemaVersion: 1,
    kind: "edit-plan",
    fps,
    style,
    audioMapPath: request.audioMapPath,
    musicOffsetSec: offset,
    durationFrames,
    structureSource: map.structure ? "structure" : "legacy-phrases",
    barKnown,
    slots,
    events,
    cues,
    notes,
  });
}

const round = (value: number) => Math.round(value * 1000) / 1000;
