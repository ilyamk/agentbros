import { z } from "zod";
import { FACE_IDS } from "./faces";
import { captionBaseShape, type CaptionBaseProps } from "./layout";

/** #RGB, #RRGGBB or #RRGGBBAA, so contrast can be measured. */
export const colourSchema = z
  .string()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i, "Use #RGB, #RRGGBB or #RRGGBBAA");

/**
 * What keeps the letters readable over footage. There is no blurred scrim: pick one of three treatments.
 * - `outline`: a stroke around every glyph with round joins, `width` visible outside the letter in em, and an optional
 *   hard `depth` drop under it (in em).
 * - `shadow`: a drop shadow offset by `x`/`y` em; `blur` 0 is a hard shadow, above 0.1 em a soft one.
 * - `box`: a solid box behind each `word`, each `line` or the whole `page`, padded and rounded in em.
 */
export const captionBackingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("outline"),
      colour: colourSchema.default("#000000"),
      width: z.number().min(0.02).max(0.25).default(0.1),
      depth: z.number().min(0).max(0.2).default(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("shadow"),
      colour: colourSchema.default("#000000"),
      x: z.number().min(-0.2).max(0.2).default(0.04),
      y: z.number().min(-0.2).max(0.2).default(0.06),
      blur: z.number().min(0).max(0.5).default(0),
      opacity: z.number().min(0).max(1).default(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("box"),
      fill: colourSchema.default("#FFFFFF"),
      scope: z.enum(["word", "line", "page"]).default("line"),
      padX: z.number().min(0).max(0.8).default(0.28),
      padY: z.number().min(0).max(0.5).default(0.08),
      radius: z.number().min(0).max(0.6).default(0.2),
    })
    .strict(),
]);
export type CaptionBacking = z.infer<typeof captionBackingSchema>;

/**
 * One rung of a preset's legibility ladder: what changes when the footage under a page defeats the preset's own
 * treatment. Rungs apply cumulatively (level 2 is rung 1, then rung 2) and touch only colours and the backing, so a
 * level never reflows a page.
 */
export const legibilityRungSchema = z
  .object({
    backing: captionBackingSchema.optional(),
    textColor: colourSchema.optional(),
    accent: colourSchema.optional(),
    accent2: colourSchema.optional(),
  })
  .strict();
export type LegibilityRung = z.infer<typeof legibilityRungSchema>;

/** Pages starting in `[from, to)` (caption seconds) sit at `position`. Written by `captions:place`; `position` in the options wins. */
export const positionRangeSchema = z
  .object({
    from: z.number().nonnegative(),
    to: z.number().nonnegative(),
    position: z.enum(["lower", "middle", "upper"]),
  })
  .strict();
export type PositionRange = z.infer<typeof positionRangeSchema>;

/** Pages starting in `[from, to)` (caption seconds, the clock of the words) draw at `level`. Written by `captions:place`. */
export const legibilityRangeSchema = z
  .object({ from: z.number().nonnegative(), to: z.number().nonnegative(), level: z.number().int().min(1).max(3) })
  .strict();
export type LegibilityRange = z.infer<typeof legibilityRangeSchema>;

export const ENTRIES = ["pop", "rise", "fade", "blur", "bounce", "slam", "typewriter", "none"] as const;
export type CaptionEntry = (typeof ENTRIES)[number];

