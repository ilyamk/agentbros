/**
 * Design Tokens — the single source of truth for every visual parameter.
 *
 * Every scene component imports its tokens from here
 * instead of hard-coding sizes, colours or spacing.
 *
 * Usage:
 *   import { typography, spacing, gradients, animation } from "../lib/design-tokens";
 *
 * Customising for a project:
 *   project.json can override colors (accent, background, text).
 *   Typography and spacing are global and change here.
 */

// ─── Typography ──────────────────────────────────────────────────────────────
//
// Sizes based on reference analysis:
// - Hero text fills 60-80% of frame width
// - Line-height 0.92-0.95 for tight, impactful headlines
// - Weights 700-900 for maximum visual impact
// - Body text (subtext) is much smaller than headlines (3-4x difference)

export const typography = {
  /** Hero — MASSIVE fill-width title. Ref: "DESIGN IS INTELLIGENCE MADE VISIBLE" */
  hero: {
    vertical: { fontSize: 140, fontWeight: 900 as const, lineHeight: 0.92, letterSpacing: -2 },
    square: { fontSize: 110, fontWeight: 900 as const, lineHeight: 0.92, letterSpacing: -2 },
    landscape: { fontSize: 132, fontWeight: 900 as const, lineHeight: 0.92, letterSpacing: -2 },
  },
  /** Condensed Hero — Bebas Neue uppercase filling full width */
  condensedHero: {
    vertical: {
      fontSize: 160,
      fontWeight: 400 as const,
      lineHeight: 0.9,
      letterSpacing: 4,
      textTransform: "uppercase" as const,
    },
    square: {
      fontSize: 120,
      fontWeight: 400 as const,
      lineHeight: 0.9,
      letterSpacing: 4,
      textTransform: "uppercase" as const,
    },
    landscape: {
      fontSize: 150,
      fontWeight: 400 as const,
      lineHeight: 0.9,
      letterSpacing: 4,
      textTransform: "uppercase" as const,
    },
  },
  /** Big impact title — hook scenes, hero text */
  bigTitle: {
    vertical: { fontSize: 84, fontWeight: 800 as const, lineHeight: 0.95 },
    square: { fontSize: 64, fontWeight: 800 as const, lineHeight: 0.95 },
    landscape: { fontSize: 78, fontWeight: 800 as const, lineHeight: 0.95 },
  },
  /** Main headline — scene headers */
  headline: {
    vertical: { fontSize: 76, fontWeight: 700 as const, lineHeight: 1.0 },
    square: { fontSize: 64, fontWeight: 700 as const, lineHeight: 1.0 },
    landscape: { fontSize: 64, fontWeight: 700 as const, lineHeight: 1.0 },
  },
  /** Feature text — card headlines, product names */
  feature: {
    vertical: { fontSize: 56, fontWeight: 700 as const, lineHeight: 1.05 },
    square: { fontSize: 44, fontWeight: 700 as const, lineHeight: 1.05 },
    landscape: { fontSize: 50, fontWeight: 700 as const, lineHeight: 1.05 },
  },
  /** Subtext — supporting descriptions (much smaller than headline) */
  subtext: {
    vertical: { fontSize: 30, fontWeight: 400 as const, lineHeight: 1.5 },
    square: { fontSize: 24, fontWeight: 400 as const, lineHeight: 1.5 },
    landscape: { fontSize: 26, fontWeight: 400 as const, lineHeight: 1.5 },
  },
  /** CTA button text */
  cta: {
    vertical: { fontSize: 40, fontWeight: 700 as const, lineHeight: 1.2 },
    square: { fontSize: 34, fontWeight: 700 as const, lineHeight: 1.2 },
    landscape: { fontSize: 38, fontWeight: 700 as const, lineHeight: 1.2 },
  },
  /** Small labels, tags */
  small: {
    vertical: { fontSize: 24, fontWeight: 500 as const, lineHeight: 1.4 },
    square: { fontSize: 20, fontWeight: 500 as const, lineHeight: 1.4 },
    landscape: { fontSize: 22, fontWeight: 500 as const, lineHeight: 1.4 },
  },
  /** Accent subtext — colored subtitles under headlines */
  accentSub: {
    vertical: {
      fontSize: 28,
      fontWeight: 600 as const,
      lineHeight: 1.3,
      letterSpacing: 3,
      textTransform: "uppercase" as const,
    },
    square: {
      fontSize: 22,
      fontWeight: 600 as const,
      lineHeight: 1.3,
      letterSpacing: 3,
      textTransform: "uppercase" as const,
    },
    landscape: {
      fontSize: 26,
      fontWeight: 600 as const,
      lineHeight: 1.3,
      letterSpacing: 3,
      textTransform: "uppercase" as const,
    },
  },
  /** Serif italic — elegant contrast accent (Playfair Display) */
  serifAccent: {
    vertical: { fontSize: 72, fontWeight: 700 as const, lineHeight: 1.0, fontStyle: "italic" as const },
    square: { fontSize: 56, fontWeight: 700 as const, lineHeight: 1.0, fontStyle: "italic" as const },
    landscape: { fontSize: 64, fontWeight: 700 as const, lineHeight: 1.0, fontStyle: "italic" as const },
  },
} as const;

