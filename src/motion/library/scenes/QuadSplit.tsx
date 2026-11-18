import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import type { Cue } from "../types";
import { QUAD_PAIR_GAP, QUAD_REST_SEC, QUAD_WINDOW_SEC, planQuadCuts, quadRects, quadShotAt } from "./scene-plan";
import { MaybeFinish, sceneBaseSchema, useLook } from "./shared";

/**
 * quad-split: four films at once in a gutterless 2x2 grid, each cell its own timeline, cut on a plan that keeps them
 * reading as four (ace's hook). The stage owns the timing, not the pictures:
 *
 * - `planQuadCuts(cuts, { fps, windowSec, pairGap, restSec })` (scene-plan.ts, pure) takes the four cells' wanted cut
 *   frames and returns the planned ones: never more than two changes within 0.1 s, two that coincide are on opposite
 *   corners one frame apart, and one cell rests through the densest stretch.
 * - `<QuadSplit cuts={...}>{[tl, tr, bl, br]}</QuadSplit>`: each child renders at full frame size and is scaled into
 *   its cell, so any block or film fits; a child reads its own shot with `quadShotAt(plan[cell], frame)`.
 * Without children each cell draws stand-in shots (a ground, a word, a drifting disc) from `shots`. Product screens in
 * a cell follow the real-UI rule: captured, never drawn.
 */

const shotSchema = z.object({ ground: z.string(), ink: z.string(), word: z.string() });

export const quadSplitSchema = sceneBaseSchema.extend({
  /** Wanted cut frames of each cell in reading order (top left, top right, bottom left, bottom right). */
  cuts: z.array(z.array(z.number().int().min(0))).length(4),
  /** Stand-in shots per cell, used in order after each cut (the last repeats); ignored for a cell with a child. */
  shots: z.array(z.array(shotSchema).min(1)).length(4),
  /** At most two changes within this many seconds (ace: 0.1). */
  windowSec: z.number().min(0.03).max(0.5),
  /** Frames between a diagonal pair (ace: 1). */
  pairGap: z.number().int().min(1).max(3),
  /** Seconds one cell rests through the densest stretch (ace: 1.9); 0 turns it off. */
  restSec: z.number().min(0).max(4),
});

export type QuadSplitProps = z.infer<typeof quadSplitSchema>;

export const quadSplitPlan = (
  p: Pick<QuadSplitProps, "cuts" | "windowSec" | "pairGap" | "restSec">,
  fps = 30,
): number[][] => planQuadCuts(p.cuts, { fps, windowSec: p.windowSec, pairGap: p.pairGap, restSec: p.restSec });

const CELL_NAMES = ["top left", "top right", "bottom left", "bottom right"];

/** One cut cue per planned change; changes of a diagonal pair share one sound (the second is silent). */
export const quadSplitCues = (
  p: Pick<QuadSplitProps, "cuts" | "windowSec" | "pairGap" | "restSec">,
  fps = 30,
): Cue[] => {
  const plan = quadSplitPlan(p, fps);
  const events = plan.flatMap((list, cell) => list.map((frame) => ({ frame, cell }))).sort((a, b) => a.frame - b.frame);
  return events.map((e, i): Cue => {
    const paired = i > 0 && e.frame - events[i - 1]!.frame <= p.pairGap;
    return {
      frame: e.frame,
      kind: "cut",
      sfx: paired ? "none" : "tick",
      weight: "support",
      label: `${CELL_NAMES[e.cell]} cuts${paired ? " (diagonal pair)" : ""}`,
    };
  });
};

