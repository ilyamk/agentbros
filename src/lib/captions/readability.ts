import type { CaptionPage } from "./pages";
import { pageText } from "./pages";

export type CaptionFormat = "vertical" | "square" | "landscape";
export type Box = { left: number; top: number; right: number; bottom: number };

/** Readability limits for burned short-form captions; sidecar SRT/VTT limits live in `delivery.ts`. */
export const CAPTION_READABILITY = {
  maxLines: 2,
  maxWordsPerPage: 4,
  minPageSec: 0.8,
  /** Above this a viewer cannot finish the page; a warning, because fast speech is sometimes the point. */
  maxCharsPerSec: 17,
} as const;

export const FRAME_SIZE: Record<CaptionFormat, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  landscape: { width: 1920, height: 1080 },
};

/**
 * Platform interface over a 1080×1920 short: what TikTok, Reels and Shorts draw on top of the video, as the union of
 * the published estimates in `docs/captions-styles.md` ("Placement"). Top 220 px (status bar, tabs, Reels and
 * Shorts headers), bottom 400 px (username, description, music, Shorts title; TikTok 320–380, Reels 310–450, Shorts
 * about 300), right 140 px (like, comment, share and audio buttons; 120–164). Paid placements cover more:
 * `AD_UI_BANDS`.
 */
export const PLATFORM_UI_BANDS: Record<"vertical", { label: string; box: Box }[]> = {
  vertical: [
    { label: "top bar", box: { left: 0, top: 0, right: 1080, bottom: 220 } },
    { label: "caption, username and music", box: { left: 0, top: 1520, right: 1080, bottom: 1920 } },
    { label: "action buttons", box: { left: 940, top: 0, right: 1080, bottom: 1920 } },
  ],
};

/**
 * Where burned captions may sit. Vertical: clear of the platform interface (`PLATFORM_UI_BANDS`), 140 px from each
 * side so text stays centred, 800×1300. Square: title-safe, 10% from each edge (no overlay in the feed). Landscape:
 * title-safe sides and top (SMPTE ST 2046-1, the central 90%) and 8% from the bottom, clear of player controls.
 * Text boxes are centred, so the usable box is symmetric about the frame centre.
 */
export const CAPTION_SAFE_ZONE: Record<CaptionFormat, Box> = {
  vertical: { left: 140, top: 220, right: 940, bottom: 1520 },
  square: { left: 108, top: 108, right: 972, bottom: 972 },
  landscape: { left: 160, top: 54, right: 1760, bottom: 994 },
};

