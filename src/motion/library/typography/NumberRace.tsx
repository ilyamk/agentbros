import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { z } from "zod";
import { pillGrow, ROLLUP_CURVES, rollupValue } from "../../text-modes";
import type { Cue } from "../types";
import { FACE_NAMES, faceRun, faceStyle } from "./faces";
import { useTextWidths } from "./fit";
import { Stage, resolveInk, useSafeArea } from "./Stage";

export const numberRaceSchema = z.object({
  from: z.number(),
  to: z.number(),
  prefix: z.string(),
  suffix: z.string(),
  /** "compact" writes 2K, 1.4M; "grouped" writes 100,000. */
  notation: z.enum(["compact", "grouped"]),
  face: z.enum(FACE_NAMES),
  ink: z.string(),
  /** Colour of lit gauge ticks. */
  accent: z.string(),
  ground: z.string(),
  /** Draw a tick arc around the number that lights with the value. */
  gauge: z.boolean(),
  at: z.number().int().nonnegative(),
  /** Frames of the race; most of the travel happens in the first quarter, then it creeps and stops dead. */
  frames: z.number().int().positive(),
  /** Number width as a share of the safe width. */
  width: z.number().min(0.2).max(1),
  grain: z.number().min(0).max(0.2),
  /**
   * Curve of the value: "front" (default, most of it in the first few frames), "power3.out" (polymarket's gauge: 61% by
   * the 5th of 20 frames), "power1.out" (its threshold) or "linear" (a running count). The value is whole units of
   * `decimals` every frame.
   */
  curve: z.enum(ROLLUP_CURVES).optional(),
  decimals: z.number().int().min(0).max(3).optional(),
  /** BCP 47 locale for grouped digits ("en-GB" default, "de-DE", "ru-RU"). */
  locale: z.string().optional(),
  /** "tabular" (default) keeps every digit the same width; "proportional" lets the figure's width change with its digits, as in the reference. */
  digits: z.enum(["tabular", "proportional"]).optional(),
  /** "pill": the figure sits in a pill that grows from a dot at `at` and stretches while it counts (gojiberry's match badge); `gauge` is ignored. */
  container: z.enum(["none", "pill"]).optional(),
  pillColour: z.string().optional(),
  pillInk: z.string().optional(),
});

export type NumberRaceProps = z.infer<typeof numberRaceSchema>;

/** The figure as shown: compact (2K, 1.4M) or grouped in a locale, at `decimals` places when given. */
export const formatRace = (
  value: number,
  notation: NumberRaceProps["notation"],
  locale = "en-GB",
  decimals?: number,
): string => {
  if (notation === "grouped")
    return value.toLocaleString(locale, { minimumFractionDigits: decimals ?? 0, maximumFractionDigits: decimals ?? 0 });
  const abs = Math.abs(value);
  const [unit, div] = abs >= 1e9 ? ["B", 1e9] : abs >= 1e6 ? ["M", 1e6] : abs >= 1e3 ? ["K", 1e3] : ["", 1];
  const scaled = value / (div as number);
  return `${Math.abs(scaled) >= 100 || unit === "" ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}${unit}`;
};

/**
 * A figure races from one value to another: most of the way in a few frames, then a creep and a dead stop that reads as
 * arrival, with an optional arc of ticks lighting with the value. For the money or count a claim is about.
 */
