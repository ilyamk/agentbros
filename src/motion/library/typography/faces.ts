import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadVariableFont as loadArchivo } from "@remotion/google-fonts/Archivo";
import { loadVariableFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadInstrumentSerif } from "@remotion/google-fonts/InstrumentSerif";
import { loadVariableFont as loadInterTight } from "@remotion/google-fonts/InterTight";
import { displayFont, geometricFont, narrowFont, primaryFont, roundedFont, serifNormalFont } from "../../../lib/fonts";
import {
  cyrillicCondensedFont,
  cyrillicGroteskFont,
  cyrillicRoundedFont,
  cyrillicWideFont,
} from "../../../lib/fonts-cyrillic";

/**
 * Display faces of the reference films. Each Latin-only face carries a Cyrillic fallback in its stack, so a Russian
 * word renders in a face of the same build instead of the browser default.
 */
const { fontFamily: interTight } = loadInterTight("normal", { subsets: ["latin", "cyrillic"] });
const { fontFamily: geist } = loadGeist("normal", { subsets: ["latin", "cyrillic"] });
const { fontFamily: archivo } = loadArchivo("normal", { subsets: ["latin"] });
const { fontFamily: anton } = loadAnton("normal", { weights: ["400"], subsets: ["latin"] });
const { fontFamily: instrumentSerif } = loadInstrumentSerif("normal", { weights: ["400"], subsets: ["latin"] });

/** Neutral grotesk (firecrawl, context-dev, ugc): semibold at -0.045em. Latin and Cyrillic. */
export const groteskFace = interTight;
/** Neutral grotesk with rounder terminals. Latin and Cyrillic. */
export const geistFace = geist;
/** Heavy wide grotesk (ref-service-explainer): Archivo at wdth 125. Pass `WIDE_AXES` as fontVariationSettings. */
export const wideFace = `${archivo}, ${cyrillicWideFont}`;
export const WIDE_AXES = `"wdth" 125, "wght" 900`;
/** Heavy condensed capitals (polymarket): Anton. */
export const condensedFace = `${anton}, ${cyrillicCondensedFont}`;
/** Editorial serif with a light, high-contrast cut. */
export const serifFace = `${instrumentSerif}, ${serifNormalFont}`;

/** Family stack for each name a style can give, including the faces registered in `src/lib/fonts*.ts`. */
export const FACE_BY_NAME: Record<string, string> = {
  "Inter Tight": groteskFace,
  Geist: geistFace,
  Archivo: wideFace,
  Anton: condensedFace,
  "Instrument Serif": serifFace,
  Inter: primaryFont,
  "Space Grotesk": displayFont,
  "Playfair Display": serifNormalFont,
  "DM Sans": roundedFont,
  Oswald: narrowFont,
  Montserrat: geometricFont,
  "Sofia Sans Extra Condensed": cyrillicCondensedFont,
  Unbounded: cyrillicWideFont,
  "Golos Text": cyrillicGroteskFont,
  Rubik: cyrillicRoundedFont,
};

export const faceFor = (name: string): string => FACE_BY_NAME[name] ?? groteskFace;

/** Font variation settings a face needs to look like its name; empty for static faces. */
export const axesFor = (family: string): string | undefined => (family === wideFace ? WIDE_AXES : undefined);

export const FACE_NAMES = ["grotesk", "wide", "condensed", "serif"] as const;
export type FaceName = (typeof FACE_NAMES)[number];

export type FaceStyle = {
  fontFamily: string;
  fontWeight: number;
  letterSpacing: string;
  fontVariationSettings?: string;
  textTransform?: "uppercase";
};

/** How each display face is set when type is the shot. Condensed and wide are capitals, as in the references. */
export const faceStyle = (name: FaceName): FaceStyle => {
  if (name === "wide")
    return {
      fontFamily: wideFace,
      fontWeight: 900,
      letterSpacing: "-0.02em",
      fontVariationSettings: WIDE_AXES,
      textTransform: "uppercase",
    };
  if (name === "condensed")
    return { fontFamily: condensedFace, fontWeight: 400, letterSpacing: "0em", textTransform: "uppercase" };
  if (name === "serif") return { fontFamily: serifFace, fontWeight: 400, letterSpacing: "-0.025em" };
  return { fontFamily: groteskFace, fontWeight: 600, letterSpacing: "-0.045em" };
};

/** A run for `useSharedFit`/`useTextWidths` that measures the face exactly as `faceStyle` sets it. */
export const faceRun = (name: FaceName, text: string) => {
  const face = faceStyle(name);
  return {
    text: face.textTransform === "uppercase" ? text.toUpperCase() : text,
    fontFamily: face.fontFamily,
    fontWeight: face.fontWeight,
    letterSpacing: face.letterSpacing,
    ...(face.fontVariationSettings ? { additionalStyles: { fontVariationSettings: face.fontVariationSettings } } : {}),
  };
};
