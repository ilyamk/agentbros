import { loadVariableFont } from "@remotion/google-fonts/RobotoFlex";

/**
 * Roboto Flex with Cyrillic: the one face here with a real width axis (wdth 25-151, wght 100-1000). Import it only
 * where it is used, so other compositions don't load it.
 */
export const { fontFamily: flexFont } = loadVariableFont("oblique 0deg 10deg", { subsets: ["latin", "cyrillic"] });
