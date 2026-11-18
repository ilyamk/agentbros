// Audio-reactive motion from precomputed curves (`pnpm audio:curves`). Every value is a pure function of the frame:
// no Web Audio, no state carried between frames. Remotion's useAudioData/visualizeAudio decode the file in the browser
// at render time and give FFT bins agents cannot read as JSON; these curves are measured once and read as data.
import React, { createContext, useContext, useEffect, useState } from "react";
import { continueRender, delayRender, Internals, staticFile, useCurrentFrame } from "remotion";
import { z } from "zod";
import { phaseAt } from "../../lib/audio-curves/compute";
import { AudioCurvesSchema, type AudioCurveName, type AudioCurves } from "../../lib/audio-curves/schema";
import type { BeatGrid } from "./beatGrid";

export {
  AUDIO_CURVE_NAMES,
  AudioCurvesSchema,
  type AudioCurveName,
  type AudioCurves,
} from "../../lib/audio-curves/schema";

export type CurveOptions = {
  /** Centred moving average over this many frames each side; ignored for phases. */
  smooth?: number;
  /** Multiplies the value, then clamps to 0..1. */
  gain?: number;
  /** Added to the frame before reading: pass a Sequence's `from` so a block reads the film's curve. */
  offsetFrames?: number;
};

const smoothedCache = new WeakMap<AudioCurves, Map<string, number[]>>();
const integralCache = new WeakMap<AudioCurves, Map<string, number[]>>();

function memo(
  cache: WeakMap<AudioCurves, Map<string, number[]>>,
  curves: AudioCurves,
  key: string,
  build: () => number[],
): number[] {
  let byKey = cache.get(curves);
  if (!byKey) cache.set(curves, (byKey = new Map()));
  let values = byKey.get(key);
  if (!values) byKey.set(key, (values = build()));
  return values;
}

function smoothed(curves: AudioCurves, name: AudioCurveName, radius: number): number[] | undefined {
  const raw = curves.curves[name];
  if (!raw || radius <= 0) return raw;
  return memo(smoothedCache, curves, `${name}:${radius}`, () =>
    raw.map((_, index) => {
      const from = Math.max(0, index - radius);
      const to = Math.min(raw.length - 1, index + radius);
      let sum = 0;
      for (let i = from; i <= to; i++) sum += raw[i]!;
      return sum / (to - from + 1);
    }),
  );
}

const lerpAt = (values: readonly number[], at: number) => {
  if (values.length === 0) return 0;
  if (at <= 0) return values[0]!;
  const last = values.length - 1;
  if (at >= last) return values[last]!;
  const index = Math.floor(at);
  return values[index]! + (values[index + 1]! - values[index]!) * (at - index);
};

const clip01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

export const hasCurve = (curves: AudioCurves | null | undefined, name: AudioCurveName) => Boolean(curves?.curves[name]);

/** The first of `names` the curves have, e.g. ["bass", "low"] prefers the bass stem. */
export const firstCurve = (curves: AudioCurves | null | undefined, names: readonly AudioCurveName[]) =>
  names.find((name) => hasCurve(curves, name));

/**
 * The curve's value at a frame, 0..1. Fractional frames (a shutter's sub-frames) interpolate; frames outside the
 * curve hold its ends. Phases are computed from the beat positions, so they wrap cleanly instead of blending 0.97 into 0.
 */
export function curveAt(curves: AudioCurves, name: AudioCurveName, frame: number, options: CurveOptions = {}): number {
  const at = frame + (options.offsetFrames ?? 0);
  if (name === "beatPhase" || name === "barPhase") {
    const marks = name === "beatPhase" ? curves.grid.beats : curves.grid.downbeats;
    return marks.length >= 2 ? phaseAt(marks, at) : 0;
  }
  const values = smoothed(curves, name, Math.max(0, Math.round(options.smooth ?? 0)));
  if (!values) return 0;
  return clip01(lerpAt(values, at) * (options.gain ?? 1));
}

