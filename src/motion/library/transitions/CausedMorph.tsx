import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill, Easing, interpolateColors, useVideoConfig } from "remotion";
import { z } from "zod";
import { displayFont, primaryFont } from "../../../lib/fonts";
import { easeFamily } from "../../ease-family";
import { DEMO, DemoSceneA, DemoSceneB, TransitionDemo } from "./demo";

export type Rect = { x: number; y: number; width: number; height: number };

type CausedMorphOptions = {
  /**
   * "rect": one element (a card, key, button) grows into the frame. "bars": chart bars level, widen and become the ground.
   * "orb": a small disc grows past the frame's corners and its fill becomes the ground. "pill": a button grows until its
   * top edge, with its sheen, is the new frame's top edge.
   */
  mode: "rect" | "bars" | "orb" | "pill" | "window";
  /** The element in frame pixels (rect mode). */
  source?: Rect;
  /** The bars in frame pixels, left to right (bars mode). */
  bars?: Rect[];
  /** The element's own colour at the start. */
  fill: string;
  /** The next scene's ground; the element ends as it. */
  colour: string;
  /** Corner radius of the element, in pixels. */
  radius: number;
  /** Share of the seam where the morph is cut to the next scene, before the element fills the frame. */
  peakAt: number;
  /** orb and pill only: the growth curve, slow start then fast (circ.in for a small orb, sine.in for a big button). */
  curve: GrowCurve;
  /** orb and pill only: strength of the top sheen (0 to 1) that the element carries into the new ground's top edge. */
  sheen: number;
  /** pill only: the button's label, carried on the growing pill at its own size and faded out in the second half. */
  label?: string;
  labelColour?: string;
  labelFont?: string;
  /**
   * orb and pill: where the sheen comes from. "top" (default): a band along the top that becomes the new frame's top
   * edge. "edges": a light band sweeps inward from both side edges as the element grows (polymarket's button).
   */
  sheenFrom: "top" | "edges";
  /** window only: the disc's diameter at rest, as a share of the frame's short side, and its centre as shares of the frame. */
  windowSize: number;
  windowX: number;
  windowY: number;
  /** window only: the colour the button drains to (muse: white), seen as a lit disc on the ground. */
  windowFill: string;
};

export type GrowCurve = "circ.in" | "sine.in" | "expo.in" | "power2.in";

export type WindowPhase = "drain" | "drift" | "rise" | "done";

export type WindowState = {
  phase: WindowPhase;
  /** Share of the disc, from the top, already drained to the ground colour. */
  drained: number;
  /** The disc's centre and diameter in pixels. */
  cx: number;
  cy: number;
  d: number;
  /** How far the picture still sits below its place inside the disc, as a share of the diameter (1 hidden, 0 in place). */
  below: number;
};

/**
 * window mode, at progress t (0..1 of the seam), split in thirds as measured on muse (5 frames each): the button's fill
 * drains top-down to the ground colour; the disc drifts and grows to its window place; the picture rises into it from
 * below. Each third runs on power2.inOut. Pure.
 */
export const windowState = (t: number, source: Rect, to: { x: number; y: number; d: number }): WindowState => {
  const x = Math.min(Math.max(t, 0), 1);
  const ease = easeFamily["power2.inOut"];
  const drained = ease(Math.min(x * 3, 1));
  const drift = ease(Math.min(Math.max(x * 3 - 1, 0), 1));
  const rise = ease(Math.min(Math.max(x * 3 - 2, 0), 1));
  const d0 = Math.min(source.width, source.height);
  const phase: WindowPhase = x >= 1 ? "done" : x < 1 / 3 ? "drain" : x < 2 / 3 ? "drift" : "rise";
  return {
    phase,
    drained,
    cx: lerp(source.x + source.width / 2, to.x, drift),
    cy: lerp(source.y + source.height / 2, to.y, drift),
    d: lerp(d0, to.d, drift),
    below: 1 - rise,
  };
};

/** edges sheen: the inward reach of each side's light band, as a share of the element's half width, at growth t. Pure. */
export const edgeSheenReach = (t: number): number => Math.min(Math.max(t, 0), 1) ** 1.5;

export type GrowShape = { cx: number; cy: number; width: number; height: number; radius: number };

/**
 * Geometry of an orb or pill growing into the ground at progress t (0..1 of the morph, up to the cut). The orb's
 * diameter grows geometrically from its own size to twice the frame's half-diagonal, so it covers every corner at t = 1,
 * while its centre drifts to the frame centre. The pill widens geometrically past the frame's width while its top edge
 * rises to the frame's top (y = 0) at t = 1 and its bottom leaves below: its top rim becomes the new top edge. Pure.
 */
