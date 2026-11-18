/**
 * The only module allowed to import `gsap` (lint enforces it). Everything else imports GSAP from here.
 *
 * Rules for a GSAP block (`useGsapTimeline` throws on most of these):
 * - Build every tween on the provided paused timeline; the Remotion frame seeks it. No play(), seek(), callbacks,
 *   `call()`, async builders or tweens outside the timeline.
 * - Tween DOM or SVG elements only. Numbers for React come from `interpolate()`.
 * - No unseeded randomness: no `"random(...)"`, `stagger: { from: "random" }` or `repeatRefresh`. ScrambleTextPlugin is
 *   not registered because it calls Math.random on every update; use the seeded `decodeText` plugin below.
 * - Plugins that measure layout (SplitText, Flip, MotionPath `align`) must build after the fonts load. Mount the scope
 *   element only once `useSharedFit` (or `useFontsReady`) is ready; the hook rebuilds when its scope element appears.
 * - Put named moments on the timeline with `addLabel` from a pure plan, and derive the item's `cues` from that same plan.
 * - ScrollTrigger, ScrollSmoother, Observer, Draggable and Inertia have no meaning in a render and stay banned.
 * - MorphSVG: one morph tween per path (chain shapes across stacked paths), stating both ends with fromTo, and no
 *   `type: "rotational"`: a fresh seek past such tweens shows the wrong shape.
 * - Physics2D is not registered: with friction it integrates step by step, so a seek can differ from a play.
 */
import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { Flip } from "gsap/Flip";
import { MorphSVGPlugin } from "gsap/MorphSVGPlugin";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { SplitText } from "gsap/SplitText";
import { TextPlugin } from "gsap/TextPlugin";
import { useLayoutEffect, useState } from "react";
import { continueRender, delayRender, random } from "remotion";

export { useGsapTimeline } from "@remotion/gsap";
export type { GsapTimelineBuildContext, GsapTimelineBuilder } from "@remotion/gsap";

type DecodeVars = { text: string; seed?: string; chars?: string; flips?: number; out?: boolean };
type DecodeData = { target: Element; text: string; seed: string; chars: string; flips: number; out: boolean };

const DEFAULT_GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=<>/";

/**
 * Seeded scramble: while the tween runs the element shows glyphs picked by `random(seed, step)`, at the end the final
 * text, before it nothing (`out: true` runs it backwards, text to nothing). `flips` is how many glyph changes the tween
 * makes. Stagger one tween per character.
 */
const decodeText = {
  name: "decodeText",
  init(this: DecodeData, target: Element, vars: DecodeVars) {
    this.target = target;
    this.text = vars.text;
    this.seed = vars.seed ?? "decode";
    this.chars = vars.chars ?? DEFAULT_GLYPHS;
    this.flips = Math.max(1, vars.flips ?? 6);
    this.out = vars.out ?? false;
  },
  render(progress: number, data: DecodeData) {
    const { target, text, seed, chars, flips, out } = data;
    const ratio = out ? 1 - progress : progress;
    if (ratio <= 0) target.textContent = "";
    else if (ratio >= 1) target.textContent = text;
    else {
      const step = Math.floor(ratio * flips);
      target.textContent = [...text]
        .map((char, index) =>
          char.trim() === "" ? char : chars[Math.floor(random(`${seed}-${index}-${step}`) * chars.length)],
        )
        .join("");
    }
  },
};

let registered = false;
const register = () => {
  if (registered) return;
  registered = true;
  // "auto" switches to translate3d mid-tween and back to 2D at the end, which leaves Chrome's layer state dependent
  // on seek history: settled glyphs then rasterise differently between render workers.
  gsap.config({ force3D: false });
  // Lazy first renders are deferred to the end of the tick, so when a seek jumps over several tweens of one property
  // (a chain of morphs), a later tween reads its start before the earlier ones have written their end.
  gsap.defaults({ lazy: false });
  gsap.registerPlugin(
    CustomEase,
    DrawSVGPlugin,
    Flip,
    MorphSVGPlugin,
    MotionPathPlugin,
    SplitText,
    TextPlugin,
    decodeText as unknown as gsap.Plugin,
  );
  CustomEase.create("kinetic.out", "M0,0 C0.12,0.72 0.18,1 1,1");
  CustomEase.create("kinetic.snap", "M0,0 C0.3,0 0.08,1.06 0.5,1.02 0.7,1 0.84,1 1,1");
  CustomEase.create("kinetic.in", "M0,0 C0.6,0 0.9,0.35 1,1");
  CustomEase.create("kinetic.inOut", "M0,0 C0.7,0 0.12,1 1,1");
};
register();

/** Named eases: `kinetic.out` (long settle), `kinetic.snap` (small overshoot), `kinetic.in` (exit), `kinetic.inOut` (travel). */
export const KINETIC_EASES = ["kinetic.out", "kinetic.snap", "kinetic.in", "kinetic.inOut"] as const;

/** True once the given font faces have loaded; holds the render until then. Gate the scope element on it. */
export const useFontsReady = (fonts: readonly string[]): boolean => {
  const [ready, setReady] = useState(false);
  const key = fonts.join("|");
  useLayoutEffect(() => {
    const handle = delayRender(`Fonts for GSAP: ${key}`);
    let live = true;
    void Promise.all(fonts.map((font) => document.fonts.load(font)))
      .then(() => {
        if (live) setReady(true);
      })
      .finally(() => continueRender(handle));
    return () => {
      live = false;
      continueRender(handle);
    };
    // `key` stands for `fonts`.
  }, [key]);
  return ready;
};

/** Seconds on the timeline to a frame relative to the block's start. */
export const toFrame = (seconds: number, fps = 30): number => Math.round(seconds * fps);

export { CustomEase, DrawSVGPlugin, Flip, gsap, MorphSVGPlugin, MotionPathPlugin, SplitText, TextPlugin };
