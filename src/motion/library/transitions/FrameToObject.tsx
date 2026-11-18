import React from "react";
import { AbsoluteFill, interpolateColors, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { displayFont, primaryFont } from "../../../lib/fonts";
import { easeFamily, familyProgress } from "../../ease-family";
import { useFittedFontSize } from "../../text";
import type { Cue } from "../types";
import { DEMO, DemoSceneB } from "./demo";

export type ShrinkEase = "power2.inOut" | "power3.out" | "expo.out";

export type ShrinkTiming = {
  /** Frame the whole frame starts to shrink (its border appears). */
  at: number;
  /** Frames of the shrink: about 19 on power2.inOut; about 32 on power3.out, which does 90% of it in 14. */
  frames: number;
  /** Scale the frame lands at: 0.4 for a slab or card, 0.47 for a monitor screen. */
  toScale: number;
  ease: ShrinkEase;
  /** Where the object's centre lands, as shares of the frame. */
  toX: number;
  toY: number;
};

export type ShrinkRect = { x: number; y: number; width: number; height: number; scale: number; progress: number };

/**
 * The rectangle the outgoing frame occupies at a frame: the whole frame before `at`, then shrinking, at the frame's own
 * aspect ratio, towards `toScale` around (toX, toY) on the named ease. Pure.
 */
export const shrinkRect = (frame: number, timing: ShrinkTiming, width: number, height: number): ShrinkRect => {
  const p = familyProgress(frame, timing.at, timing.frames, timing.ease);
  const scale = 1 + (timing.toScale - 1) * p;
  const cx = width * (0.5 + (timing.toX - 0.5) * p);
  const cy = height * (0.5 + (timing.toY - 0.5) * p);
  return {
    x: cx - (width * scale) / 2,
    y: cy - (height * scale) / 2,
    width: width * scale,
    height: height * scale,
    scale,
    progress: p,
  };
};

export type MatteTarget = { x: number; y: number; width: number; height: number };

export type MatteRect = { x: number; y: number; width: number; height: number; radius: number; progress: number };

/**
 * matte mode: the rect of a rounded matte that starts at `from` (shares of the frame, centred: motionfly's 0.92 x 0.85)
 * and shrinks on the named ease into `target` (shares of the frame, top-left based), landing exactly on it at
 * `at + frames`. Its corner radius goes from 3% of the short side to half the target's height, so a thin target ends as
 * a pill-ended bar. Pure.
 */
export const matteRect = (
  frame: number,
  timing: Pick<ShrinkTiming, "at" | "frames" | "ease">,
  from: { width: number; height: number },
  target: MatteTarget,
  width: number,
  height: number,
): MatteRect => {
  const p = familyProgress(frame, timing.at, timing.frames, timing.ease);
  const w0 = from.width * width;
  const h0 = from.height * height;
  const x0 = (width - w0) / 2;
  const y0 = (height - h0) / 2;
  const x = lerp(x0, target.x * width, p);
  const y = lerp(y0, target.y * height, p);
  const w = lerp(w0, target.width * width, p);
  const h = lerp(h0, target.height * height, p);
  const radius = lerp(0.03 * Math.min(width, height), (target.height * height) / 2, p);
  return { x, y, width: w, height: h, radius: Math.min(radius, h / 2, w / 2), progress: p };
};

type MatteCollapseProps = Pick<ShrinkTiming, "at" | "frames" | "ease"> & {
  /** Size of the matte on the cut frame, as shares of the frame. */
  from: { width: number; height: number };
  /** The element the matte becomes (an underline, a chip), as shares of the frame. */
  target: MatteTarget;
  /** The matte's colour on the cut. */
  fill: string;
  /** The element's colour; the matte turns to it over the last tenth of the shrink, once it is a bar. */
  landColour: string;
  /** Soft edge on the cut frame, in pixels; it sharpens as the matte lands. */
  soft: number;
  /** The incoming plate under the matte. */
  children: React.ReactNode;
  /** Laid over the plate around the landed element (a dock, a menu), faded in from the landing. */
  around?: React.ReactNode;
};

/**
 * A soft-edged rounded matte, near full frame on the cut, collapses into one element of the incoming shot on the named
 * ease and hands over to it on its last frame: what covered the picture becomes its underline or selection.
 */
export const MatteCollapse: React.FC<MatteCollapseProps> = ({
  at,
  frames,
  ease,
  from,
  target,
  fill,
  landColour,
  soft,
  children,
  around,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const rect = matteRect(frame, { at, frames, ease }, from, target, width, height);
  const colour = interpolateColors(Math.min(Math.max((rect.progress - 0.9) / 0.1, 0), 1), [0, 1], [fill, landColour]);
  const blur = soft * (1 - rect.progress);
  const aroundIn = familyProgress(frame, at + Math.round(frames * 0.8), 8, "power3.out");
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill>{children}</AbsoluteFill>
      {around ? <AbsoluteFill style={{ opacity: aroundIn }}>{around}</AbsoluteFill> : null}
      <div
        style={{
          position: "absolute",
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          borderRadius: rect.radius,
          backgroundColor: colour,
          filter: blur > 0.3 ? `blur(${blur}px)` : undefined,
        }}
      />
    </AbsoluteFill>
  );
};

export type ObjectContinuation = "hold" | "button" | "button-flip";

export type ObjectPhases = {
  /** The slab narrows to button proportions. */
  buttonAt: number;
  buttonFrames: number;
  /** The label types, one glyph every two frames. */
  typeAt: number;
  /** The button turns edge-on, then opens the other way as the object. */
  flipAt: number;
  edgeOn: number;
  open: number;
};

/** Frames of each continuation step after the shrink lands. Pure. */
export const objectPhases = (timing: Pick<ShrinkTiming, "at" | "frames">, label: string): ObjectPhases => {
  const buttonAt = timing.at + timing.frames;
  const buttonFrames = 10;
  const typeAt = buttonAt + buttonFrames - 1;
  const flipAt = typeAt + label.length * 2 + 8;
  return { buttonAt, buttonFrames, typeAt, flipAt, edgeOn: flipAt + 4, open: flipAt + 4 + 8 };
};

/** Cut where the frame detaches (`seamFrame` in a film), land when the shrink settles, then the continuation's beats. */
export const frameToObjectCues = ({
  seamFrame,
  then,
  label,
  ...timing
}: Pick<ShrinkTiming, "at" | "frames"> & { seamFrame?: number; then: ObjectContinuation; label: string }): Cue[] => {
  const cut = seamFrame ?? timing.at;
  const shift = cut - timing.at;
  const phases = objectPhases(timing, label);
  const cues: Cue[] = [
    { frame: cut, kind: "cut", sfx: "whoosh", weight: "hero", label: "frame detaches and shrinks" },
    { frame: cut + timing.frames, kind: "land", weight: "support", label: "object settles" },
  ];
  if (then !== "hold")
    cues.push({ frame: phases.typeAt + shift, kind: "type", sfx: "tick", weight: "support", label: "label types" });
  if (then === "button-flip")
    cues.push({
      frame: phases.edgeOn + shift,
      kind: "reveal",
      sfx: "pop",
      weight: "support",
      label: "button opens as the object",
    });
  return cues;
};

type FrameToObjectProps = ShrinkTiming & {
  /** The new scene's ground. */
  ground: string;
  /** The object's own fill, seen as the shot fades inside it. */
  fill: string;
  /** Share of the outgoing shot still visible inside the object once it has landed; 0 leaves only the fill. */
  contentKeep: number;
  housing: "slab" | "monitor";
  then: ObjectContinuation;
  label: string;
  /** What the button opens into (button-flip). */
  object?: React.ReactNode;
  /** The outgoing full-frame shot. */
  children: React.ReactNode;
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The whole frame shrinks into an object inside a new scene: it gains a thin border and a diagonal sheen, keeps its
 * aspect ratio down to a slab (or a monitor's screen), and can go on to narrow into a button whose label types, turn
 * edge-on and open as the object. 2D transforms only (the edge-on turn is a scaleY), so seeks are exact.
 */
export const FrameToObject: React.FC<FrameToObjectProps> = ({
  ground,
  fill,
  contentKeep,
  housing,
  then,
  label,
  object,
  children,
  ...timing
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const rect = shrinkRect(frame, timing, width, height);
  // The label is fitted once, to the settled button: 70% of the landed slab, a pill 0.2 of its own width tall.
  const finalW = width * timing.toScale * 0.7;
  const finalH = finalW * 0.2;
  const fitted = useFittedFontSize({
    text: label || " ",
    withinWidth: finalW - finalH * 1.5,
    fontFamily: primaryFont,
    fontWeight: 600,
  });
  const labelShare = Math.min(0.36, (fitted ?? finalH * 0.36) / finalH);
  if (frame < timing.at) return <AbsoluteFill style={{ overflow: "hidden" }}>{children}</AbsoluteFill>;
  const phases = objectPhases(timing, label);
  const buttonP = then === "hold" ? 0 : familyProgress(frame, phases.buttonAt, phases.buttonFrames, "power2.inOut");
  // Button proportions: as wide as 70% of the slab, a pill 0.2 of its own width tall.
  const bw = lerp(rect.width, rect.width * 0.7, buttonP);
  const bh = lerp(rect.height, rect.width * 0.7 * 0.2, buttonP);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const radius = lerp(lerp(0, 26 * u, rect.progress), bh / 2, buttonP);
  const flipping = then === "button-flip" && frame >= phases.flipAt;
  const opened = flipping && frame >= phases.edgeOn;
  const squash = !flipping
    ? 1
    : !opened
      ? 1 - easeFamily["sine.in"](Math.min((frame - phases.flipAt) / (phases.edgeOn - phases.flipAt), 1))
      : easeFamily["expo.out"](Math.min((frame - phases.edgeOn) / (phases.open - phases.edgeOn), 1));
  const keep = lerp(1, contentKeep, rect.progress) * (1 - buttonP);
  const sheenAt = lerp(-0.4, 1.3, rect.progress);
  const typed = Math.max(0, Math.min(label.length, Math.floor((frame - phases.typeAt) / 2) + 1));
  const plusTurn = lerp(-180, 0, familyProgress(frame, phases.typeAt - 6, 8, "expo.out"));
  const monitor = housing === "monitor";
  const bezel = 14 * u * rect.progress;
  const objW = opened ? rect.width * 0.82 : bw;
  const objH = opened ? rect.width * 0.82 * 0.62 : bh;
  return (
    <AbsoluteFill style={{ backgroundColor: ground, overflow: "hidden" }}>
      {monitor ? (
        <>
          <div
            style={{
              position: "absolute",
              left: cx - rect.width * 0.08,
              top: rect.y + rect.height + bezel,
              width: rect.width * 0.16,
              height: rect.height * 0.22,
              background: "#2A2E2B",
              opacity: rect.progress,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: cx - rect.width * 0.22,
              top: rect.y + rect.height * 1.22 + bezel,
              width: rect.width * 0.44,
              height: 12 * u,
              borderRadius: 6 * u,
              background: "#2A2E2B",
              opacity: rect.progress,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: rect.x - bezel,
              top: rect.y - bezel,
              width: rect.width + bezel * 2,
              height: rect.height + bezel * 2,
              borderRadius: radius + bezel,
              background: "#141614",
            }}
          />
        </>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: cx - objW / 2,
          top: cy - (objH * squash) / 2,
          width: objW,
          height: objH,
          transform: `scaleY(${squash})`,
          transformOrigin: "50% 0",
          borderRadius: opened ? 28 * u : radius,
          overflow: "hidden",
          backgroundColor: fill,
          boxShadow: monitor
            ? undefined
            : `0 0 0 ${Math.max(1, 2 * u) * Math.min(1, rect.progress * 4)}px rgba(255,255,255,0.9), 0 ${24 * u * rect.progress}px ${60 * u}px rgba(18,18,18,${0.14 * rect.progress})`,
        }}
      >
        {opened ? (
          object
        ) : (
          <>
            <div
              style={{
                position: "absolute",
                left: (rect.width - bw) / -2,
                top: (rect.height - bh) / -2,
                width,
                height,
                transform: `scale(${rect.scale})`,
                transformOrigin: "0 0",
                opacity: keep,
              }}
            >
              {children}
            </div>
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: `linear-gradient(115deg, rgba(255,255,255,0) ${(sheenAt - 0.18) * 100}%, rgba(255,255,255,0.22) ${sheenAt * 100}%, rgba(255,255,255,0) ${(sheenAt + 0.18) * 100}%)`,
              }}
            />
            {then !== "hold" && buttonP > 0.6 ? (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  paddingLeft: bh * 0.42,
                  gap: bh * 0.3,
                  fontFamily: primaryFont,
                  fontWeight: 600,
                  fontSize: bh * labelShare,
                  color: DEMO.chalk,
                  whiteSpace: "pre",
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    fontWeight: 400,
                    fontSize: bh * 0.5,
                    transform: `rotate(${plusTurn}deg)`,
                    lineHeight: 1,
                  }}
                >
                  +
                </span>
                <span>{label.slice(0, typed)}</span>
              </div>
            ) : null}
          </>
        )}
      </div>
    </AbsoluteFill>
  );
};