export const growShape = (
  mode: "orb" | "pill",
  source: Rect,
  t: number,
  curve: GrowCurve,
  width: number,
  height: number,
): GrowShape => {
  const g = easeFamily[curve](Math.min(Math.max(t, 0), 1));
  const sx = source.x + source.width / 2;
  const sy = source.y + source.height / 2;
  const cx = lerp(sx, width / 2, g);
  if (mode === "orb") {
    const d0 = Math.min(source.width, source.height);
    const d1 = 2 * Math.hypot(width / 2, height / 2) * 1.02;
    const d = d0 * (d1 / d0) ** g;
    return { cx, cy: lerp(sy, height / 2, g), width: d, height: d, radius: d / 2 };
  }
  // Both sides grow geometrically, so the pill keeps its shape early and only stretches as it fills; the centre ends at
  // 0.65 of the height, which puts the top edge on y = 0 when the height is 1.3 frames.
  const w = source.width * ((width * 1.08) / source.width) ** g;
  const h = source.height * ((height * 1.3) / source.height) ** g;
  const cy = lerp(sy, height * 0.65, g);
  return { cx, cy, width: w, height: h, radius: (Math.min(w, h) / 2) * (1 - g) };
};

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);
const GROW = Easing.bezier(0.7, 0, 0.84, 0);
const LEVEL = Easing.bezier(0.33, 1, 0.68, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Share of the seam the morph uses by default; it is cut while a margin of the outgoing scene still shows. */
export const CAUSED_MORPH_PEAK = 0.82;

const CausedMorphPresentation: React.FC<TransitionPresentationComponentProps<CausedMorphOptions>> = ({
  children,
  presentationProgress: p,
  presentationDirection,
  passedProps,
}) => {
  const { width, height } = useVideoConfig();
  const {
    mode,
    source,
    bars,
    fill,
    colour,
    radius,
    peakAt,
    curve,
    sheen,
    sheenFrom,
    windowSize,
    windowX,
    windowY,
    windowFill,
  } = passedProps;
  if (mode === "window") {
    // The whole seam is used: drain, drift, rise.
    const from = source ?? { x: width * 0.45, y: height * 0.5 - width * 0.05, width: width * 0.1, height: width * 0.1 };
    const state = windowState(p, from, {
      x: windowX * width,
      y: windowY * height,
      d: windowSize * Math.min(width, height),
    });
    if (presentationDirection === "exiting")
      return state.phase === "drain" || state.phase === "drift" ? <AbsoluteFill>{children}</AbsoluteFill> : null;
    if (state.phase === "done") return <AbsoluteFill>{children}</AbsoluteFill>;
    // The old scene around the button fades to the ground while it drains (muse: the mic fades), so the drift shows only the disc.
    const groundIn = state.drained;
    const r = state.d / 2;
    const drainedAt = state.drained * 100;
    return (
      <AbsoluteFill>
        <AbsoluteFill style={{ backgroundColor: colour, opacity: groundIn }} />
        <div
          style={{
            position: "absolute",
            left: state.cx - r,
            top: state.cy - r,
            width: state.d,
            height: state.d,
            borderRadius: "50%",
            background: `linear-gradient(180deg, ${windowFill} 0%, ${windowFill} ${drainedAt}%, ${fill} ${drainedAt}%, ${fill} 100%)`,
            boxShadow: `0 0 0 1px rgba(18,18,18,${0.06 * state.drained}), 0 ${r * 0.08}px ${r * 0.3}px rgba(18,18,18,${0.12 * state.drained})`,
          }}
        />
        {state.phase === "rise" ? (
          <AbsoluteFill style={{ clipPath: `circle(${r}px at ${state.cx}px ${state.cy}px)` }}>
            {/* Only the next scene's own disc rises (clipped in its own space, so the clip travels with it), into the drained disc. */}
            <AbsoluteFill
              style={{
                transform: `translateY(${state.below * state.d}px)`,
                clipPath: `circle(${r}px at ${state.cx}px ${state.cy}px)`,
              }}
            >
              {children}
            </AbsoluteFill>
          </AbsoluteFill>
        ) : null}
      </AbsoluteFill>
    );
  }
  if (presentationDirection === "exiting") return p < peakAt ? <AbsoluteFill>{children}</AbsoluteFill> : null;
  if (p >= peakAt) return <AbsoluteFill>{children}</AbsoluteFill>;
  const t = p / peakAt;
  const tint = interpolateColors(clamp01(t / 0.4), [0, 1], [fill, colour]);
  if (mode === "bars" && bars && bars.length > 0) {
    // Phase one: every bar rises to the tallest one's top. Phase two: the bars widen into a band that climbs to the cut.
    const level = Math.min(...bars.map((bar) => bar.y));
    const bottom = Math.max(...bars.map((bar) => bar.y + bar.height));
    const a = LEVEL(clamp01(t / 0.3));
    const b = GROW(clamp01((t - 0.3) / 0.7));
    const share = width / bars.length;
    return (
      <AbsoluteFill>
        {bars.map((bar, i) => {
          const top = lerp(lerp(bar.y, level, a), height * 0.04, b);
          const x = lerp(bar.x, i * share, b);
          const w = lerp(bar.width, share + 1, b);
          const end = lerp(bottom, height, b);
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: x,
                top,
                width: w,
                height: end - top,
                backgroundColor: tint,
                borderRadius: radius * (1 - b),
              }}
            />
          );
        })}
      </AbsoluteFill>
    );
  }
  if (mode === "orb" || mode === "pill") {
    const from = source ?? {
      x: width * 0.44,
      y: height / 2 - width * 0.06,
      width: width * 0.12,
      height: mode === "orb" ? width * 0.12 : width * 0.03,
    };
    const shape = growShape(mode, from, t, curve, width, height);
    const shade = interpolateColors(clamp01(t / 0.5), [0, 1], [fill, colour]);
    const band =
      mode === "orb" ? shape.height * 0.34 : Math.min(Math.max(shape.height * 0.14, from.height * 0.45), height * 0.12);
    return (
      <AbsoluteFill>
        <div
          style={{
            position: "absolute",
            left: shape.cx - shape.width / 2,
            top: shape.cy - shape.height / 2,
            width: shape.width,
            height: shape.height,
            borderRadius: shape.radius,
            backgroundColor: shade,
            overflow: "hidden",
          }}
        >
          {sheen > 0 && sheenFrom === "edges" ? (
            // A light band from each side edge reaches further in as the element grows (polymarket's button lightening).
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: `linear-gradient(90deg, rgba(255,255,255,${0.45 * sheen}) 0%, rgba(255,255,255,0) ${edgeSheenReach(t) * 50}%, rgba(255,255,255,0) ${100 - edgeSheenReach(t) * 50}%, rgba(255,255,255,${0.45 * sheen}) 100%)`,
              }}
            />
          ) : sheen > 0 ? (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                height: band,
                background: `linear-gradient(180deg, rgba(255,255,255,${0.32 * sheen}) 0%, rgba(255,255,255,0) 100%)`,
              }}
            />
          ) : null}
          {mode === "pill" && passedProps.label ? (
            // With the edge sheen the label shrinks as the button grows (polymarket); otherwise it rides at its own size.
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: passedProps.labelFont ?? primaryFont,
                fontWeight: 600,
                fontSize: from.height * 0.36 * (sheenFrom === "edges" ? 1 - 0.5 * clamp01(t) : 1),
                color: passedProps.labelColour ?? "#FFFFFF",
                opacity: 1 - clamp01((t - 0.55) / 0.3),
                whiteSpace: "nowrap",
              }}
            >
              {passedProps.label}
            </div>
          ) : null}
        </div>
      </AbsoluteFill>
    );
  }
  const rect = source ?? { x: width * 0.4, y: height * 0.4, width: width * 0.2, height: height * 0.2 };
  const g = GROW(t);
  // Size grows exponentially so the edges keep an even apparent speed; the cut comes at 94% of the frame.
  const w = rect.width * ((width * 0.94) / rect.width) ** g;
  const h = rect.height * ((height * 0.94) / rect.height) ** g;
  const cx = lerp(rect.x + rect.width / 2, width / 2, g);
  const cy = lerp(rect.y + rect.height / 2, height / 2, g);
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: cx - w / 2,
          top: cy - h / 2,
          width: w,
          height: h,
          backgroundColor: tint,
          borderRadius: radius * (1 - 0.7 * g),
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * An element of the outgoing scene becomes the next scene's ground: a card or key grows into the frame, or chart bars
 * level and widen into a flood, and the cut lands before it fills, on the new ground. Pair with `cutTiming(16..24)`.
 */
