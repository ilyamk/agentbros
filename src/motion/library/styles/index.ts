import type { LibraryStyle } from "../types";

/**
 * Complete looks. Font names resolve through `FACE_BY_NAME` in `../typography/faces.ts` (which also covers the faces of
 * `src/lib/fonts.ts` and `src/lib/fonts-cyrillic.ts`); this file names them only, so the registry loads no fonts.
 * Latin and Cyrillic: Inter, Inter Tight, Geist, Playfair Display, Oswald, Montserrat, Sofia Sans Extra Condensed,
 * Unbounded, Golos Text, Rubik. Latin only, with a Cyrillic fallback in the stack: Archivo (-> Unbounded),
 * Anton (-> Sofia Sans Extra Condensed), Instrument Serif (-> Playfair Display), Space Grotesk, DM Sans.
 *
 * Type scale is bimodal, as in the reference films: when type is the shot a hero word fills 50–95% of the width; when
 * picture is the shot a caption sits at about 10%. Nothing lives at the template middle, and no kicker/headline/subline
 * stack. `grounds` are flat colours to swap on hard cuts: the swap is the cut device. Seven of ten references are light.
 */
export const styles: LibraryStyle[] = [
  {
    id: "paper-signal",
    title: "Paper signal",
    description:
      "Light product launch: paper-white ground, near-black semibold grotesk at -0.045em, one signal-orange accent used only for numbers and once per film as the whole ground on the drop. Sentences build word by word with inline icon chips; the hero number fills the frame on a hard cut to orange. Developer tools, APIs, data products. Banned: vignette, glow, gradients, kicker labels. Cyrillic: yes (Inter Tight).",
    palette: { background: "#FAFAF8", surface: "#FFFFFF", text: "#111111", muted: "#6B6B66", accent: "#EE5A24" },
    fonts: { display: "Inter Tight", body: "Inter Tight" },
    motion: { springDamping: 14, springStiffness: 140, staggerFrames: 3, holdFrames: 36 },
    finish: { grain: 0.03, vignette: 0, motionBlur: true, glow: 0 },
    grounds: ["#FAFAF8", "#EE5A24", "#111111"],
    typeScale: { hero: 0.6, title: 0.42, caption: 0.1 },
  },
  {
    id: "ultramarine-poster",
    title: "Ultramarine poster",
    description:
      "Poster energy on three grounds swapped on the beat: paper white, ultramarine and black. Heavy condensed capitals (Anton) at 56–88% of the width for words; money in a semibold grotesk with green for gains. Every claim is a number growing, front-loaded then dead still. Consumer finance, markets, launches. Banned: soft fades between grounds, glow, rounded cards. Cyrillic: yes (Sofia Sans Extra Condensed via the Anton stack, Inter Tight).",
    palette: {
      background: "#F4F4F1",
      surface: "#FFFFFF",
      text: "#0D0D0D",
      muted: "#7A7A75",
      accent: "#3356F8",
      accent2: "#1DB954",
    },
    fonts: { display: "Anton", body: "Inter Tight" },
    motion: { springDamping: 12, springStiffness: 190, staggerFrames: 2, holdFrames: 24 },
    finish: { grain: 0.04, vignette: 0, motionBlur: true, glow: 0 },
    grounds: ["#F4F4F1", "#3356F8", "#0D0D0D"],
    typeScale: { hero: 0.72, title: 0.5, caption: 0.1 },
  },
  {
    id: "signal-red-code",
    title: "Signal red code",
    description:
      "A film that proves it is made of code: near-black, signal red and white grounds swapped on almost every cut, a heavy wide grotesk (Archivo at wdth 125) in capitals at 73–96% of the width, allowed to overflow; one word per pulse, letters scrambling to code glyphs, small captions top-left with the newest word tagged red. Developer tools, motion and creative software. Banned: chroma fringe, glow, vignette. Cyrillic: yes (Unbounded via the Archivo stack, Golos Text).",
    palette: { background: "#0C0C0C", surface: "#1A1A1A", text: "#F4F2EE", muted: "#7A7A7A", accent: "#EF4A2D" },
    fonts: { display: "Archivo", body: "Golos Text", mono: "Geist" },
    motion: { springDamping: 10, springStiffness: 215, staggerFrames: 1, holdFrames: 12 },
    finish: { grain: 0.05, vignette: 0, motionBlur: true, glow: 0 },
    grounds: ["#0C0C0C", "#EF4A2D", "#F4F2EE"],
    typeScale: { hero: 0.85, title: 0.6, caption: 0.06 },
  },
  {
    id: "warm-editorial",
    title: "Warm editorial",
    description:
      "Warm off-white ground with ink-black Instrument Serif headlines at -0.025em and a neutral grotesk for captions; one forest-green accent for the key word, a sage ground swapped in for chapter cuts. Long holds (0.5 s + 0.3 s a word). Essays, education, culture, wellbeing. Banned: mono caps labels as decoration, kicker stacks, glow, gradients. Cyrillic: yes (Playfair Display via the Instrument Serif stack, Inter Tight).",
    palette: { background: "#F3EEE6", surface: "#FBF8F3", text: "#1A1814", muted: "#77705F", accent: "#2F5D3A" },
    fonts: { display: "Instrument Serif", body: "Inter Tight" },
    motion: { springDamping: 14, springStiffness: 140, staggerFrames: 4, holdFrames: 60 },
    finish: { grain: 0.06, vignette: 0, motionBlur: false, glow: 0 },
    grounds: ["#F3EEE6", "#DCE3D2", "#1A1814"],
    typeScale: { hero: 0.62, title: 0.5, caption: 0.1 },
  },
  {
    id: "pale-tint-app",
    title: "Pale tint app",
    description:
      "Friendly consumer app on a pale tint (lavender white) with a cobalt accent: rounded geometric sans (DM Sans) in mixed case, real UI at 1.6–2x, a yellow highlight that cools to ink in 9 frames on the newest word, one cobalt full-frame ground per film. Consumer apps, AI assistants, creator tools. Banned: glass cards, purple mesh, bounce on UI chrome, glow. Cyrillic: no for DM Sans; use Rubik.",
    palette: {
      background: "#F2F1FA",
      surface: "#FFFFFF",
      text: "#16152B",
      muted: "#6E6C8A",
      accent: "#3D5AFE",
      accent2: "#FFD60A",
    },
    fonts: { display: "DM Sans", body: "DM Sans" },
    motion: { springDamping: 12, springStiffness: 190, staggerFrames: 3, holdFrames: 30 },
    finish: { grain: 0.03, vignette: 0, motionBlur: true, glow: 0 },
    grounds: ["#F2F1FA", "#3D5AFE", "#FFFFFF"],
    typeScale: { hero: 0.6, title: 0.45, caption: 0.1 },
  },
  {
    id: "keynote-dark",
    title: "Keynote dark",
    description:
      "Premium product stage when the product itself is lit: near-black ground with one local key light on the product only, white Inter Tight at -0.04em, hero words at 60–90% of the width on hard cuts, a paper-white ground swapped in for the one stat. 0% overshoot on type, springs 18/200, 2% grain. Product reveals with a real render. Banned: glow, orbs, floating UI on a void, full-frame vignetted gradients, kicker/headline/subline stacks. Cyrillic: yes (Inter Tight).",
    palette: {
      background: "#050507",
      surface: "#121317",
      text: "#F5F5F7",
      muted: "#86868B",
      accent: "#2997FF",
      accent2: "#BF5AF2",
    },
    fonts: { display: "Inter Tight", body: "Inter" },
    motion: { springDamping: 18, springStiffness: 200, staggerFrames: 3, holdFrames: 45 },
    finish: { grain: 0.02, vignette: 0.2, motionBlur: true, glow: 0 },
    grounds: ["#050507", "#F5F5F7", "#2997FF"],
    typeScale: { hero: 0.7, title: 0.45, caption: 0.1 },
  },
  {
    id: "linear-midnight",
    title: "Linear midnight",
    description:
      "Precise SaaS look: charcoal ground, Geist semibold at -0.04em, one indigo accent on one word per line, real UI at 1.6–2x, words staggered 3 f, springs 12/190 snapping to steps; an off-white ground swapped in when the UI goes full frame. Developer tools and B2B. Banned: purple mesh gradients, glass cards, three cards in a row, tilted 3D UI, glow. Cyrillic: yes (Geist).",
    palette: {
      background: "#08090A",
      surface: "#141519",
      text: "#F7F8F8",
      muted: "#8A8F98",
      accent: "#5E6AD2",
      accent2: "#A5B4FC",
    },
    fonts: { display: "Geist", body: "Geist", mono: "Geist" },
    motion: { springDamping: 12, springStiffness: 190, staggerFrames: 3, holdFrames: 36 },
    finish: { grain: 0.05, vignette: 0.2, motionBlur: true, glow: 0 },
    grounds: ["#08090A", "#F7F8F8", "#5E6AD2"],
    typeScale: { hero: 0.62, title: 0.45, caption: 0.1 },
  },
  {
    id: "stripe-gradient",
    title: "Stripe gradient",
    description:
      "Bright fintech look: light ground with one warm saturated mesh behind a single hero (never full-frame), dark navy Inter Tight at -0.04em, springs 14/140, list items staggered 2 f; a navy ground swapped in for the stat. Payments and platforms. Banned: blue or purple mesh on dark, glass cards, glow, docked logo. Cyrillic: yes (Inter Tight).",
    palette: {
      background: "#F6F9FC",
      surface: "#FFFFFF",
      text: "#0A2540",
      muted: "#425466",
      accent: "#635BFF",
      accent2: "#FF5996",
    },
    fonts: { display: "Inter Tight", body: "Inter" },
    motion: { springDamping: 14, springStiffness: 140, staggerFrames: 2, holdFrames: 40 },
    finish: { grain: 0.04, vignette: 0, motionBlur: true, glow: 0 },
    grounds: ["#F6F9FC", "#0A2540", "#635BFF"],
    typeScale: { hero: 0.6, title: 0.45, caption: 0.1 },
  },
  {
    id: "editorial-paper",
    title: "Editorial paper",
    description:
      "Printed-matter look on the paper-fibre ground: ink-black Playfair Display headlines, one vermilion accent that once floods the frame on a cut, paper overshoot 3–5%, words staggered 4 f, long holds (0.5 s + 0.3 s a word), 0.08 grain. Essays, culture, education. Banned: cream paper with serif plus mono caps labels as decoration, kicker stacks, glow, gradients. Cyrillic: yes (Playfair Display, Inter).",
    palette: { background: "#F2EDE4", surface: "#E8E1D5", text: "#151412", muted: "#6E675D", accent: "#D9441C" },
    fonts: { display: "Playfair Display", body: "Inter" },
    motion: { springDamping: 14, springStiffness: 140, staggerFrames: 4, holdFrames: 60 },
    finish: { grain: 0.08, vignette: 0, motionBlur: false, glow: 0 },
    grounds: ["#F2EDE4", "#D9441C", "#151412"],
    typeScale: { hero: 0.6, title: 0.5, caption: 0.1 },
  },
  {
    id: "brutalist-mono",
    title: "Brutalist mono",
    description:
      "Black and white with one acid accent: Anton condensed capitals filling 60–90% of the width, grounds swapping black, white and acid on hard cuts, letters staggered 1 f, whips 4–9 f with 10 px blur. Manifestos, fashion, music. Banned: glow, gradients, rounded cards, slow creeping scale. Cyrillic: yes (Sofia Sans Extra Condensed via the Anton stack, Golos Text); capitals only for Russian.",
    palette: { background: "#0A0A0A", surface: "#1A1A1A", text: "#FFFFFF", muted: "#7A7A7A", accent: "#D4FF00" },
    fonts: { display: "Anton", body: "Golos Text" },
    motion: { springDamping: 10, springStiffness: 215, staggerFrames: 1, holdFrames: 20 },
    finish: { grain: 0.07, vignette: 0, motionBlur: true, glow: 0 },
    grounds: ["#0A0A0A", "#FFFFFF", "#D4FF00"],
    typeScale: { hero: 0.88, title: 0.6, caption: 0.08 },
  },
  {
    id: "playful-pop",
    title: "Playful pop",
    description:
      "Colour-block consumer look: flat saturated planes swapped on cuts (cream, coral, blue), rounded wide type, rubber overshoot 15–25% on objects (never on UI chrome), springs 8/200 for one hero moment and 10/215 elsewhere, chips staggered 6 f. Consumer apps and social. Banned: bouncing UI chrome, click rings, glow, decorative particles. Cyrillic: yes (Unbounded, Rubik).",
    palette: {
      background: "#FFF4E0",
      surface: "#FFFFFF",
      text: "#1B1B3A",
      muted: "#6B6B8A",
      accent: "#FF4D6D",
      accent2: "#3A86FF",
    },
    fonts: { display: "Unbounded", body: "Rubik" },
    motion: { springDamping: 10, springStiffness: 215, staggerFrames: 3, holdFrames: 30 },
    finish: { grain: 0.04, vignette: 0, motionBlur: true, glow: 0 },
    grounds: ["#FFF4E0", "#FF4D6D", "#3A86FF"],
    typeScale: { hero: 0.7, title: 0.5, caption: 0.1 },
  },
  {
    id: "luxury-serif",
    title: "Luxury serif",
    description:
      "Cinematic luxury: warm key light upper left on the product only, deep warm black, champagne accent, Instrument Serif display at 0% overshoot, springs 18/200, letters of a name 3 f apart, final line held 2 s or more; a champagne paper ground swapped in for one quiet line. Premium goods and hospitality. Banned: glow, bokeh orbs, gold gradients on type, bounce. Cyrillic: yes (Playfair Display via the Instrument Serif stack, Montserrat).",
    palette: {
      background: "#0D0B09",
      surface: "#1A1612",
      text: "#F3EBDD",
      muted: "#9C8F7A",
      accent: "#C9A96E",
      accent2: "#E8D5A8",
    },
    fonts: { display: "Instrument Serif", body: "Montserrat" },
    motion: { springDamping: 18, springStiffness: 200, staggerFrames: 3, holdFrames: 75 },
    finish: { grain: 0.02, vignette: 0.06, motionBlur: false, glow: 0 },
    grounds: ["#0D0B09", "#EFE6D6"],
    typeScale: { hero: 0.6, title: 0.45, caption: 0.09 },
  },
  {
    id: "neon-tech",
    title: "Neon tech",
    description:
      "Brand-owned neon: black with cyan and magenta light, wide display, whips 4–9 f with 18 px full-frame blur, springs 12/190, words staggered 2 f; a cyan ground swapped in on the drop. Bloom allowed at 0.4 only because the look is built on emitted light. Gaming and music. Banned: purple mesh gradients, floating UI on a void, flares as decoration. Cyrillic: yes (Unbounded, Golos Text).",
    palette: {
      background: "#030308",
      surface: "#0E0E1A",
      text: "#EAF6FF",
      muted: "#6C7A99",
      accent: "#00E5FF",
      accent2: "#FF2BD6",
    },
    fonts: { display: "Unbounded", body: "Golos Text" },
    motion: { springDamping: 12, springStiffness: 190, staggerFrames: 2, holdFrames: 24 },
    finish: { grain: 0.06, vignette: 0.4, motionBlur: true, glow: 0.4 },
    grounds: ["#030308", "#00E5FF", "#FF2BD6"],
    typeScale: { hero: 0.75, title: 0.5, caption: 0.08 },
  },
];

export const getStyle = (id: string): LibraryStyle => {
  const style = styles.find((entry) => entry.id === id);
  if (!style) throw new Error(`Unknown style "${id}". Known: ${styles.map((entry) => entry.id).join(", ")}.`);
  return style;
};