export type TypographyToken = keyof typeof typography;
export type FormatKey = "vertical" | "square" | "landscape";

// ─── Spacing & Safe Zones ────────────────────────────────────────────────────

/** Spoken caption slot kept separate from media headlines in edited workflows. */
export const captionLayout = {
  fontSize: 56,
  lineHeight: 1.1,
  wordGapRatio: 0.3,
  reservedRows: 2,
  mediaTextColor: "#FFFFFF",
  mediaSubtextReveal: { start: 6, end: 12 },
} as const;

export const spacing = {
  /** Platform UI safe zone — top */
  safeTop: { vertical: 200, square: 60, landscape: 60 },
  /** Platform controls safe zone — bottom */
  safeBottom: { vertical: 300, square: 60, landscape: 60 },
  /** Side padding */
  sidePadding: { vertical: 60, square: 48, landscape: 60 },
  /** Gap between headline and subtext */
  headlineGap: 24,
  /** Gap between elements in a card */
  cardPadding: { vertical: 60, square: 44, landscape: 48 },
} as const;

// ─── Color Palettes (presets) ────────────────────────────────────────────────

export const palettes = {
  darkTech: { accent: "#6C5CE7", background: "#0F0F0F", text: "#FFFFFF" },
  neonGradient: { accent: "#FF6B6B", background: "#0D0221", text: "#FFFFFF" },
  oceanBlue: { accent: "#00CEC9", background: "#0A1628", text: "#E8F4FD" },
  warmSunset: { accent: "#FF9F43", background: "#1A0A0A", text: "#FFF5E1" },
  forestGreen: { accent: "#00B894", background: "#0A1A0A", text: "#E8FDE8" },
  minimalLight: { accent: "#6C5CE7", background: "#FAFAFA", text: "#1A1A2E" },
  coralPop: { accent: "#E17055", background: "#FFFFFF", text: "#2D3436" },
  whatsappDark: { accent: "#25D366", background: "#0A0A0F", text: "#FFFFFF" },
} as const;

export type PaletteKey = keyof typeof palettes;

// ─── Gradient Backgrounds ────────────────────────────────────────────────────
//
// RULE: Only two background types are acceptable:
//   1. Solid color — clean, minimal (#F0F0F0 or #0A0A0F)
//   2. Multi-blob radial gradient — 4-6 color blobs at different corners,
//      with animated position shifts for a living, breathing feel.
//
// AVOID simple 2-color linear gradients — they look cheap.
//
// How to use multi-blob gradients:
//   Each gradient has a `base` color and 4-6 `blobs` (radial gradients).
//   Render as stacked <AbsoluteFill> layers, each with one radial-gradient.
//   Animate blob positions using interpolate(frame, ...) on the position %.
//
// Example:
//   const gradient = gradients.aurora;
//   <AbsoluteFill style={{ backgroundColor: gradient.base }} />
//   {gradient.blobs.map((blob, i) => {
//     const shift = interpolate(frame, [0, durationInFrames], [0, blob.drift]);
//     return (
//       <AbsoluteFill key={i} style={{
//         background: `radial-gradient(ellipse at ${blob.x + shift}% ${blob.y}%, ${blob.color} 0%, transparent ${blob.radius}%)`,
//         opacity: blob.opacity,
//       }} />
//     );
//   })}

export type GradientBlob = {
  /** X position (0-100%) */
  x: number;
  /** Y position (0-100%) */
  y: number;
  /** Color of the blob */
  color: string;
  /** Opacity 0-1 */
  opacity: number;
  /** Spread radius as % (40-80 typical) */
  radius: number;
  /** How much the blob drifts during animation (± %) */
  drift: number;
};