export const frameToObjectSchema = z.object({
  /** Frames from the block's start to the perceived cut (the frame detaching), for `cues` in a film; the preview keeps `at`. */
  seamFrame: z.number().int().min(0).optional(),
  at: z.number().int().min(0),
  frames: z.number().int().min(6).max(48),
  toScale: z.number().min(0.2).max(0.8),
  ease: z.enum(["power2.inOut", "power3.out", "expo.out"]),
  toX: z.number().min(0.1).max(0.9),
  toY: z.number().min(0.1).max(0.9),
  ground: z.string(),
  fill: z.string(),
  contentKeep: z.number().min(0).max(1),
  housing: z.enum(["slab", "monitor"]),
  then: z.enum(["hold", "button", "button-flip"]),
  label: z.string(),
  /** "frame" (default): the whole frame shrinks into an object. "matte": a soft dark matte over the next plate collapses into one of its elements (`MatteCollapse`). */
  mode: z.enum(["frame", "matte"]).optional(),
  /** matte: the element the matte becomes, as shares of the frame (default: an underline under the dock's first icon). */
  target: z
    .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
    .optional(),
  /** matte: the element's colour. */
  landColour: z.string().optional(),
});

/** motionfly's matte collapse: a 92% x 85% black card on the plate shrinks into the dock's underline in 12 frames, power3.out. */
export const matteCollapsePreset = {
  mode: "matte" as const,
  at: 14,
  frames: 12,
  ease: "power3.out" as const,
  fill: "#0B0B0D",
  landColour: "#FFFFFF",
  target: { x: 0.415, y: 0.468, width: 0.04, height: 0.006 },
};

