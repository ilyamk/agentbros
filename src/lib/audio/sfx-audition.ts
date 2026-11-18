// sfx:audition: each hero sound chosen from measured candidates by fixed criteria, with Earshot's model-free audit as
// advisory evidence. The ranking is pure and deterministic; gathering and measuring are injected so tests run offline.
import type { CueSheet } from "../../types/film";
import type { CandidateChecks, SfxCandidate, SfxSelection, SfxSelectionCue } from "../../types/sfx-selection";
import { cueDecision, needsDecision, soundCueWeight, type SoundKind } from "./cut-decisions";
import { heroSoundCues, type HeroSoundCue } from "./sfx-selection-check";
import { libraryFit, type LibrarySound } from "./cue-sounds";

/** Earshot warnings that make a sound unusable whatever its fit: nothing to hear, flat tops, an edge click, DC. */
export const HARD_CHECK_CODES = ["silent", "clipping", "edge", "dc"] as const;
/** Each remaining warning (clicks, truncated tail, ring, glide…) and note lowers the audit factor; never below the floor. */
export const WARNING_PENALTY = 0.15;
export const NOTE_PENALTY = 0.03;
export const ARTIFACT_FLOOR = 0.2;
/** A candidate this far below the best still wins when the best repeats the previous same-kind hero sound. */
export const VARIETY_MARGIN = 0.1;
/** Below this true peak a file is treated as silent; above 0 dBTP it clips. */
export const SILENT_PEAK_DB = -60;
export const CLIP_PEAK_DB = 0;
/** Ties go to the more specific source: a measured take for this film, then the measured library, then the synth pack. */
export const ORIGIN_ORDER = ["earshot", "library", "synth"] as const;
/** Candidates kept per source and cue, best fit first. */
export const PER_SOURCE = 3;

export const AUDITION_CRITERIA =
  `Excluded: starts before the film, true peak below ${SILENT_PEAK_DB} dBTP (silent) or above ${CLIP_PEAK_DB} dBTP (clipped), ` +
  `or an Earshot warning ${HARD_CHECK_CODES.join("/")}. Score = fit of length, pre-roll and tail to the room around the cue ` +
  `(libraryFit, 0..1) × audit factor (1 − ${WARNING_PENALTY} per Earshot warning − ${NOTE_PENALTY} per note, floor ${ARTIFACT_FLOOR}; ` +
  `1 without Earshot). Ties: ${ORIGIN_ORDER.join(" > ")}, then sha256. A sound that repeats the previous same-kind hero cue ` +
  `yields to one within ${VARIETY_MARGIN}.`;

export const AUDITION_NOTICE =
  "Agents cannot hear: candidates are ranked by measurements and an advisory audit, not by taste. The user judges the sound.";

const round = (value: number) => Math.round(value * 1000) / 1000;

export { heroSoundCues, selectionProblems, type HeroSoundCue } from "./sfx-selection-check";

/** Room around a cue among the sheet's sounding cues: seconds since the previous one (or the film start) and to the next. */
export function cueRoom(
  sheet: Pick<CueSheet, "fps" | "cues">,
  sec: number,
  durationSec?: number,
): { beforeSec: number; afterSec: number } {
  const times = [
    ...new Set(
      sheet.cues
        .filter((cue) => cueDecision(cue).state === "sound")
        .map((cue) => cue.frame / sheet.fps)
        .filter((time) => Math.abs(time - sec) > 1e-6),
    ),
  ].sort((a, b) => a - b);
  const before = times.filter((time) => time < sec).at(-1) ?? 0;
  const after = times.find((time) => time > sec) ?? Math.max(sec + 4, durationSec ?? 0);
  return { beforeSec: round(sec - before), afterSec: round(after - sec) };
}

/** Where a sound sits on its cue: an explicit measured phase, else a riser's or whoosh's peak, else its onset (as sfx:cues). */
export const anchorOf = (sound: LibrarySound) =>
  sound.alignSec ?? (sound.kind === "riser" || sound.kind === "whoosh" ? sound.peakSec : sound.onsetSec);

