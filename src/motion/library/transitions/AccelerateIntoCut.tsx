import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { displayFont, primaryFont } from "../../../lib/fonts";
import { easeFamily } from "../../ease-family";
import { useFittedFontSize } from "../../text";
import { intendedOverflow } from "../overflow";
import type { Cue } from "../types";
import { DEMO, DemoSceneA } from "./demo";

export type AccelerateMove = "push" | "drift-up" | "drift-left";

export type AccelerateTiming = {
  /** Frame, relative to the block's start, of the hard cut: the first frame of the new shot. */
  seamFrame: number;
  /** Frames of the old shot's move before the cut; it accelerates on circ.in and is fastest on its last frame. */
  approach: number;
  /**
   * Travel of the old shot over `approach`: for `push` the log of the scale it reaches (0.4 is about 1.5x), for a drift
   * the share of the frame height (`drift-up`) or width (`drift-left`), 0.04-0.12 (the drift translates over `ground`).
   */
  amount: number;
  /** Speed ratio from one frame of the new shot to the next: 0.5 halves it each frame. */
  decay: number;
};

/**
 * Travel of a shot at a frame, in the units of `amount`, and its speed: before the cut the travel since the previous
 * frame, after it the travel to the next one, so both sides of the seam carry the same peak speed.
 */
export type AccelerateState = { side: "before" | "after"; travel: number; speed: number };

/** Speed of the old shot on its last frame: the speed the new shot picks up. Pure. */
export const accelerateSeamSpeed = ({ approach, amount }: Pick<AccelerateTiming, "approach" | "amount">): number =>
  amount * (1 - easeFamily["circ.in"]((approach - 1) / approach));

/**
 * The move on both sides of the cut. Before it the old shot travels `amount` on circ.in, reaching it on its last frame
 * (seamFrame - 1), so its speed peaks there. The cut frame shows the new shot at rest; from the next frame it moves on
 * in the same direction at the old shot's last speed, multiplied by `decay` every frame, and comes to rest after
 * travelling `speed / (1 - decay)`. Measured: 34, 17, 7.7 frame differences after the cut (halving). Pure.
 */
export const accelerateState = (frame: number, timing: AccelerateTiming): AccelerateState => {
  const { seamFrame, approach, amount, decay } = timing;
  if (frame < seamFrame) {
    const at = (f: number) =>
      amount * easeFamily["circ.in"](Math.min(Math.max((f - (seamFrame - approach)) / approach, 0), 1));
    // Frames run seamFrame - approach + 1 .. seamFrame - 1 inside the move; t reaches 1 on the last old frame.
    const travel = at(frame + 1);
    return { side: "before", travel, speed: travel - at(frame) };
  }
  const v = accelerateSeamSpeed(timing);
  const k = frame - seamFrame;
  const travel = (v * (1 - decay ** k)) / (1 - decay);
  // Speed here looks forward (travel to the next frame), so the cut frame carries the seam's full speed and its blur.
  return { side: "after", travel, speed: v * decay ** k };
};

/** Total travel of the new shot after the cut. */
export const accelerateTail = (timing: Pick<AccelerateTiming, "approach" | "amount" | "decay">): number =>
  accelerateSeamSpeed(timing) / (1 - timing.decay);

/** First frame after the cut whose speed is below `share` of the seam's speed. */
export const accelerateRestFrame = (timing: AccelerateTiming, share = 0.05): number =>
  timing.seamFrame + Math.ceil(Math.log(share) / Math.log(timing.decay));

/** Cut on the seam (hero), and the new shot coming to rest (support). */
export const accelerateCues = (timing: AccelerateTiming): Cue[] => [
  { frame: timing.seamFrame, kind: "cut", sfx: "whoosh", weight: "hero", label: "cut at peak speed" },
  { frame: accelerateRestFrame(timing), kind: "land", weight: "support", label: "new shot brakes to rest" },
];

type ShotTransform = { transform: string; blur: number };

const shotTransform = (
  move: AccelerateMove,
  side: "before" | "after",
  travel: number,
  speed: number,
  origin: { x: number; y: number },
  width: number,
  height: number,
  tail: number,
): ShotTransform => {
  const diag = Math.hypot(width, height);
  if (move === "push") {
    // The old shot grows from 1; the new one starts at 1 and grows by the tail, so no edge ever shows.
    const scale = Math.exp(travel);
    const blur = Math.min(speed * diag * 0.06, 14);
    const ox = origin.x * width;
    const oy = origin.y * height;
    return { transform: `translate(${ox}px, ${oy}px) scale(${scale}) translate(${-ox}px, ${-oy}px)`, blur };
  }
  const span = move === "drift-up" ? height : width;
  // A pure translation over `ground`, as on the reference (a white interface over white): the old shot leaves by
  // `travel`, the new one arrives from `tail` and settles at 0. Keep `amount` small (0.04-0.12) and the ground the shots' own.
  const offset = side === "before" ? -travel * span : (tail - travel) * span;
  const blur = Math.min(speed * span * 0.12, 14);
  return { transform: move === "drift-up" ? `translate(0px, ${offset}px)` : `translate(${offset}px, 0px)`, blur };
};

/**
 * A move that accelerates into a hard cut, picked up by the next shot. The old shot pushes (or drifts) faster every
 * frame and is cut at its peak speed; the new shot carries the same direction and brakes, halving its speed each frame,
 * so the change hides in the motion and reads as one camera arriving. 2D transforms; blur grows with speed.
 */