export const causedMorph = ({
  mode = "rect",
  source,
  bars,
  fill,
  colour,
  radius = 24,
  peakAt = CAUSED_MORPH_PEAK,
  curve = "circ.in",
  sheen = 0,
  label,
  labelColour,
  labelFont,
  sheenFrom = "top",
  windowSize = 0.34,
  windowX = 0.5,
  windowY = 0.42,
  windowFill = "#FFFFFF",
}: Partial<CausedMorphOptions> &
  Pick<CausedMorphOptions, "fill" | "colour">): TransitionPresentation<CausedMorphOptions> => ({
  component: CausedMorphPresentation,
  props: {
    mode,
    source,
    bars,
    fill,
    colour,
    radius,
    peakAt,
    curve,
    sheen,
    label,
    labelColour,
    labelFont,
    sheenFrom,
    windowSize,
    windowX,
    windowY,
    windowFill,
  },
});

/**
 * The new ground's top edge as an orb or pill with `sheen` left it: a soft light band. Lay it over the top of the next
 * scene so the element's top highlight carries across the cut as the frame's top edge.
 */
export const GroundRim: React.FC<{ sheen?: number; share?: number }> = ({ sheen = 1, share = 0.1 }) => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        height: `${share * 100}%`,
        background: `linear-gradient(180deg, rgba(255,255,255,${0.32 * sheen}) 0%, rgba(255,255,255,0) 100%)`,
      }}
    />
  </AbsoluteFill>
);