export const AD_PLATFORMS = ["tiktok", "reels", "shorts"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

/**
 * What a paid placement draws over a 1080×1920 ad, from each platform's own safe-zone template (opened 2026-11-13):
 * - TikTok in-feed: the "In-Feed-Standard Version LTR" template on https://ads.tiktok.com/help/article/video-ads-specifications
 *   (drawn at 720×1280; ×1.5 here): top 240, bottom 660, 120 each side, and the action column 300 px wide from
 *   y 840 down. The "with Anchor" templates (a product link above the caption) cover more and are not modelled.
 * - Instagram and Facebook Reels ads: https://www.facebook.com/business/ads-guide/update/video/instagram-reels,
 *   "keep the top 14%, bottom 35% and 6% of each side free of text and logos": 269, 672 and 65 px.
 * - YouTube Shorts and other vertical video ads: the vertical safe-zone overlay linked from
 *   https://support.google.com/google-ads/answer/13547298 (1080×1920 PNG, clear area x 48–888, y 288–1248).
 * An ad still carries the organic interface, so `uiBands` adds `PLATFORM_UI_BANDS` to these.
 */
export const AD_UI_BANDS: Record<AdPlatform, { label: string; box: Box }[]> = {
  tiktok: [
    { label: "TikTok ad top bar", box: { left: 0, top: 0, right: 1080, bottom: 240 } },
    { label: "TikTok ad caption, CTA and username", box: { left: 0, top: 1260, right: 1080, bottom: 1920 } },
    { label: "TikTok ad left margin", box: { left: 0, top: 0, right: 120, bottom: 1920 } },
    { label: "TikTok ad right margin", box: { left: 960, top: 0, right: 1080, bottom: 1920 } },
    { label: "TikTok ad action buttons", box: { left: 780, top: 840, right: 1080, bottom: 1920 } },
  ],
  reels: [
    { label: "Reels ad top 14%", box: { left: 0, top: 0, right: 1080, bottom: 269 } },
    { label: "Reels ad bottom 35%", box: { left: 0, top: 1248, right: 1080, bottom: 1920 } },
    { label: "Reels ad left 6%", box: { left: 0, top: 0, right: 65, bottom: 1920 } },
    { label: "Reels ad right 6%", box: { left: 1015, top: 0, right: 1080, bottom: 1920 } },
  ],
  shorts: [
    { label: "Shorts ad top", box: { left: 0, top: 0, right: 1080, bottom: 288 } },
    { label: "Shorts ad bottom", box: { left: 0, top: 1248, right: 1080, bottom: 1920 } },
    { label: "Shorts ad left", box: { left: 0, top: 0, right: 48, bottom: 1920 } },
    { label: "Shorts ad right", box: { left: 888, top: 0, right: 1080, bottom: 1920 } },
  ],
};

/** Which interface captions keep clear of: `organic` posts, or a paid placement on one platform or all three (`ad`). */
export const CAPTION_UI_ZONES = ["organic", "ad", "ad-tiktok", "ad-reels", "ad-shorts"] as const;
export type CaptionUiZone = (typeof CAPTION_UI_ZONES)[number];

export const uiZoneOf = (placement: "organic" | "ad", platform: AdPlatform | "all" = "all"): CaptionUiZone =>
  placement === "organic" ? "organic" : platform === "all" ? "ad" : `ad-${platform}`;

/**
 * The zone for a `captions:place` run: `--placement` (and `--platform`, which alone means an ad) when given, else the
 * zone the timeline's caption style already records, else organic.
 */
export const resolveUiZone = (
  placement: "organic" | "ad" | undefined,
  platform: AdPlatform | "all" | undefined,
  recorded?: unknown,
): CaptionUiZone => {
  if (placement === "organic" && platform) throw new Error(`--platform ${platform} applies to --placement ad only`);
  if (placement || platform) return uiZoneOf(placement ?? "ad", platform);
  return (CAPTION_UI_ZONES as readonly unknown[]).includes(recorded) ? (recorded as CaptionUiZone) : "organic";
};

/** Caption-style options with `uiZone` set to `zone`; organic is the default, so it is left out. */
export const withUiZone = (
  options: Record<string, unknown> | undefined,
  zone: CaptionUiZone,
): Record<string, unknown> => {
  const { uiZone: _previous, ...rest } = options ?? {};
  return zone === "organic" ? rest : { ...rest, uiZone: zone };
};

/** The bands a vertical caption must not touch under one zone: the organic ones, plus each chosen platform's ad bands. */
export const uiBands = (zone: CaptionUiZone = "organic"): { label: string; box: Box }[] => {
  if (zone === "organic") return PLATFORM_UI_BANDS.vertical;
  const platforms = zone === "ad" ? AD_PLATFORMS : [zone.slice(3) as AdPlatform];
  return [...PLATFORM_UI_BANDS.vertical, ...platforms.flatMap((platform) => AD_UI_BANDS[platform])];
};

/**
 * Vertical caption zones for paid placements, clear of `uiBands(zone)` and symmetric about the centre. TikTok's action
 * column leaves 300–780 at caption height (one width for every position, so a page fits wherever it is moved);
 * `ad` is the intersection of all three.
 */
export const CAPTION_AD_SAFE_ZONE: Record<Exclude<CaptionUiZone, "organic">, Box> = {
  "ad-tiktok": { left: 300, top: 240, right: 780, bottom: 1260 },
  "ad-reels": { left: 140, top: 269, right: 940, bottom: 1248 },
  "ad-shorts": { left: 192, top: 288, right: 888, bottom: 1248 },
  ad: { left: 300, top: 288, right: 780, bottom: 1248 },
};

/** The caption zone for a format and interface; ad zones apply to vertical only (square and landscape keep title-safe). */
export const captionSafeZone = (format: CaptionFormat, zone: CaptionUiZone = "organic"): Box =>
  format === "vertical" && zone !== "organic" ? CAPTION_AD_SAFE_ZONE[zone] : CAPTION_SAFE_ZONE[format];

/** The safe zone narrowed to be symmetric about the frame centre, so centred text stays centred. */
export const centredSafeBox = (format: CaptionFormat, ui: CaptionUiZone = "organic"): Box => {
  const zone = captionSafeZone(format, ui);
  const centre = FRAME_SIZE[format].width / 2;
  const half = Math.min(centre - zone.left, zone.right - centre);
  return { left: centre - half, top: zone.top, right: centre + half, bottom: zone.bottom };
};

export type CaptionPosition = "lower" | "middle" | "upper";

/** The box a caption page is laid out in: full safe width, tall enough for `maxLines` at `lineHeightPx`. */
export const captionBox = (
  format: CaptionFormat,
  position: CaptionPosition,
  lineHeightPx: number,
  maxLines: number = CAPTION_READABILITY.maxLines,
  padPx = 24,
  ui: CaptionUiZone = "organic",
): Box => {
  const safe = centredSafeBox(format, ui);
  const height = Math.min(safe.bottom - safe.top, lineHeightPx * maxLines + padPx * 2);
  const { height: frameHeight } = FRAME_SIZE[format];
  const top =
    position === "lower"
      ? safe.bottom - height
      : position === "upper"
        ? safe.top
        : Math.min(safe.bottom - height, Math.max(safe.top, frameHeight / 2 - height / 2));
  return { left: safe.left, right: safe.right, top, bottom: top + height };
};

export type ReadabilityFinding = {
  code:
    | "TOO_MANY_LINES"
    | "TOO_MANY_WORDS"
    | "LINE_TOO_LONG"
    | "PAGE_TOO_SHORT"
    | "READING_SPEED"
    | "OUTSIDE_SAFE_ZONE"
    | "LOW_CONTRAST"
    | "TEXT_TOO_SMALL"
    | "CAPTION_IN_UI_ZONE"
    | "CAPTION_OVER_FACE";
  severity: "error" | "warning";
  pageIndex: number | null;
  message: string;
};

export type ReadabilityLimits = {
  maxLines: number;
  maxWordsPerPage: number;
  minPageSec: number;
  maxCharsPerSec: number;
  /** Optional line budget in characters (the page builder's `maxCharsPerLine`). */
  maxCharsPerLine?: number;
};

const inside = (box: Box, zone: Box) =>
  box.left >= zone.left && box.top >= zone.top && box.right <= zone.right && box.bottom <= zone.bottom;

/** Flags pages a viewer cannot read, and a caption box outside the platform safe zone. */
export const checkCaptionPages = (
  pages: readonly CaptionPage[],
  options: { format: CaptionFormat; box?: Box; limits?: Partial<ReadabilityLimits>; ui?: CaptionUiZone },
): ReadabilityFinding[] => {
  const limits = { ...CAPTION_READABILITY, ...options.limits };
  const findings: ReadabilityFinding[] = [];
  const zone = captionSafeZone(options.format, options.ui);
  if (options.box && !inside(options.box, zone))
    findings.push({
      code: "OUTSIDE_SAFE_ZONE",
      severity: "error",
      pageIndex: null,
      message: `Caption box ${JSON.stringify(options.box)} leaves the ${options.format}${options.ui && options.ui !== "organic" ? ` ${options.ui}` : ""} safe zone ${JSON.stringify(zone)}`,
    });
  pages.forEach((page, pageIndex) => {
    const lines = pageText(page);
    const text = lines.join(" ");
    const seconds = page.end - page.start;
    if (lines.length > limits.maxLines)
      findings.push({
        code: "TOO_MANY_LINES",
        severity: "error",
        pageIndex,
        message: `${lines.length} lines: "${text}"`,
      });
    if (page.words.length > limits.maxWordsPerPage)
      findings.push({
        code: "TOO_MANY_WORDS",
        severity: "warning",
        pageIndex,
        message: `${page.words.length} words: "${text}"`,
      });
    if (limits.maxCharsPerLine !== undefined)
      for (const line of lines)
        if (line.length > limits.maxCharsPerLine && line.includes(" "))
          findings.push({
            code: "LINE_TOO_LONG",
            severity: "warning",
            pageIndex,
            message: `${line.length} characters: "${line}"`,
          });
    if (seconds < limits.minPageSec - 1e-9)
      findings.push({
        code: "PAGE_TOO_SHORT",
        severity: "warning",
        pageIndex,
        message: `${seconds.toFixed(2)} s on screen: "${text}"`,
      });
    const speed = text.length / Math.max(seconds, 1e-3);
    if (speed > limits.maxCharsPerSec)
      findings.push({
        code: "READING_SPEED",
        severity: "warning",
        pageIndex,
        message: `${speed.toFixed(1)} characters/s: "${text}"`,
      });
  });
  return findings;
};

const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (r: number, g: number, b: number) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** Relative luminance and alpha of #RGB, #RRGGBB or #RRGGBBAA. */
export const parseColour = (hex: string): { luminance: number; alpha: number } => {
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  const full = short ? `${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : hex.replace(/^#/, "");
  const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(full);
  if (!m) throw new Error(`Caption colour must be #RGB, #RRGGBB or #RRGGBBAA: ${hex}`);
  return {
    luminance: luminance(parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)),
    alpha: m[4] ? parseInt(m[4], 16) / 255 : 1,
  };
};