export const AccelerateIntoCut: React.FC<
  AccelerateTiming & {
    move?: AccelerateMove;
    originX?: number;
    originY?: number;
    afterOriginX?: number;
    afterOriginY?: number;
    ground?: string;
    before: React.ReactNode;
    after: React.ReactNode;
  }
> = ({
  move = "push",
  originX = 0.5,
  originY = 0.5,
  afterOriginX,
  afterOriginY,
  ground = "#000000",
  before,
  after,
  ...timing
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const state = accelerateState(frame, timing);
  const origin =
    state.side === "before" ? { x: originX, y: originY } : { x: afterOriginX ?? originX, y: afterOriginY ?? originY };
  const { transform, blur } = shotTransform(
    move,
    state.side,
    state.travel,
    state.speed,
    origin,
    width,
    height,
    accelerateTail(timing),
  );
  const style: React.CSSProperties = {
    transform,
    transformOrigin: "0 0",
    filter: blur > 0.4 ? `blur(${blur.toFixed(2)}px)` : undefined,
  };
  if (move !== "push") style.transformOrigin = "50% 50%";
  // The shot is carried through the frame from the start of the approach until the new shot comes to rest.
  const moving = frame >= timing.seamFrame - timing.approach && frame < accelerateRestFrame(timing);
  const overflow = intendedOverflow(
    moving,
    "accelerate-into-cut: the shot is pushed through the frame at speed into the cut",
  );
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: ground }}>
      <Sequence durationInFrames={timing.seamFrame} layout="none" name="Before the cut">
        <AbsoluteFill {...overflow} style={style}>
          {before}
        </AbsoluteFill>
      </Sequence>
      <Sequence from={timing.seamFrame} layout="none" name="After the cut">
        <AbsoluteFill {...overflow} style={style}>
          {after}
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};

export const accelerateIntoCutSchema = z.object({
  seamFrame: z.number().int().min(1),
  approach: z.number().int().min(3).max(30),
  amount: z.number().min(0.02).max(1.2),
  decay: z.number().min(0.2).max(0.8),
  move: z.enum(["push", "drift-up", "drift-left"]),
  /** Point the push closes on, as shares of the frame. */
  originX: z.number().min(0).max(1),
  originY: z.number().min(0).max(1),
  /** Preview only: the figure the close-up lands on and its caption. */
  figure: z.string(),
  caption: z.string(),
});

export type AccelerateIntoCutProps = z.infer<typeof accelerateIntoCutSchema>;

export const ACCELERATE_INTO_CUT_FRAMES = 84;

export const accelerateIntoCutDefaults: AccelerateIntoCutProps = {
  seamFrame: 44,
  approach: 12,
  amount: 0.42,
  decay: 0.5,
  move: "push",
  originX: 0.78,
  originY: 0.58,
  figure: "−92%",
  caption: "Deploy time, last 90 days",
};

/** Close-up of the card the push flew into: the figure big, the bars cropped by the frame. */
const CloseUp: React.FC<{ figure: string; caption: string }> = ({ figure, caption }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const vertical = height > width;
  const bars = [0.58, 0.81, 0.74, 0.96];
  const drift = 1 + frame * 0.0004;
  const left = vertical ? 90 * u : width * 0.08;
  // The push carries on by up to about 1.45x after the cut (with the drift): fit the figure to the width that leaves.
  const fitted = useFittedFontSize({
    text: figure,
    withinWidth: (width - left * 2) / 1.5,
    fontFamily: displayFont,
    fontWeight: 700,
  });
  return (
    <AbsoluteFill style={{ backgroundColor: "#FFFFFF", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left,
          top: vertical ? height * 0.22 : height * 0.16,
          transform: `scale(${drift})`,
          transformOrigin: "0 0",
        }}
      >
        <div
          style={{
            fontFamily: primaryFont,
            fontWeight: 600,
            fontSize: 34 * u,
            color: DEMO.inkMuted,
            letterSpacing: "0.02em",
          }}
        >
          {caption}
        </div>
        <div
          style={{
            fontFamily: displayFont,
            fontWeight: 700,
            fontSize: Math.min(340 * u, fitted ?? 240 * u),
            lineHeight: 0.9,
            letterSpacing: -10 * u,
            color: DEMO.indigo,
            marginTop: 20 * u,
          }}
        >
          {figure}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: vertical ? -60 * u : width * 0.06,
          bottom: -40 * u,
          width: vertical ? width * 0.9 : width * 0.42,
          height: height * (vertical ? 0.42 : 0.62),
          display: "flex",
          alignItems: "flex-end",
          gap: 34 * u,
        }}
      >
        {bars.map((bar, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${bar * 100}%`,
              borderRadius: 12 * u,
              background: i === bars.length - 1 ? DEMO.indigo : "rgba(18,18,18,0.10)",
            }}
          />
        ))}
      </div>
    </AbsoluteFill>
  );
};

/** Library preview: a push on the product card accelerates into a cut to its figure, which carries the push and brakes. */
export const AccelerateIntoCutPreview: React.FC<AccelerateIntoCutProps> = ({ figure, caption, ...rest }) => (
  <AccelerateIntoCut
    {...rest}
    ground={DEMO.paper}
    afterOriginX={0.1}
    afterOriginY={0.4}
    before={<DemoSceneA />}
    after={<CloseUp figure={figure} caption={caption} />}
  />
);
