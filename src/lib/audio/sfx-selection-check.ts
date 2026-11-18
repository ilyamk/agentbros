// The sound step's hero-sound check, kept apart from the audition so film:done does not load the cue-sound planner.
import type { CueSheet } from "../../types/film";
import type { SfxSelection } from "../../types/sfx-selection";
import { cueDecision, needsDecision, soundCueWeight, type SoundKind } from "./cut-decisions";

export type HeroSoundCue = { cueId: string; frame: number; kind: string; sfx: SoundKind; sec: number };

/** The cue-sheet cues that decide a sound and play it as hero (soundCueWeight), in film order. */
export function heroSoundCues(sheet: Pick<CueSheet, "fps" | "cues">): HeroSoundCue[] {
  return sheet.cues
    .flatMap((cue) => {
      if (!needsDecision(cue)) return [];
      const decision = cueDecision(cue);
      if (decision.state !== "sound" || soundCueWeight(cue) !== "hero") return [];
      return [{ cueId: cue.id, frame: cue.frame, kind: cue.kind, sfx: decision.sfx, sec: cue.frame / sheet.fps }];
    })
    .sort((a, b) => a.frame - b.frame || a.cueId.localeCompare(b.cueId));
}

/**
 * The sound step's `hero-sounds-selected` check: each hero sound cue of the current cue sheet was auditioned, and the
 * sound sfx:cues placed on it is the selected one (by sha256, so a frozen project copy counts). Fewer than two candidates
 * is advisory: the environment may hold only one sound of a kind. Never reads an Earshot verdict.
 */
export function selectionProblems(input: {
  sheet: Pick<CueSheet, "fps" | "cues">;
  sheetSha256: string | undefined;
  selection: SfxSelection | undefined;
  /** sfx:cues' placed events, when written. */
  placed?: { label?: string; file: string; layerOf?: string }[];
  /** sha256 of a file under public/, undefined when it is missing. */
  hashOf: (file: string) => string | undefined;
}): { problems: string[]; advisories: string[] } {
  const heroes = heroSoundCues(input.sheet);
  if (!heroes.length) return { problems: [], advisories: [] };
  const run = "run sfx:audition --project <id>, then sfx:cues with --selection";
  if (!input.selection)
    return {
      problems: [`${heroes.length} hero sound cue(s) were not auditioned (no valid sfx-selection.json): ${run}`],
      advisories: [],
    };
  if (input.selection.cueSheet.sha256 !== input.sheetSha256)
    return { problems: [`sfx-selection.json was made for another cue sheet: ${run}`], advisories: [] };
  const problems: string[] = [];
  const advisories: string[] = [];
  const byCue = new Map(input.selection.cues.map((cue) => [cue.cueId, cue]));
  for (const hero of heroes) {
    const entry = byCue.get(hero.cueId);
    if (!entry || entry.sfx !== hero.sfx) {
      problems.push(`hero cue ${hero.cueId} (${hero.sfx}) has no audition entry: ${run}`);
      continue;
    }
    if (entry.candidates.length < 2)
      advisories.push(
        `hero cue ${hero.cueId} compared ${entry.candidates.length} candidate(s): render an Earshot take (sfx:synth --engine earshot) or index library sounds of ${hero.sfx}`,
      );
    const chosen = entry.candidates.find((candidate) => candidate.id === entry.selected);
    if (!chosen) continue;
    if (!input.placed) {
      problems.push(`hero cue ${hero.cueId}: no sound-cues.json to show the selected sound was placed: ${run}`);
      continue;
    }
    const placed = input.placed.find((event) => event.label === hero.cueId && !event.layerOf);
    if (!placed) {
      problems.push(`hero cue ${hero.cueId}: sfx:cues placed no sound on it; rerun sfx:cues with --selection`);
      continue;
    }
    if (input.hashOf(placed.file) !== chosen.sha256)
      problems.push(
        `hero cue ${hero.cueId}: sfx:cues placed ${placed.file}, not the selected ${chosen.id} (${chosen.file}); rerun sfx:cues with --selection`,
      );
  }
  return { problems, advisories };
}
