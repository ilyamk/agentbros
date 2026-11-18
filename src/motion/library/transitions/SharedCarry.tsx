import React, { useId } from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { morphRect, type LayoutKeyframe } from "../../kinetic-math";
import { CAMERA_EASE } from "../camera/ParallaxRig";
import { DEMO } from "./demo";
import { displayFont, primaryFont } from "../../../lib/fonts";

export type CarryRect = { x: number; y: number; width: number; height: number; radius: number };

type SharedCarryProps = {
  /** Frame the carried element starts to travel. */
  at: number;
  /** Travel frames; 14–20 reads as a deliberate carry. */
  frames: number;
  /** The element's rect in scene A and in scene B, in frame pixels. */
  from: CarryRect;
  to: CarryRect;
  /** Scene A without the element (its slot left empty), and scene B without it. */
  before: React.ReactNode;
  after: React.ReactNode;
  /** Draws the element at its current rect; `scale` is width relative to `to`, so lay it out at the B size and scale. */
  carry: (rect: CarryRect, scale: number) => React.ReactNode;
  /** Peak directional smear in pixels; craft rules put a carried element at 6–12. */
  maxBlur?: number;
};

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);

/**
 * Shared-element carry: one element leaves its place in scene A, travels on the camera ease with directional motion blur,
 * and lands in its place in scene B. Scene A blurs out while it leaves, scene B builds around it as it lands; the
 * element itself never cuts. Keep the two scenes on the same ground so no world crossfades.
 */
/** The carried element lands at the end of its travel; that landing is the cut the sound locks to. */
export const sharedCarryLand = (at: number, frames: number): number => at + frames;

