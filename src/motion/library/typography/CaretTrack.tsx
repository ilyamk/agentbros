import React, { useMemo } from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { scrambleGlyphs } from "../../kinetic-math";
import { chipSlots, mixHex, typeProgress } from "../../text-modes";
import { splitGraphemes } from "../../text-split";
import { intentCurves, progress } from "../../timing";
import {
  caretFollow,
  caretKeyAt,
  caretMarkAt,
  caretOn,
  caretTypingPlan,
  newestWordAccent,
  retypeLinePlan,
  type CaretPlan,
} from "../../type-track";
import type { Cue } from "../types";
import { FACE_NAMES, faceRun, faceStyle } from "./faces";
import { useTextWidths } from "./fit";
import { Stage, resolveInk } from "./Stage";

export const caretTrackSchema = z.object({
  /** The line typed first. */
  text: z.string().min(1),
  /** Frame of the first keystroke; the caret blinks alone before it. */
  at: z.number().int().nonnegative(),
  /** Mean frames per character at 30 fps (per word with `unit: "word"`): 1.05 is the fastest reference, 1.6 a calm one. */
  framesPerChar: z.number().min(0.5).max(12),
  /** "char" types letter by letter; "word" puts each word on whole. */
  unit: z.enum(["char", "word"]),
  /** 0 = an even tick; up to 1 = seeded unevenness around the same mean pace. */
  jitter: z.number().min(0).max(1),
  /** Frame the line is deleted backwards by word; -1 keeps it. */
  backspaceAt: z.number().int(),
  /** Words left after the backspace; 0 deletes all. */
  keepWords: z.number().int().nonnegative(),
  /** Frames per deleted word. */
  backspaceStep: z.number().int().min(1).max(8),
  /** Empty frames (caret alone) between the deletion and the retype. */
  emptyFrames: z.number().int().min(1).max(30),
  /** What is typed after the kept words; empty for none. */
  retype: z.string(),
  /** "type" types it; "scramble" puts it on whole as glyph noise that resolves left to right in `scrambleFrames`. */
  retypeMode: z.enum(["type", "scramble"]),
  scrambleFrames: z.number().int().min(2).max(20),
  /** Colour of the newest word while it types and for `accentFrames` after. Same as `ink` for none. */
  accent: z.string(),
  accentFrames: z.number().int().min(0).max(20),
  /** "none" draws no caret (abdulah). */
  caret: z.enum(["block", "bar", "none"]),
  /** Soft bloom around the caret, 0 for none. */
  caretGlow: z.number().min(0).max(1),
  /** Idle blink: frames per cycle and frames on. */
  blinkCycle: z.number().int().min(4).max(60),
  blinkOn: z.number().int().min(1).max(59),
  face: z.enum(FACE_NAMES),
  /** Type size as a share of the frame's shorter side (0.11 = hero scale). */
  size: z.number().min(0.03).max(0.3),
  /** Left edge of the line before it scrolls, share of the width. */
  x: z.number().min(0).max(0.9),
  /** Baseline band centre, share of the height. */
  y: z.number().min(0.1).max(0.9),
  /** Share of the width where the caret holds once the line reaches it: the frame follows the caret and the start of the line runs off the left edge. 1 never scrolls. */
  anchor: z.number().min(0.2).max(1),
  /** Frames the follow averages over: 1 steps a glyph at a time, 4 glides. */
  followSmooth: z.number().int().min(1).max(12),
  /** Slow push toward the caret over the shot (0.04 = 4%). */
  push: z.number().min(0).max(0.3),
  ground: z.string(),
  /** "auto" picks paper-white or near-black for the ground. */
  ink: z.string(),
  grain: z.number().min(0).max(0.2),
  /** "word" (default) deletes a word every `backspaceStep` frames; "char" deletes `backspaceRate` characters a frame (cashfree: 1-2). */
  backspaceUnit: z.enum(["word", "char"]).optional(),
  backspaceRate: z.number().min(0.5).max(6).optional(),
  /** Pace of the retype in frames a character; defaults to `framesPerChar` (cashfree retypes about 2 characters a frame: 0.5). */
  retypeFramesPerChar: z.number().min(0.25).max(12).optional(),
  /**
   * Square chips in the line (abdulah 17.1-19.4 s): each appears at the end of the line once `at` characters are typed,
   * rides the caret (each new glyph pushes it right) and, from `park` characters on, stays in the line with the text
   * typing after it. `src` is an image under public/, else a `colour` tile.
   */
  chips: z
    .array(
      z.object({
        at: z.number().int().nonnegative(),
        park: z.number().int().nonnegative().optional(),
        src: z.string().optional(),
        colour: z.string().optional(),
      }),
    )
    .optional(),
  /** Chip side as a share of the type size (abdulah: about 0.03 of the width). */
  chipSize: z.number().min(0.2).max(1.5).optional(),
  /** Frame the chips slide out to the right (6 frames, ease-in) while the line greys and fades; -1 or absent keeps them. */
  chipExitAt: z.number().int().optional(),
  /**
   * Delete a whole typed line and retype it (design-reference/techniques/delete-and-retype-line.md). When set, `lines`
   * replace `text` and `retype`, and the backspace props above are ignored: the first line types from `at`, holds `hold`
   * frames after its last key, is removed by `deleteMode`, stays empty `emptyFrames`, and the second line types.
   */
  retypeLine: z
    .object({
      lines: z.tuple([z.string().min(1), z.string().min(1)]),
      /** Frames from the first line's last key to the removal (abdulah 16, cashfree 40). */
      hold: z.number().int().min(1).max(240),
      /** "char"/"word" backspace; "select-all" shows the line selected, then deletes it in one key; "cut" removes it on one frame. */
      deleteMode: z.enum(["char", "word", "select-all", "cut"]),
      /** Units removed a frame: characters (cashfree 2.1) or words (abdulah 0.67). */
      deleteRate: z.number().min(0.1).max(8),
      /** Frames between visible delete steps; 2 animates on twos (abdulah). */
      deleteStep: z.number().int().min(1).max(4).optional(),
      /** Frames the last word shows greyed before the backspace (abdulah 2), or the line shows selected ("select-all", default 8). */
      markFrames: z.number().int().min(0).max(30).optional(),
      /** Empty frames before the second line (cashfree: 6; abdulah holds a kept word 8 instead). */
      emptyFrames: z.number().int().min(1).max(30),
      /** Units of the second line; defaults to `unit`. */
      retypeUnit: z.enum(["char", "word"]).optional(),
      /** Frames per unit of the second line; defaults to `framesPerChar` (cashfree 3.4 a word). */
      retypeFramesPerUnit: z.number().min(0.25).max(30).optional(),
    })
    .optional(),
});

