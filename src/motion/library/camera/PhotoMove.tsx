import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { cropAt, MIN_SPEED, moveProgress, planMove } from "../../../lib/photo/crop";
import { serifNormalFont } from "../../../lib/fonts";
import { IMAGE_CARD_PAPER, imageCardRect, secondCardPose } from "./camera-plan";

const rect = z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() });

export const photoMoveSchema = z.object({
  /** The photo: a `staticFile` name ("projects/ID/assets/imported/…jpg") or a URL; "" draws a stand-in. */
  src: z.string(),
  /** Displayed (EXIF-rotated) size in pixels, from `pnpm photo:focus`. */
  imageWidth: z.number().positive(),
  imageHeight: z.number().positive(),
  /** Start and end focus boxes, normalised to the image; each grows to the frame's aspect around its centre. */
  from: rect,
  to: rect,
  /** cover: the photo fills the frame. blur: the photo may show whole over a blurred, darkened copy of itself. */
  fill: z.enum(["cover", "blur"]),
  easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]),
  /** Slowest motion allowed, as a share of the frame a second; a slower move is carried further along its path. */
  minSpeed: z.number().min(0),
  /** Frames the move takes; 0 = the whole sequence. */
  moveFrames: z.number().int().min(0),
  blur: z.number().min(0),
  /** How much the blurred fill is darkened, 0..1. */
  dim: z.number().min(0).max(1),
  /**
   * `full` (default): the photo is the frame. `card` (abdulah t04): the photo moves inside a card with a 1 px edge on
   * a paper ground, optionally with a second card cut on behind it at a small rotation. Numbers in camera-plan.ts.
   */
  frame: z.enum(["full", "card"]).optional(),
  /** The card as shares of the frame; absent uses `imageCardRect` (abdulah: about 0.25 W x 0.45 H in the right third). */
  card: rect.optional(),
  /** Ground around the card (abdulah: #F8F6F2) and the card's 1 px edge colour. */
  paper: z.string().optional(),
  edge: z.string().optional(),
  /** Small serif word set under the card; empty sets none. */
  caption: z.string().optional(),
  /** Frame the second card cuts on behind the first (abdulah F177, 0.4 s after the card); -1 or absent: none. */
  secondAt: z.number().int().min(-1).optional(),
  /** The second card's photo ("" draws the stand-in), its rotation in degrees (about 3) and offset in shares of the card. */
  secondSrc: z.string().optional(),
  secondRotate: z.number().min(-15).max(15).optional(),
  secondOffset: z.object({ x: z.number(), y: z.number() }).optional(),
});

export type PhotoMoveProps = z.infer<typeof photoMoveSchema>;
export const PHOTO_MOVE_FRAMES = 120;

export const photoMoveDefaults: PhotoMoveProps = {
  src: "",
  imageWidth: 4032,
  imageHeight: 3024,
  from: { x: 0.5, y: 0.1, w: 0.36, h: 0.85 },
  to: { x: 0.6, y: 0.22, w: 0.16, h: 0.3 },
  fill: "cover",
  easing: "linear",
  minSpeed: MIN_SPEED,
  moveFrames: 0,
  blur: 48,
  dim: 0.45,
};

const resolve = (src: string) => (/^(https?:|data:|\/)/.test(src) ? src : staticFile(src));

/** A drawn 4:3 stand-in photo (a person on a hillside at dusk), so the preview needs no media. */
const StandIn: React.FC = () => (
  <svg viewBox="0 0 400 300" preserveAspectRatio="none" style={{ width: "100%", height: "100%", display: "block" }}>
    <defs>
      <linearGradient id="pm-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#2b3a67" />
        <stop offset="0.6" stopColor="#e07a5f" />
        <stop offset="1" stopColor="#f2cc8f" />
      </linearGradient>
    </defs>
    <rect width="400" height="300" fill="url(#pm-sky)" />
    <circle cx="96" cy="150" r="34" fill="#f8e1b0" opacity="0.9" />
    <path d="M0 210 Q90 160 190 200 T400 180 V300 H0Z" fill="#3d405b" />
    <path d="M0 250 Q120 215 240 245 T400 235 V300 H0Z" fill="#283044" />
    <rect x="232" y="128" width="72" height="140" rx="30" fill="#81b29a" />
    <circle cx="268" cy="104" r="22" fill="#f4d6c3" />
    <path d="M246 98 Q268 70 290 98 Q284 84 268 84 Q252 84 246 98Z" fill="#3a2a22" />
    <circle cx="261" cy="104" r="2.2" fill="#2a1d18" />
    <circle cx="275" cy="104" r="2.2" fill="#2a1d18" />
    <path d="M262 114 Q268 118 274 114" stroke="#9b4a3c" strokeWidth="2" fill="none" />
  </svg>
);