export const captionStyleSchema = z.object({
  ...captionBaseShape,
  face: z.enum(FACE_IDS),
  uppercase: z.boolean(),
  /** Second accent, for the serif word of a mixed-scale page. */
  accent2: colourSchema,
  backing: captionBackingSchema,
  active: z
    .object({
      /** The spoken word takes the accent colour. */
      recolour: z.boolean(),
      /** Largest scale of the spoken word, reached with a small overshoot. */
      scale: z.number().min(1).max(1.5),
      /** An accent box sits behind the spoken word and slides from word to word. */
      box: z.boolean(),
      boxText: colourSchema,
      /** Two edges move at different speeds on the same line and reopen at a line break. */
      boxMotion: z.enum(["slide", "elastic"]).optional(),
      /** Opacity of words not yet spoken; 1 shows the whole page at once. Ignored with `reveal: "word"`. */
      upcomingOpacity: z.number().min(0).max(1),
      /**
       * `brighten` (absent): words not yet spoken sit at `upcomingOpacity` and come up to full as spoken. `switch`: each
       * word takes the accent on the frame it is spoken and keeps it, a karaoke fill in one frame (abdulah 34.0-36.5 s).
       */
      fill: z.enum(["brighten", "switch"]).optional(),
    })
    .strict(),
  emphasis: z
    .object({
      /** `auto`: marked, listed and heuristic key words; `marked`: only `emphasis` words and `keywords`; `off`: none. */
      source: z.enum(["auto", "marked", "off"]),
      /** Key words take the accent colour. */
      recolour: z.boolean(),
      /** Size of a key word against the page; small connective words shrink in `mixed` layout. */
      scale: z.number().min(1).max(2.4),
      /** In `mixed` layout the second most important word is set in the serif italic, in `accent2`. */
      serif: z.boolean(),
    })
    .strict(),
  /** How each word or page arrives. Entries last 4–8 frames at 30 fps, so captions stay on the voice. */
  entry: z.enum(ENTRIES),
  /** `page`: the page arrives whole; `word`: each word arrives as it is spoken, its place kept so nothing reflows. */
  reveal: z.enum(["page", "word"]),
  /** `lines`: one or two centred lines; `stack`: one word per line; `mixed`: sizes by importance, stacked editorially. */
  layout: z.enum(["lines", "stack", "mixed"]),
  /** Lines per page (stack and mixed pages may use up to 3). */
  maxLines: z.number().int().min(1).max(3),
  /** Largest type size as a share of the frame's shorter side, before `textScale`. */
  size: z.number().min(0.04).max(0.24),
  /** The preset's legibility ladder, mildest rung first; empty when its treatment already holds on any footage. */
  fallbacks: z.array(legibilityRungSchema).max(3).default([]),
  /** Measured levels per page, decided from clean stills of the footage before rendering; absent pages use level 0. */
  legibility: z.array(legibilityRangeSchema).max(20_000).default([]),
  /** Measured position per page, chosen from clean stills to keep faces and on-screen text clear; absent pages use `position`. */
  positions: z.array(positionRangeSchema).max(20_000).default([]),
});
export type CaptionStyleProps = z.infer<typeof captionStyleSchema>;

const base: CaptionBaseProps = {
  words: [],
  startOffsetSec: 0,
  maxWords: 3,
  minPageSec: 0.8,
  position: "lower",
  placement: "safe-zone",
  textScale: 1,
  language: "en",
  textColor: "#FFFFFF",
  accent: "#FFD60A",
  keywords: [],
};

const quiet = { recolour: false, scale: 1, box: false, boxText: "#FFFFFF", upcomingOpacity: 1 } as const;
const noEmphasis = { source: "off", recolour: false, scale: 1, serif: false } as const;

type Preset = Omit<CaptionStyleProps, "words" | "legibility" | "positions">;

