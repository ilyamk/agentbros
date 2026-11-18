import React, { useId } from "react";
import { AbsoluteFill, Freeze, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { displayFont, primaryFont } from "../../../lib/fonts";
import { speedAt, timeRemap, type SpeedSegment } from "../../timing";
import type { Cue } from "../types";

export type SpeedRampSettings = {
  /** Speed changes in output frames; see `SpeedSegment` in src/motion/timing. */
  segments: readonly SpeedSegment[];
  /** Speed before the first segment. */
  initialSpeed?: number;
  /** Direction of the speed blur; "none" switches it off. */
  blurAxis?: "x" | "y" | "none";
  /** Blur sigma in pixels per unit of speed above real time (speed 4 at 3 gives 9 px). */
  blurPerSpeed?: number;
  maxBlur?: number;
};

/** Directional blur sigma for a speed: nothing at or below real time, then proportional, capped. */
export const rampBlur = (speed: number, blurPerSpeed = 3, maxBlur = 18): number =>
  Math.min(Math.max(0, speed - 1) * blurPerSpeed, maxBlur);

/**
 * A speed ramp over any child: the child sees a remapped frame (`timeRemap`), so slow-fast-slow is continuous, with a
 * directional blur that grows with the speed. Procedural children receive fractional frames in slow motion; for
 * `<Video>` from `@remotion/media`, round `timeRemap` yourself and seek the clip with it.
 */
export const SpeedRamp: React.FC<SpeedRampSettings & { children: React.ReactNode }> = ({
  segments,
  initialSpeed = 1,
  blurAxis = "x",
  blurPerSpeed = 3,
  maxBlur = 18,
  children,
}) => {
  const frame = useCurrentFrame();
  const id = useId().replaceAll(":", "");
  const source = timeRemap(frame, segments, initialSpeed);
  const sigma = blurAxis === "none" ? 0 : rampBlur(speedAt(frame, segments, initialSpeed), blurPerSpeed, maxBlur);
  const blurred = sigma > 0.5;
  return (
    <AbsoluteFill style={{ filter: blurred ? `url(#ramp-${id})` : undefined }}>
      {blurred ? (
        <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
          <filter id={`ramp-${id}`} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
            <feGaussianBlur edgeMode="duplicate" stdDeviation={blurAxis === "x" ? `${sigma} 0` : `0 ${sigma}`} />
          </filter>
        </svg>
      ) : null}
      <Freeze frame={source}>{children}</Freeze>
    </AbsoluteFill>
  );
};

/** A whoosh where the clip speeds up past 1.5x the previous speed, the hit where it slows to its last speed. */
export const speedRampCues = ({
  segments,
  initialSpeed = 1,
}: Pick<SpeedRampSettings, "segments" | "initialSpeed">): Cue[] => {
  const cues: Cue[] = [];
  let previous = initialSpeed;
  segments.forEach((segment, i) => {
    const ramp = segment.ramp ?? 6;
    if (segment.speed > previous * 1.5)
      cues.push({ frame: segment.at, kind: "peak", sfx: "whoosh", weight: "support", label: "ramps up" });
    else if (segment.speed < previous / 1.5)
      cues.push({
        frame: segment.at + ramp,
        kind: "land",
        sfx: "impact",
        weight: i === segments.length - 1 ? "hero" : "support",
        label: "back to slow",
      });
    previous = segment.speed;
  });
  return cues;
};

const segmentSchema = z.object({
  at: z.number().min(0),
  speed: z.number().min(0).max(16),
  ramp: z.number().min(0).max(60),
});

export const speedRampSchema = z.object({
  segments: z.array(segmentSchema).min(1),
  initialSpeed: z.number().min(0).max(16),
  blurAxis: z.enum(["x", "y", "none"]),
  blurPerSpeed: z.number().min(0).max(12),
  maxBlur: z.number().min(0).max(60),
  /** Preview only: show the speed in the corner. */
  readout: z.boolean(),
});

export type SpeedRampProps = z.infer<typeof speedRampSchema>;

export const SPEED_RAMP_FRAMES = 120;

export const speedRampDefaults: SpeedRampProps = {
  initialSpeed: 0.3,
  segments: [
    { at: 30, speed: 4, ramp: 10 },
    { at: 64, speed: 0.25, ramp: 14 },
  ],
  blurAxis: "x",
  blurPerSpeed: 3,
  maxBlur: 18,
  readout: true,
};

const GROUND = "#ECE8DF";
const INK = "#161513";
const ACCENT = "#E2552B";

/** The ramped material: a timecode, a strip of numbered frames sliding past and a runner, all on source time. */
const RampMaterial: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const vertical = height > width;
  const cell = 150 * u;
  const gap = 18 * u;
  const pitch = cell + gap;
  const travel = frame * 14 * u;
  const first = Math.floor(travel / pitch) - 1;
  const count = Math.ceil(width / pitch) + 3;
  const stripTop = vertical ? height * 0.52 : height * 0.56;
  const seconds = frame / fps;
  const timecode = `00:0${Math.floor(seconds)}.${String(Math.floor((seconds % 1) * 100)).padStart(2, "0")}`;
  const runnerX = ((width * 0.35 + frame * 9 * u) % (width + 200 * u)) - 100 * u;
  return (
    <AbsoluteFill style={{ backgroundColor: GROUND, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: 80 * u,
          top: vertical ? height * 0.2 : height * 0.12,
          fontFamily: primaryFont,
          fontWeight: 600,
          fontSize: 28 * u,
          letterSpacing: "0.16em",
          color: INK,
          opacity: 0.55,
        }}
      >
        SOURCE TIME
      </div>
      <div
        style={{
          position: "absolute",
          left: 72 * u,
          top: vertical ? height * 0.23 : height * 0.17,
          fontFamily: displayFont,
          fontWeight: 700,
          fontSize: (vertical ? 150 : 190) * u,
          letterSpacing: "-0.04em",
          color: INK,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {timecode}
      </div>
      {Array.from({ length: count }, (_, k) => {
        const index = first + k;
        const x = index * pitch - travel;
        const lit = index % 6 === 0;
        return (
          <div
            key={index}
            style={{
              position: "absolute",
              left: x,
              top: stripTop,
              width: cell,
              height: cell * 1.3,
              borderRadius: 10 * u,
              backgroundColor: lit ? ACCENT : INK,
              color: lit ? INK : GROUND,
              fontFamily: primaryFont,
              fontWeight: 600,
              fontSize: 30 * u,
              padding: 16 * u,
              boxSizing: "border-box",
            }}
          >
            {String(index).padStart(3, "0")}
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: stripTop + cell * 1.3 + 70 * u,
          height: 2 * u,
          backgroundColor: INK,
          opacity: 0.25,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: runnerX,
          top: stripTop + cell * 1.3 + 46 * u,
          width: 48 * u,
          height: 48 * u,
          borderRadius: "50%",
          backgroundColor: ACCENT,
        }}
      />
    </AbsoluteFill>
  );
};

/** Library preview: slow, fast with blur, slow again over a frame strip, with the live speed in the corner. */
export const SpeedRampPreview: React.FC<SpeedRampProps> = ({ readout, ...settings }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const speed = speedAt(frame, settings.segments, settings.initialSpeed);
  return (
    <AbsoluteFill>
      <SpeedRamp {...settings}>
        <RampMaterial />
      </SpeedRamp>
      {readout ? (
        <div
          style={{
            position: "absolute",
            right: 80 * u,
            top: height > width ? height * 0.2 : height * 0.12,
            fontFamily: primaryFont,
            fontWeight: 700,
            fontSize: 44 * u,
            color: speed > 1 ? ACCENT : INK,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          ×{speed.toFixed(2)}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
