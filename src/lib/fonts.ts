import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadBebasNeue } from "@remotion/google-fonts/BebasNeue";
import { loadFont as loadPlayfairDisplay } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as loadDMSans } from "@remotion/google-fonts/DMSans";
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";
import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";
import { fontFamily as interTightFamily, loadFont as loadInterTight } from "@remotion/google-fonts/InterTight";
import { fontFamily as jetBrainsMonoFamily, loadFont as loadJetBrainsMono } from "@remotion/google-fonts/JetBrainsMono";
import { fontFamily as rubikFamily, loadFont as loadRubik } from "@remotion/google-fonts/Rubik";
import {
  fontFamily as sofiaCondensedFamily,
  loadFont as loadSofiaSansCondensed,
} from "@remotion/google-fonts/SofiaSansCondensed";
import {
  fontFamily as sofiaExtraCondensedFamily,
  loadFont as loadSofiaSansExtraCondensed,
} from "@remotion/google-fonts/SofiaSansExtraCondensed";

// ─── Primary — clean body text ──────────────────────────────────────────────
export const { fontFamily: primaryFont } = loadInter("normal", {
  weights: ["400", "500", "600", "700", "800", "900"],
  subsets: ["latin", "cyrillic"],
});

// ─── Display — geometric headings ──────────────────────────────────────────
export const { fontFamily: displayFont } = loadSpaceGrotesk("normal", {
  weights: ["500", "600", "700"],
  subsets: ["latin"],
});

// ─── Condensed Caps — massive fill-width titles (ref: movie posters) ───────
export const { fontFamily: condensedFont } = loadBebasNeue("normal", {
  weights: ["400"], // Bebas Neue only has 400 but looks bold
  subsets: ["latin"],
});

// ─── Serif Italic — elegant contrast headlines (ref: editorial) ────────────
export const { fontFamily: serifFont } = loadPlayfairDisplay("italic", {
  weights: ["400", "500", "600", "700", "800", "900"],
  subsets: ["latin", "cyrillic"],
});
export const { fontFamily: serifNormalFont } = loadPlayfairDisplay("normal", {
  weights: ["400", "500", "600", "700", "800", "900"],
  subsets: ["latin", "cyrillic"],
});

// ─── Rounded — friendly clean sans (alt to Inter) ─────────────────────────
export const { fontFamily: roundedFont } = loadDMSans("normal", {
  weights: ["400", "500", "600", "700", "800", "900"],
  subsets: ["latin"],
});

// ─── Narrow Bold — compact impactful text ──────────────────────────────────
export const { fontFamily: narrowFont } = loadOswald("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin", "cyrillic"],
});

// ─── Geometric — modern titles with character ──────────────────────────────
export const { fontFamily: geometricFont } = loadMontserrat("normal", {
  weights: ["400", "500", "600", "700", "800", "900"],
  subsets: ["latin", "cyrillic"],
});

// ─── Caption faces — burned caption presets (src/motion/library/captions) ───
// Family names only: the files load on first use through `loadCaptionFace`, so renders without these captions
// never fetch them. A font context may supply them as optional roles; it then loads them itself and has no
// `loadCaptionFace`. All OFL, Latin and Cyrillic.
export const captionHeavyItalicFont = geometricFont;
export const captionCondensedItalicFont = sofiaCondensedFamily;
export const captionExtraCondensedFont = sofiaExtraCondensedFamily;
export const captionRoundedFont = rubikFamily;
export const captionGroteskFont = interTightFamily;
export const captionMonoFont = jetBrainsMonoFamily;

export type CaptionFontRole =
  | "captionHeavyItalicFont"
  | "captionCondensedItalicFont"
  | "captionExtraCondensedFont"
  | "captionRoundedFont"
  | "captionGroteskFont"
  | "captionMonoFont";

const CAPTION_SUBSETS: ("latin" | "cyrillic")[] = ["latin", "cyrillic"];
const captionLoads = new Map<CaptionFontRole, Promise<unknown>>();
const startCaptionFace = (role: CaptionFontRole): Promise<unknown> => {
  switch (role) {
    case "captionHeavyItalicFont":
      return loadMontserrat("italic", { weights: ["800", "900"], subsets: CAPTION_SUBSETS }).waitUntilDone();
    case "captionCondensedItalicFont":
      return loadSofiaSansCondensed("italic", { weights: ["800", "900"], subsets: CAPTION_SUBSETS }).waitUntilDone();
    case "captionExtraCondensedFont":
      return loadSofiaSansExtraCondensed("normal", {
        weights: ["800", "900"],
        subsets: CAPTION_SUBSETS,
      }).waitUntilDone();
    case "captionRoundedFont":
      return loadRubik("normal", { weights: ["800", "900"], subsets: CAPTION_SUBSETS }).waitUntilDone();
    case "captionGroteskFont":
      return loadInterTight("normal", {
        weights: ["500", "600", "700", "800"],
        subsets: CAPTION_SUBSETS,
      }).waitUntilDone();
    case "captionMonoFont":
      return loadJetBrainsMono("normal", { weights: ["500", "700"], subsets: CAPTION_SUBSETS }).waitUntilDone();
  }
};

/** Loads one caption face once; resolves when its files are in `document.fonts`. */
export const loadCaptionFace = (role: CaptionFontRole): Promise<unknown> => {
  let load = captionLoads.get(role);
  if (!load) {
    load = startCaptionFace(role);
    captionLoads.set(role, load);
  }
  return load;
};

// ─── Font Role Map ─────────────────────────────────────────────────────────
// Use these semantic names in components:
//
//   primaryFont     → Body text, subtitles, descriptions
//   displayFont     → Headlines, scene headers
//   condensedFont   → MASSIVE caps titles (Bebas Neue, always uppercase)
//   serifFont       → Italic accent headlines (Playfair Display italic)
//   serifNormalFont → Serif normal weight
//   roundedFont     → Friendly sans alternative (DM Sans)
//   narrowFont      → Compact bold text (Oswald)
//   geometricFont   → Modern geometric titles (Montserrat)
//
//   caption*Font    → burned caption presets, loaded on first use (loadCaptionFace)
//
// Cyrillic variable faces live in ./fonts-cyrillic and load only where imported.