/** The professional presets. Names describe the look; `docs/captions-styles.md` explains each recipe. */
export const CAPTION_PRESETS = {
  /** White heavy caps, thick round-jointed black outline with a hard drop, the spoken word green and popping. */
  "outline-pop": {
    ...base,
    face: "heavy",
    uppercase: true,
    accent: "#5BF06A",
    accent2: "#FFE234",
    backing: { kind: "outline", colour: "#000000", width: 0.1, depth: 0.05 },
    active: { ...quiet, recolour: true, scale: 1.12 },
    emphasis: noEmphasis,
    entry: "pop",
    reveal: "page",
    layout: "lines",
    maxLines: 2,
    size: 0.096,
    fallbacks: [],
  },
  /** Condensed italic caps, all in warm yellow, hard black shadow; each word pops in as it is spoken. */
  "italic-shadow": {
    ...base,
    maxWords: 4,
    face: "condensed-italic",
    uppercase: true,
    textColor: "#FFE234",
    accent: "#FFFFFF",
    accent2: "#FFFFFF",
    backing: { kind: "shadow", colour: "#000000", x: 0.035, y: 0.07, blur: 0, opacity: 1 },
    active: { ...quiet, scale: 1.08 },
    emphasis: noEmphasis,
    entry: "pop",
    reveal: "word",
    layout: "lines",
    maxLines: 2,
    size: 0.125,
    fallbacks: [{ backing: { kind: "outline", colour: "#000000", width: 0.06, depth: 0.07 } }],
  },
  /** White heavy italic caps with a hard shadow; the page's key word (number, marked or longest content word) in yellow. */
  "keyword-colour": {
    ...base,
    maxWords: 4,
    face: "heavy-italic",
    uppercase: true,
    accent: "#FFD60A",
    accent2: "#FFFFFF",
    backing: { kind: "shadow", colour: "#000000", x: 0.03, y: 0.06, blur: 0.06, opacity: 0.95 },
    active: quiet,
    emphasis: { source: "auto", recolour: true, scale: 1.12, serif: false },
    entry: "rise",
    reveal: "word",
    layout: "lines",
    maxLines: 2,
    size: 0.09,
    fallbacks: [{ backing: { kind: "outline", colour: "#000000", width: 0.06, depth: 0.06 } }],
  },
  /** Sentence-case heavy sans with a thin outline; a solid accent box slides behind the spoken word. */
  "word-box": {
    ...base,
    face: "heavy",
    uppercase: false,
    accent: "#7B5CFF",
    accent2: "#FFE234",
    backing: { kind: "outline", colour: "#000000", width: 0.06, depth: 0 },
    active: { ...quiet, box: true, scale: 1.04, boxText: "#FFFFFF" },
    emphasis: noEmphasis,
    entry: "pop",
    reveal: "page",
    layout: "lines",
    maxLines: 2,
    size: 0.084,
    fallbacks: [],
  },
  /** Dark sentence-case text on a solid white rounded box per line, like the platforms' own text labels; calm rise. */
  "line-box": {
    ...base,
    maxWords: 5,
    face: "grotesk",
    uppercase: false,
    textColor: "#111111",
    accent: "#E8336D",
    accent2: "#E8336D",
    backing: { kind: "box", fill: "#FFFFFF", scope: "line", padX: 0.3, padY: 0.1, radius: 0.24 },
    active: quiet,
    emphasis: noEmphasis,
    entry: "rise",
    reveal: "page",
    layout: "lines",
    maxLines: 2,
    size: 0.08,
    fallbacks: [],
  },
  /** Chunky rounded caps in pale pink, one word per line, centred on the speaker; words bounce in as spoken. */
  "chunky-stack": {
    ...base,
    position: "middle",
    face: "rounded",
    uppercase: true,
    textColor: "#FFD3DF",
    accent: "#FFFFFF",
    accent2: "#FFFFFF",
    backing: { kind: "shadow", colour: "#24070F", x: 0, y: 0.05, blur: 0.16, opacity: 1 },
    active: quiet,
    emphasis: noEmphasis,
    entry: "bounce",
    reveal: "word",
    layout: "stack",
    maxLines: 3,
    size: 0.14,
    fallbacks: [{ backing: { kind: "outline", colour: "#24070F", width: 0.07, depth: 0.05 } }],
  },
  /** Editorial mixed scale: tiny connective words, a huge key word in mint, one serif italic word in yellow; blur-in per word. */
  "editorial-mix": {
    ...base,
    maxWords: 5,
    minPageSec: 1,
    face: "grotesk",
    uppercase: false,
    accent: "#6FF0C8",
    accent2: "#FFE36E",
    backing: { kind: "shadow", colour: "#000000", x: 0, y: 0.04, blur: 0.16, opacity: 0.85 },
    active: quiet,
    emphasis: { source: "auto", recolour: true, scale: 1.9, serif: true },
    entry: "blur",
    reveal: "word",
    layout: "mixed",
    maxLines: 3,
    size: 0.085,
    fallbacks: [{ backing: { kind: "outline", colour: "#000000", width: 0.06, depth: 0 } }],
  },
  /** Quiet sentence case for calm talk: thin dark outline, words fill from dim to white as they are spoken. */
  "clean-sentence": {
    ...base,
    maxWords: 6,
    face: "clean",
    uppercase: false,
    accent: "#FFD60A",
    accent2: "#FFFFFF",
    backing: { kind: "outline", colour: "#101010", width: 0.045, depth: 0 },
    active: { ...quiet, upcomingOpacity: 0.55 },
    emphasis: noEmphasis,
    entry: "fade",
    reveal: "page",
    layout: "lines",
    maxLines: 2,
    size: 0.08,
    fallbacks: [{ backing: { kind: "outline", colour: "#101010", width: 0.07, depth: 0 } }],
  },
  /** One huge condensed word at a time, slammed in; key words yellow. For hooks and fast cuts. */
  "single-punch": {
    ...base,
    maxWords: 1,
    minPageSec: 0.2,
    position: "middle",
    face: "extra-condensed",
    uppercase: true,
    accent: "#FFE234",
    accent2: "#FFFFFF",
    backing: { kind: "outline", colour: "#000000", width: 0.05, depth: 0.04 },
    active: quiet,
    emphasis: { source: "auto", recolour: true, scale: 1, serif: false },
    entry: "slam",
    reveal: "page",
    layout: "lines",
    maxLines: 1,
    size: 0.2,
    fallbacks: [{ backing: { kind: "outline", colour: "#000000", width: 0.07, depth: 0.04 } }],
  },
  /** Monospaced words typed on with a cursor as they are spoken, on a black box that grows with the line. */
  typewriter: {
    ...base,
    maxWords: 4,
    face: "mono",
    uppercase: false,
    accent: "#FFE234",
    accent2: "#FFFFFF",
    backing: { kind: "box", fill: "#0B0B0B", scope: "line", padX: 0.32, padY: 0.12, radius: 0.08 },
    active: quiet,
    emphasis: noEmphasis,
    entry: "typewriter",
    reveal: "word",
    layout: "lines",
    maxLines: 2,
    size: 0.08,
    fallbacks: [],
  },
} satisfies Record<string, Preset>;

