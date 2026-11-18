import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { GradeLayer } from "../effects/GradeStepFlash";
import {
  FLEX_MONTAGE_HOLDS,
  GRADES,
  cadenceStarts,
  maxChangesPerWindow,
  montageHolds,
  plateAt,
} from "../effects/flash-plan";
import { PLATE_KINDS, PlateSource, type PlateKind } from "../effects/plates";
import type { Cue } from "../types";
import { focusSizeAt, focusTransform } from "./scene-plan";
import { MaybeFinish, sceneBaseSchema, useLook } from "./shared";

const plateSchema = z.object({
  /** Image or clip inside public/; empty draws the procedural `plate`. */
  src: z.string(),
  plate: z.enum(PLATE_KINDS),
  /** Ground, mid and light of the procedural plate. */
  palette: z.tuple([z.string(), z.string(), z.string()]),
  /** This plate's own whole-frame grade (each plate can have its own). */
  grade: z.enum(GRADES),
  /** The caption's `{word}` on this plate; empty keeps the previous one. */
  word: z.string(),
  /**
   * The plate's focus box (a highlighted phrase, an eye) as shares of the plate; with the montage's `focusSize` the
   * plate is scaled and moved so this box lands on `focusAt` at that size on every plate (aligned burst).
   */
  focus: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }).optional(),
});

export const captionFlashMontageSchema = sceneBaseSchema.extend({
  plates: z.array(plateSchema).min(2).max(32),
  /** Frames each plate holds, in order: a lead, the flashes (3–6 frames each), the landing. Missing entries repeat the last. */
  holds: z.array(z.number().int().min(1)).min(1),
  /** Frame the first plate cuts in. */
  at: z.number().int().min(0),
  /** One line held fixed over the run; `{word}` swaps per plate; words after it reveal across the cuts when `tailReveal`. */
  caption: z.string(),
  tailReveal: z.boolean(),
  /** Frames the caption comes on and goes off (-1 stays to the end); it can leave mid-run. */
  captionOn: z.number().int().min(0),
  captionOff: z.number().int().min(-1),
  /** Left edge (align "left") or centre (align "centre") as a share of width; baseline height as a share of height. */
  captionX: z.number().min(0).max(1),
  captionY: z.number().min(0.05).max(0.95),
  align: z.enum(["left", "centre"]),
  /** Caption size as a share of the frame's width (a caption, not a hero: 0.035–0.06). */
  captionSize: z.number().min(0.02).max(0.12),
  captionInk: z.string(),
  /**
   * Keep the cadence within six cuts in any second (three flashes, WCAG 2.3.1) whatever the plates are, lengthening the
   * fewest holds. Off plays `holds` exactly; then check the render with motion:check (FLASH_RISK) or keep consecutive
   * plates close in tone.
   */
  flashSafe: z.boolean(),
  duotone: z.tuple([z.string(), z.string()]),
  /**
   * Aligned burst (ugc-app highlight-lock, palmier two-frame-burst): every plate with a `focus` box is placed so the box
   * sits on `focusAt` (shares of the frame, default the centre) at `focusSize` of the frame's width on the first plate,
   * growing geometrically to `focusSize * focusGrow` on the last (by plate index). Absent: plates fill the frame.
   */
  focusAt: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  focusSize: z.number().min(0.01).max(2).optional(),
  focusGrow: z.number().min(0.1).max(10).optional(),
});

export type CaptionFlashMontageProps = z.infer<typeof captionFlashMontageSchema>;

/** Holds of every plate, repeating the last entry of `holds`, then made safe when `flashSafe`. */
export const captionMontageHolds = (
  { plates, holds, flashSafe, at }: Pick<CaptionFlashMontageProps, "plates" | "holds" | "flashSafe" | "at">,
  fps = 30,
): number[] =>
  montageHolds(
    plates.map((_, i) => holds[Math.min(i, holds.length - 1)]!),
    { flashSafe, fps, at },
  );

export const captionFlashMontageFrames = (
  props: Pick<CaptionFlashMontageProps, "plates" | "holds" | "flashSafe" | "at">,
  fps = 30,
): number => props.at + captionMontageHolds(props, fps).reduce((a, b) => a + b, 0);

/** Most cuts in any one second of the montage, for the flash budget. */
export const captionMontageMaxCutsPerSecond = (
  props: Pick<CaptionFlashMontageProps, "plates" | "holds" | "flashSafe" | "at">,
  fps = 30,
): number => maxChangesPerWindow(cadenceStarts(captionMontageHolds(props, fps), props.at), fps);

/** The caption on plate `index`: the swapped word and how many tail words show. */
export const captionAt = (
  caption: string,
  words: readonly string[],
  index: number,
  plates: number,
  tailReveal: boolean,
): { head: string; word: string; tail: string } => {
  const [head = "", rest] = caption.split("{word}");
  let word = "";
  for (let i = 0; i <= index && i < words.length; i++) if (words[i]) word = words[i]!;
  const tailWords = (rest ?? "").trim().split(/\s+/).filter(Boolean);
  const shown = !tailReveal
    ? tailWords.length
    : plates <= 1
      ? tailWords.length
      : Math.round((tailWords.length * Math.max(0, index)) / (plates - 1));
  return { head, word: rest === undefined ? "" : word, tail: tailWords.slice(0, shown).join(" ") };
};