export const MATTE_FROM = { width: 0.92, height: 0.85 };

export type FrameToObjectPreviewProps = z.infer<typeof frameToObjectSchema>;

export const FRAME_TO_OBJECT_FRAMES = 110;

export const frameToObjectDefaults: FrameToObjectPreviewProps = {
  at: 22,
  frames: 19,
  toScale: 0.4,
  ease: "power2.inOut",
  toX: 0.5,
  toY: 0.5,
  ground: "#F7F3EF",
  fill: "#1F4D37",
  contentKeep: 0.2,
  housing: "slab",
  then: "button-flip",
  label: "Open an account",
};

/** What the button opens into in the preview: a small balance card whose currency chips follow the figure, 3 frames apart. */
const BalanceCard: React.FC<{ from: number }> = ({ from }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  return (
    <AbsoluteFill
      style={{ backgroundColor: "#FFFFFF", padding: 34 * u, boxSizing: "border-box", justifyContent: "space-between" }}
    >
      <div style={{ fontFamily: primaryFont, fontWeight: 600, fontSize: 22 * u, color: DEMO.inkMuted }}>
        Main account
      </div>
      <div
        style={{ fontFamily: displayFont, fontWeight: 700, fontSize: 64 * u, letterSpacing: -2 * u, color: DEMO.ink }}
      >
        $12,480.00
      </div>
      <div style={{ display: "flex", gap: 10 * u }}>
        {["USD", "EUR", "USDC"].map((tag, i) => (
          <div
            key={tag}
            style={{
              opacity: familyProgress(frame, from + 2 + i * 3, 4, "power3.out"),
              fontFamily: primaryFont,
              fontWeight: 600,
              fontSize: 18 * u,
              padding: `${8 * u}px ${16 * u}px`,
              borderRadius: 999,
              background: i === 2 ? "#1F4D37" : "rgba(18,18,18,0.06)",
              color: i === 2 ? "#FFFFFF" : DEMO.ink,
            }}
          >
            {tag}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

/** The matte preview's plate: a dusk sky over a sea line, with a floating dock whose first icon the matte underlines. */
const DockPlate: React.FC = () => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  return (
    <AbsoluteFill
      style={{ background: "linear-gradient(180deg, #A9B9CF 0%, #E9C9B4 58%, #50606F 58.2%, #2E3A46 100%)" }}
    >
      <div
        style={{
          position: "absolute",
          left: width * 0.385,
          top: height * 0.355,
          width: width * 0.23,
          height: height * 0.1,
          borderRadius: 28 * u,
          background: "rgba(255,255,255,0.22)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-around",
          padding: `0 ${18 * u}px`,
          boxSizing: "border-box",
        }}
      >
        {["#F2541B", "#2F4BFF", "#1F4D37", "#141414"].map((c) => (
          <div key={c} style={{ width: height * 0.065, height: height * 0.065, borderRadius: 16 * u, background: c }} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

/** Library preview: a full-frame statement shrinks into a slab on a warm ground, narrows into a button, types, turns and opens; or (matte) a black card collapses into a dock's underline. */
export const FrameToObjectPreview: React.FC<FrameToObjectPreviewProps> = ({
  seamFrame: _seam,
  mode,
  target,
  landColour,
  ...props
}) =>
  mode === "matte" ? (
    <MatteCollapse
      at={props.at}
      frames={props.frames}
      ease={props.ease}
      from={MATTE_FROM}
      target={target ?? matteCollapsePreset.target}
      fill={props.fill}
      landColour={landColour ?? "#FFFFFF"}
      soft={24}
    >
      <DockPlate />
    </MatteCollapse>
  ) : (
    <FrameToObject {...props} object={<BalanceCard from={objectPhases(props, props.label).open} />}>
      <DemoSceneB title="Banking, rebuilt" ground="#1F4D37" ink="#F2F0EA" />
    </FrameToObject>
  );