export type CaptionPresetId = keyof typeof CAPTION_PRESETS;
export const CAPTION_PRESET_IDS = Object.keys(CAPTION_PRESETS) as CaptionPresetId[];
export const elasticWordBoxPreset = {
  ...CAPTION_PRESETS["word-box"],
  active: { ...CAPTION_PRESETS["word-box"].active, boxMotion: "elastic" },
  legibility: [],
  positions: [],
} satisfies Omit<CaptionStyleProps, "words">;

/**
 * `clean-sentence` as a karaoke fill: the page sits in white, each word switches to the accent in one frame as it is
 * spoken and stays (abdulah 34.0-36.5 s: 4-5 words a line, steps(1)). Pass as the preset props of `caption-clean-sentence`.
 */
export const cleanSentenceSwitchPreset = {
  ...CAPTION_PRESETS["clean-sentence"],
  maxWords: 5,
  accent: "#E2678F",
  active: { ...quiet, upcomingOpacity: 1, fill: "switch" },
} satisfies Preset;

/**
 * Profiles saved before the presets, each drawn by its closest preset. Their old options still apply where they mean
 * the same thing (`accent`, `textColor`, `maxWords`...); `backing` (the removed scrim) and option names with no
 * counterpart are dropped. All four now render without the scrim.
 */