/** Sum of the curve from frame 0 to `frame`, in value-frames: drives a speed that never runs backwards. */
export function curveIntegral(
  curves: AudioCurves,
  name: AudioCurveName,
  frame: number,
  options: CurveOptions = {},
): number {
  const values = smoothed(curves, name, Math.max(0, Math.round(options.smooth ?? 0)));
  if (!values) return 0;
  const prefix = memo(integralCache, curves, `${name}:${options.smooth ?? 0}`, () => {
    const out = [0];
    for (const value of values) out.push(out[out.length - 1]! + value);
    return out;
  });
  const at = Math.max(0, frame + (options.offsetFrames ?? 0));
  const whole = Math.floor(at);
  const index = Math.min(whole, prefix.length - 1);
  const tail = at - index;
  const last = values[Math.min(index, values.length - 1)] ?? 0;
  return (prefix[index]! + last * tail) * (options.gain ?? 1);
}

/** Scale factor for a pulse: `pulse(kick, 0.02)` is 1 at rest and 1.02 on the strongest hit. */
export const pulse = (value: number, amount: number) => 1 + clip01(value) * amount;

/** Position 0..1 within the current beat, from curves or a beat grid. 0 when there is no grid. */
export function beatPhase(source: AudioCurves | BeatGrid, frame: number): number {
  return "kind" in source ? curveAt(source, "beatPhase", frame) : phaseAt(source.beats, frame);
}

/** Position 0..1 within the current bar. */
export function barPhase(source: AudioCurves | BeatGrid, frame: number): number {
  return "kind" in source ? curveAt(source, "barPhase", frame) : phaseAt(source.downbeats, frame);
}

// --- Loading ---

type Entry = { curves?: AudioCurves; error?: Error; promise: Promise<void> };
const fileCache = new Map<string, Entry>();

function load(src: string): Entry {
  let entry = fileCache.get(src);
  if (!entry) {
    const created: Entry = {
      promise: fetch(staticFile(src))
        .then((response) => {
          if (!response.ok) throw new Error(`${src}: HTTP ${response.status}`);
          return response.json();
        })
        .then((json) => {
          created.curves = AudioCurvesSchema.parse(json);
        })
        .catch((error: unknown) => {
          created.error = error instanceof Error ? error : new Error(String(error));
        }),
    };
    fileCache.set(src, (entry = created));
  }
  return entry;
}