export type MultiGradient = {
  base: string;
  blobs: readonly GradientBlob[];
};

export const gradients = {
  /** Light clean — soft warm gray (solid, no blobs needed) */
  cleanLight: {
    base: "#F0F0F0",
    blobs: [] as const,
  },

  /** Dark clean — near black (solid) */
  cleanDark: {
    base: "#0A0A0F",
    blobs: [] as const,
  },

  /** Aurora — purple/blue/teal/pink. Premium tech feel. */
  aurora: {
    base: "#0C1220",
    blobs: [
      { x: 0, y: 0, color: "#4A00E0", opacity: 0.7, radius: 60, drift: 8 },
      { x: 100, y: 0, color: "#00CEC9", opacity: 0.5, radius: 55, drift: -6 },
      { x: 100, y: 100, color: "#6C5CE7", opacity: 0.6, radius: 50, drift: 5 },
      { x: 0, y: 100, color: "#E84393", opacity: 0.4, radius: 55, drift: -8 },
      { x: 50, y: 50, color: "#0984E3", opacity: 0.25, radius: 70, drift: 4 },
    ] as const,
  },

  /** Sunset — warm orange/pink/purple. Energetic, bold. */
  sunset: {
    base: "#1A0A0A",
    blobs: [
      { x: 0, y: 0, color: "#FF6B6B", opacity: 0.7, radius: 55, drift: 6 },
      { x: 100, y: 20, color: "#FF9F43", opacity: 0.6, radius: 50, drift: -5 },
      { x: 80, y: 100, color: "#E84393", opacity: 0.5, radius: 55, drift: 7 },
      { x: 0, y: 80, color: "#6C5CE7", opacity: 0.4, radius: 50, drift: -6 },
      { x: 50, y: 0, color: "#FD79A8", opacity: 0.3, radius: 60, drift: 4 },
    ] as const,
  },

  /** Ocean — deep blue/teal/cyan. Calm, professional. */
  ocean: {
    base: "#0A1628",
    blobs: [
      { x: 0, y: 0, color: "#0984E3", opacity: 0.7, radius: 60, drift: 7 },
      { x: 100, y: 0, color: "#00CEC9", opacity: 0.6, radius: 55, drift: -5 },
      { x: 100, y: 100, color: "#0652DD", opacity: 0.5, radius: 50, drift: 6 },
      { x: 0, y: 100, color: "#00B894", opacity: 0.4, radius: 55, drift: -7 },
    ] as const,
  },

  /** Purple-Pink-Teal — bright showcase (Telegram-style). LIGHT base. */
  purplePinkTeal: {
    base: "#B5AFE9",
    blobs: [
      { x: 0, y: 10, color: "#50A6FF", opacity: 0.72, radius: 60, drift: 8 },
      { x: 100, y: 100, color: "#E8A0BF", opacity: 0.6, radius: 55, drift: -6 },
      { x: 0, y: 100, color: "#8EDED5", opacity: 0.9, radius: 60, drift: 5 },
      { x: 100, y: 0, color: "#C7A0F5", opacity: 0.5, radius: 50, drift: -4 },
      { x: 50, y: 50, color: "#F8C3D3", opacity: 0.3, radius: 70, drift: 6 },
    ] as const,
  },

  /** Green-Mint — WhatsApp/green themed. LIGHT base. */
  greenMint: {
    base: "#7DB88B",
    blobs: [
      { x: 0, y: 10, color: "#D6D896", opacity: 0.7, radius: 55, drift: 6 },
      { x: 100, y: 100, color: "#DBDDBE", opacity: 0.8, radius: 50, drift: -5 },
      { x: 0, y: 100, color: "#78A389", opacity: 0.6, radius: 55, drift: 7 },
      { x: 100, y: 0, color: "#A8E6CF", opacity: 0.5, radius: 50, drift: -6 },
      { x: 50, y: 50, color: "#B5D99C", opacity: 0.3, radius: 65, drift: 4 },
    ] as const,
  },

  /** Iridescent — blue/teal/yellow/lavender. Bright, playful. */
  iridescent: {
    base: "#B5AFE9",
    blobs: [
      { x: 0, y: 10, color: "#50A6FF", opacity: 0.72, radius: 55, drift: 7 },
      { x: 0, y: 100, color: "#8EDED5", opacity: 0.9, radius: 60, drift: -6 },
      { x: 100, y: 100, color: "#FFEF9B", opacity: 0.8, radius: 55, drift: 5 },
      { x: 100, y: 0, color: "#DDA0F5", opacity: 0.5, radius: 50, drift: -8 },
      { x: 50, y: 0, color: "#A0E7E5", opacity: 0.4, radius: 65, drift: 4 },
    ] as const,
  },

  /** Polar Lights — dark cinematic purple/teal. */
  polarLights: {
    base: "#0C1D31",
    blobs: [
      { x: 100, y: 0, color: "#5D1C89", opacity: 0.8, radius: 55, drift: 6 },
      { x: 0, y: 100, color: "#561164", opacity: 0.6, radius: 50, drift: -7 },
      { x: 100, y: 100, color: "#2C5964", opacity: 0.7, radius: 55, drift: 5 },
      { x: 0, y: 0, color: "#1B3A5C", opacity: 0.5, radius: 60, drift: -4 },
      { x: 50, y: 50, color: "#3D1F6D", opacity: 0.3, radius: 70, drift: 6 },
    ] as const,
  },

  /** Minimal Light — soft white with barely-visible pastel blobs */
  minimalLight: {
    base: "#FAFAFA",
    blobs: [
      { x: 0, y: 0, color: "#E8D5F5", opacity: 0.3, radius: 60, drift: 5 },
      { x: 100, y: 100, color: "#D5E8F5", opacity: 0.25, radius: 55, drift: -4 },
      { x: 100, y: 0, color: "#F5E8D5", opacity: 0.2, radius: 50, drift: 6 },
      { x: 0, y: 100, color: "#D5F5E8", opacity: 0.2, radius: 55, drift: -5 },
    ] as const,
  },
} as const;