/** A gathered candidate before scoring. */
export type RawCandidate = {
  origin: SfxCandidate["origin"];
  sound: LibrarySound;
  sha256: string;
  takeReceipt?: string;
  loudness: SfxCandidate["loudness"];
  checks: CandidateChecks;
};

/** Scores one candidate for one cue. Pure. */
export function scoreCandidate(
  candidate: RawCandidate,
  room: { beforeSec: number; afterSec: number },
  cueSec: number,
): Pick<SfxCandidate, "scores" | "excluded"> {
  const fit = round(Math.min(1, Math.max(0, libraryFit(candidate.sound, room))));
  const artifacts =
    candidate.checks.engine === "earshot"
      ? round(
          Math.max(
            ARTIFACT_FLOOR,
            1 - WARNING_PENALTY * candidate.checks.warnings.length - NOTE_PENALTY * candidate.checks.notes.length,
          ),
        )
      : null;
  const scores = { fit, artifacts, total: round(fit * (artifacts ?? 1)) };
  const peak = candidate.loudness.truePeakDb;
  const hard =
    candidate.checks.engine === "earshot"
      ? candidate.checks.warnings.find((warning) => (HARD_CHECK_CODES as readonly string[]).includes(warning.code))
      : undefined;
  const excluded =
    cueSec - anchorOf(candidate.sound) < -1e-6
      ? `its anchor (${round(anchorOf(candidate.sound))} s in) would start it before the film`
      : peak === null || peak < SILENT_PEAK_DB
        ? `silent (true peak ${peak ?? "unmeasured"} dBTP)`
        : peak > CLIP_PEAK_DB
          ? `clipped (true peak ${peak} dBTP)`
          : hard
            ? `Earshot ${hard.code}: ${hard.msg}`
            : undefined;
  return { scores, ...(excluded ? { excluded } : {}) };
}

const originRank = (origin: SfxCandidate["origin"]) => ORIGIN_ORDER.indexOf(origin);

/** Orders eligible candidates best first: total, then origin, then sha256. Pure. */
export function rankEligible(candidates: SfxCandidate[]): SfxCandidate[] {
  return candidates
    .filter((candidate) => !candidate.excluded)
    .sort(
      (a, b) =>
        b.scores.total - a.scores.total ||
        originRank(a.origin) - originRank(b.origin) ||
        a.sha256.localeCompare(b.sha256),
    );
}

const describe = (candidate: SfxCandidate) =>
  `${candidate.id} (${candidate.origin}, ${candidate.scores.total}: fit ${candidate.scores.fit}, ${
    candidate.checks.engine === "earshot"
      ? candidate.checks.warnings.length
        ? `${candidate.checks.warnings.map((warning) => warning.code).join("+")} in the audit`
        : "clean audit"
      : "no audit"
  })`;

/** Picks one candidate for a cue, or none, with the reason in words. `previousSha` is the last same-kind hero choice. */
export function chooseCandidate(
  candidates: SfxCandidate[],
  previousSha?: string,
): Pick<SfxSelectionCue, "selected" | "reason"> {
  const ranked = rankEligible(candidates);
  if (!ranked.length)
    return {
      selected: null,
      reason: candidates.length
        ? `No eligible candidate: ${candidates.map((candidate) => `${candidate.id} ${candidate.excluded}`).join("; ")}. sfx:cues picks as before.`
        : "No candidate of this kind in the synth pack, the library or the Earshot takes. sfx:cues picks as before.",
    };
  let best = ranked[0]!;
  let variety = "";
  if (previousSha && best.sha256 === previousSha) {
    const other = ranked.find(
      (candidate) => candidate.sha256 !== previousSha && candidate.scores.total >= best.scores.total - VARIETY_MARGIN,
    );
    if (other) {
      variety = ` ${best.id} repeats the previous same-kind hero sound, so the next within ${VARIETY_MARGIN} wins.`;
      best = other;
    }
  }
  const rest = ranked.filter((candidate) => candidate !== best);
  const single = candidates.length < 2 ? " Only one candidate was compared: add an Earshot take or library sound." : "";
  return {
    selected: best.id,
    reason: `${describe(best)}${rest.length ? ` over ${rest.map(describe).join(", ")}` : ""}.${variety}${single}`,
  };
}