const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const mix = (under: number, over: number, coverage: number) => under * (1 - coverage) + over * coverage;

/** Large-text WCAG minimum; caption type is well above 18 pt at playback size. */
export const MIN_CAPTION_CONTRAST = 3;

/**
 * What sits directly around a caption's letters. `outline` widths and shadow offsets are in em; `none` means the
 * letters stand on the footage alone.
 */
export type ContrastBacking =
  | { kind: "outline"; colour: string; width: number }
  | { kind: "shadow"; colour: string; blur: number; opacity: number }
  | { kind: "box"; fill: string }
  | { kind: "none" };

/** One colour drawn on screen and what stands behind it, e.g. the accent word on the outline. */
export type ContrastPair = { label: string; text: string; backing: ContrastBacking };

/**
 * Share of the letters' surroundings each treatment covers. An outline of 0.06 em or more rings every glyph, so the
 * outline colour is the background; thinner ones count in part. A hard shadow sits on one edge only (25%), a soft one
 * spreads round the letter (50%). A box covers everything, through its own alpha.
 */
export const backingCoverage = (backing: ContrastBacking): { colour: string; coverage: number } | null => {
  if (backing.kind === "none") return null;
  if (backing.kind === "box") return { colour: backing.fill, coverage: parseColour(backing.fill).alpha };
  if (backing.kind === "outline")
    return {
      colour: backing.colour,
      coverage: Math.min(1, Math.max(0, (backing.width - 0.02) / 0.04)) * parseColour(backing.colour).alpha,
    };
  return {
    colour: backing.colour,
    coverage: (backing.blur >= 0.1 ? 0.5 : 0.25) * backing.opacity * parseColour(backing.colour).alpha,
  };
};