export const SharedCarry: React.FC<SharedCarryProps> = ({
  at,
  frames,
  from,
  to,
  before,
  after,
  carry,
  maxBlur = 10,
}) => {
  const frame = useCurrentFrame();
  const id = useId().replaceAll(":", "");
  const keys: LayoutKeyframe[] = [
    { at, ...from },
    { at: at + frames, ...to, curve: CAMERA_EASE },
  ];
  const rect = morphRect(frame, keys);
  const next = morphRect(frame + 1, keys);
  const prev = morphRect(frame - 1, keys);
  const vx = (next.x + next.width / 2 - (prev.x + prev.width / 2)) / 2;
  const vy = (next.y + next.height / 2 - (prev.y + prev.height / 2)) / 2;
  const sx = Math.min(Math.abs(vx) * 0.15, maxBlur);
  const sy = Math.min(Math.abs(vy) * 0.15, maxBlur);
  const blurred = sx > 0.4 || sy > 0.4;
  const t = (frame - at) / frames;
  // Blur swap around the element: A leaves over the first 35%, B builds over the last 40%.
  const out = clamp01(t / 0.35);
  const inn = clamp01((t - 0.6) / 0.4);
  return (
    <AbsoluteFill>
      <Sequence durationInFrames={Math.ceil(at + frames * 0.35) + 1} layout="none" name="Before carry">
        <AbsoluteFill style={{ opacity: 1 - out, filter: out > 0 ? `blur(${8 * out}px)` : undefined }}>
          {before}
        </AbsoluteFill>
      </Sequence>
      <Sequence from={Math.floor(at + frames * 0.6)} layout="none" name="After carry">
        <AbsoluteFill style={{ opacity: inn, filter: inn < 1 ? `blur(${8 * (1 - inn)}px)` : undefined }}>
          {after}
        </AbsoluteFill>
      </Sequence>
      <AbsoluteFill style={{ filter: blurred ? `url(#${id})` : undefined }}>
        {blurred ? (
          <svg width={0} height={0} style={{ position: "absolute" }}>
            <filter id={id} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
              <feGaussianBlur stdDeviation={`${sx} ${sy}`} />
            </filter>
          </svg>
        ) : null}
        {carry(rect, rect.width / to.width)}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const BARS = [0.34, 0.52, 0.41, 0.66, 0.58, 0.81, 0.74, 0.96];

const ChartCard: React.FC<{ rect: CarryRect; scale: number; base: CarryRect; u: number }> = ({
  rect,
  scale,
  base,
  u,
}) => (
  <div
    style={{
      position: "absolute",
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      borderRadius: rect.radius,
      background: "#FFFFFF",
      border: `${Math.max(1, 2 * u)}px solid rgba(18,18,18,0.08)`,
      overflow: "hidden",
    }}
  >
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: base.width,
        height: base.height,
        transform: `scale(${scale}, ${rect.height / base.height})`,
        transformOrigin: "0 0",
        padding: 56 * u,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: primaryFont,
          color: DEMO.inkMuted,
          fontSize: 30 * u,
          fontWeight: 500,
        }}
      >
        <span>Deploy time</span>
        <span style={{ color: DEMO.indigo, fontWeight: 700 }}>−92%</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 56 * u,
          right: 56 * u,
          bottom: 56 * u,
          height: base.height * 0.6,
          display: "flex",
          alignItems: "flex-end",
          gap: 22 * u,
        }}
      >
        {BARS.map((bar, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${bar * 100}%`,
              borderRadius: 12 * u,
              background: i === BARS.length - 1 ? DEMO.indigo : "rgba(18,18,18,0.12)",
            }}
          />
        ))}
      </div>
    </div>
  </div>
);

export const sharedCarrySchema = z.object({
  /** Frames from the block's start to the landing (the perceived cut), for `cues` in a film: `sharedCarryLand(at, frames)`. The preview keeps its own. */
  seamFrame: z.number().int().min(0).optional(),
  frames: z.number().int().min(8).max(30),
  maxBlur: z.number().min(0).max(20),
  headline: z.string(),
  caption: z.string(),
});

export type SharedCarryPreviewProps = z.infer<typeof sharedCarrySchema>;

export const SHARED_CARRY_FRAMES = 96;

export const SharedCarryPreview: React.FC<SharedCarryPreviewProps> = ({ frames, maxBlur, headline, caption }) => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const vertical = height > width;
  const fromW = (vertical ? 620 : 700) * u;
  const from: CarryRect = vertical
    ? { x: width - fromW - 80 * u, y: height * 0.62, width: fromW, height: fromW * 0.62, radius: 30 * u }
    : { x: width * 0.56, y: height * 0.5 - fromW * 0.31, width: fromW, height: fromW * 0.62, radius: 30 * u };
  const toW = vertical ? width - 160 * u : width * 0.6;
  const to: CarryRect = vertical
    ? { x: 80 * u, y: height * 0.4, width: toW, height: toW * 0.72, radius: 40 * u }
    : { x: width * 0.06, y: height * 0.2, width: toW, height: height * 0.6, radius: 40 * u };
  const ground = <AbsoluteFill style={{ backgroundColor: DEMO.paper }} />;
  const before = (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: vertical ? 90 * u : width * 0.08,
          top: vertical ? height * 0.22 : height * 0.36,
          width: vertical ? width - 180 * u : width * 0.42,
        }}
      >
        <div
          style={{
            fontFamily: displayFont,
            fontWeight: 700,
            fontSize: 132 * u,
            lineHeight: 1,
            letterSpacing: -4 * u,
            color: DEMO.ink,
          }}
        >
          {headline}
        </div>
      </div>
    </AbsoluteFill>
  );
  const after = (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: vertical ? 80 * u : width * 0.7,
          top: vertical ? height * 0.2 : height * 0.3,
          width: vertical ? width - 160 * u : width * 0.26,
        }}
      >
        <div
          style={{
            fontFamily: displayFont,
            fontWeight: 700,
            fontSize: 200 * u,
            lineHeight: 1,
            letterSpacing: -8 * u,
            color: DEMO.indigo,
          }}
        >
          −92%
        </div>
        <div
          style={{
            fontFamily: primaryFont,
            fontWeight: 500,
            fontSize: 34 * u,
            color: DEMO.inkMuted,
            marginTop: 20 * u,
          }}
        >
          {caption}
        </div>
      </div>
    </AbsoluteFill>
  );
  return (
    <AbsoluteFill>
      {ground}
      <SharedCarry
        at={38}
        frames={frames}
        from={from}
        to={to}
        before={before}
        after={after}
        maxBlur={maxBlur}
        carry={(rect, scale) => <ChartCard rect={rect} scale={scale} base={to} u={u} />}
      />
    </AbsoluteFill>
  );
};
