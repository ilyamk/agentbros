import React from "react";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { displayFont, primaryFont } from "../../../lib/fonts";
import type { Cue } from "../types";
import { gather, impact, seal, seg, smoother } from "./contact-math";

export const gatherSealSchema = z.object({
  /** The cast: short labels of the things that become one mark. */
  cast: z.array(z.string().min(1)).min(3).max(8),
  colours: z.array(z.string()).min(1),
  word: z.string(),
  gatherFrom: z.number().int().min(0),
  gatherFrames: z.number().int().min(10).max(60),
  staggerFrames: z.number().int().min(0).max(6),
  ground: z.string(),
  ink: z.string(),
  disc: z.string(),
  seed: z.number().int(),
});

export type GatherSealProps = z.infer<typeof gatherSealSchema>;

export const GATHER_SEAL_FRAMES = 105;

const landFrame = ({
  cast,
  gatherFrom,
  gatherFrames,
  staggerFrames,
}: Pick<GatherSealProps, "cast" | "gatherFrom" | "gatherFrames" | "staggerFrames">): number =>
  gatherFrom + gatherFrames + (cast.length - 1) * staggerFrames;

export const gatherSealCues = (
  p: Pick<GatherSealProps, "cast" | "gatherFrom" | "gatherFrames" | "staggerFrames">,
): Cue[] => [
  { frame: p.gatherFrom, kind: "reveal", sfx: "whoosh", weight: "support", label: "cast starts to gather" },
  { frame: landFrame(p), kind: "land", sfx: "impact", weight: "hero", label: "cast folds into the seal" },
  { frame: landFrame(p) + 6, kind: "reveal", sfx: "none", weight: "support", label: "name rises" },
];

/**
 * A cast of items scattered over the frame travels on fanned arcs into a ring while a disc grows and
 * turns beneath them, and the name rises under the seal: many things become one mark. A lockup carry.
 */
export const GatherSeal: React.FC<GatherSealProps> = ({
  cast,
  colours,
  word,
  gatherFrom,
  gatherFrames,
  staggerFrames,
  ground,
  ink,
  disc,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const u = Math.min(width, height) / 1080;
  const n = cast.length;
  const t0 = gatherFrom / fps;
  const t1 = (gatherFrom + gatherFrames) / fps;
  const stagger = staggerFrames / fps;
  const land = landFrame({ cast, gatherFrom, gatherFrames, staggerFrames }) / fps;
  const centre = { x: width / 2, y: height * (height > width ? 0.44 : 0.42) };
  const ringR = 150 * u;
  const chip = 128 * u;
  const s = seal(t, t1 - 0.1, land + 0.25, { r: ringR + chip * 0.75, turns: 0.5 });
  const hit = impact(t, land, { sqx: 0.06, sqy: 0.06 });
  const name = smoother(seg(t, land + 0.2, land + 0.75));
  return (
    <AbsoluteFill style={{ backgroundColor: ground, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: centre.x - s.r,
          top: centre.y - s.r,
          width: s.r * 2,
          height: s.r * 2,
          borderRadius: "50%",
          background: disc,
          transform: `rotate(${s.rot}deg) scale(${hit.sx})`,
        }}
      />
      {cast.map((label, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2 + (s.rot * Math.PI) / 180;
        const from = {
          x: width * (0.12 + 0.76 * random(`${seed}-x-${i}`)),
          y: height * (0.12 + 0.76 * random(`${seed}-y-${i}`)),
        };
        const to = { x: centre.x + Math.cos(angle) * ringR, y: centre.y + Math.sin(angle) * ringR };
        const g = gather(t, t0, t1, i, n, from, to, { stagger, arc: 140 * u, spin: 0.35 });
        const size = chip * (1 - 0.3 * g.k);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: g.x - size / 2,
              top: g.y - size / 2,
              width: size,
              height: size,
              borderRadius: "50%",
              background: colours[i % colours.length],
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: primaryFont,
              fontWeight: 700,
              fontSize: size * 0.3,
              color: ground,
              transform: `rotate(${g.rot}rad) scale(${hit.sx}, ${hit.sy})`,
            }}
          >
            {label}
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: centre.y + ringR + chip * 1.2,
          overflow: "hidden",
          textAlign: "center",
          paddingBottom: 12 * u,
        }}
      >
        <div
          style={{
            fontFamily: displayFont,
            fontWeight: 700,
            fontSize: 120 * u,
            letterSpacing: -3 * u,
            lineHeight: 1.05,
            color: ink,
            transform: `translateY(${(1 - name) * 110}%)`,
          }}
        >
          {word}
        </div>
      </div>
    </AbsoluteFill>
  );
};
