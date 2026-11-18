import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import { z } from "zod";
import { condensedFont } from "../../../lib/fonts";
import { useFittedFontSize } from "../../text";
import type { Cue } from "../types";

/**
 * Text behind the subject: plate, then a title, then the plate's subject again on top, cut out by its matte, so the
 * title sits in the picture's depth. The top layer is the same plate masked by the matte (never a separately decoded
 * cut-out drawn over it), so colour and position match the plate exactly and no seam shows. The matte is a frame
 * sequence from `pnpm matte` (docs/matte.md): its RGBA `cutout/` frames (`maskMode: "alpha"`) or its grey `alpha/`
 * frames (`"luminance"`). A still needs one PNG. With no plate the block draws its own bust, so it previews alone.
 */

export const SUBJECT_OCCLUSION_FRAMES = 90;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;

export const subjectOcclusionSchema = z.object({
  /** Picture inside public/ (image or clip). Empty: a drawn bust, so the block previews with no files. */
  plate: z.string(),
  /**
   * The subject's matte inside public/ at the plate's pixel size: one PNG, or a printf pattern such as
   * `projects/<id>/matte/cutout/frame-%05d.png` numbered by source frame. Empty with a plate: the title stays on top.
   */
  matte: z.string(),
  /** `alpha`: the PNG's alpha channel (rmbg or `pnpm matte` cut-outs). `luminance`: a grey matte, white = subject. */
  maskMode: z.enum(["alpha", "luminance"]),
  /** Source frame number of the first matte frame (`input.startFrame` in matte.json); the clip is trimmed to match. */
  matteStart: z.number().int().min(0),
  /** Matte frames available (`input.frames`); the last one holds after them. */
  matteFrames: z.number().int().min(1),
  /** Frame rate of the clip and its matte (`input.fps`), so a 60 fps source maps onto a 30 fps film. */
  sourceFps: z.number().positive(),
  /** The title: one line, upper-cased, fitted to `widthShare` of the frame. */
  text: z.string().min(1),
  color: z.string(),
  /** Title width as a share of the frame width (it may pass behind the subject at any size). */
  widthShare: z.number().min(0.2).max(1.2),
  /** Vertical centre of the title as a share of height (behind the head on a portrait: about 0.3). */
  y: z.number().min(0).max(1),
  /** Frame the title starts rising from behind the subject, and the frames it takes (expo out). */
  enterAt: z.number().int().min(0),
  enterFrames: z.number().int().min(1).max(60),
  /** Rise distance as a share of the title's own height. */
  rise: z.number().min(0).max(2),
  /** Letter spacing in em. */
  tracking: z.number().min(-0.1).max(0.3),
  /** Drawn bust only: ground, figure and light colours. */
  palette: z.tuple([z.string(), z.string(), z.string()]),
});

export type SubjectOcclusionProps = z.infer<typeof subjectOcclusionSchema>;

export const subjectOcclusionDefaults: SubjectOcclusionProps = {
  plate: "",
  matte: "",
  maskMode: "alpha",
  matteStart: 0,
  matteFrames: 1,
  sourceFps: 30,
  text: "Behind",
  color: "#F3EEE4",
  widthShare: 0.94,
  y: 0.36,
  enterAt: 8,
  enterFrames: 26,
  rise: 0.55,
  tracking: 0.01,
  palette: ["#C6542E", "#1E1B18", "#F2C9A0"],
};

/** The matte file for `frame`: `matteStart` plus the source frames elapsed, held on the last; a single PNG as is. */
export const matteFileAt = (
  frame: number,
  fps: number,
  {
    matte,
    matteStart,
    matteFrames,
    sourceFps,
  }: Pick<SubjectOcclusionProps, "matte" | "matteStart" | "matteFrames" | "sourceFps">,
): string => {
  const pattern = /%0(\d+)d/.exec(matte);
  if (!pattern) return matte;
  const elapsed = Math.min(matteFrames - 1, Math.max(0, Math.floor((frame * sourceFps) / fps + 1e-6)));
  return matte.replace(pattern[0], String(matteStart + elapsed).padStart(Number(pattern[1]), "0"));
};

/** Title rise: 0 before `enterAt`, eased to 1 over `enterFrames`. */
export const occlusionRise = (
  frame: number,
  { enterAt, enterFrames }: Pick<SubjectOcclusionProps, "enterAt" | "enterFrames">,
): number =>
  interpolate(frame, [enterAt, enterAt + enterFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.exp),
  });

export const subjectOcclusionCues = ({ enterAt }: Pick<SubjectOcclusionProps, "enterAt">): Cue[] => [
  { frame: enterAt, kind: "reveal", sfx: "whoosh", weight: "support", label: "title rises behind the subject" },
];