/**
 * A still that moves from one crop to another (Ken Burns), zoom geometric so its rate is even, never slower than
 * `minSpeed`. With fill "blur" a photo whose aspect differs from the frame sits whole over a blurred copy.
 */
export const PhotoMove: React.FC<PhotoMoveProps> = (props) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  if (props.frame !== "card") return <PhotoFill {...props} boxWidth={width} boxHeight={height} />;
  const card = props.card ?? imageCardRect(width, height);
  const cw = card.w * width;
  const ch = card.h * height;
  const edge = props.edge ?? "rgba(20,18,14,0.22)";
  const second = secondCardPose(
    frame,
    props.secondAt ?? -1,
    props.secondRotate ?? 3,
    props.secondOffset ?? { x: 0.07, y: -0.05 },
  );
  const u = Math.min(width, height) / 1080;
  const box = (children: React.ReactNode, extra?: React.CSSProperties) => (
    <div
      style={{
        position: "absolute",
        left: card.x * width,
        top: card.y * height,
        width: cw,
        height: ch,
        overflow: "hidden",
        border: `1px solid ${edge}`,
        boxSizing: "border-box",
        background: "#0b0b0d",
        ...extra,
      }}
    >
      {children}
    </div>
  );
  return (
    <AbsoluteFill style={{ background: props.paper ?? IMAGE_CARD_PAPER, overflow: "hidden" }}>
      {second.shown
        ? box(<PhotoFill {...props} src={props.secondSrc ?? ""} fill="cover" boxWidth={cw} boxHeight={ch} still />, {
            transform: `translate(${second.x * cw}px, ${second.y * ch}px) rotate(${second.rotate}deg)`,
          })
        : null}
      {box(<PhotoFill {...props} fill="cover" boxWidth={cw} boxHeight={ch} />)}
      {props.caption ? (
        <div
          style={{
            position: "absolute",
            left: card.x * width,
            width: cw,
            top: (card.y + card.h) * height + 22 * u,
            textAlign: "center",
            fontFamily: serifNormalFont,
            fontSize: 40 * u,
            color: "#1C1A16",
          }}
        >
          {props.caption}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/** The photo's move inside a box of `boxWidth` x `boxHeight` (the frame, or a card). `still` holds the end crop. */
const PhotoFill: React.FC<PhotoMoveProps & { boxWidth: number; boxHeight: number; still?: boolean }> = ({
  boxWidth: width,
  boxHeight: height,
  still,
  ...props
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const frames = Math.max(1, props.moveFrames || durationInFrames);
  const imageAspect = props.imageWidth / props.imageHeight;
  const move = planMove({
    from: props.from,
    to: props.to,
    imageAspect,
    frameAspect: width / height,
    fill: props.fill,
    durationSec: frames / fps,
    easing: props.easing,
    minSpeed: props.minSpeed,
  });
  const crop = cropAt(move.from, move.to, still ? 1 : moveProgress(frame / Math.max(1, frames - 1), props.easing));
  const base = width / Math.min(move.from.w, move.to.w);
  const scale = width / crop.w / base;
  const picture = (style: React.CSSProperties) =>
    props.src ? (
      <Img src={resolve(props.src)} style={{ ...style, objectFit: "cover", display: "block" }} />
    ) : (
      <div style={style}>
        <StandIn />
      </div>
    );
  return (
    <AbsoluteFill style={{ background: "#0b0b0d", overflow: "hidden" }}>
      {props.fill === "blur" ? (
        <AbsoluteFill
          style={{ filter: `blur(${props.blur}px) brightness(${1 - props.dim})`, transform: "scale(1.15)" }}
        >
          {picture({ width: "100%", height: "100%" })}
        </AbsoluteFill>
      ) : null}
      {picture({
        position: "absolute",
        left: 0,
        top: 0,
        width: base,
        height: base / imageAspect,
        transformOrigin: "0 0",
        transform: `translate(${-crop.x * (width / crop.w)}px, ${-crop.y * (height / crop.h)}px) scale(${scale})`,
      })}
    </AbsoluteFill>
  );
};