/** The darkest and brightest 5% of a clean still (captions off, packed RGB) inside a box. */
export const footageTails = (
  still: { rgb: Uint8Array; width: number; height: number },
  box: Box,
): { dark: number; bright: number } | null => {
  const x0 = Math.max(0, Math.floor(box.left)),
    x1 = Math.min(still.width, Math.ceil(box.right));
  const y0 = Math.max(0, Math.floor(box.top)),
    y1 = Math.min(still.height, Math.ceil(box.bottom));
  const values: number[] = [];
  for (let y = y0; y < y1; y += 2)
    for (let x = x0; x < x1; x += 2) {
      const i = (y * still.width + x) * 3;
      values.push(luminance(still.rgb[i]!, still.rgb[i + 1]!, still.rgb[i + 2]!));
    }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return { dark: values[Math.floor(values.length * 0.05)]!, bright: values[Math.floor(values.length * 0.95)]! };
};

/** Contrast of one pair over the footage: the worse of the darkest and brightest footage, with the treatment applied. */
export const pairContrast = (pair: ContrastPair, tails: { dark: number; bright: number }): number => {
  const text = parseColour(pair.text).luminance;
  const cover = backingCoverage(pair.backing);
  const behind = (footage: number) =>
    cover ? mix(footage, parseColour(cover.colour).luminance, cover.coverage) : footage;
  return Math.min(ratio(text, behind(tails.dark)), ratio(text, behind(tails.bright)));
};