/** Curves JSON under public/ (e.g. "projects/x/pipeline/curves.json"), loaded once per path; holds the render until read. */
export function useAudioCurvesFile(src: string | null | undefined): AudioCurves | null {
  const entry = src ? load(src) : null;
  const [, setLoaded] = useState(0);
  const [handle] = useState(() => (entry && !entry.curves && !entry.error ? delayRender(`audio curves ${src}`) : null));
  useEffect(() => {
    if (handle === null || !entry) return;
    let live = true;
    void entry.promise.then(() => {
      continueRender(handle);
      if (live) setLoaded((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [handle, entry]);
  if (entry?.error) throw entry.error;
  return entry?.curves ?? null;
}

type Context = { curves: AudioCurves | null; offsetFrames: number | null; start: number };
const AudioCurvesContext = createContext<Context>({ curves: null, offsetFrames: null, start: 0 });

/** Where the enclosing Sequence starts in composition frames; survives `<Freeze>`, which keeps `absoluteFrom`. */
const useSequenceStart = () => useContext(Internals.SequenceContext)?.absoluteFrom ?? 0;

/**
 * Frames to add to a block's `useCurrentFrame()` so it reads the provider's timeline: the distance between the
 * block's Sequence start and the provider's, or the provider's explicit `offsetFrames`. A static distance, so a
 * shutter's sub-frames and a `<Freeze>` still shift what the block reads.
 */
export const curvesOffset = (context: Pick<Context, "offsetFrames" | "start">, blockStart: number) =>
  context.offsetFrames ?? blockStart - context.start;

/**
 * Makes curves available to every block below with a `react` prop. Put it at the film root: a block inside
 * `<Sequence from>` reads the film's frame automatically. `offsetFrames` overrides that: blocks read their own frame
 * plus `offsetFrames`, as before (for a provider placed inside a scene that starts at `offsetFrames` in the track).
 */
export const AudioCurvesProvider: React.FC<{
  curves?: AudioCurves;
  src?: string;
  offsetFrames?: number;
  children: React.ReactNode;
}> = ({ curves, src, offsetFrames, children }) => {
  const loaded = useAudioCurvesFile(curves ? null : src);
  const outer = useContext(AudioCurvesContext);
  const start = useSequenceStart();
  const value = curves ?? loaded;
  return (
    <AudioCurvesContext.Provider value={value ? { curves: value, offsetFrames: offsetFrames ?? null, start } : outer}>
      {children}
    </AudioCurvesContext.Provider>
  );
};

/** The nearest provider's curves and the offset this block adds to its frame to read them. */
export function useAudioCurvesContext(): { curves: AudioCurves | null; offsetFrames: number } {
  const context = useContext(AudioCurvesContext);
  const blockStart = useSequenceStart();
  return { curves: context.curves, offsetFrames: curvesOffset(context, blockStart) };
}

/** The curve's value at the current frame; `curves` defaults to the nearest AudioCurvesProvider. 0 without curves. */
export function useAudioCurve(
  curves: AudioCurves | null | undefined,
  name: AudioCurveName,
  options: CurveOptions = {},
): number {
  const frame = useCurrentFrame();
  const context = useAudioCurvesContext();
  const source = curves ?? context.curves;
  if (!source) return 0;
  return curveAt(source, name, frame, {
    ...options,
    offsetFrames: (options.offsetFrames ?? 0) + (curves ? 0 : context.offsetFrames),
  });
}

/** Wraps children in a div styled from the curve's value at the current frame. */
export const AudioReactive: React.FC<{
  curves?: AudioCurves;
  name: AudioCurveName;
  map: (value: number) => React.CSSProperties;
  options?: CurveOptions;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}> = ({ curves, name, map, options, style, children }) => {
  const value = useAudioCurve(curves, name, options);
  return <div style={{ ...style, ...map(value) }}>{children}</div>;
};

// --- The `react` prop on library blocks ---

/** Small config only: the curves come from an AudioCurvesProvider, so props stay readable JSON. Off when absent. */
export const audioReactSchema = (maxAmount: number) =>
  z.object({
    /** Curve to follow; each block has a default. */
    curve: z
      .enum([
        "level",
        "low",
        "mid",
        "high",
        "energy",
        "drums",
        "bass",
        "other",
        "vocals",
        "kick",
        "snare",
        "hat",
        "downbeat",
      ])
      .optional(),
    /** Strength; each block documents its unit and keeps the default subtle. */
    amount: z.number().min(0).max(maxAmount).optional(),
    smooth: z.number().int().min(0).max(30).optional(),
  });

export type AudioReactProp = { curve?: AudioCurveName; amount?: number; smooth?: number };

/** A block's reading of its `react` prop at the current frame: null when off or with no curves above it. */
export function useAudioReact(
  react: AudioReactProp | undefined,
  fallbacks: readonly AudioCurveName[],
  defaultSmooth = 0,
): {
  value: number;
  amount: number | undefined;
  curves: AudioCurves;
  name: AudioCurveName;
  offsetFrames: number;
  smooth: number;
} | null {
  const frame = useCurrentFrame();
  const { curves, offsetFrames } = useAudioCurvesContext();
  if (!react || !curves) return null;
  const name = react.curve && hasCurve(curves, react.curve) ? react.curve : firstCurve(curves, fallbacks);
  if (!name) return null;
  const smooth = react.smooth ?? defaultSmooth;
  return {
    value: curveAt(curves, name, frame, { offsetFrames, smooth }),
    amount: react.amount,
    curves,
    name,
    offsetFrames,
    smooth,
  };
}