const label = (index: number) =>
  index < 26
    ? String.fromCharCode(65 + index)
    : `${String.fromCharCode(64 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`;

/** One cue's candidates labelled, scored and chosen. Pure. */
export function auditionCue(
  cue: HeroSoundCue,
  room: { beforeSec: number; afterSec: number },
  raw: RawCandidate[],
  previousSha?: string,
): SfxSelectionCue {
  const candidates: SfxCandidate[] = raw.map((candidate, index) => ({
    id: label(index),
    origin: candidate.origin,
    file: candidate.sound.file,
    sha256: candidate.sha256,
    ...(candidate.takeReceipt ? { takeReceipt: candidate.takeReceipt } : {}),
    timing: {
      durationSec: round(candidate.sound.durationSec),
      alignSec: round(anchorOf(candidate.sound)),
      onsetSec: round(candidate.sound.onsetSec),
      peakSec: round(candidate.sound.peakSec),
      tailSec: round(candidate.sound.tailSec),
    },
    loudness: candidate.loudness,
    checks: candidate.checks,
    ...scoreCandidate(candidate, room, cue.sec),
  }));
  return {
    cueId: cue.cueId,
    frame: cue.frame,
    kind: cue.kind,
    sfx: cue.sfx,
    room,
    candidates,
    ...chooseCandidate(candidates, previousSha),
  };
}

/** Sources of candidate sounds, all as measured LibrarySounds with paths under public/. */
export type AuditionSources = {
  /** Earshot takes rendered for this film (earshotLibrarySounds), with their receipt paths. */
  takes?: { sound: LibrarySound; receipt: string }[];
  /** The measured library (librarySounds over sfx-index.json). */
  library?: LibrarySound[];
  /** The synth pack's takes as sounds (packSounds). */
  pack?: LibrarySound[];
};

/** Up to PER_SOURCE sounds of the cue's kind from each source, best fit first; one file appears once. Pure. */
export function gatherSounds(
  sfx: SoundKind,
  room: { beforeSec: number; afterSec: number },
  sources: AuditionSources,
): { origin: SfxCandidate["origin"]; sound: LibrarySound; takeReceipt?: string }[] {
  const best = (sounds: LibrarySound[]) =>
    [...new Map(sounds.filter((sound) => sound.kind === sfx).map((sound) => [sound.file, sound])).values()]
      .map((sound) => ({ sound, fit: libraryFit(sound, room) }))
      .sort((a, b) => b.fit - a.fit || a.sound.file.localeCompare(b.sound.file))
      .slice(0, PER_SOURCE)
      .map((item) => item.sound);
  const takes = (sources.takes ?? []).filter((take) => take.sound.kind === sfx);
  const chosenTakes = best(takes.map((take) => take.sound)).map((sound) => ({
    origin: "earshot" as const,
    sound,
    takeReceipt: takes.find((take) => take.sound === sound)!.receipt,
  }));
  const all = [
    ...chosenTakes,
    ...best(sources.library ?? []).map((sound) => ({ origin: "library" as const, sound })),
    ...best(sources.pack ?? []).map((sound) => ({ origin: "synth" as const, sound })),
  ];
  const seen = new Set<string>();
  return all.filter((item) => (seen.has(item.sound.file) ? false : (seen.add(item.sound.file), true)));
}