export type CaretTrackProps = z.infer<typeof caretTrackSchema>;

export const caretTrackPlan = (p: CaretTrackProps): CaretPlan =>
  p.retypeLine
    ? retypeLinePlan({
        ...p.retypeLine,
        at: p.at,
        framesPerChar: p.framesPerChar,
        unit: p.unit,
        jitter: p.jitter,
        seed: "caret-track",
      })
    : caretTypingPlan({
        text: p.text,
        at: p.at,
        framesPerChar: p.framesPerChar,
        unit: p.unit,
        jitter: p.jitter,
        seed: "caret-track",
        backspaceAt: p.backspaceAt,
        keepWords: p.keepWords,
        backspaceStep: p.backspaceStep,
        emptyFrames: p.emptyFrames,
        retype: p.retype,
        retypeMode: p.retypeMode,
        backspaceUnit: p.backspaceUnit,
        backspaceRate: p.backspaceRate,
        retypeFramesPerChar: p.retypeFramesPerChar,
      });

const nbsp = (text: string) => text.replace(/ /g, " ");

/**
 * A line types at hero scale with a caret, and the frame follows the caret: once the line reaches `anchor`, every key
 * pushes it left, so the start of the sentence leaves the frame and the eye never travels. The newest word is tinted
 * while it types and a few frames after; the caret blinks only when idle. Optionally the line deletes by word and the
 * correction types (or scrambles) in its place.
 */
