import type React from "react";
import type { z } from "zod";

export type LibraryFormat = "vertical" | "square" | "landscape";

export const FORMAT_SIZE: Record<LibraryFormat, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  landscape: { width: 1920, height: 1080 },
};

export type LibraryCategory =
  | "typography"
  | "finish"
  | "backgrounds"
  | "ui"
  | "transitions"
  | "camera"
  | "three"
  | "data"
  | "scenes"
  | "kinetic"
  | "effects"
  | "captions";

/** A named moment inside a block that sound and the edit can lock to. */
export type CueKind = "land" | "hit" | "cut" | "reveal" | "click" | "type" | "exit" | "peak" | "stop";
/** Suggested sound family for a cue; the sound step picks the actual file. */
export type SfxKind =
  "click" | "pop" | "whoosh" | "impact" | "chime" | "riser" | "sub-drop" | "tick" | "glass" | "none";
export type Cue = {
  /** Frame relative to the block's own start. */
  frame: number;
  kind: CueKind;
  sfx?: SfxKind;
  /** hero = the one sound the moment is about; support = everything else. */
  weight?: "hero" | "support";
  label?: string;
};

/**
 * One reusable, parameterised building block. Every item renders on its own as a preview
 * composition `Lib-<id>` from `src/motion/library/index.tsx`, so an agent can look at it before use.
 */
export type LibraryItem<P extends Record<string, unknown> = Record<string, unknown>> = {
  /** Kebab-case, unique across the library, e.g. "glyph-spring-blur". */
  id: string;
  category: LibraryCategory;
  title: string;
  /** One or two sentences: what the viewer sees and when to use it. Agents choose from this line. */
  description: string;
  /** Free words for search: mood, motion verb, use case. */
  tags: string[];
  component: React.FC<P>;
  /** Zod schema of the props. Defaults must make a good-looking preview with no input. */
  schema: z.ZodType<P>;
  defaultProps: P;
  durationInFrames: number;
  durationForProps?: (props: P) => number;
  /** Formats the item has been checked in; the first is the preview default. */
  formats: LibraryFormat[];
  /** Where the idea came from, e.g. "hyperframes: registry/blocks/data-chart (Apache-2.0, idea only)". */
  inspiredBy?: string[];
  /** Import path agents use in their own scenes. */
  importPath: string;
  /**
   * The export a scene should use, when `component` is only a preview wrapper,
   * e.g. "FilmFinish" or "<FilmFinish grain={0.07}>{scene}</FilmFinish>".
   */
  usage?: string;
  /**
   * Frames that sound and the cut should lock to, computed from the props the scene passes.
   * Blocks with no events (grounds, finish) return []. Required for every block (tests/motion-library.test.ts).
   */
  cues?: (props: P) => Cue[];
  /**
   * Set on stock-looking devices (god rays, chrome, flares, light burns, light leaks...):
   * why and when it is still justified. Agents never pick these by default.
   */
  sparing?: string;
};

/** A complete look: palette, type pairing and motion personality. Scenes read it through props. */
export type LibraryStyle = {
  id: string;
  title: string;
  description: string;
  palette: { background: string; surface: string; text: string; muted: string; accent: string; accent2?: string };
  fonts: { display: string; body: string; mono?: string };
  /** Spring and timing personality. */
  motion: { springDamping: number; springStiffness: number; staggerFrames: number; holdFrames: number };
  /** `preset` names a finish preset (src/motion/library/finish/presets.ts) for FilmFinish; the numbers stay the look's own. */
  finish: {
    grain: number;
    vignette: number;
    motionBlur: boolean;
    glow: number;
    preset?: "clean" | "filmic" | "tactile";
  };
  /** 2–3 flat ground colours to swap on hard cuts; the first is `palette.background`. Pick ink per ground by luminance. */
  grounds?: string[];
  /** Type sizes as shares of frame width: a hero word when type is the shot, a caption when picture is. */
  typeScale?: { hero: number; title: number; caption: number };
};

export const defineItem = <P extends Record<string, unknown>>(item: LibraryItem<P>): LibraryItem =>
  item as unknown as LibraryItem;