/** A synth pack's takes as measured sounds: the file's alignment is its anchor, the attack at its start. */
export function packSounds(
  entries: { kind: string; file: string; alignSec: number; durationSec: number }[],
  packBase: string,
): LibrarySound[] {
  const kinds: Record<string, SoundKind> = { hit: "impact" };
  return entries.flatMap((entry) => {
    const kind = (kinds[entry.kind] ?? entry.kind) as SoundKind;
    return [
      {
        kind,
        file: `${packBase.replace(/\/$/, "")}/${entry.file}`,
        durationSec: entry.durationSec,
        onsetSec: 0,
        peakSec: entry.alignSec,
        alignSec: entry.alignSec,
        tailSec: Math.max(0, entry.durationSec - entry.alignSec),
        dynamics: kind === "riser" ? "swell" : kind === "whoosh" ? "sweep" : "impulse",
      } satisfies LibrarySound,
    ];
  });
}

export type AuditionDeps = {
  /** sha256 of a file under public/. */
  hash: (file: string) => string;
  /** Independent loudness of a file under public/. */
  loudness: (file: string) => SfxCandidate["loudness"];
  /** Earshot's audit of a file under public/, or why it did not run. Called once per file. */
  check: (file: string, sha256: string) => CandidateChecks | Promise<CandidateChecks>;
};

/** Every hero cue of the sheet auditioned, in film order. Deterministic for the same sources and deps. */
export async function audition(input: {
  project: string;
  sheet: CueSheet;
  cueSheet: { path: string; sha256: string };
  durationSec?: number;
  sources: AuditionSources;
  earshot: SfxSelection["earshot"];
  deps: AuditionDeps;
}): Promise<SfxSelection> {
  const { sheet, deps } = input;
  const measured = new Map<string, { sha256: string; loudness: SfxCandidate["loudness"]; checks: CandidateChecks }>();
  const read = async (file: string) => {
    const known = measured.get(file);
    if (known) return known;
    const sha256 = deps.hash(file);
    const value = { sha256, loudness: deps.loudness(file), checks: await deps.check(file, sha256) };
    measured.set(file, value);
    return value;
  };
  const previous = new Map<SoundKind, string>();
  const cues: SfxSelectionCue[] = [];
  for (const cue of heroSoundCues(sheet)) {
    const room = cueRoom(sheet, cue.sec, input.durationSec);
    const raw: RawCandidate[] = [];
    for (const item of gatherSounds(cue.sfx, room, input.sources))
      raw.push({
        origin: item.origin,
        sound: item.sound,
        ...(item.takeReceipt ? { takeReceipt: item.takeReceipt } : {}),
        ...(await read(item.sound.file)),
      });
    const result = auditionCue(cue, room, raw, previous.get(cue.sfx));
    const chosen = result.candidates.find((candidate) => candidate.id === result.selected);
    if (chosen) previous.set(cue.sfx, chosen.sha256);
    cues.push(result);
  }
  return {
    version: 1,
    project: input.project,
    fps: sheet.fps,
    cueSheet: input.cueSheet,
    earshot: input.earshot,
    criteria: AUDITION_CRITERIA,
    cues,
    notice: AUDITION_NOTICE,
  };
}

/** The chosen sound of each auditioned cue, as sfx:cues places it, keyed by cue id. */
export function selectedSounds(
  selection: SfxSelection | undefined,
): Map<string, { sound: LibrarySound; sha256: string }> {
  const chosen = new Map<string, { sound: LibrarySound; sha256: string }>();
  for (const cue of selection?.cues ?? []) {
    const candidate = cue.candidates.find((item) => item.id === cue.selected);
    if (!candidate) continue;
    chosen.set(cue.cueId, {
      sha256: candidate.sha256,
      sound: {
        kind: cue.sfx,
        file: candidate.file,
        durationSec: candidate.timing.durationSec,
        onsetSec: candidate.timing.onsetSec,
        peakSec: candidate.timing.peakSec,
        alignSec: candidate.timing.alignSec,
        tailSec: candidate.timing.tailSec,
        dynamics: cue.sfx === "riser" ? "swell" : cue.sfx === "whoosh" ? "sweep" : "impulse",
        integratedLufs: candidate.loudness.integratedLufs,
      },
    });
  }
  return chosen;
}