export const NumberRace: React.FC<NumberRaceProps> = (props) => {
  const { from, to, prefix, suffix, notation, face, ink, accent, ground, at, frames, width, grain } = props;
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const set = faceStyle(face);
  const format = (value: number) => formatRace(value, notation, props.locale, props.decimals);
  const pill = props.container === "pill";
  const gauge = props.gauge && !pill;
  const ends = [`${prefix}${format(to)}${suffix}`, `${prefix}${format(from)}${suffix}`];
  const measured = useTextWidths(
    ends.map((text) => faceRun(face, text)),
    100,
  );
  if (measured === null)
    return (
      <Stage background={ground} grain={grain}>
        {null}
      </Stage>
    );

  const curve = props.curve ?? "front";
  const value = rollupValue(frame, {
    from,
    to,
    at,
    frames,
    curve,
    decimals: props.decimals ?? (notation === "grouped" ? 0 : undefined) ?? 6,
  });
  const t = to === from ? 1 : (value - from) / (to - from);
  const shown = `${prefix}${format(value)}${suffix}`;
  const numeric = props.digits === "proportional" ? "proportional-nums" : "tabular-nums";
  if (pill)
    return (
      <RacePill
        {...props}
        shown={set.textTransform === "uppercase" ? shown.toUpperCase() : shown}
        widest={Math.max(...measured)}
        numeric={numeric}
      />
    );
  const size = Math.min(safe.height * (gauge ? 0.3 : 0.6), (safe.width * width * 100) / Math.max(...measured, 1));
  const inkColour = resolveInk(ink, ground);
  const radius = Math.min(safe.width * 0.5, (safe.vertical ? safe.width : safe.height) * 0.62);
  const TICKS = 72;
  const SWEEP = 200;

  return (
    <Stage background={ground} grain={grain}>
      {gauge ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <svg
            width={radius * 2.2}
            height={radius * 2.2}
            viewBox={`${-radius * 1.1} ${-radius * 1.1} ${radius * 2.2} ${radius * 2.2}`}
            style={{ overflow: "visible" }}
          >
            {Array.from({ length: TICKS }, (_, index) => {
              const share = index / (TICKS - 1);
              const angle = ((-90 - SWEEP / 2 + share * SWEEP) * Math.PI) / 180;
              const lit = share <= t + 1e-6 && frame >= at;
              const inner = radius * 0.82;
              return (
                <line
                  key={index}
                  x1={Math.cos(angle) * inner}
                  y1={Math.sin(angle) * inner}
                  x2={Math.cos(angle) * radius}
                  y2={Math.sin(angle) * radius}
                  stroke={lit ? accent : inkColour}
                  strokeOpacity={lit ? 1 : 0.12}
                  strokeWidth={Math.max(2, radius * 0.012)}
                  strokeLinecap="round"
                />
              );
            })}
          </svg>
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            ...set,
            textTransform: undefined,
            fontSize: size,
            lineHeight: 1,
            color: inkColour,
            whiteSpace: "pre",
            fontVariantNumeric: numeric,
            transform: gauge ? `translateY(${radius * 0.08}px)` : undefined,
          }}
        >
          {set.textTransform === "uppercase" ? shown.toUpperCase() : shown}
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

/** The figure in a pill that grows from a dot (4 frames) and stretches (4) while it counts: about 8 frames to the target at 30 fps. */
const RacePill: React.FC<NumberRaceProps & { shown: string; widest: number; numeric: string }> = (p) => {
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const set = faceStyle(p.face);
  if (frame < p.at)
    return (
      <Stage background={p.ground} grain={p.grain}>
        {null}
      </Stage>
    );
  const grow = pillGrow(frame, p.at, 4, Math.max(1, p.frames - 4));
  const size = Math.min(safe.height * 0.12, (safe.width * p.width * 100) / Math.max(p.widest, 1));
  const height = size * 1.5;
  const full = (p.widest * size) / 100 + height * 0.9;
  const w = height + (full - height) * grow.stretch;
  const colour = p.pillColour ?? p.accent;
  return (
    <Stage background={p.ground} grain={p.grain}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            width: w,
            height,
            borderRadius: height / 2,
            backgroundColor: colour,
            transform: `scale(${grow.dot})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              ...set,
              textTransform: undefined,
              fontSize: size,
              lineHeight: 1,
              color: resolveInk(p.pillInk ?? "auto", colour),
              whiteSpace: "pre",
              fontVariantNumeric: p.numeric,
              opacity: Math.min(1, grow.stretch * 1.5),
            }}
          >
            {p.shown}
          </div>
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

export const numberRaceDefaults: NumberRaceProps = {
  from: 2000,
  to: 100000,
  prefix: "$",
  suffix: "",
  notation: "compact",
  face: "grotesk",
  ink: "#111111",
  accent: "#3356F8",
  ground: "#F3F3F1",
  gauge: true,
  at: 6,
  frames: 30,
  width: 0.34,
  grain: 0.03,
};

/** polymarket's gauge: proportional digits on power3.out, 20 frames. */
export const numberRaceGaugePreset: NumberRaceProps = {
  ...numberRaceDefaults,
  frames: 20,
  curve: "power3.out",
  digits: "proportional",
};

/** A running count: linear, grouped, proportional digits (polymarket's prize tick). */
export const numberRaceRunningPreset: NumberRaceProps = {
  ...numberRaceDefaults,
  from: 12400,
  to: 44260,
  notation: "grouped",
  gauge: false,
  frames: 30,
  curve: "linear",
  digits: "proportional",
  width: 0.5,
};

/** gojiberry's match badge: a green pill grows from a dot and counts to 100% in about 8 frames. */
export const numberRaceBadgePreset: NumberRaceProps = {
  ...numberRaceDefaults,
  from: 0,
  to: 100,
  prefix: "",
  suffix: "% match",
  notation: "grouped",
  ground: "#FFFFFF",
  gauge: false,
  at: 10,
  frames: 8,
  curve: "power3.out",
  container: "pill",
  pillColour: "#27C46B",
  pillInk: "#FFFFFF",
  width: 0.3,
  digits: "proportional",
};

export const numberRaceCues = (props: NumberRaceProps): Cue[] => [
  { frame: props.at, kind: "peak", sfx: "riser", weight: "support", label: "race starts" },
  { frame: props.at + props.frames, kind: "stop", sfx: "impact", weight: "hero", label: "value lands" },
];
