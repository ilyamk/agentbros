import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { arrivalTint, settleTrack } from "../../text-modes";
import { curves, progress, track, type Keyframe } from "../../timing";
import type { Cue } from "../types";
import { groteskFace } from "./faces";
import { useTextWidths } from "./fit";
import { ARRIVE, EXIT, Stage, resolveInk, useSafeArea } from "./Stage";

export const CHIP_GLYPHS = [
  "spark",
  "bolt",
  "globe",
  "chat",
  "grid",
  "leaf",
  "cube",
  "search",
  "wave",
  "star",
  "code",
  "film",
  "music",
  "terminal",
  "play",
  "render",
] as const;
export type Glyph = (typeof CHIP_GLYPHS)[number];

export const sentenceBuildSchema = z.object({
  /**
   * The sentence. `*250M+*` takes the accent; `{spark}` is an inline icon chip (spark, bolt, globe, chat, grid, leaf,
   * cube, search, wave, star, code, film, music, terminal, play, render); `{img:projects/x/logo.png}` is an image chip
   * from public/; `/` breaks the line.
   */
  text: z.string(),
  ink: z.string(),
  accent: z.string(),
  /** Chip tile colours, cycled; the glyph is drawn in the ink of each tile. */
  chipColours: z.array(z.string()).min(1),
  ground: z.string(),
  /** Widest line as a share of the safe width. */
  width: z.number().min(0.3).max(1),
  at: z.number().int().nonnegative(),
  /** Frames between words (2–4); chips in a row come twice as fast. */
  step: z.number().positive(),
  /** Frame the sentence blurs out; -1 holds. */
  exitAt: z.number().int(),
  grain: z.number().min(0).max(0.2),
  /**
   * "flow" (default): each word opens its own space and the line re-centres, words blur in. "fixed": the block is laid
   * out in its final place from the start and each word switches on whole in one frame; chips fade and scale in over 3.
   */
  layout: z.enum(["flow", "fixed"]).optional(),
  /** Fixed layout: "centre" centres every line; "left" left-aligns the lines inside a centred block. */
  align: z.enum(["centre", "left"]).optional(),
  /** Font weight; 600 by default, 500 reads as the references' medium. */
  weight: z.number().int().min(300).max(900).optional(),
  /** Font size as a share of the frame height, e.g. 0.126; absent fits the widest line to `width`. */
  size: z.number().min(0.02).max(0.4).optional(),
  /** Line pitch as a multiple of the font size; 1.2 by default. */
  leading: z.number().min(0.9).max(2).optional(),
  /** Reveal frame of every token in reading order, overriding `at` and `step` (e.g. a cadence that slows). */
  frames: z.array(z.number().int()).optional(),
  /** Chip outline: "tile" (rounded square, default) or "round" (roundel); `chipScale` sizes chips against the font. */
  chipShape: z.enum(["tile", "round"]).optional(),
  chipScale: z.number().min(0.4).max(1.4).optional(),
  /** Entrance: the block rises from this share of the height below its place, over `riseFrames` with an ease-out. */
  riseFrom: z.number().min(0).max(0.5).optional(),
  riseFrames: z.number().int().min(1).optional(),
  /** Slow upward drift, as a share of the height, from the landing of the rise to `exitAt`, so the hold is never dead. */
  creep: z.number().min(0).max(0.05).optional(),
  /** "blur" (default) fades out through blur; "rise" travels up with no fade, accelerating, for a hard cut on its end. */
  exit: z.enum(["blur", "rise"]).optional(),
  /** Rise exit: travel as a share of the height, its frames and its curve. */
  exitTravel: z.number().min(0).max(1).optional(),
  exitFrames: z.number().int().min(1).optional(),
  exitCurve: z.enum(["quadIn", "expoIn", "linear"]).optional(),
  /**
   * Arrival tint: each word shows these colours one a frame from its reveal, then settles linearly to its own colour,
   * done `tintFrames` after it appeared (motionfly: lilac, raspberry, teal to ink in 5; ugc-app: one yellow cooling to
   * white in 9). Empty or absent for none.
   */
  tint: z.array(z.string()).optional(),
  tintFrames: z.number().int().min(1).max(30).optional(),
  /** Flow layout: four dots outside the line's corners that spread to its new width over 6 frames after each word (motionfly). */
  cornerDots: z.boolean().optional(),
  dotColour: z.string().optional(),
  /** Fixed layout: each word (or each group sharing a frame in `frames`) fades in over this many frames instead of switching on (postiz: 3). */
  fadeFrames: z.number().int().min(0).max(12).optional(),
  /** Fixed layout: starting blur in pixels. It resolves during the word's fade. */
  focusBlur: z.number().min(0).max(16).optional(),
  /** Slow push on the whole block over the shot, as a share of its size (postiz: 0.04-0.06). */
  push: z.number().min(0).max(0.2).optional(),
});