export const CaretTrack: React.FC<CaretTrackProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const plan = useMemo(() => caretTrackPlan(p), [p]);
  const set = faceStyle(p.face);
  const runs = plan.strings.map((text) => faceRun(p.face, nbsp(text || " ")));
  const widths = useTextWidths(runs, 100);
  const ink = resolveInk(p.ink, p.ground);
  if (widths === null)
    return (
      <Stage background={p.ground} grain={p.grain}>
        {null}
      </Stage>
    );

  const fontSize = Math.min(width, height) * p.size;
  const x0 = width * p.x;
  const chips = p.chips ?? [];
  const chipSide = fontSize * (p.chipSize ?? 0.62);
  const chipSpan = chipSide + fontSize * 0.16;
  const chipsOn = (text: string) => chipSlots([...text].length, chips).filter(Boolean).length;
  const widthOf = (text: string) =>
    (text === "" ? 0 : ((widths[plan.strings.indexOf(text)] ?? 0) * fontSize) / 100) + chipsOn(text) * chipSpan;
  const caretXAt = (f: number) => x0 + widthOf(caretKeyAt(f, plan)?.text ?? "");
  const offset = caretFollow(frame, caretXAt, { anchor: width * p.anchor, smooth: p.followSmooth });

  const key = caretKeyAt(frame, plan);
  const text = key?.text ?? "";
  let graphemes = splitGraphemes(text);
  if (key?.kind === "scramble" && frame - key.frame < p.scrambleFrames) {
    const kept = splitGraphemes(text.slice(0, plan.keptLength));
    const fresh = scrambleGlyphs(splitGraphemes(text.slice(plan.keptLength)), frame, {
      at: key.frame,
      duration: p.scrambleFrames,
      seed: "caret-track",
      spreadShare: 0.5,
      resolveShare: 0.5,
    });
    graphemes = [...kept, ...fresh];
  }
  const mark = caretMarkAt(frame, plan);
  const accent = p.accentFrames > 0 ? newestWordAccent(frame, plan, p.accentFrames) : null;
  const before = graphemes.slice(0, accent?.start ?? graphemes.length).join("");
  const lit = accent ? graphemes.slice(accent.start, accent.end).join("") : "";
  const after = accent ? graphemes.slice(accent.end).join("") : "";
  const slots = chipSlots(graphemes.length, chips);
  const chipOut =
    p.chipExitAt !== undefined && p.chipExitAt >= 0 ? typeProgress(frame, p.chipExitAt, 6, "power2.in") : 0;
  const lineFade = p.chipExitAt !== undefined && p.chipExitAt >= 0 ? typeProgress(frame, p.chipExitAt, 3, "linear") : 0;
  const chipNode = (index: number) => {
    const chip = chips[index]!;
    return (
      <span
        key={`chip-${index}`}
        style={{
          display: "inline-block",
          width: chipSide,
          height: chipSide,
          margin: `0 ${fontSize * 0.08}px`,
          borderRadius: chipSide * 0.08,
          overflow: "hidden",
          backgroundColor: chip.colour ?? p.accent,
          flexShrink: 0,
          transform: chipOut > 0 ? `translateX(${chipOut * width}px)` : undefined,
        }}
      >
        {chip.src ? (
          <Img src={staticFile(chip.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : null}
      </span>
    );
  };
  /** The typed line as runs of text with parked chips between them and riding chips at the end; the accent span kept. */
  const lineNodes = (): React.ReactNode[] => {
    const cuts = slots
      .flatMap((slot, index) =>
        slot && !slot.riding ? [{ after: Math.min(slot.after, graphemes.length), index }] : [],
      )
      .sort((a, b) => a.after - b.after);
    const litStart = accent?.start ?? graphemes.length;
    const litEnd = accent?.end ?? graphemes.length;
    const piece = (from: number, to: number, key: string): React.ReactNode[] => {
      const out: React.ReactNode[] = [];
      const plain1 = graphemes.slice(from, Math.min(to, litStart)).join("");
      const lit1 = graphemes.slice(Math.max(from, litStart), Math.min(to, litEnd)).join("");
      const plain2 = graphemes.slice(Math.max(from, litEnd), to).join("");
      if (plain1) out.push(<span key={`${key}a`}>{nbsp(plain1)}</span>);
      if (lit1)
        out.push(
          <span key={`${key}b`} style={{ color: p.accent }}>
            {nbsp(lit1)}
          </span>,
        );
      if (plain2) out.push(<span key={`${key}c`}>{nbsp(plain2)}</span>);
      return out;
    };
    const nodes: React.ReactNode[] = [];
    let from = 0;
    for (const cut of cuts) {
      nodes.push(...piece(from, cut.after, `p${cut.index}`), chipNode(cut.index));
      from = cut.after;
    }
    nodes.push(...piece(from, graphemes.length, "end"));
    slots.forEach((slot, index) => {
      if (slot?.riding) nodes.push(chipNode(index));
    });
    return nodes;
  };

  const lastKey = key?.frame ?? -Infinity;
  const showCaret =
    p.caret !== "none" &&
    caretOn(frame, Number.isFinite(lastKey) ? lastKey : 0, {
      cycle: p.blinkCycle,
      on: Math.min(p.blinkOn, p.blinkCycle - 1),
    });
  const caretX = x0 + widthOf(text) + offset;
  const caretW = p.caret === "block" ? fontSize * 0.5 : Math.max(2, fontSize * 0.06);
  const caretH = fontSize * (p.caret === "block" ? 0.78 : 1.0);
  const caretGap = p.caret === "block" ? fontSize * 0.06 : fontSize * 0.03;
  const baselineY = height * p.y;

  const span = Math.max(plan.end + 30, 60);
  const push = 1 + p.push * progress(frame, p.at, span, intentCurves.glide);
  const origin = `${Math.min(caretX, width * p.anchor)}px ${baselineY}px`;

  return (
    <Stage background={p.ground} grain={p.grain}>
      <AbsoluteFill style={{ transform: `scale(${push})`, transformOrigin: origin }}>
        <div
          style={{
            position: "absolute",
            left: x0 + offset,
            top: baselineY - fontSize * 0.6,
            height: fontSize * 1.2,
            display: "flex",
            alignItems: "center",
            fontFamily: set.fontFamily,
            fontWeight: set.fontWeight,
            letterSpacing: set.letterSpacing,
            fontVariationSettings: set.fontVariationSettings,
            fontSize,
            lineHeight: 1,
            color: lineFade > 0 ? mixHex(ink, "#8A8A8A", lineFade) : ink,
            opacity: 1 - lineFade,
            whiteSpace: "pre",
          }}
        >
          {chips.length > 0 ? (
            lineNodes()
          ) : mark ? (
            <>
              {nbsp(graphemes.slice(0, mark.start).join(""))}
              <span
                style={mark.style === "select" ? { backgroundColor: p.accent, color: p.ground } : { opacity: 0.45 }}
              >
                {nbsp(graphemes.slice(mark.start, mark.end).join(""))}
              </span>
              {nbsp(graphemes.slice(mark.end).join(""))}
            </>
          ) : (
            <>
              {nbsp(before)}
              {lit ? <span style={{ color: p.accent }}>{nbsp(lit)}</span> : null}
              {after ? nbsp(after) : null}
            </>
          )}
        </div>
        {showCaret && lineFade === 0 ? (
          <div
            style={{
              position: "absolute",
              left: caretX + caretGap,
              top: baselineY - caretH / 2,
              width: caretW,
              height: caretH,
              backgroundColor: ink,
              borderRadius: p.caret === "bar" ? caretW / 2 : 2,
              boxShadow:
                p.caretGlow > 0
                  ? `0 0 ${fontSize * 0.25 * p.caretGlow}px ${fontSize * 0.06 * p.caretGlow}px ${ink}`
                  : undefined,
            }}
          />
        ) : null}
      </AbsoluteFill>
    </Stage>
  );
};

export const caretTrackDefaults: CaretTrackProps = {
  text: "Find founders who sold a company before thirty",
  at: 10,
  framesPerChar: 1.2,
  unit: "char",
  jitter: 0.35,
  backspaceAt: 88,
  keepWords: 3,
  backspaceStep: 2,
  emptyFrames: 6,
  retype: "are hiring their first designer",
  retypeMode: "type",
  scrambleFrames: 5,
  accent: "#FF4A3D",
  accentFrames: 4,
  caret: "block",
  caretGlow: 0,
  blinkCycle: 19,
  blinkOn: 10,
  face: "grotesk",
  size: 0.11,
  x: 0.08,
  y: 0.5,
  anchor: 0.62,
  followSmooth: 4,
  push: 0.04,
  ground: "#0C0C0D",
  ink: "#F3F1EC",
  grain: 0.03,
};

/** cashfree's placeholder: the line deleted by character at 1.5 a frame, 6 empty frames, the headline retyped at 2 a frame, on white. */
export const caretTrackCharBackspacePreset: CaretTrackProps = {
  ...caretTrackDefaults,
  text: "Your headline here",
  framesPerChar: 1,
  jitter: 0,
  backspaceAt: 40,
  keepWords: 0,
  backspaceUnit: "char",
  backspaceRate: 1.5,
  emptyFrames: 6,
  retype: "Payments that move at your speed",
  retypeFramesPerChar: 0.5,
  accentFrames: 0,
  caret: "bar",
  ground: "#FFFFFF",
  ink: "#111111",
  accent: "#2F6BFF",
  anchor: 0.86,
  push: 0,
  grain: 0,
};

/** abdulah's line: a chip riding the caret, parked, a second chip riding after it, then both out to the right as the line greys off. */
export const caretTrackChipPreset: CaretTrackProps = {
  ...caretTrackDefaults,
  text: "Every archive hides a second film",
  framesPerChar: 1,
  jitter: 0,
  backspaceAt: -1,
  retype: "",
  accentFrames: 0,
  caret: "bar",
  size: 0.07,
  x: 0.12,
  anchor: 0.9,
  push: 0,
  ground: "#EFEBE3",
  ink: "#1A1A1A",
  accent: "#C54A76",
  grain: 0.03,
  chips: [
    { at: 1, park: 14, colour: "#C54A76" },
    { at: 14, colour: "#3D5AFE" },
  ],
  chipSize: 0.62,
  chipExitAt: 70,
};

/** A cue on each word's first key (soft key clicks), the start of the backspace, the retype and the line's last key. */
export const caretTrackCues = (p: CaretTrackProps): Cue[] => {
  const plan = caretTrackPlan(p);
  if (p.retypeLine) return retypeLineCues(p.retypeLine.deleteMode, plan);
  const cues: Cue[] = [];
  let previous = "";
  let deleting = false;
  for (const key of plan.keys) {
    if (key.kind === "delete") {
      if (!deleting)
        cues.push({ frame: key.frame, kind: "type", sfx: "tick", weight: "support", label: "backspace by word" });
      deleting = true;
    } else if (key.kind === "scramble") {
      cues.push({ frame: key.frame, kind: "reveal", sfx: "glass", weight: "hero", label: "correction scrambles in" });
      deleting = false;
    } else {
      const added = key.text.slice(previous.length);
      const startsWord = previous === "" || /\s$/.test(previous) || deleting;
      if (startsWord && /\S/.test(added))
        cues.push({ frame: key.frame, kind: "type", sfx: "click", weight: "support" });
      deleting = false;
    }
    previous = key.text;
  }
  if (p.chipExitAt !== undefined && p.chipExitAt >= 0 && (p.chips?.length ?? 0) > 0)
    cues.push({ frame: p.chipExitAt, kind: "exit", sfx: "whoosh", weight: "support", label: "chip slides out" });
  const last = plan.keys.at(-1);
  if (last && last.kind === "type")
    cues.push({ frame: last.frame, kind: "land", sfx: "none", weight: "hero", label: "line complete" });
  return cues;
};

/**
 * Cues of `retypeLine`: a click on each word's first key of both lines, the selection (select-all), a tick on every
 * delete step by word (abdulah has onsets on four of its five chunks) or on the first one by character, a cut for "cut", and the
 * second line's last key landing.
 */
const retypeLineCues = (mode: NonNullable<CaretTrackProps["retypeLine"]>["deleteMode"], plan: CaretPlan): Cue[] => {
  const cues: Cue[] = [];
  for (const mark of plan.marks ?? [])
    if (mark.style === "select")
      cues.push({ frame: mark.from, kind: "click", sfx: "click", weight: "support", label: "line selected" });
  let previous = "";
  let deleting = false;
  for (const key of plan.keys) {
    if (key.kind === "delete") {
      if (mode === "cut")
        cues.push({ frame: key.frame, kind: "cut", sfx: "none", weight: "support", label: "line cut out" });
      else if (mode === "word" || !deleting)
        cues.push({
          frame: key.frame,
          kind: "type",
          sfx: "tick",
          weight: "support",
          label: mode === "select-all" ? "selection deleted" : `backspace by ${mode}`,
        });
      deleting = true;
    } else {
      const added = key.text.slice(previous.length);
      const startsWord = previous === "" || /\s$/.test(previous) || deleting;
      if (startsWord && /\S/.test(added))
        cues.push({
          frame: key.frame,
          kind: "type",
          sfx: "click",
          weight: "support",
          ...(deleting ? { label: "retype" } : {}),
        });
      deleting = false;
    }
    previous = key.text;
  }
  const last = plan.keys.at(-1);
  if (last && last.kind === "type")
    cues.push({ frame: last.frame, kind: "land", sfx: "none", weight: "hero", label: "second line complete" });
  return cues;
};

/**
 * abdulah's timing (0.13-4.33 s, 30 fps, animated on twos): a small serif line, no caret, typed about 2 frames a
 * character in uneven bursts, held 16 frames, the last word greyed 2 frames, deleted backwards by word on twos at 0.67
 * words a frame, 6 empty frames, the counter-line put on a word every 9 frames.
 */
export const caretTrackRetypeWordPreset: CaretTrackProps = {
  ...caretTrackDefaults,
  text: "Great work never waits for the right moment.",
  at: 4,
  framesPerChar: 2,
  unit: "char",
  jitter: 0.6,
  backspaceAt: -1,
  retype: "",
  retypeLine: {
    lines: ["Great work never waits for the right moment.", "Begin before you feel ready."],
    hold: 16,
    deleteMode: "word",
    deleteRate: 0.67,
    deleteStep: 2,
    markFrames: 2,
    emptyFrames: 6,
    retypeUnit: "word",
    retypeFramesPerUnit: 9,
  },
  accentFrames: 0,
  caret: "none",
  face: "serif",
  size: 0.085,
  x: 0.18,
  y: 0.47,
  anchor: 1,
  push: 0,
  ground: "#000000",
  ink: "#F2F0EA",
  grain: 0.02,
};

/**
 * cashfree's timing (18.63-21.73 s, 30 fps): a three-word placeholder typed a word every 5 frames with a bar caret,
 * held 40 frames, backspaced 2.1 characters a frame, 6 empty frames, the headline retyped a word every 3.4 frames;
 * caret solid 12 frames after a key (cashfree shows no off phase; 8 off is ours).
 */
export const caretTrackRetypeCharPreset: CaretTrackProps = {
  ...caretTrackDefaults,
  text: "Placeholder headline here",
  at: 5,
  framesPerChar: 5,
  unit: "word",
  jitter: 0,
  backspaceAt: -1,
  retype: "",
  retypeLine: {
    lines: ["Placeholder headline here", "Send invoices and get paid in days"],
    hold: 40,
    deleteMode: "char",
    deleteRate: 2.1,
    emptyFrames: 6,
    retypeUnit: "word",
    retypeFramesPerUnit: 3.4,
  },
  accentFrames: 0,
  caret: "bar",
  blinkCycle: 20,
  blinkOn: 12,
  size: 0.07,
  x: 0.12,
  y: 0.5,
  anchor: 0.9,
  push: 0,
  ground: "#FFFFFF",
  ink: "#111111",
  accent: "#2F6BFF",
  grain: 0,
};
