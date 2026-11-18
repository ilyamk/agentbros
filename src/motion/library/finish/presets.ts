/** Pure finish settings and presets: no React, so tests and style tooling import it directly. */

export type TextureKind = "paper" | "halftone" | "scanlines";
export type FinishPresetName = "clean" | "filmic" | "tactile";

export type FilmFinishSettings = {
  /** Grain strength; 0.04 default (near-invisible), 0.06 to 0.09 for a filmic look. 0 removes the layer. */
  grain?: number;
  /** Black at the frame edge, 0 to 1; transparent to 55% of the radius. Off by default: it greys light grounds. */
  vignette?: number;
  /** Bloom on highlights, 0 to 1. Off by default: craft rules ban glow unless the brand uses it. Costs one full-frame blur. */
  bloom?: number;
  /** Luminance above which highlights bloom, 0 to 1. */
  bloomThreshold?: number;
  /** Colour fringes towards the edges, in pixels at the corner. Renders the children a second time. */
  aberration?: number;
  /** Warm light leaking in from one edge, 0 to 1. */
  lightLeak?: number;
  lightLeakColour?: string;
  /** Hand-held breathing of the whole frame, 0 to 1. Moves the camera, never a title on its own. */
  drift?: number;
  seed?: string;
  /** A procedural material over the frame (`texture-overlay`); "none" by default. */
  texture?: TextureKind | "none";
  /** Strength of `texture`, 0 to 1. */
  textureOpacity?: number;
};

export type ResolvedFinish = Required<FilmFinishSettings>;

/** What `FilmFinish` renders with no preset and no props: grain only, exactly as before presets existed. */
export const FILM_FINISH_DEFAULTS: ResolvedFinish = {
  grain: 0.04,
  vignette: 0,
  bloom: 0,
  bloomThreshold: 0.62,
  aberration: 0,
  lightLeak: 0,
  lightLeakColour: "#ffb36b",
  drift: 0,
  seed: "finish",
  texture: "none",
  textureOpacity: 0,
};

/**
 * Three finished looks, named by what the film is made of. Each sets only what differs from the defaults.
 * - clean: digital, product, interface. Finer grain and a vignette you feel rather than see.
 * - filmic: shot material, mood, story. Grain a touch heavier, a real vignette, a slow seeded drift, faint bloom.
 * - tactile: print, paper, collage, editorial. Heavy grain, paper fibre over everything, a mid vignette.
 */
export const finishPresets: Record<FinishPresetName, FilmFinishSettings> = {
  clean: { grain: 0.02, vignette: 0.08 },
  filmic: { grain: 0.05, vignette: 0.18, drift: 0.15, bloom: 0.05, bloomThreshold: 0.9 },
  tactile: { grain: 0.07, vignette: 0.12, texture: "paper", textureOpacity: 0.28 },
};

export const FINISH_PRESET_NAMES = Object.keys(finishPresets) as FinishPresetName[];

/** Defaults, then the preset, then every explicit setting that is not `undefined`. */
export const resolveFinish = (preset?: FinishPresetName, explicit: FilmFinishSettings = {}): ResolvedFinish => {
  const set = Object.fromEntries(
    Object.entries(explicit).filter(([, value]) => value !== undefined),
  ) as FilmFinishSettings;
  return { ...FILM_FINISH_DEFAULTS, ...(preset ? finishPresets[preset] : {}), ...set };
};