/**
 * Contrast of every colour a caption draws (fill, accent, active and box text) against what is behind it: the
 * footage under the caption box on a clean still, both its darkest and brightest 5%, with the treatment applied (see
 * `backingCoverage`). Fails below 3:1 for any pair; the message names each failing pair.
 */
export const checkCaptionBackground = (
  still: { rgb: Uint8Array; width: number; height: number },
  box: Box,
  options: { pairs: readonly ContrastPair[]; minContrast?: number },
): ReadabilityFinding | null => {
  const tails = footageTails(still, box);
  if (!tails) return null;
  const min = options.minContrast ?? MIN_CAPTION_CONTRAST;
  const failing = options.pairs
    .map((pair) => ({ pair, contrast: pairContrast(pair, tails) }))
    .filter(({ contrast }) => contrast < min);
  return failing.length
    ? {
        code: "LOW_CONTRAST",
        severity: "error",
        pageIndex: null,
        message: `${failing.map(({ pair, contrast }) => `${pair.label} ${pair.text} on ${pair.backing.kind} reaches ${contrast.toFixed(2)}:1`).join("; ")} over the footage under the caption box (needs ${min}:1); thicken the outline, use a box, or change the colour`,
      }
    : null;
};

/**
 * Smallest readable caption on a phone, as cap height (height of a capital) over frame height: 3% for the words a
 * page is read by (58 px on 1920), 2% for the small connective words of a mixed-scale page (38 px). Measured on the
 * platform-native and creator-tool captions in `docs/captions-styles.md`, whose cap heights run 3–4.5%.
 */
export const MIN_CAP_HEIGHT = { base: 0.03, small: 0.02 } as const;

export type SizedCaptionWord = { text: string; fontSize: number; capHeightEm: number; small: boolean };

/** Words set smaller than `MIN_CAP_HEIGHT` once the page is laid out (after fitting), one finding per page. */
export const checkCaptionSizes = (
  pages: readonly { pageIndex: number; words: readonly SizedCaptionWord[] }[],
  frameHeight: number,
): ReadabilityFinding[] =>
  pages.flatMap(({ pageIndex, words }) => {
    const small = words.filter(
      (word) =>
        word.fontSize * word.capHeightEm <
        frameHeight * (word.small ? MIN_CAP_HEIGHT.small : MIN_CAP_HEIGHT.base) - 0.5,
    );
    if (!small.length) return [];
    const worst = small.reduce((a, b) => (a.fontSize * a.capHeightEm <= b.fontSize * b.capHeightEm ? a : b));
    const cap = worst.fontSize * worst.capHeightEm;
    return [
      {
        code: "TEXT_TOO_SMALL" as const,
        severity: "error" as const,
        pageIndex,
        message: `${small.map((word) => `"${word.text}"`).join(", ")}: cap height ${cap.toFixed(0)} px is ${((cap / frameHeight) * 100).toFixed(1)}% of the frame height (needs ${(worst.small ? MIN_CAP_HEIGHT.small : MIN_CAP_HEIGHT.base) * 100}%); shorten the page or raise the size`,
      },
    ];
  });