const StandInShot: React.FC<{ shot: z.infer<typeof shotSchema>; since: number; seed: number; display: string }> = ({
  shot,
  since,
  seed,
  display,
}) => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  // Every cell is mid-motion on every frame (ace's hook): the word creeps, the disc drifts at constant speed.
  const creep = 1 + 0.0025 * since;
  const dir = seed % 2 ? 1 : -1;
  const disc = 0.5 + dir * (0.32 - 0.004 * since);
  return (
    <AbsoluteFill style={{ backgroundColor: shot.ground, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: disc * width - 110 * u,
          top: height * (0.22 + 0.12 * (seed % 3)),
          width: 220 * u,
          height: 220 * u,
          borderRadius: "50%",
          background: shot.ink,
          opacity: 0.16,
        }}
      />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            fontFamily: display,
            fontWeight: 700,
            fontSize: 280 * u,
            letterSpacing: "-0.04em",
            color: shot.ink,
            transform: `scale(${creep})`,
            whiteSpace: "pre",
          }}
        >
          {shot.word}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Four full-frame layers scaled into a gutterless 2x2 grid, each cell cut on its planned frames. */
export const QuadSplit: React.FC<QuadSplitProps & { children?: React.ReactNode[] }> = ({ children, ...props }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const look = useLook(props.styleId);
  const plan = quadSplitPlan(props, fps);
  const rects = quadRects();
  return (
    <MaybeFinish on={props.finish} styleId={props.styleId} seed="quad-split">
      <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden" }}>
        {rects.map((rect, cell) => {
          const list = plan[cell]!;
          const shot = quadShotAt(list, frame);
          const since = frame - (shot === 0 ? 0 : list[shot - 1]!);
          const shots = props.shots[cell]!;
          return (
            <div
              key={cell}
              style={{
                position: "absolute",
                left: rect.x * width,
                top: rect.y * height,
                width: rect.w * width,
                height: rect.h * height,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width,
                  height,
                  transform: `scale(${rect.w}, ${rect.h})`,
                  transformOrigin: "0 0",
                }}
              >
                {children?.[cell] ?? (
                  <StandInShot
                    shot={shots[Math.min(shot, shots.length - 1)]!}
                    since={since}
                    seed={cell + shot}
                    display={look.displayFamily}
                  />
                )}
              </div>
            </div>
          );
        })}
      </AbsoluteFill>
    </MaybeFinish>
  );
};

const S = (ground: string, ink: string, word: string) => ({ ground, ink, word });

export const QUAD_SPLIT_FRAMES = 210;

export const quadSplitDefaults: QuadSplitProps = {
  styleId: "paper-signal",
  finish: false,
  // Wanted cuts at 30 fps: top right and bottom left both ask for frame 38 (planned as a diagonal pair 1 frame apart),
  // three cells ask for 96-100 (spread so no three fall within 0.1 s); top right rests through the dense middle.
  cuts: [
    [20, 52, 96, 128, 170],
    [38, 110, 150],
    [38, 66, 100, 134, 176],
    [24, 80, 98, 160],
  ],
  shots: [
    [
      S("#EEF0F3", "#16181D", "draft"),
      S("#16181D", "#EEF0F3", "cut"),
      S("#3D5AFE", "#FFFFFF", "ship"),
      S("#EEF0F3", "#16181D", "again"),
      S("#FFB020", "#16181D", "live"),
      S("#16181D", "#EEF0F3", "done"),
    ],
    [
      S("#F6E7D8", "#2A1E14", "slow"),
      S("#E9ECF2", "#1E2A44", "calm"),
      S("#1E2A44", "#E9ECF2", "steady"),
      S("#F6E7D8", "#2A1E14", "still"),
    ],
    [
      S("#0F1B2D", "#9CC3FF", "plan"),
      S("#9CC3FF", "#0F1B2D", "type"),
      S("#0F1B2D", "#FFFFFF", "send"),
      S("#FFFFFF", "#0F1B2D", "reply"),
      S("#2B1B3D", "#F2D9FF", "book"),
      S("#F2D9FF", "#2B1B3D", "meet"),
    ],
    [
      S("#1B1B1B", "#F4F4F2", "one"),
      S("#F4F4F2", "#1B1B1B", "two"),
      S("#2E7D5B", "#F4F4F2", "four"),
      S("#F4F4F2", "#2E7D5B", "many"),
      S("#1B1B1B", "#F4F4F2", "all"),
    ],
  ],
  windowSec: QUAD_WINDOW_SEC,
  pairGap: QUAD_PAIR_GAP,
  restSec: QUAD_REST_SEC,
};
