import { loadVariableFont as loadSofiaSansExtraCondensed } from "@remotion/google-fonts/SofiaSansExtraCondensed";
import { loadVariableFont as loadUnbounded } from "@remotion/google-fonts/Unbounded";
import { loadVariableFont as loadGolosText } from "@remotion/google-fonts/GolosText";
import { loadVariableFont as loadRubik } from "@remotion/google-fonts/Rubik";

// Variable faces with real Cyrillic: fontWeight animates continuously.
// Separate from ./fonts so existing compositions do not load them.
export const CYRILLIC_FONT_SUBSETS: ("latin" | "cyrillic")[] = ["latin", "cyrillic"];

export const { fontFamily: cyrillicCondensedFont } = loadSofiaSansExtraCondensed("normal", {
  subsets: CYRILLIC_FONT_SUBSETS,
});
export const { fontFamily: cyrillicWideFont } = loadUnbounded("normal", {
  subsets: CYRILLIC_FONT_SUBSETS,
});
export const { fontFamily: cyrillicGroteskFont } = loadGolosText("normal", {
  subsets: CYRILLIC_FONT_SUBSETS,
});
export const { fontFamily: cyrillicRoundedFont } = loadRubik("normal", {
  subsets: CYRILLIC_FONT_SUBSETS,
});

// cyrillicCondensedFont → poster titles (Sofia Sans Extra Condensed, wght 1-1000)
// cyrillicWideFont      → wide display (Unbounded, wght 200-900)
// cyrillicGroteskFont   → headlines and text (Golos Text, wght 400-900)
// cyrillicRoundedFont   → friendly sans (Rubik, wght 300-900)