/** A tick on every cut, the first a whoosh, the landing plate the hero hit; the caption's arrival is a reveal. */
export const captionFlashMontageCues = (
  props: Pick<CaptionFlashMontageProps, "plates" | "holds" | "flashSafe" | "at" | "captionOn">,
): Cue[] => {
  const starts = cadenceStarts(captionMontageHolds(props), props.at);
  const cues: Cue[] = starts
    .slice(1)
    .map((frame, i) =>
      i === starts.length - 2
        ? { frame, kind: "land", sfx: "impact", weight: "hero", label: "landing plate" }
        : { frame, kind: "cut", sfx: i === 0 ? "whoosh" : "tick", weight: "support" },
    );
  cues.push({ frame: props.captionOn, kind: "reveal", sfx: "none", weight: "support", label: "caption on" });
  return cues.sort((a, b) => a.frame - b.frame);
};

/**
 * One caption held fixed while a run of plates hard-cuts under it on a frame cadence (a lead plate, flashes of 3–6
 * frames, a landing plate), each plate with its own grade; the caption's word can swap per plate and its last words
 * complete on the landing.
 */
export const CaptionFlashMontage: React.FC<CaptionFlashMontageProps & { children?: React.ReactNode[] }> = ({
  children,
  ...props
}) => {
  const {
    plates,
    at,
    caption,
    tailReveal,
    captionOn,
    captionOff,
    captionX,
    captionY,
    align,
    captionSize,
    captionInk,
    duotone,
    styleId,
    finish,
  } = props;
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const look = useLook(styleId);
  const holds = captionMontageHolds(props, fps);
  const starts = cadenceStarts(holds, at);
  const index = plateAt(starts, frame);
  const text = captionAt(
    caption,
    plates.map((p) => p.word),
    Math.max(0, index),
    plates.length,
    tailReveal,
  );
  const captionVisible = frame >= captionOn && (captionOff < 0 || frame < captionOff);
  const size = captionSize * width;
  return (
    <MaybeFinish on={finish} styleId={styleId} seed="caption-flash-montage">
      <AbsoluteFill style={{ backgroundColor: "#000" }}>
        {plates.map((plate, i) => (
          <Sequence
            key={i}
            from={starts[i]!}
            durationInFrames={i === plates.length - 1 ? Math.max(1, durationInFrames - starts[i]!) : holds[i]!}
            layout="none"
          >
            <GradeLayer
              grade={plate.grade}
              duotone={duotone}
              ground={look.palette.background}
              groundInk={look.palette.accent}
              dotSize={10}
            >
              <FocusPlace
                focus={plate.focus}
                at={props.focusAt}
                size={
                  props.focusSize === undefined
                    ? undefined
                    : focusSizeAt(i, plates.length, props.focusSize, props.focusGrow ?? 1)
                }
                width={width}
                height={height}
              >
                <PlateSource
                  src={children?.[i] ? "" : plate.src}
                  kind={plate.plate as PlateKind}
                  seed={`montage-${i}`}
                  palette={plate.palette}
                >
                  {children?.[i]}
                </PlateSource>
              </FocusPlace>
            </GradeLayer>
          </Sequence>
        ))}
        {captionVisible ? (
          <div
            style={{
              position: "absolute",
              left: align === "left" ? captionX * width : 0,
              right: align === "left" ? undefined : 0,
              top: captionY * height,
              transform: "translateY(-100%)",
              textAlign: align === "left" ? "left" : "center",
              fontFamily: look.bodyFamily,
              fontWeight: 600,
              fontSize: size,
              lineHeight: 1.1,
              letterSpacing: "-0.015em",
              color: captionInk,
              whiteSpace: "pre",
              textShadow: "0 1px 12px rgba(0,0,0,0.35)",
            }}
          >
            {text.head}
            {text.word}
            {text.tail ? ` ${text.tail}` : ""}
          </div>
        ) : null}
      </AbsoluteFill>
    </MaybeFinish>
  );
};

/** Places a plate so its focus box lands on the montage's focus point and size; passes it through without both. */
const FocusPlace: React.FC<{
  focus?: { x: number; y: number; w: number; h: number };
  at?: { x: number; y: number };
  size?: number;
  width: number;
  height: number;
  children: React.ReactNode;
}> = ({ focus, at, size, width, height, children }) => {
  if (!focus || size === undefined) return <>{children}</>;
  const t = focusTransform(focus, at ?? { x: 0.5, y: 0.5 }, size, width, height);
  return (
    <AbsoluteFill style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`, transformOrigin: "0 0" }}>
      {children}
    </AbsoluteFill>
  );
};

const P = (plate: PlateKind, palette: [string, string, string], grade: (typeof GRADES)[number], word: string) => ({
  src: "",
  plate,
  palette,
  grade,
  word,
});

export const captionFlashMontageDefaults: CaptionFlashMontageProps = {
  styleId: "paper-signal",
  finish: false,
  plates: [
    P("horizon", ["#24303B", "#6E8090", "#E3E7EA"], "none", "Lisbon"),
    P("horizon", ["#3A2A22", "#A77A5E", "#F2D9C4"], "none", "Oaxaca"),
    P("horizon", ["#1F2B26", "#5F7D6E", "#D8E4DC"], "mono", "Bergen"),
    P("horizon", ["#2E2440", "#7A6A9A", "#E6DEF2"], "none", "Kyoto"),
    P("horizon", ["#33301F", "#8F8A5A", "#EFEBCB"], "duotone", "Hobart"),
    P("horizon", ["#3B2326", "#A0626A", "#F1D3D6"], "none", "Tbilisi"),
    P("horizon", ["#22303A", "#5E7F94", "#DCE8EF"], "none", "anywhere"),
  ],
  holds: FLEX_MONTAGE_HOLDS,
  at: 0,
  caption: "Work from {word} this week.",
  tailReveal: true,
  captionOn: 0,
  captionOff: -1,
  captionX: 0.1,
  captionY: 0.47,
  align: "left",
  captionSize: 0.042,
  captionInk: "#FFFFFF",
  flashSafe: true,
  duotone: ["#1E1A14", "#EFE6CC"],
};
