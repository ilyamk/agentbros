import type { Cue } from "../types";
import { captureTiming } from "./scene-plan";

export const CUT = {
  proof: 45,
  first: 145,
  invert: 169,
  return: 184,
  second: 202,
  open: 249,
  lock: 278,
  end: 324,
} as const;
export const cutCues: Cue[] = [
  { frame: 0, kind: "hit", sfx: "impact", label: "type lands" },
  { frame: 12, kind: "type", sfx: "tick", label: "type locks" },
  { frame: CUT.proof, kind: "cut", sfx: "whoosh", label: "enter the index" },
  {
    frame: CUT.proof + captureTiming(CUT.first - CUT.proof, true).click,
    kind: "click",
    sfx: "click",
    weight: "hero",
    label: "select transitions",
  },
  { frame: CUT.first, kind: "cut", sfx: "impact", label: "first specimen" },
  { frame: CUT.invert, kind: "cut", sfx: "tick", label: "ground swaps" },
  { frame: CUT.return, kind: "cut", sfx: "pop", label: "ground returns" },
  { frame: CUT.second, kind: "cut", sfx: "glass", label: "second specimen" },
  { frame: CUT.lock, kind: "land", sfx: "sub-drop", label: "aperture fills the frame" },
];

/** The badge on the result card lands on the same ring in the first specimen. */
export function specimenRing(width: number, height: number) {
  const portrait = height > width;
  return {
    x: width * (portrait ? 0.61 : 0.766),
    y: height * (portrait ? 0.65 : 0.53),
    size: Math.min(width, height) * (portrait ? 0.91 : 0.92),
  };
}
