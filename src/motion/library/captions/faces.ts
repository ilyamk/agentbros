import * as fonts from "../../../lib/fonts";
import type { CaptionFontRole } from "../../../lib/fonts";

/** Caption faces. Every one is OFL from Google Fonts and carries Latin and Cyrillic. */
export const FACE_IDS = [
  "heavy",
  "heavy-italic",
  "condensed-italic",
  "extra-condensed",
  "rounded",
  "grotesk",
  "clean",
  "serif-italic",
  "mono",
] as const;
export type FaceId = (typeof FACE_IDS)[number];

export type Face = {
  fontFamily: string;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  /** In em; tight display faces read better slightly closed up. */
  letterSpacingEm: number;
  /** Average advance of a lower-case character in em, for the page builder's line budget; upper case adds 15%. */
  charWidthEm: number;
  /** Height of a capital letter in em, for the minimum readable size. */
  capHeightEm: number;
};

/**
 * Each face is a role of `src/lib/fonts.ts`, so a font context (local, offline fonts) replaces it with the rest. A
 * caption role the context does not supply falls back to the nearest required role (`fallback`), never to Google.
 */
type Spec = Omit<Face, "fontFamily"> & {
  role: CaptionFontRole | null;
  fallback: "geometricFont" | "condensedFont" | "roundedFont" | "primaryFont" | "serifFont";
};

const SPECS: Record<FaceId, Spec> = {
  heavy: {
    fontWeight: 900,
    fontStyle: "normal",
    letterSpacingEm: -0.01,
    charWidthEm: 0.66,
    capHeightEm: 0.7,
    role: null,
    fallback: "geometricFont",
  },
  "heavy-italic": {
    fontWeight: 900,
    fontStyle: "italic",
    letterSpacingEm: -0.01,
    charWidthEm: 0.64,
    capHeightEm: 0.7,
    role: "captionHeavyItalicFont",
    fallback: "geometricFont",
  },
  "condensed-italic": {
    fontWeight: 900,
    fontStyle: "italic",
    letterSpacingEm: 0,
    charWidthEm: 0.45,
    capHeightEm: 0.7,
    role: "captionCondensedItalicFont",
    fallback: "condensedFont",
  },
  "extra-condensed": {
    fontWeight: 900,
    fontStyle: "normal",
    letterSpacingEm: 0.005,
    charWidthEm: 0.38,
    capHeightEm: 0.7,
    role: "captionExtraCondensedFont",
    fallback: "condensedFont",
  },
  rounded: {
    fontWeight: 900,
    fontStyle: "normal",
    letterSpacingEm: 0,
    charWidthEm: 0.62,
    capHeightEm: 0.7,
    role: "captionRoundedFont",
    fallback: "roundedFont",
  },
  grotesk: {
    fontWeight: 800,
    fontStyle: "normal",
    letterSpacingEm: -0.025,
    charWidthEm: 0.54,
    capHeightEm: 0.727,
    role: "captionGroteskFont",
    fallback: "primaryFont",
  },
  clean: {
    fontWeight: 700,
    fontStyle: "normal",
    letterSpacingEm: -0.01,
    charWidthEm: 0.56,
    capHeightEm: 0.727,
    role: null,
    fallback: "primaryFont",
  },
  "serif-italic": {
    fontWeight: 500,
    fontStyle: "italic",
    letterSpacingEm: -0.01,
    charWidthEm: 0.5,
    capHeightEm: 0.708,
    role: null,
    fallback: "serifFont",
  },
  mono: {
    fontWeight: 700,
    fontStyle: "normal",
    letterSpacingEm: -0.02,
    charWidthEm: 0.6,
    capHeightEm: 0.73,
    role: "captionMonoFont",
    fallback: "primaryFont",
  },
};

// A font context's generated module exports only the roles it supplies and no loader, so read both defensively.
const roles = fonts as unknown as Partial<Record<CaptionFontRole | Spec["fallback"], string>> & {
  loadCaptionFace?: (role: CaptionFontRole) => Promise<unknown>;
};

/** Face metrics without loading anything, for page building and tests in Node. */
export const faceMetrics = (id: FaceId): Omit<Face, "fontFamily"> => {
  const { role: _role, fallback: _fallback, ...metrics } = SPECS[id];
  return metrics;
};

/** The face's family: its caption role when present, else the fallback role. Loads nothing. */
export const face = (id: FaceId): Face => {
  const spec = SPECS[id];
  const fontFamily = (spec.role ? roles[spec.role] : undefined) ?? roles[spec.fallback] ?? "sans-serif";
  return { ...faceMetrics(id), fontFamily };
};

/** Resolves once the face's files are in `document.fonts`, so canvas measurement uses them and not a fallback. */
export const faceReady = async (id: FaceId): Promise<void> => {
  const role = SPECS[id].role;
  if (role && roles.loadCaptionFace) await roles.loadCaptionFace(role);
  await document.fonts.ready;
};
