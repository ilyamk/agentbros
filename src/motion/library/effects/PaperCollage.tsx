import React, { useId } from "react";
import { AbsoluteFill, Easing, Img, interpolate, random, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { PaperFibre } from "../backgrounds/PaperFibre";
import type { Cue } from "../types";
import { limbAngle } from "./effects-plan";

const pieceSchema = z.object({
  label: z.string(),
  /** PNG with alpha inside public/ for a real cut-out; without it the piece is a cardstock shape. */
  src: z.string().optional(),
  /** Cardstock shape when there is no `src`; "strip" is film with sprocket holes. */
  shape: z.enum(["rect", "circle", "triangle", "strip"]),
  /** Cardstock colour, or the paper under a halftone photo. */
  fill: z.string(),
  /** Print as halftone dots: a photo turns black-and-white dots; a shape is shaded by a light from the top left. */
  halftone: z.boolean(),
  /** Centre, as shares of the frame width and height. */
  x: z.number(),
  y: z.number(),
  /** Size, as shares of the frame's short side. */
  w: z.number().positive(),
  h: z.number().positive(),
  /** Rest angle in degrees. */
  rotate: z.number(),
  /** Frame the piece starts to arrive. */
  at: z.number().int().min(0),
  /** Slides in from an edge, drops from above the table, unfolds flat, or unrolls along its long side. */
  from: z.enum(["left", "right", "top", "bottom", "drop", "unfold", "unroll"]),
  /** Frame it is taken away again (a hand that places something and withdraws); -1 stays. */
  leaveAt: z.number().int(),
  /**
   * A puppet limb: once landed, this piece swings about `pivotX`/`pivotY` (shares of its box) by `swing` degrees over
   * `period` frames, holding each pose `step` frames (stop-motion on twos or threes). Cut the limb as its own piece.
   */
  limb: z
    .object({
      pivotX: z.number().min(0).max(1),
      pivotY: z.number().min(0).max(1),
      swing: z.number().min(0).max(90),
      period: z.number().int().min(4).max(240),
      step: z.number().int().min(1).max(4),
    })
    .optional(),
});

export type CollagePiece = z.infer<typeof pieceSchema>;

export const paperCollageSchema = z.object({
  /** The flat paper colour field; choose it by meaning (see the paper-collage reference). */
  field: z.string(),
  /** Paper fibre strength of the field, 0 to 1. */
  fibre: z.number().min(0).max(1),
  /** Three to six pieces in assembly order: structure, subject, connector, action, result. Later pieces lie on top. */
  pieces: z.array(pieceSchema).min(1).max(8),
  /** Frames per held drawing: 2 is stop-motion on twos, 1 is smooth. */
  step: z.number().int().min(1).max(4),
  /** Frames a piece takes to arrive. */
  travel: z.number().int().min(2),
  /** Cream keyline width and halftone cell size, in pixels at a 1080 short side. */
  keyline: z.number().min(0),
  keylineColour: z.string(),
  dot: z.number().min(3),
  seed: z.number().int(),
});

export type PaperCollageProps = z.infer<typeof paperCollageSchema>;

const ARRIVE = Easing.out(Easing.back(1.5));
const LEAVE = Easing.in(Easing.cubic);
const SETTLE = 5;

const held = (frame: number, step: number) => Math.floor(frame / step) * step;

/** First frame on which a piece is at rest (snapped to the held drawing that shows it). */
export const collageLanding = (piece: Pick<CollagePiece, "at">, travel: number, step: number): number =>
  Math.ceil((piece.at + travel) / step) * step;

export const paperCollageCues = ({
  pieces,
  travel,
  step,
}: Pick<PaperCollageProps, "pieces" | "travel" | "step">): Cue[] => {
  const last = pieces.reduce((latest, piece, i) => (piece.at >= pieces[latest]!.at ? i : latest), 0);
  return pieces.flatMap((piece, i): Cue[] => [
    i === last
      ? {
          frame: collageLanding(piece, travel, step),
          kind: "stop",
          sfx: "click",
          weight: "hero",
          label: `${piece.label} completes the picture`,
        }
      : {
          frame: collageLanding(piece, travel, step),
          kind: "land",
          sfx: "click",
          weight: "support",
          label: piece.label,
        },
    ...(piece.leaveAt >= 0
      ? [
          {
            frame: piece.leaveAt,
            kind: "exit",
            sfx: "whoosh",
            weight: "support",
            label: `${piece.label} withdraws`,
          } as Cue,
        ]
      : []),
  ]);
};

const shapeClip: Record<CollagePiece["shape"], string> = {
  rect: "inset(0)",
  circle: "circle(50% at 50% 50%)",
  triangle: "polygon(50% 0%, 100% 100%, 0% 100%)",
  strip: "inset(0)",
};

/**
 * Halftone print of its children: luminance is summed with a 45-degree dot screen and thresholded, so dark areas print
 * big dots and light areas none. Black dots on white; lay it on paper with `mix-blend-mode: multiply`.
 */
export const Halftone: React.FC<{ dot: number; ink?: number; children: React.ReactNode }> = ({
  dot,
  ink = 0.88,
  children,
}) => (
  <AbsoluteFill
    style={{ background: "#fff", filter: "grayscale(1) contrast(28)", mixBlendMode: "multiply", opacity: ink }}
  >
    <AbsoluteFill style={{ filter: "grayscale(1) brightness(0.5)" }}>{children}</AbsoluteFill>
    <div
      style={{
        position: "absolute",
        inset: "-50%",
        transform: "rotate(45deg)",
        backgroundImage: `radial-gradient(circle at center, #000 0px, #808080 ${dot * 0.72}px)`,
        backgroundSize: `${dot}px ${dot}px`,
        mixBlendMode: "plus-lighter",
      }}
    />
  </AbsoluteFill>
);

/** SVG filter that rings any alpha shape with a cut keyline; reference it as `url(#id)` in a CSS filter. */
export const KeylineFilter: React.FC<{ id: string; width: number; colour: string }> = ({ id, width, colour }) => (
  <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
    <filter id={id} x="-15%" y="-15%" width="130%" height="130%" colorInterpolationFilters="sRGB">
      <feMorphology in="SourceAlpha" operator="dilate" radius={width} result="grown" />
      <feFlood floodColor={colour} />
      <feComposite in2="grown" operator="in" result="line" />
      <feMerge>
        <feMergeNode in="line" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </svg>
);

type Pose = {
  visible: boolean;
  dx: number;
  dy: number;
  rotate: number;
  scale: number;
  tilt: number;
  reveal: number;
  lift: number;
};

const piecePose = (
  frame: number,
  piece: CollagePiece,
  ctx: { travel: number; step: number; seed: number; width: number; height: number; size: number },
): Pose => {
  const t = held(frame, ctx.step);
  const rest: Pose = { visible: true, dx: 0, dy: 0, rotate: 0, scale: 1, tilt: 0, reveal: 1, lift: 0 };
  if (t < piece.at) return { ...rest, visible: false };
  const arrive = ARRIVE(Math.min(1, (t - piece.at) / ctx.travel));
  const leaving = piece.leaveAt >= 0 && t >= piece.leaveAt;
  const away = leaving ? LEAVE(Math.min(1, (t - piece.leaveAt) / ctx.travel)) : 0;
  if (leaving && away >= 1) return { ...rest, visible: false };
  const out = leaving ? away : 1 - arrive;
  const moving = out > 0.001;
  const landedFor = t - (piece.at + ctx.travel);
  const lift = moving
    ? 0.6 + 0.4 * out
    : interpolate(landedFor, [0, SETTLE], [0.6, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const key = `${ctx.seed}-${piece.label}-${t}`;
  const jitter = moving
    ? { x: (random(`${key}-x`) - 0.5) * 6, y: (random(`${key}-y`) - 0.5) * 6, r: (random(`${key}-r`) - 0.5) * 2.4 }
    : { x: 0, y: 0, r: 0 };
  const halfW = (piece.w * ctx.size) / 2;
  const halfH = (piece.h * ctx.size) / 2;
  const cx = piece.x * ctx.width;
  const cy = piece.y * ctx.height;
  const spin = (random(`${ctx.seed}-${piece.label}-spin`) - 0.5) * 16;
  const side =
    leaving && (piece.from === "drop" || piece.from === "unfold" || piece.from === "unroll") ? "top" : piece.from;
  const pose = { ...rest, lift, dx: jitter.x, dy: jitter.y, rotate: jitter.r };
  switch (side) {
    case "left":
      return { ...pose, dx: pose.dx - out * (cx + halfW * 1.5 + 40), rotate: pose.rotate + out * spin };
    case "right":
      return { ...pose, dx: pose.dx + out * (ctx.width - cx + halfW * 1.5 + 40), rotate: pose.rotate + out * spin };
    case "top":
      return { ...pose, dy: pose.dy - out * (cy + halfH * 1.5 + 40), rotate: pose.rotate + out * spin };
    case "bottom":
      return { ...pose, dy: pose.dy + out * (ctx.height - cy + halfH * 1.5 + 40), rotate: pose.rotate + out * spin };
    case "drop":
      return { ...pose, scale: 1 + 0.24 * out, rotate: pose.rotate + out * spin * 0.6 };
    case "unfold":
      return { ...pose, tilt: 88 * out };
    case "unroll":
      return { ...pose, reveal: Math.max(0, 1 - out) };
  }
};

const Sprockets: React.FC<{ vertical: boolean; size: number }> = ({ vertical, size }) => {
  const hole = size * 0.016;
  const pitch = size * 0.032;
  const band = (edge: "start" | "end"): React.CSSProperties => ({
    position: "absolute",
    ...(vertical
      ? { top: 0, bottom: 0, width: hole * 1.6, [edge === "start" ? "left" : "right"]: hole * 0.7 }
      : { left: 0, right: 0, height: hole * 1.6, [edge === "start" ? "top" : "bottom"]: hole * 0.7 }),
    backgroundImage: `linear-gradient(${vertical ? "180deg" : "90deg"}, #F3EAD7 0 ${hole}px, transparent ${hole}px)`,
    backgroundSize: vertical ? `100% ${pitch}px` : `${pitch}px 100%`,
    opacity: 0.92,
  });
  return (
    <>
      <div style={band("start")} />
      <div style={band("end")} />
      <div
        style={{
          position: "absolute",
          inset: vertical ? `${hole}px ${hole * 3.2}px` : `${hole * 3.2}px ${hole}px`,
          background: "rgba(10,10,10,0.18)",
        }}
      />
    </>
  );
};

const ShapeShade: React.FC<{ shape: CollagePiece["shape"] }> = ({ shape }) => (
  <AbsoluteFill
    style={{
      background:
        shape === "circle"
          ? "radial-gradient(circle at 32% 28%, #fff 0%, #e6e6e6 30%, #8a8a8a 78%, #3a3a3a 100%)"
          : "linear-gradient(150deg, #fff 0%, #d8d8d8 45%, #7a7a7a 100%)",
    }}
  />
);

/**
 * Editorial paper-collage assembly: a flat paper field opens empty, then cut-out pieces (halftone photos and cardstock
 * shapes, each with a cream keyline and a paper shadow) slide in, drop, unfold or unroll one by one and snap into place
 * on stop-motion timing, the shadow tightening as each is pressed down. The last frame holds the finished picture.
 */
export const PaperCollage: React.FC<PaperCollageProps> = ({
  field,
  fibre,
  pieces,
  step,
  travel,
  keyline,
  keylineColour,
  dot,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const size = Math.min(width, height);
  const u = size / 1080;
  const filterId = `keyline-${useId().replaceAll(":", "")}`;
  const flicker = (random(`${seed}-flicker-${held(frame, step)}`) - 0.5) * 0.035;
  return (
    <AbsoluteFill style={{ backgroundColor: field, overflow: "hidden" }}>
      <PaperFibre paper={field} fibre="#000000" texture={fibre} lightX={0.4} lightY={0.3} falloff={0.22} seed={seed} />
      <KeylineFilter id={filterId} width={keyline * u} colour={keylineColour} />
      {pieces.map((piece) => {
        const pose = piecePose(frame, piece, { travel, step, seed, width, height, size });
        if (!pose.visible) return null;
        const w = piece.w * size;
        const h = piece.h * size;
        const shadowY = (5 + 34 * pose.lift) * u;
        const shadowBlur = (6 + 40 * pose.lift) * u;
        const shadowAlpha = 0.3 - 0.1 * pose.lift;
        const vertical = h > w;
        const reveal =
          pose.reveal < 1
            ? vertical
              ? `inset(0 0 ${(1 - pose.reveal) * 100}% 0)`
              : `inset(0 ${(1 - pose.reveal) * 100}% 0 0)`
            : undefined;
        const mask = piece.src ? `url("${staticFile(piece.src)}") center / contain no-repeat` : undefined;
        const originY = piece.from === "unfold" ? 1 : 0.5;
        const limb = piece.limb ? limbAngle(frame, piece.limb, collageLanding(piece, travel, step)) : 0;
        const ox = piece.limb ? (piece.limb.pivotX - 0.5) * w : 0;
        const oy = piece.limb ? (piece.limb.pivotY - originY) * h : 0;
        const swing = limb ? ` translate(${ox}px, ${oy}px) rotate(${limb}deg) translate(${-ox}px, ${-oy}px)` : "";
        return (
          <div
            key={piece.label}
            style={{
              position: "absolute",
              left: piece.x * width - w / 2,
              top: piece.y * height - h / 2,
              width: w,
              height: h,
              transform: `perspective(${1400 * u}px) translate(${pose.dx * u}px, ${pose.dy * u}px) rotate(${piece.rotate + pose.rotate}deg) rotateX(${pose.tilt}deg) scale(${pose.scale})${swing}`,
              transformOrigin: piece.from === "unfold" ? "50% 100%" : "50% 50%",
              filter: `url(#${filterId}) drop-shadow(${shadowY * 0.35}px ${shadowY}px ${shadowBlur}px rgba(20,12,6,${shadowAlpha}))`,
              clipPath: reveal,
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                isolation: "isolate",
                overflow: "hidden",
                backgroundColor: piece.fill,
                clipPath: piece.src ? undefined : shapeClip[piece.shape],
                mask,
                WebkitMask: mask,
                filter: pose.tilt > 0 ? `brightness(${1 - (pose.tilt / 88) * 0.45})` : undefined,
              }}
            >
              {piece.src ? (
                piece.halftone ? (
                  <Halftone dot={dot * u}>
                    <Img src={staticFile(piece.src)} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                  </Halftone>
                ) : (
                  <Img
                    src={staticFile(piece.src)}
                    style={{ position: "absolute", width: "100%", height: "100%", objectFit: "contain" }}
                  />
                )
              ) : piece.halftone ? (
                <Halftone dot={dot * u}>
                  <ShapeShade shape={piece.shape} />
                </Halftone>
              ) : null}
              {piece.shape === "strip" && !piece.src ? <Sprockets vertical={vertical} size={size} /> : null}
            </div>
          </div>
        );
      })}
      <AbsoluteFill
        style={{ backgroundColor: flicker > 0 ? "#fff" : "#000", opacity: Math.abs(flicker), pointerEvents: "none" }}
      />
    </AbsoluteFill>
  );
};

const piece = (
  p: Partial<CollagePiece> & Pick<CollagePiece, "label" | "x" | "y" | "w" | "h" | "at" | "from" | "fill">,
): CollagePiece => ({
  shape: "rect",
  halftone: false,
  rotate: 0,
  leaveAt: -1,
  ...p,
});

/** "Your day disappears into the phone": clock, its hands, a halftone phone, the film it eats, the scrap that is left. */
export const paperCollageDefaults: PaperCollageProps = {
  field: "#C8452C",
  fibre: 0.55,
  step: 2,
  travel: 10,
  keyline: 7,
  keylineColour: "#F3EAD7",
  dot: 12,
  seed: 7,
  pieces: [
    piece({
      label: "clock face",
      shape: "circle",
      halftone: true,
      fill: "#EFE6D2",
      x: 0.5,
      y: 0.3,
      w: 0.66,
      h: 0.66,
      at: 4,
      from: "drop",
    }),
    piece({ label: "minute hand", fill: "#1E1C1A", x: 0.5, y: 0.235, w: 0.032, h: 0.27, at: 16, from: "top" }),
    piece({
      label: "hour hand",
      fill: "#1E1C1A",
      x: 0.585,
      y: 0.3,
      w: 0.2,
      h: 0.034,
      rotate: 0,
      at: 22,
      from: "right",
    }),
    piece({
      label: "phone",
      src: "shared/collage/phone-cutout.png",
      halftone: true,
      fill: "#E9E4DA",
      x: 0.33,
      y: 0.69,
      w: 0.36,
      h: 0.75,
      rotate: -9,
      at: 34,
      from: "left",
    }),
    piece({
      label: "film strip",
      shape: "strip",
      fill: "#2E8C8C",
      x: 0.7,
      y: 0.665,
      w: 0.17,
      h: 0.42,
      rotate: 7,
      at: 48,
      from: "unroll",
    }),
    piece({
      label: "scrap of the day",
      shape: "rect",
      fill: "#F2C230",
      x: 0.71,
      y: 0.885,
      w: 0.3,
      h: 0.1,
      rotate: -5,
      at: 62,
      from: "bottom",
    }),
  ],
};

export const PAPER_COLLAGE_FRAMES = 105;

/**
 * The default collage with its minute hand cut as a puppet limb: pivoted at the clock's centre (the hand's bottom end),
 * swinging 14 degrees over 36 frames on threes, as paper-style's single-limb puppets move.
 */
export const paperCollageLimbPreset: PaperCollageProps = {
  ...paperCollageDefaults,
  pieces: paperCollageDefaults.pieces.map((p) =>
    p.label === "minute hand" ? { ...p, limb: { pivotX: 0.5, pivotY: 1, swing: 14, period: 36, step: 3 } } : p,
  ),
};
