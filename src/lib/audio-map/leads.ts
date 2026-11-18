// Pure: no Node imports, so Remotion scenes (src/motion/sync) and the CLI share one table.
import type { CueKind as LibraryCueKind } from "../../motion/library/types";

/** Cue kinds of a cue sheet (src/types/film.ts CueKindSchema). */
export type SheetCueKind = "cut" | "transition" | "reveal" | "hit" | "stop" | "sfx";

/**
 * Frames a visual event lands before its music anchor. Sound before picture is noticed at ~45 ms,
 * sound after picture only at ~125 ms (ITU-R BT.1359), so picture may lead, never trail:
 * a cut one frame early, a visual hit up to three, a sound effect exactly on its frame.
 */
export const DEFAULT_LEAD_FRAMES: Readonly<Record<SheetCueKind, number>> = {
  cut: 1,
  transition: 1,
  reveal: 0,
  hit: 1,
  stop: 0,
  sfx: 0,
};
export const MAX_LEAD_FRAMES: Readonly<Record<SheetCueKind, number>> = {
  cut: 2,
  transition: 2,
  reveal: 3,
  hit: 3,
  stop: 2,
  sfx: 0,
};

export type LeadOverrides = Partial<Record<SheetCueKind, number>>;

/** The lead for a kind, clamped to what perception tolerates. */
export function leadFor(kind: SheetCueKind, overrides: LeadOverrides = {}): number {
  const wanted = overrides[kind] ?? DEFAULT_LEAD_FRAMES[kind];
  return Math.max(0, Math.min(MAX_LEAD_FRAMES[kind], Math.round(wanted)));
}

/** The frame the picture event lands on, given the frame its music anchor sits on. */
export const leadFrame = (anchorFrame: number, kind: SheetCueKind, overrides: LeadOverrides = {}): number =>
  Math.max(0, anchorFrame - leadFor(kind, overrides));

/** Library block cue kinds mapped to the cue-sheet vocabulary. */
export const LIBRARY_TO_SHEET_KIND: Readonly<Record<LibraryCueKind, SheetCueKind>> = {
  land: "hit",
  hit: "hit",
  cut: "cut",
  reveal: "reveal",
  click: "sfx",
  type: "sfx",
  exit: "cut",
  peak: "transition",
  stop: "stop",
};

export const toSheetKind = (kind: LibraryCueKind | SheetCueKind): SheetCueKind =>
  kind in LIBRARY_TO_SHEET_KIND ? LIBRARY_TO_SHEET_KIND[kind as LibraryCueKind] : (kind as SheetCueKind);