export const causedMorphSchema = z.object({
  /** Frames from the block's start to the perceived cut, for `cues` in a film (sfx:cues places the cut there); the preview keeps its centred seam. */
  seamFrame: z.number().int().min(0).optional(),
  mode: z.enum(["rect", "bars", "orb", "pill", "window"]),
  colour: z.string(),
  peakAt: z.number().min(0.5).max(0.95),
  transitionFrames: z.number().int().min(6).max(36),
  /** orb and pill: growth curve (default circ.in) and top sheen carried into the new ground (default 0.8 in the preview). */
  curve: z.enum(["circ.in", "sine.in", "expo.in", "power2.in"]).optional(),
  sheen: z.number().min(0).max(1).optional(),
  /** orb and pill: "top" (default) or "edges" (polymarket's band from each side). */
  sheenFrom: z.enum(["top", "edges"]).optional(),
});

export type CausedMorphPreviewProps = z.infer<typeof causedMorphSchema>;

export const CAUSED_MORPH_FRAMES = 90;

/** Preview on DemoSceneA: its card (rect) or its chart bars (bars) become the ground of scene B. */
/** Rect of the preview's call-to-action: a pill (48% of the width, as measured) or an orb (10%), on the frame's vertical centre. */
const ctaRect = (mode: "orb" | "pill", width: number, height: number): Rect => {
  const vertical = height > width;
  if (mode === "orb") {
    const d = width * (vertical ? 0.16 : 0.1);
    return { x: width * 0.5 - d / 2, y: height * 0.56 - d / 2, width: d, height: d };
  }
  const w = width * (vertical ? 0.62 : 0.4);
  const h = w * 0.22;
  return { x: width / 2 - w / 2, y: height * 0.58 - h / 2, width: w, height: h };
};

/** The outgoing shot of the orb and pill previews: a short line over the element that is about to become the ground. */
const CtaScene: React.FC<{ mode: "orb" | "pill"; colour: string; label: string }> = ({ mode, colour, label }) => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const rect = ctaRect(mode, width, height);
  return (
    <AbsoluteFill style={{ backgroundColor: DEMO.paper }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: rect.y - 190 * u,
          textAlign: "center",
          fontFamily: displayFont,
          fontWeight: 700,
          fontSize: 92 * u,
          letterSpacing: -3 * u,
          color: DEMO.ink,
        }}
      >
        Starts tonight.
      </div>
      <div
        style={{
          position: "absolute",
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          borderRadius: rect.height / 2,
          backgroundColor: colour,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: rect.height * 0.45,
            background: "linear-gradient(180deg, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0) 100%)",
          }}
        />
        {mode === "pill" ? (
          <span style={{ fontFamily: primaryFont, fontWeight: 600, fontSize: rect.height * 0.36, color: DEMO.chalk }}>
            {label}
          </span>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

/** The window preview's next scene: a portrait in a disc on the paper ground, at the place the button's disc settles. */
const PortraitScene: React.FC<{ size: number; x: number; y: number }> = ({ size, x, y }) => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const d = size * Math.min(width, height);
  return (
    <AbsoluteFill style={{ backgroundColor: DEMO.paper }}>
      <div
        style={{
          position: "absolute",
          left: x * width - d / 2,
          top: y * height - d / 2,
          width: d,
          height: d,
          borderRadius: "50%",
          overflow: "hidden",
          background: "linear-gradient(180deg, #CFE3FF 0%, #9EC2F5 100%)",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: d * 0.32,
            top: d * 0.22,
            width: d * 0.36,
            height: d * 0.36,
            borderRadius: "50%",
            background: "#F2C9A8",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: d * 0.16,
            top: d * 0.62,
            width: d * 0.68,
            height: d * 0.6,
            borderRadius: "50%",
            background: DEMO.indigo,
          }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: y * height + d / 2 + 40 * u,
          textAlign: "center",
          fontFamily: displayFont,
          fontWeight: 700,
          fontSize: 76 * u,
          letterSpacing: -2 * u,
          color: DEMO.ink,
        }}
      >
        Meet Ava.
      </div>
    </AbsoluteFill>
  );
};