export type GradientKey = keyof typeof gradients;

// ─── Animation Tokens ────────────────────────────────────────────────────────

export const animation = {
  /** Smooth entrance — no bounce */
  smooth: { damping: 200, stiffness: 100 } as const,
  /** Bouncy entrance — playful */
  bouncy: { damping: 12, stiffness: 80 } as const,
  /** Very bouncy — for impact moments */
  veryBouncy: { damping: 8, stiffness: 100 } as const,
  /** Stiff — quick snap into place */
  stiff: { damping: 200, stiffness: 200 } as const,

  /** Standard exit fade duration (seconds) */
  exitFadeSec: 0.3,
  /** Transition overlap between scenes (frames) */
  transitionFrames: 12,
  /** Stagger delay between list items (seconds) */
  staggerSec: 0.1,
} as const;

// ─── Device Mockup Tokens ────────────────────────────────────────────────────
//
// KEY RULE: devices must always be shown LARGE — filling 60-85% of the frame.
// Cropping is encouraged: phone can extend beyond frame edges.
// See AGENTS.md section "Device Mockups" for layout rules.

export const phoneMockup = {
  /** Phone width by format — LARGE, fills most of frame width */
  width: { vertical: 560, square: 640, landscape: 480 },
  /** iPhone aspect ratio (height/width) */
  aspectRatio: 2.16,
  /** Border radius as fraction of width */
  bezelRadiusFraction: 0.12,
  innerRadiusFraction: 0.1,
  /** Dynamic Island size as fraction of phone width */
  dynamicIslandWidth: 0.28,
  dynamicIslandHeight: 0.075,
  /** Bezel thickness (px) */
  bezelThickness: 8,
  /** Frame style presets */
  frameStyle: {
    dark: {
      gradient: "linear-gradient(145deg, #2a2a2a 0%, #1a1a1a 50%, #0a0a0a 100%)",
      shadow: "0 25px 100px rgba(0,0,0,0.5), 0 10px 40px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1)",
    },
    silver: {
      gradient: "linear-gradient(145deg, #e8e8e8 0%, #c0c0c0 50%, #a0a0a0 100%)",
      shadow: "0 25px 80px rgba(0,0,0,0.25), 0 10px 30px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.8)",
    },
    light: {
      gradient: "linear-gradient(145deg, #f5f5f5 0%, #e0e0e0 50%, #d0d0d0 100%)",
      shadow: "0 20px 60px rgba(0,0,0,0.15), 0 8px 24px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.9)",
    },
  },
} as const;

// ─── Effects Defaults ────────────────────────────────────────────────────────

export const effects = {
  particles: { count: 25, speed: 0.5, maxSize: 4 },
  vignette: { intensity: 0.5 },
  noiseGrain: { opacity: 0.03 },
  grid: { opacityHex: "08", cellSize: 50 },
  pattern: { opacity: 0.12, blendMode: "overlay" as const },
} as const;