export type SentenceBuildProps = z.infer<typeof sentenceBuildSchema>;

export type Token =
  { kind: "word"; text: string; accent: boolean } | { kind: "chip"; glyph: Glyph } | { kind: "img"; src: string };

export const parseSentence = (text: string): Token[][] =>
  text.split("/").map((line) =>
    (line.match(/\{[^}]+\}|\*[^*]+\*|[^\s{*]+/g) ?? []).map((part): Token => {
      if (part.startsWith("{img:")) return { kind: "img", src: part.slice(5, -1) };
      if (part.startsWith("{")) {
        const name = part.slice(1, -1) as Glyph;
        return { kind: "chip", glyph: CHIP_GLYPHS.includes(name) ? name : "spark" };
      }
      if (part.startsWith("*")) return { kind: "word", text: part.slice(1, -1), accent: true };
      return { kind: "word", text: part, accent: false };
    }),
  );

/** Reveal frame of every token in reading order: words `step` apart, consecutive chips `step / 2` apart. */
export const tokenFrames = (lines: Token[][], at: number, step: number, frames?: readonly number[]): number[][] => {
  if (frames?.length) {
    let i = 0;
    return lines.map((line) => line.map(() => frames[Math.min(i++, frames.length - 1)]!));
  }
  let time = at;
  let previousChip = false;
  return lines.map((line) =>
    line.map((token, index) => {
      const chip = token.kind !== "word";
      if (index > 0 || time > at) time += chip && previousChip ? step / 2 : step;
      previousChip = chip;
      return Math.round(time);
    }),
  );
};

const GLYPH_PATHS: Record<Glyph, string> = {
  spark: "M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  globe:
    "M12 3a9 9 0 100 18 9 9 0 000-18zm0 0c2.5 2.6 3.6 5.6 3.6 9s-1.1 6.4-3.6 9c-2.5-2.6-3.6-5.6-3.6-9s1.1-6.4 3.6-9zM3.5 9h17M3.5 15h17",
  chat: "M4 5h16v11H9l-5 4z",
  grid: "M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z",
  leaf: "M5 19C5 10 10 5 20 4c-1 10-6 15-15 15zm0 0l8-8",
  cube: "M12 2l9 5v10l-9 5-9-5V7zm0 0v10m0 0l9-5m-9 5l-9-5",
  search: "M10.5 4a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM15.5 15.5L21 21",
  wave: "M2 12c2.5-5 5-5 7.5 0s5 5 7.5 0 3.5-3 5-2",
  star: "M12 2.5l2.9 6.2 6.6.7-5 4.5 1.4 6.6L12 17.2l-5.9 3.3 1.4-6.6-5-4.5 6.6-.7z",
  code: "M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5M13.5 5l-3 14",
  film: "M4 6h16v12H4zM8 6v12M16 6v12M4 10h4M4 14h4M16 10h4M16 14h4",
  music: "M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
  terminal: "M4 5h16v14H4zM8 10l3 2.5L8 15M13 15h4",
  play: "M8 5.5v13l11-6.5z",
  render: "M4 5h16v14H4zM10 9v6l5-3z",
};
const STROKED = new Set<Glyph>([
  "globe",
  "leaf",
  "cube",
  "search",
  "wave",
  "code",
  "film",
  "music",
  "terminal",
  "render",
]);