export const LEGACY_CAPTION_PROFILES = {
  "word-highlight": {
    preset: "clean-sentence",
    overrides: { active: { ...quiet, recolour: true, scale: 1.06 }, maxWords: 3 },
  },
  "bold-upper": { preset: "outline-pop", overrides: {} },
  "boxed-word": { preset: "word-box", overrides: {} },
  "keyword-emphasis": {
    preset: "keyword-colour",
    overrides: { emphasis: { source: "marked", recolour: true, scale: 1.16, serif: false }, maxWords: 3 },
  },
} as const satisfies Record<string, { preset: CaptionPresetId; overrides: Partial<Preset> }>;
export type LegacyCaptionProfileId = keyof typeof LEGACY_CAPTION_PROFILES;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Old option names of the four legacy blocks, translated onto the preset props. */
const translateLegacy = (options: Record<string, unknown>): Record<string, unknown> => {
  // `stroke`, `shadow` and `radius` tuned the old looks and have no counterpart; they are dropped.
  const {
    backing,
    stroke: _stroke,
    shadow: _shadow,
    font,
    boxText,
    radius: _radius,
    keywordScale,
    upcomingOpacity,
    ...rest
  } = options;
  const out: Record<string, unknown> = { ...rest };
  if (isPlainObject(backing)) out.backing = backing;
  if (font === "condensed") out.face = "extra-condensed";
  if (typeof boxText === "string") out.active = { ...(isPlainObject(out.active) ? out.active : {}), boxText };
  if (typeof upcomingOpacity === "number")
    out.active = { ...(isPlainObject(out.active) ? out.active : {}), upcomingOpacity };
  if (typeof keywordScale === "number")
    out.emphasis = { ...(isPlainObject(out.emphasis) ? out.emphasis : {}), scale: keywordScale };
  return out;
};

/**
 * Props for a preset or legacy profile: the preset, then the legacy overrides, then the caller's options. Nested
 * objects (`backing`, `active`, `emphasis`) merge one level deep; a `backing` of another kind replaces the old one.
 */
export const resolveCaptionProps = (
  profile: CaptionPresetId | LegacyCaptionProfileId,
  options: Record<string, unknown> = {},
): Record<string, unknown> => {
  const legacy = profile in LEGACY_CAPTION_PROFILES ? LEGACY_CAPTION_PROFILES[profile as LegacyCaptionProfileId] : null;
  const preset: Record<string, unknown> = {
    ...CAPTION_PRESETS[legacy ? legacy.preset : (profile as CaptionPresetId)],
    ...(legacy?.overrides ?? {}),
  };
  const incoming = translateLegacy(options);
  // An explicit position is the editor's decision: it replaces any measured per-page positions.
  if (typeof incoming.position === "string") delete incoming.positions;
  const merged: Record<string, unknown> = { ...preset };
  for (const [key, value] of Object.entries(incoming)) {
    const current = merged[key];
    if (
      isPlainObject(value) &&
      isPlainObject(current) &&
      (key !== "backing" || value.kind === undefined || value.kind === current.kind)
    )
      merged[key] = { ...current, ...value };
    else merged[key] = value;
  }
  return merged;
};

/**
 * The preset at a legibility level: its ladder's first `level` rungs applied in order. Level 0 is the preset itself;
 * a level past the ladder's top stays at the top.
 */
export const escalate = (p: CaptionStyleProps, level: number): CaptionStyleProps =>
  p.fallbacks.slice(0, Math.max(0, level)).reduce<CaptionStyleProps>((q, rung) => {
    const next = { ...q };
    if (rung.backing) next.backing = rung.backing;
    if (rung.textColor) next.textColor = rung.textColor;
    if (rung.accent) next.accent = rung.accent;
    if (rung.accent2) next.accent2 = rung.accent2;
    return next;
  }, p);

/** The level recorded for a page starting at `pageStart` (caption seconds): the highest range covering it. */
export const legibilityLevel = (p: CaptionStyleProps, pageStart: number): number =>
  p.legibility.reduce(
    (level, range) => (pageStart >= range.from - 1e-6 && pageStart < range.to ? Math.max(level, range.level) : level),
    0,
  );

/** The position recorded for a page starting at `pageStart`, else the props' `position`. */
export const positionAt = (p: CaptionStyleProps, pageStart: number): CaptionStyleProps["position"] =>
  p.positions.find((range) => pageStart >= range.from - 1e-6 && pageStart < range.to)?.position ?? p.position;