const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** A face (or a head) in frame pixels; `grow` widens it so a caption does not graze the chin or the brow. */
export const faceZone = (face: Box, grow = 0.15): Box => {
  const w = face.right - face.left,
    h = face.bottom - face.top;
  return {
    left: face.left - w * grow,
    right: face.right + w * grow,
    top: face.top - h * grow,
    bottom: face.bottom + h * grow,
  };
};

/**
 * Where a page's text actually sits (`box`, frame pixels, at the format's 1080-based size) against the platform
 * interface (vertical only, the bands of `ui`, organic by default: `CAPTION_IN_UI_ZONE`, an error) and the faces on
 * that frame (`CAPTION_OVER_FACE`, a warning, from 5% of the face's area inside its widened margin: sometimes no
 * position is free).
 */
export const checkCaptionPlacement = (
  box: Box,
  options: { format: CaptionFormat; faces?: readonly Box[]; pageIndex?: number | null; ui?: CaptionUiZone },
): ReadabilityFinding[] => {
  const findings: ReadabilityFinding[] = [];
  const pageIndex = options.pageIndex ?? null;
  if (options.format === "vertical")
    for (const band of uiBands(options.ui))
      if (overlap(box, band.box) > 0)
        findings.push({
          code: "CAPTION_IN_UI_ZONE",
          severity: "error",
          pageIndex,
          message: `Caption ${JSON.stringify(roundBox(box))} runs under the platform's ${band.label} ${JSON.stringify(band.box)}`,
        });
  const hit = (options.faces ?? []).find(
    (face) => overlap(box, faceZone(face)) > 0.05 * (face.right - face.left) * (face.bottom - face.top),
  );
  if (hit)
    findings.push({
      code: "CAPTION_OVER_FACE",
      severity: "warning",
      pageIndex,
      message: `Caption ${JSON.stringify(roundBox(box))} covers a face at ${JSON.stringify(roundBox(hit))}`,
    });
  return findings;
};

const roundBox = (box: Box): Box => ({
  left: Math.round(box.left),
  top: Math.round(box.top),
  right: Math.round(box.right),
  bottom: Math.round(box.bottom),
});

/**
 * Share of pixels inside `box` on a clean still with a sharp luminance step to the next pixel across or down:
 * printed text, signs and lower thirds score high; skin, walls and soft backgrounds low. A cheap probe, not OCR.
 */
export const detailDensity = (still: { rgb: Uint8Array; width: number; height: number }, box: Box): number => {
  const x0 = Math.max(0, Math.floor(box.left)),
    x1 = Math.min(still.width - 1, Math.ceil(box.right));
  const y0 = Math.max(0, Math.floor(box.top)),
    y1 = Math.min(still.height - 1, Math.ceil(box.bottom));
  const at = (x: number, y: number) => {
    const i = (y * still.width + x) * 3;
    return 0.2126 * still.rgb[i]! + 0.7152 * still.rgb[i + 1]! + 0.0722 * still.rgb[i + 2]!;
  };
  let sharp = 0,
    total = 0;
  for (let y = y0; y < y1; y += 2)
    for (let x = x0; x < x1; x += 2) {
      const l = at(x, y);
      if (Math.max(Math.abs(l - at(Math.min(x + 2, x1), y)), Math.abs(l - at(x, Math.min(y + 2, y1)))) > 28) sharp++;
      total++;
    }
  return total ? sharp / total : 0;
};