export const Chip: React.FC<{ token: Token; size: number; colour: string; ink: string; round?: boolean }> = ({
  token,
  size,
  colour,
  ink,
  round = false,
}) => {
  const box = size * 1.0;
  const tile: React.CSSProperties = {
    width: box,
    height: box,
    borderRadius: round ? box / 2 : box * 0.24,
    backgroundColor: colour,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.06)",
  };
  if (token.kind === "img")
    return (
      <div style={tile}>
        <Img src={staticFile(token.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  if (token.kind !== "chip") return null;
  const stroked = STROKED.has(token.glyph);
  return (
    <div style={tile}>
      <svg viewBox="0 0 24 24" width={box * 0.56} height={box * 0.56}>
        <path
          d={GLYPH_PATHS[token.glyph]}
          fill={stroked ? "none" : ink}
          stroke={stroked ? ink : "none"}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};

const inkFor = (colour: string) => resolveInk("auto", colour);

/**
 * A sentence that builds word by word, centred line by line, with icons or logos popping in as words and the numbers in
 * the accent. Each new word opens its own space, so the line re-centres smoothly as it grows (firecrawl's hook).
 */
export const SentenceBuild: React.FC<SentenceBuildProps> = (props) => {
  if (props.layout === "fixed") return <FixedSentence {...props} />;
  return <FlowSentence {...props} />;
};

/** Scale of a slow push over the shot, from the first reveal to the exit (or 90 frames on). */
const pushScale = (frame: number, p: SentenceBuildProps, first: number): number =>
  p.push
    ? 1 + p.push * progress(frame, first, Math.max(1, (p.exitAt >= 0 ? p.exitAt : first + 90) - first), "linear")
    : 1;

/** The word's colour at a frame: its arrival tint settling to `base`. */
const wordColour = (frame: number, p: SentenceBuildProps, start: number, base: string): string =>
  p.tint?.length ? arrivalTint(frame, start, p.tint, base, p.tintFrames ?? 5) : base;

const FlowSentence: React.FC<SentenceBuildProps> = (p) => {
  const { text, ink, accent, chipColours, ground, width, at, step, exitAt, grain, weight = 600, frames: given } = p;
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const lines = parseSentence(text);
  const words = lines.flat().filter((token): token is Extract<Token, { kind: "word" }> => token.kind === "word");
  const run = (value: string) => ({
    text: value,
    fontFamily: groteskFace,
    fontWeight: weight,
    letterSpacing: "-0.04em",
  });
  const measured = useTextWidths(
    words.map((word) => run(word.text)),
    100,
  );
  if (measured === null)
    return (
      <Stage background={ground} grain={grain}>
        {null}
      </Stage>
    );

  const widthOf = new Map<Token, number>();
  words.forEach((word, index) => widthOf.set(word, measured[index]!));
  const GAP = 26;
  const CHIP = 112;
  const lineWidth = (line: Token[]) =>
    line.reduce((sum, token) => sum + (token.kind === "word" ? widthOf.get(token)! : CHIP) + GAP, -GAP);
  const widest = Math.max(...lines.map(lineWidth), 1);
  const size = Math.min(
    safe.vertical ? 150 : 132,
    (safe.width * Math.min(1, safe.vertical ? width * 1.18 : width) * 100) / widest,
  );
  const scale = size / 100;
  const ink0 = resolveInk(ink, ground);
  const frames = tokenFrames(lines, at, step, given);
  const out = exitAt >= 0 ? progress(frame, exitAt, 6, EXIT) : 0;
  const first = Math.min(...frames.flat());
  let chipIndex = 0;
  const tokenWidth = (token: Token, index: number) =>
    ((token.kind === "word" ? widthOf.get(token)! : CHIP) + (index > 0 ? GAP : 0)) * scale;
  const dots = p.cornerDots ? cornerDotBox(frame, lines, frames, tokenWidth, size) : null;
  const push = pushScale(frame, p, first);

  return (
    <Stage background={ground} grain={grain}>
      {dots ? <CornerDots box={dots} size={size} colour={p.dotColour ?? ink0} opacity={1 - out} scale={push} /> : null}
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: size * 0.08,
          opacity: 1 - out,
          filter: out > 0 ? `blur(${out * 16}px)` : undefined,
          transform: push !== 1 ? `scale(${push})` : undefined,
        }}
      >
        {lines.map((line, lineIndex) => (
          <div
            key={lineIndex}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", height: size * 1.12 }}
          >
            {line.map((token, index) => {
              const start = frames[lineIndex]![index]!;
              const colour = token.kind === "word" ? null : chipColours[chipIndex++ % chipColours.length]!;
              if (frame < start) return null;
              const open = progress(frame, start, 5, ARRIVE);
              const full = ((token.kind === "word" ? widthOf.get(token)! : CHIP) + (index > 0 ? GAP : 0)) * scale;
              const reveal = progress(frame, start, 4, "linear");
              const content =
                token.kind === "word" ? (
                  <span
                    style={{
                      fontFamily: groteskFace,
                      fontWeight: weight,
                      letterSpacing: "-0.04em",
                      fontSize: size,
                      lineHeight: 1,
                      color: wordColour(frame, p, start, token.accent ? accent : ink0),
                      whiteSpace: "pre",
                      filter: reveal < 1 ? `blur(${(1 - reveal) * 6}px)` : undefined,
                      opacity: reveal,
                    }}
                  >
                    {token.text}
                  </span>
                ) : (
                  <div
                    style={{ transform: `scale(${0.55 + 0.45 * progress(frame, start, 7, ARRIVE)})`, opacity: reveal }}
                  >
                    <Chip token={token} size={size} colour={colour!} ink={inkFor(colour!)} />
                  </div>
                );
              return (
                <div
                  key={index}
                  style={{
                    width: full * open,
                    display: "flex",
                    justifyContent: "flex-start",
                    alignItems: "center",
                    overflow: "visible",
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      width: full,
                      flexShrink: 0,
                      display: "flex",
                      justifyContent: "flex-start",
                      paddingLeft: index > 0 ? GAP * scale : 0,
                      boxSizing: "border-box",
                    }}
                  >
                    {content}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </AbsoluteFill>
    </Stage>
  );
};

/** Vertical offset of a fixed block as a share of the height: rise in, creep, then an accelerating exit upward. */
export const fixedBlockOffset = (frame: number, p: SentenceBuildProps, firstFrame: number): number => {
  const riseFrom = p.riseFrom ?? 0;
  const riseEnd = firstFrame + (p.riseFrames ?? 8);
  const creep = p.creep ?? 0;
  const keys: Keyframe[] = [
    { at: firstFrame, value: riseFrom },
    { at: riseEnd, value: 0, curve: curves.expoOut },
  ];
  if (p.exitAt >= 0) {
    keys.push({ at: Math.max(riseEnd + 1, p.exitAt), value: -creep });
    if ((p.exit ?? "blur") === "rise")
      keys.push({
        at: Math.max(riseEnd + 2, p.exitAt + (p.exitFrames ?? 12)),
        value: -creep - (p.exitTravel ?? 0.07),
        curve: curves[p.exitCurve ?? "quadIn"],
      });
  }
  return track(frame, keys);
};

const FIXED_CHIP_ARRIVAL_FRAMES = 3;

const fixedFadeFrames = (p: SentenceBuildProps) => p.fadeFrames ?? ((p.focusBlur ?? 0) > 0 ? 8 : 0);

export const fixedWordArrival = (frame: number, start: number, fade: number, focusBlur: number) => {
  const opacity = progress(frame, start, fade, "linear");
  const blur = focusBlur * (1 - progress(frame, start, fade, "expoOut"));
  return { opacity, filter: blur > 0 ? `blur(${blur}px)` : undefined };
};

const FixedSentence: React.FC<SentenceBuildProps> = (p) => {
  const {
    text,
    ink,
    accent,
    chipColours,
    ground,
    width,
    at,
    step,
    exitAt,
    grain,
    weight = 600,
    align = "centre",
    leading = 1.2,
    chipShape = "tile",
    chipScale = 1,
  } = p;
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const safe = useSafeArea();
  const lines = parseSentence(text);
  const words = lines.flat().filter((token): token is Extract<Token, { kind: "word" }> => token.kind === "word");
  const measured = useTextWidths(
    words.map((word) => ({ text: word.text, fontFamily: groteskFace, fontWeight: weight, letterSpacing: "-0.03em" })),
    100,
  );
  if (measured === null)
    return (
      <Stage background={ground} grain={grain}>
        {null}
      </Stage>
    );

  const widthOf = new Map<Token, number>();
  words.forEach((word, index) => widthOf.set(word, measured[index]!));
  const GAP = 24;
  const CHIP = 100 * chipScale;
  const lineWidth = (line: Token[]) =>
    line.reduce((sum, token) => sum + (token.kind === "word" ? widthOf.get(token)! : CHIP) + GAP, -GAP);
  const widest = Math.max(...lines.map(lineWidth), 1);
  const size = p.size
    ? p.size * height
    : Math.min(
        safe.vertical ? 150 : 132,
        (safe.width * Math.min(1, safe.vertical ? width * 1.18 : width) * 100) / widest,
      );
  const ink0 = resolveInk(ink, ground);
  const frames = tokenFrames(lines, at, step, p.frames);
  const first = Math.min(...frames.flat());
  const leaving = (p.exit ?? "blur") === "blur" && exitAt >= 0;
  const out = leaving ? progress(frame, exitAt, 6, EXIT) : 0;
  const y = fixedBlockOffset(frame, p, first) * height;
  const push = pushScale(frame, p, first);
  const focusBlur = p.focusBlur ?? 0;
  const fade = fixedFadeFrames(p);
  let chipIndex = 0;

  return (
    <Stage background={ground} grain={grain}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: align === "left" ? "flex-start" : "center",
            transform: `translateY(${y}px)${push !== 1 ? ` scale(${push})` : ""}`,
            opacity: 1 - out,
            filter: out > 0 ? `blur(${out * 16}px)` : undefined,
          }}
        >
          {lines.map((line, lineIndex) => (
            <div
              key={lineIndex}
              style={{ display: "flex", alignItems: "center", gap: (GAP * size) / 100, height: size * leading }}
            >
              {line.map((token, index) => {
                const start = frames[lineIndex]![index]!;
                if (token.kind === "word")
                  return (
                    <span
                      key={index}
                      style={{
                        fontFamily: groteskFace,
                        fontWeight: weight,
                        letterSpacing: "-0.03em",
                        fontSize: size,
                        lineHeight: 1,
                        color: wordColour(frame, p, start, token.accent ? accent : ink0),
                        whiteSpace: "pre",
                        ...fixedWordArrival(frame, start, fade, focusBlur),
                      }}
                    >
                      {token.text}
                    </span>
                  );
                const colour = chipColours[chipIndex++ % chipColours.length]!;
                const t = progress(frame, start, FIXED_CHIP_ARRIVAL_FRAMES, "linear");
                return (
                  <div key={index} style={{ opacity: t, transform: `scale(${0.8 + 0.2 * curves.expoOut(t)})` }}>
                    <Chip
                      token={token}
                      size={(size * CHIP) / 100}
                      colour={colour}
                      ink={inkFor(colour)}
                      round={chipShape === "round"}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

type DotBox = { width: number; height: number };

/**
 * The box the corner dots frame: the widest revealed line (each token at its full width once it has started) and the
 * whole block's height, the width easing to each new value over 6 frames (motionfly: 5-8 frames, power2.out).
 */
const cornerDotBox = (
  frame: number,
  lines: Token[][],
  frames: number[][],
  widthOf: (token: Token, index: number) => number,
  size: number,
): DotBox | null => {
  const starts = [...new Set(frames.flat())].sort((a, b) => a - b);
  if (starts.length === 0 || frame < starts[0]!) return null;
  const widthAt = (f: number) =>
    Math.max(
      ...lines.map((line, li) =>
        line.reduce((sum, token, i) => sum + (frames[li]![i]! <= f ? widthOf(token, i) : 0), 0),
      ),
    );
  const width = settleTrack(
    frame,
    starts.map((f) => ({ frame: f, value: widthAt(f) })),
    6,
  );
  return { width, height: lines.length * size * 1.12 + (lines.length - 1) * size * 0.08 };
};

const CornerDots: React.FC<{ box: DotBox; size: number; colour: string; opacity: number; scale: number }> = ({
  box,
  size,
  colour,
  opacity,
  scale,
}) => {
  const dot = Math.max(6, size * 0.09);
  const pad = size * 0.32;
  const w = box.width * scale + pad * 2;
  const h = box.height * scale + pad * 0.6;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity }}>
      <div style={{ position: "relative", width: w, height: h }}>
        {[
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ].map(([x, y]) => (
          <div
            key={`${x}${y}`}
            style={{
              position: "absolute",
              left: x ? w - dot : 0,
              top: y ? h - dot : 0,
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: colour,
            }}
          />
        ))}
      </div>
    </AbsoluteFill>
  );
};

export const sentenceBuildDefaults: SentenceBuildProps = {
  text: "Build the launch film / with {code} {film} {music} {terminal} {render} agents / in *15* seconds",
  ink: "#111111",
  accent: "#EE5A24",
  chipColours: ["#111111", "#FF7A45", "#E9E6FF", "#3D5AFE", "#F2F1EC"],
  ground: "#FAFAF8",
  width: 0.78,
  at: 4,
  step: 3,
  exitAt: 100,
  grain: 0.03,
};

/** The fixed layout with a rise in, creep and an ease-in rise exit, on a white ground. */
export const sentenceBuildFixedPreset: SentenceBuildProps = {
  ...sentenceBuildDefaults,
  ink: "#262626",
  accent: "#EA4C1C",
  chipColours: ["#1F1F1F", "#E6ECF8", "#3066EE", "#F3EFE6", "#FFE7A3"],
  ground: "#FFFFFF",
  width: 0.9,
  step: 4,
  exitAt: 90,
  grain: 0,
  layout: "fixed",
  align: "left",
  weight: 500,
  chipShape: "round",
  chipScale: 0.78,
  riseFrom: 0.08,
  riseFrames: 8,
  creep: 0.007,
  exit: "rise",
  exitTravel: 0.07,
  exitFrames: 12,
  exitCurve: "quadIn",
};

/** motionfly's promise line: a word about every 10 frames, each lilac, raspberry, teal and settled to ink in 5, four corner dots spreading with it. */
export const sentenceBuildTintPreset: SentenceBuildProps = {
  ...sentenceBuildDefaults,
  text: "Motion that ships / with every release",
  ink: "#030303",
  accent: "#030303",
  ground: "#FEFEFE",
  step: 10,
  exitAt: -1,
  grain: 0,
  tint: ["#B873B3", "#B73A69", "#0A7F6F"],
  tintFrames: 5,
  cornerDots: true,
};

/** ugc-app's stat line: each word arrives yellow and cools to white in 9 frames while the line recentres, on black. */
export const sentenceBuildCoolingPreset: SentenceBuildProps = {
  ...sentenceBuildDefaults,
  text: "Most people quit / *8 days* before it works",
  ink: "#FFFFFF",
  accent: "#FFD84A",
  ground: "#0B0B0C",
  step: 6,
  exitAt: -1,
  tint: ["#FFD84A"],
  tintFrames: 9,
};

/** postiz's title card: laid out in its final place, word groups fade in over 3 frames, 6 apart, no rise, a 5% push. */
export const sentenceBuildFadeGroupsPreset: SentenceBuildProps = {
  ...sentenceBuildDefaults,
  text: "Schedule every post / from one calendar",
  ink: "#1E1B16",
  accent: "#1E1B16",
  ground: "#F6F1E7",
  layout: "fixed",
  frames: [4, 4, 4, 10, 10, 10],
  fadeFrames: 3,
  push: 0.05,
  exitAt: -1,
  grain: 0,
};

export const textGeneratePreset = {
  ...sentenceBuildDefaults,
  text: "A signal becomes / a story.",
  ground: "#EDF0E5",
  ink: "#18261F",
  layout: "fixed",
  width: 0.84,
  at: 5,
  step: 3,
  fadeFrames: 8,
  focusBlur: 8,
  exitAt: -1,
  grain: 0,
} satisfies SentenceBuildProps;

export const sentenceBuildCues = (props: SentenceBuildProps): Cue[] => {
  const lines = parseSentence(props.text);
  const frames = tokenFrames(lines, props.at, props.step, props.frames);
  const cues: Cue[] = [];
  lines.forEach((line, lineIndex) =>
    line.forEach((token, index) => {
      const frame = frames[lineIndex]![index]!;
      if (token.kind === "word")
        cues.push({ frame, kind: "type", sfx: token.accent ? "tick" : "none", weight: "support", label: token.text });
      else
        cues.push({
          frame,
          kind: "reveal",
          sfx: "pop",
          weight: "support",
          label: token.kind === "chip" ? token.glyph : "image",
        });
    }),
  );
  const last = cues.at(-1);
  const focusFrames = props.layout === "fixed" && (props.focusBlur ?? 0) > 0 ? fixedFadeFrames(props) : 0;
  if (last && focusFrames > 0) {
    const frame = Math.max(
      ...cues.map((cue) => cue.frame + (cue.kind === "type" ? focusFrames : FIXED_CHIP_ARRIVAL_FRAMES)),
    );
    cues.push({ frame, kind: "land", sfx: "none", weight: "hero", label: "Sentence in focus" });
  } else if (last) {
    Object.assign(last, { kind: "land", weight: "hero" });
  }
  if (props.exitAt >= 0) cues.push({ frame: props.exitAt, kind: "exit", sfx: "none", weight: "support" });
  return cues;
};