/** A drawn head-and-shoulders bust on a lit ground; `only` draws the figure alone (the subject layer). */
const DrawnBust: React.FC<{ palette: SubjectOcclusionProps["palette"]; only?: boolean }> = ({
  palette: [ground, figure, light],
  only,
}) => {
  const { width, height } = useVideoConfig();
  const s = Math.min(width, height);
  const cx = width / 2;
  const base = height;
  const headY = height * 0.5;
  const body = `M ${cx - s * 0.46} ${base} C ${cx - s * 0.44} ${headY + s * 0.36} ${cx - s * 0.3} ${headY + s * 0.24} ${cx - s * 0.1} ${headY + s * 0.2} L ${cx - s * 0.08} ${headY + s * 0.1} L ${cx + s * 0.08} ${headY + s * 0.1} L ${cx + s * 0.1} ${headY + s * 0.2} C ${cx + s * 0.3} ${headY + s * 0.24} ${cx + s * 0.44} ${headY + s * 0.36} ${cx + s * 0.46} ${base} Z`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: "absolute", inset: 0 }}
      aria-hidden
    >
      <defs>
        <radialGradient id="occlusion-ground" cx="50%" cy="38%" r="70%">
          <stop offset="0%" stopColor={light} stopOpacity={0.55} />
          <stop offset="60%" stopColor={ground} />
          <stop offset="100%" stopColor={ground} />
        </radialGradient>
        {/* Opaque stops only: the figure must hide the title completely where it stands in front. */}
        <radialGradient id="occlusion-skin" cx="38%" cy="30%" r="80%">
          <stop offset="0%" stopColor={light} />
          <stop offset="18%" stopColor={light} />
          <stop offset="75%" stopColor={figure} />
        </radialGradient>
      </defs>
      {only ? null : <rect width={width} height={height} fill="url(#occlusion-ground)" />}
      <path d={body} fill="url(#occlusion-skin)" />
      <ellipse cx={cx} cy={headY - s * 0.04} rx={s * 0.15} ry={s * 0.19} fill="url(#occlusion-skin)" />
    </svg>
  );
};

const PlatePicture: React.FC<{ src: string; trimBefore: number }> = ({ src, trimBefore }) =>
  VIDEO.test(src) ? (
    <Video
      src={staticFile(src)}
      muted
      trimBefore={trimBefore || undefined}
      objectFit="cover"
      style={{ width: "100%", height: "100%" }}
    />
  ) : (
    <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  );

/**
 * The block. Layers, back to front: the plate, the title rising from `y` + `rise`, the plate again masked by the matte.
 * Cover-fit on both plate layers and on the mask keeps them registered at any format.
 */
export const SubjectOcclusion: React.FC<SubjectOcclusionProps> = (props) => {
  const { plate, matte, maskMode, matteStart, sourceFps, text, color, widthShare, y, rise, tracking, palette } = props;
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const shown = text.toUpperCase();
  const fitted = useFittedFontSize({
    text: shown,
    withinWidth: width * widthShare,
    fontFamily: condensedFont,
    fontWeight: 400,
    letterSpacing: `${tracking}em`,
  });
  const size = Math.min(fitted ?? 0, height * 0.6);
  const progress = occlusionRise(frame, props);
  const trimBefore = Math.round((matteStart * fps) / sourceFps);
  const matteFile = plate && matte ? matteFileAt(frame, fps, props) : "";
  const mask = matteFile ? `url("${staticFile(matteFile)}")` : "";
  const title =
    fitted === null ? null : (
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start" }}>
        <div
          style={{
            position: "absolute",
            top: height * y - size * 0.5,
            width: "100%",
            textAlign: "center",
            fontFamily: condensedFont,
            fontSize: size,
            lineHeight: 1,
            letterSpacing: `${tracking}em`,
            color,
            whiteSpace: "pre",
            transform: `translateY(${(1 - progress) * rise * size}px)`,
            opacity: interpolate(progress, [0, 0.15], [0, 1], { extrapolateRight: "clamp" }),
          }}
        >
          {shown}
        </div>
      </AbsoluteFill>
    );
  if (!plate) {
    return (
      <AbsoluteFill style={{ backgroundColor: palette[0], overflow: "hidden" }}>
        <DrawnBust palette={palette} />
        {title}
        <DrawnBust palette={palette} only />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden" }}>
      <PlatePicture src={plate} trimBefore={trimBefore} />
      {title}
      {mask ? (
        <>
          {/* Holds the render until this frame's matte has loaded, so the CSS mask never paints empty. */}
          <Img src={staticFile(matteFile)} style={{ position: "absolute", width: 1, height: 1, opacity: 0 }} />
          <AbsoluteFill
            style={{
              maskImage: mask,
              WebkitMaskImage: mask,
              maskMode: maskMode,
              maskSize: "cover",
              WebkitMaskSize: "cover",
              maskPosition: "center",
              WebkitMaskPosition: "center",
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
            }}
          >
            <PlatePicture src={plate} trimBefore={trimBefore} />
          </AbsoluteFill>
        </>
      ) : null}
    </AbsoluteFill>
  );
};
