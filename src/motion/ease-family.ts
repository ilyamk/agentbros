import type { Curve } from "./timing";

/**
 * Eases named as the reference analyses name them (GSAP's families), as pure functions of 0..1, so a block can take the
 * measured name from a `techniques.json` entry and use exactly that shape. No GSAP import: the maths is the published
 * definition of each family. All start at 0 and end at 1.
 */
export const easeFamily = {
  linear: (t: number) => t,
  "sine.in": (t: number) => 1 - Math.cos((t * Math.PI) / 2),
  "sine.out": (t: number) => Math.sin((t * Math.PI) / 2),
  "power1.in": (t: number) => t * t,
  "power2.in": (t: number) => t ** 3,
  "power2.inOut": (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  "power3.out": (t: number) => 1 - (1 - t) ** 4,
  "circ.in": (t: number) => 1 - Math.sqrt(Math.max(0, 1 - t * t)),
  "circ.out": (t: number) => Math.sqrt(Math.max(0, 1 - (t - 1) ** 2)),
  "expo.in": (t: number) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  "expo.out": (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
} satisfies Record<string, Curve>;

export type EaseFamilyName = keyof typeof easeFamily;

export const EASE_FAMILY_NAMES = Object.keys(easeFamily) as EaseFamilyName[];

/** Eased 0..1 progress of a window by a family name, clamped at both ends. */
export const familyProgress = (frame: number, from: number, duration: number, name: EaseFamilyName): number => {
  if (duration <= 0) return frame >= from ? 1 : 0;
  const t = Math.min(Math.max((frame - from) / duration, 0), 1);
  return easeFamily[name](t);
};
