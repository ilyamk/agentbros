import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";

// Latin and Cyrillic, so Russian copy is set in Geist rather than the browser's serif fallback.
const SUBSETS: ("latin" | "latin-ext" | "cyrillic" | "cyrillic-ext")[] = [
  "latin",
  "latin-ext",
  "cyrillic",
  "cyrillic-ext",
];

const geistFamily = loadGeist("normal", { weights: ["400", "500", "600", "700"], subsets: SUBSETS }).fontFamily;
const geistMonoFamily = loadGeistMono("normal", { weights: ["400", "500"], subsets: SUBSETS }).fontFamily;

/** Geist with a sans stack behind it, so a script Geist lacks never falls back to a serif. */
export const geist = `${geistFamily}, "Helvetica Neue", Arial, sans-serif`;
export const geistMono = `${geistMonoFamily}, "SF Mono", Menlo, monospace`;
