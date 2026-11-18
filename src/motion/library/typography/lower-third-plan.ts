/** Entrance length in frames (0.6 s at 30 fps) and exit length (55% of it, craft rules). */
export const LOWER_THIRD_IN = 18;
export const LOWER_THIRD_OUT = 10;

/** Delay of each part after `inAt`: the rule or bar leads, the name follows, the role and logo land last. */
export const LOWER_THIRD_STAGGER = { lead: 0, name: 3, role: 7, logo: 9 } as const;

export type LowerThirdTimes = { inAt: number; settled: number; outAt: number | null; gone: number | null };

/** Frames of the entrance, the settled hold and the exit; `outAt < 0` keeps it on screen to the end of the clip. */
export const lowerThirdTimes = (inAt: number, outAt: number): LowerThirdTimes => {
  const settled = inAt + LOWER_THIRD_IN + LOWER_THIRD_STAGGER.logo;
  if (outAt < 0) return { inAt, settled, outAt: null, gone: null };
  const out = Math.max(outAt, settled);
  return { inAt, settled, outAt: out, gone: out + LOWER_THIRD_OUT };
};

export const lowerThirdCues = (p: { inAt: number; outAt: number; name: string }) => {
  const t = lowerThirdTimes(p.inAt, p.outAt);
  const cues: { frame: number; kind: "reveal" | "exit"; sfx: "none"; weight: "support"; label: string }[] = [
    {
      frame: t.inAt + LOWER_THIRD_STAGGER.name,
      kind: "reveal",
      sfx: "none",
      weight: "support",
      label: `${p.name} named`,
    },
  ];
  if (t.outAt !== null)
    cues.push({ frame: t.outAt, kind: "exit", sfx: "none", weight: "support", label: "lower third leaves" });
  return cues;
};