/** polymarket's button swallow: the pill grows on power2.in for about 17 frames, lit by a band from each side, cut before it fills. */
export const edgeSheenPreset = {
  mode: "pill" as const,
  colour: "#2F4BFF",
  peakAt: 0.9,
  transitionFrames: 17,
  curve: "power2.in" as const,
  sheen: 1,
  sheenFrom: "edges" as const,
};

/** Defaults of the window preview, as muse measured them: three 5-frame thirds, a 0.34-wide portrait. */
export const windowPreset = { mode: "window" as const, colour: "#F3F2EE", peakAt: 0.67, transitionFrames: 15 };

export const CausedMorphPreview: React.FC<CausedMorphPreviewProps> = ({
  mode,
  colour,
  peakAt,
  transitionFrames,
  curve,
  sheen,
  sheenFrom,
}) => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const vertical = height > width;
  if (mode === "window") {
    const button = ctaRect("orb", width, height);
    return (
      <TransitionDemo
        presentation={causedMorph({
          mode,
          source: button,
          fill: DEMO.indigo,
          colour,
          windowSize: 0.34,
          windowX: 0.5,
          windowY: 0.42,
        })}
        transitionFrames={transitionFrames}
        totalFrames={CAUSED_MORPH_FRAMES}
        before={<CtaScene mode="orb" colour={DEMO.indigo} label="" />}
        after={<PortraitScene size={0.34} x={0.5} y={0.42} />}
      />
    );
  }
  if (mode === "orb" || mode === "pill") {
    const s = sheen ?? 0.8;
    return (
      <TransitionDemo
        presentation={causedMorph({
          mode,
          source: ctaRect(mode, width, height),
          fill: colour,
          colour,
          peakAt,
          curve: curve ?? (mode === "orb" ? "circ.in" : "sine.in"),
          sheen: s,
          sheenFrom: sheenFrom ?? "top",
          label: mode === "pill" ? "Start free" : undefined,
          labelColour: DEMO.chalk,
        })}
        transitionFrames={transitionFrames}
        totalFrames={CAUSED_MORPH_FRAMES}
        before={<CtaScene mode={mode} colour={colour} label="Start free" />}
        after={
          <AbsoluteFill>
            <DemoSceneB ground={colour} ink={DEMO.chalk} title="Ready" />
            {/* At the cut the orb's sheen band ends about 0.17 of the height into the frame, at a quarter of its top strength. */}
            {sheenFrom === "edges" ? null : (
              <GroundRim sheen={mode === "orb" ? s * 0.25 : s} share={mode === "orb" ? 0.17 : 0.12} />
            )}
          </AbsoluteFill>
        }
      />
    );
  }
  const cardW = (vertical ? 820 : 760) * u;
  const cardH = cardW * 0.62;
  const cardLeft = vertical ? (width - cardW) / 2 : width * 0.52;
  const cardTop = vertical ? height * 0.5 : (height - cardH) / 2;
  const values = [0.34, 0.52, 0.41, 0.66, 0.58, 0.81, 0.74, 0.96];
  const gap = 18 * u;
  const barW = (cardW - 88 * u - 7 * gap) / 8;
  const area = cardH * 0.58;
  const bars = values.map((v, i) => ({
    x: cardLeft + 44 * u + i * (barW + gap),
    y: cardTop + cardH - 44 * u - area * v,
    width: barW,
    height: area * v,
  }));
  const presentation =
    mode === "bars"
      ? causedMorph({ mode, bars, fill: "rgba(18,18,18,0.12)", colour, radius: 6 * u, peakAt })
      : causedMorph({
          mode,
          source: { x: cardLeft, y: cardTop, width: cardW, height: cardH },
          fill: "#FFFFFF",
          colour,
          radius: 28 * u,
          peakAt,
        });
  return (
    <TransitionDemo
      presentation={presentation}
      transitionFrames={transitionFrames}
      totalFrames={CAUSED_MORPH_FRAMES}
      before={<DemoSceneA />}
      after={<DemoSceneB ground={colour} ink={colour === DEMO.paper ? DEMO.ink : DEMO.chalk} title="2 weeks" />}
    />
  );
};
