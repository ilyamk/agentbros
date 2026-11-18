import { Easing, random } from "remotion";
import { backspaceByChar } from "./text-modes";
import { progress, type Curve } from "./timing";

/**
 * Pure numbers under the reference-measured typography blocks: a caret typewriter that types, deletes by word and
 * retypes; a caret blink; the newest-word accent; the crop that follows the caret; a word split around an insert; a
 * giant word pulled back to reading size. No browser, so tests import this file directly.
 *
 * Every frame count is at 30 fps. Reference films measured at 60 fps (gojiberry, ace) or 24 fps (nexaa) were converted
 * by time, never copied as frame numbers.
 */

// --- Caret typing ---

export type CaretTypingOptions = {
  /** The first line typed. */
  text: string;
  /** Frame of the first keystroke. */
  at: number;
  /** Mean frames per character (per word when `unit` is "word"). 1.05 at 30 fps is gojiberry, 1.6 is muse. */
  framesPerChar: number;
  /** "char" types a character per key; "word" puts a whole word on per key (gojiberry's black typewriter). */
  unit?: "char" | "word";
  /** 0 = a dead-even tick; up to 1 = gaps vary by ±100% around the mean, which stays exact. */
  jitter?: number;
  seed?: string;
  /** Frame the backspace starts; -1 keeps the line. */
  backspaceAt?: number;
  /** Words left standing after the backspace (0 deletes the whole line). */
  keepWords?: number;
  /** Frames per deleted word chunk (abdulah: about 2). */
  backspaceStep?: number;
  /** "word" (default) deletes a word chunk every `backspaceStep` frames; "char" deletes `backspaceRate` characters a frame (cashfree). */
  backspaceUnit?: "word" | "char";
  /** Characters deleted a frame with `backspaceUnit: "char"` (cashfree: 1-2, so 1.5). */
  backspaceRate?: number;
  /** Empty frames between the last deletion and the retype (cashfree: 6). */
  emptyFrames?: number;
  /** Text typed after the kept words; empty for none. */
  retype?: string;
  /** Pace of the retype; defaults to `framesPerChar`. */
  retypeFramesPerChar?: number;
  /** "type" types the retype; "scramble" puts it on whole in one key, for the block to resolve from glyph noise. */
  retypeMode?: "type" | "scramble";
};

export type CaretKey = { frame: number; text: string; kind: "type" | "delete" | "scramble" };

export type CaretPlan = {
  keys: CaretKey[];
  /** Every distinct string the line shows, for measuring once up front. */
  strings: string[];
  /** Frame of the last key of the first line. */
  typedEnd: number;
  /** Frame the retype starts, or -1. */
  retypeAt: number;
  /** Frame of the last key of all. */
  end: number;
  /** Length of the kept prefix the retype is appended to (the scramble covers only what follows it). */
  keptLength: number;
  /** Character ranges drawn greyed or selected over a frame span (`retypeLinePlan` only). */
  marks?: CaretMark[];
};

/** A character range [start, end) of the text shown greyed ("dim") or selected, from frame `from` to before `to`. */
export type CaretMark = { from: number; to: number; start: number; end: number; style: "dim" | "select" };

/** Units of a string, each with the text up to and including it: graphemes, or words with their trailing space. */
const units = (text: string, unit: "char" | "word"): string[] => {
  if (unit === "char") return [...text];
  return text.match(/\S+\s*/g) ?? [];
};

/**
 * Frame of each unit: cumulative gaps of `pace` with a seeded spread whose mean is exactly `pace`, rounded once, so the
 * mean pace holds over any long run (unlike `typingSchedule`, whose pauses lengthen it).
 */
export const evenSchedule = (count: number, at: number, pace: number, jitter = 0, seed = "caret"): number[] => {
  const raw: number[] = [];
  let t = at;
  for (let i = 0; i < count; i++) {
    raw.push(t);
    const spread = jitter > 0 ? (random(`${seed}-${i}`) * 2 - 1) * jitter : 0;
    t += pace * (1 + spread);
  }
  // Re-scale the jitter so the last key lands where an even tick would: the mean pace is exact.
  if (jitter > 0 && count > 1) {
    const span = raw[count - 1]! - at;
    const even = pace * (count - 1);
    for (let i = 0; i < count; i++) raw[i] = at + ((raw[i]! - at) * even) / Math.max(span, 1e-9);
  }
  const frames = raw.map((value) => Math.round(value));
  for (let i = 1; i < frames.length; i++) if (frames[i]! < frames[i - 1]!) frames[i] = frames[i - 1]!;
  return frames;
};

/** Word chunk boundaries of a string, from the end: each entry is a shorter prefix, one word (and its spaces) gone. */
export const backspaceChunks = (text: string, keepWords: number): string[] => {
  const words = text.match(/\S+\s*/g) ?? [];
  const keep = Math.max(0, Math.min(keepWords, words.length));
  const out: string[] = [];
  for (let n = words.length - 1; n >= keep; n--) out.push(words.slice(0, n).join(""));
  return out;
};

export const caretTypingPlan = (options: CaretTypingOptions): CaretPlan => {
  const {
    text,
    at,
    framesPerChar,
    unit = "char",
    jitter = 0,
    seed = "caret",
    backspaceAt = -1,
    keepWords = 0,
    backspaceStep = 2,
    emptyFrames = 6,
    retype = "",
    retypeMode = "type",
  } = options;
  const keys: CaretKey[] = [];
  const first = units(text, unit);
  const firstFrames = evenSchedule(first.length, at, framesPerChar, jitter, `${seed}-a`);
  let shown = "";
  first.forEach((piece, index) => {
    shown += piece;
    keys.push({ frame: firstFrames[index]!, text: shown, kind: "type" });
  });
  const typedEnd = keys.at(-1)?.frame ?? at;
  let retypeAt = -1;
  let keptLength = text.length;
  if (backspaceAt >= 0) {
    const start = Math.max(backspaceAt, typedEnd + 1);
    const chunks = backspaceChunks(text, keepWords);
    const kept = chunks.at(-1) ?? text;
    if (options.backspaceUnit === "char" && chunks.length > 0)
      keys.push(...backspaceByChar(text, kept, start, options.backspaceRate ?? 1.5));
    else
      chunks.forEach((prefix, index) =>
        keys.push({ frame: start + index * backspaceStep, text: prefix, kind: "delete" }),
      );
    keptLength = kept.length;
    const lastDelete = keys.at(-1)!.frame;
    if (retype !== "") {
      retypeAt = lastDelete + Math.max(1, emptyFrames);
      // A kept word is followed by the retype with exactly one space between.
      const base = kept === "" ? "" : kept.replace(/\s*$/, " ");
      keptLength = base.length;
      if (retypeMode === "scramble") {
        keys.push({ frame: retypeAt, text: base + retype, kind: "scramble" });
      } else {
        const second = units(retype, unit);
        const secondFrames = evenSchedule(
          second.length,
          retypeAt,
          options.retypeFramesPerChar ?? framesPerChar,
          jitter,
          `${seed}-b`,
        );
        let typed = base;
        second.forEach((piece, index) => {
          typed += piece;
          keys.push({ frame: secondFrames[index]!, text: typed, kind: "type" });
        });
      }
    }
  }
  const strings = [...new Set(["", ...keys.map((key) => key.text)])];
  return { keys, strings, typedEnd, retypeAt, end: keys.at(-1)?.frame ?? at, keptLength };
};

// --- Delete a whole line and retype it ---

export type RetypeDeleteMode = "char" | "word" | "select-all" | "cut";

export type RetypeLineOptions = {
  /** The first line, then the line that replaces it. */
  lines: readonly [string, string];
  /** Frame of the first keystroke. */
  at: number;
  /** Mean frames per unit of the first line. */
  framesPerChar: number;
  unit?: "char" | "word";
  jitter?: number;
  seed?: string;
  /** Frames from the first line's last key to the start of the removal (abdulah 16, cashfree 40). */
  hold: number;
  /** Backspace by character or word chunk, show the line selected then delete it in one key, or cut it out on one frame. */
  deleteMode: RetypeDeleteMode;
  /** "char"/"word": units removed a frame (cashfree 2.1 characters, abdulah 0.67 words). */
  deleteRate: number;
  /** Frames between visible delete steps: 1, or 2 for a film animated on twos (abdulah). */
  deleteStep?: number;
  /** "word"/"char": frames the last word shows greyed before the first deletion (abdulah 2). "select-all": frames the whole line shows selected. */
  markFrames?: number;
  /** Empty frames (caret alone) between the last deletion and the first key of the second line (cashfree: 6; abdulah never empties, its kept word holds 8). */
  emptyFrames: number;
  /** Units of the second line; defaults to `unit` (cashfree retypes by word). */
  retypeUnit?: "char" | "word";
  /** Frames per unit of the second line; defaults to `framesPerChar` (cashfree 3.4 a word). */
  retypeFramesPerUnit?: number;
};

/**
 * Keys that remove `text` backwards from `start`: by character or word at `rate` units a frame, a visible step every
 * `step` frames (cumulative, rounded, so the mean rate is exact and a step can remove 0, 1 or several); one delete key
 * for "select-all" and "cut". The last key always shows the empty line.
 */
export const deleteSteps = (
  text: string,
  mode: RetypeDeleteMode,
  start: number,
  rate: number,
  step = 1,
): CaretKey[] => {
  if (text === "") return [];
  if (mode === "select-all" || mode === "cut") return [{ frame: start, text: "", kind: "delete" }];
  const pieces = units(text, mode);
  const keys: CaretKey[] = [];
  const perStep = Math.max(1e-3, rate * Math.max(1, step));
  let removed = 0;
  for (let k = 0; removed < pieces.length; k++) {
    const next = Math.min(pieces.length, Math.round((k + 1) * perStep));
    if (next > removed) {
      removed = next;
      keys.push({
        frame: start + k * Math.max(1, step),
        text: pieces.slice(0, pieces.length - removed).join(""),
        kind: "delete",
      });
    }
  }
  return keys;
};

/**
 * A first line types, holds `hold` frames after its last key, is removed whole (`deleteMode`), the line stays empty
 * `emptyFrames`, then the second line types in its place. abdulah 0.13-4.33 s and cashfree 18.63-21.73 s
 * (design-reference/techniques/delete-and-retype-line.md).
 */
export const retypeLinePlan = (o: RetypeLineOptions): CaretPlan => {
  const {
    lines,
    at,
    framesPerChar,
    unit = "char",
    jitter = 0,
    seed = "retype",
    hold,
    deleteMode,
    deleteRate,
    deleteStep = 1,
    emptyFrames,
  } = o;
  const [first, second] = lines;
  const keys: CaretKey[] = [];
  const marks: CaretMark[] = [];
  const firstUnits = units(first, unit);
  const firstFrames = evenSchedule(firstUnits.length, at, framesPerChar, jitter, `${seed}-a`);
  let shown = "";
  firstUnits.forEach((piece, index) => {
    shown += piece;
    keys.push({ frame: firstFrames[index]!, text: shown, kind: "type" });
  });
  const typedEnd = keys.at(-1)?.frame ?? at;
  const markAt = typedEnd + Math.max(1, hold);
  const markFrames = Math.max(0, o.markFrames ?? (deleteMode === "select-all" ? 8 : 0));
  if (markFrames > 0 && deleteMode !== "cut") {
    const trimmed = first.replace(/\s+$/, "");
    const start = deleteMode === "select-all" ? 0 : trimmed.lastIndexOf(" ") + 1;
    marks.push({
      from: markAt,
      to: markAt + markFrames,
      start,
      end: trimmed.length,
      style: deleteMode === "select-all" ? "select" : "dim",
    });
  }
  const deleteAt = markAt + (deleteMode === "cut" ? 0 : markFrames);
  keys.push(...deleteSteps(first, deleteMode, deleteAt, deleteRate, deleteStep));
  const lastDelete = keys.at(-1)!.frame;
  const retypeAt = lastDelete + Math.max(1, emptyFrames);
  const secondUnits = units(second, o.retypeUnit ?? unit);
  const secondFrames = evenSchedule(
    secondUnits.length,
    retypeAt,
    o.retypeFramesPerUnit ?? framesPerChar,
    jitter,
    `${seed}-b`,
  );
  let typed = "";
  secondUnits.forEach((piece, index) => {
    typed += piece;
    keys.push({ frame: secondFrames[index]!, text: typed, kind: "type" });
  });
  const strings = [...new Set(["", ...keys.map((key) => key.text)])];
  return { keys, strings, typedEnd, retypeAt, end: keys.at(-1)?.frame ?? at, keptLength: 0, marks };
};

/** The mark drawn on a frame, or null. */
export const caretMarkAt = (frame: number, plan: CaretPlan): CaretMark | null =>
  plan.marks?.find((mark) => frame >= mark.from && frame < mark.to) ?? null;

/** The latest key at or before a frame, or null before the first. */
export const caretKeyAt = (frame: number, plan: CaretPlan): CaretKey | null => {
  let found: CaretKey | null = null;
  for (const key of plan.keys) {
    if (key.frame > frame) break;
    found = key;
  }
  return found;
};

/** Text on screen at a frame. */
export const caretTextAt = (frame: number, plan: CaretPlan): string => caretKeyAt(frame, plan)?.text ?? "";

/**
 * Is the caret drawn on this frame? Solid for `on` frames after every keystroke (so it never blinks while typing),
 * then on/off on a `cycle` (airform: 19 frames, about 10 on and 9 off).
 */
export const caretOn = (
  frame: number,
  lastKeyFrame: number,
  { cycle = 19, on = 10 }: { cycle?: number; on?: number } = {},
): boolean => {
  const since = frame - lastKeyFrame;
  if (since < 0) return true;
  return ((since % cycle) + cycle) % cycle < on;
};

/**
 * Character range [start, end) of the newest word while it is accented: from its first key until `accentFrames` after
 * it completes (a space typed after it, or the line ending). Null when no word is accented. Deletions clear it.
 */
export const newestWordAccent = (
  frame: number,
  plan: CaretPlan,
  accentFrames: number,
): { start: number; end: number } | null => {
  const keys = plan.keys;
  let index = -1;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i]!.frame > frame) break;
    index = i;
  }
  if (index < 0) return null;
  const key = keys[index]!;
  if (key.kind === "delete") return null;
  const text = key.text;
  const trimmed = text.replace(/\s+$/, "");
  const start = trimmed.lastIndexOf(" ") + 1;
  if (trimmed.length === 0) return null;
  const range = { start, end: trimmed.length };
  // Still mid-word: the next key adds a letter to this word.
  const next = keys[index + 1];
  const added = next && next.kind === "type" && next.text.startsWith(text) ? next.text.slice(text.length) : "";
  if (added !== "" && /^\S/.test(added) && !/\s$/.test(text)) return range;
  // Otherwise it completed at the earliest key of this run that already shows the whole word.
  let completedAt = key.frame;
  for (let i = index - 1; i >= 0; i--) {
    const k = keys[i]!;
    if (k.kind === "delete" || !k.text.startsWith(trimmed)) break;
    completedAt = k.frame;
  }
  // `completedAt` is the key that first showed the whole word (with or without its space).
  return frame - completedAt < accentFrames ? range : null;
};

/**
 * Horizontal offset of a line so that its caret holds at `anchor` once the line passes it: min(0, anchor − caretX),
 * averaged over the last `smooth` frames so the crop glides instead of stepping a glyph at a time.
 */
export const caretFollow = (
  frame: number,
  caretXAt: (frame: number) => number,
  { anchor, smooth = 4 }: { anchor: number; smooth?: number },
): number => {
  const n = Math.max(1, Math.round(smooth));
  let sum = 0;
  for (let k = 0; k < n; k++) sum += Math.min(0, anchor - caretXAt(frame - k));
  return sum / n;
};

// --- Word split ---

/** Measured eases: foren's gap opens accelerating (power2.in), the inserted card settles power3.out, muse throws the words with a jump then a power2.out drift. */
export const splitCurves = {
  open: Easing.bezier(0.55, 0.085, 0.68, 0.53) as Curve,
  settle: Easing.bezier(0.215, 0.61, 0.355, 1) as Curve,
  /** The drift after the fling's first-frame jump: power2.out, so the cropped halves linger at the edges about 13 frames. */
  fling: Easing.bezier(0.25, 0.46, 0.45, 0.94) as Curve,
};

export type SplitOptions = {
  /** Frame the gap starts to open. */
  openAt: number;
  /** Frames to open the gap (foren: 5). */
  openFrames: number;
  /** Gap the halves part to before the insert, in px (foren: 0.08 of frame width). */
  gap: number;
  /** Frame the insert appears in the gap. */
  insertAt: number;
  /** Frames for the insert to grow from a dot and settle (foren: 5; muse pops in about 3). */
  settleFrames: number;
  /** Width of the insert once settled, px. */
  insertWidth: number;
  /** Space between the insert and each half once it sits, px. */
  margin: number;
  /** "part": halves frame the insert; "fling": halves scale up and fly off both edges (muse). */
  mode: "part" | "fling";
  /** Frames of the fling (muse: about 13). */
  flingFrames: number;
  /** Distance each half travels in the fling, px: one for both, or [left, right] (each half's inner edge to its frame edge clears it). */
  flingDistance: number | readonly [number, number];
  /** Scale the halves reach in the fling. */
  flingScale: number;
  /** Share of the throw done on its first frame, the rest drifting out on expo.out (muse: about 0.65, the words jump to the edges with the pop). */
  flingJump?: number;
};

/** Progress of the fling: 0 before `from`, a jump on the first frame, then the rest decelerating. */
export const flingProgress = (frame: number, from: number, frames: number, jump = 0.65): number =>
  frame < from ? 0 : jump + (1 - jump) * progress(frame, from, frames, splitCurves.fling);

export type SplitState = {
  /** Offset of the left half (negative: to the left) and of the right half, px from their closed places. */
  left: number;
  right: number;
  /** Scale of both halves. */
  scale: number;
  /** Insert size 0..1 (dot to full). */
  insert: number;
};

/**
 * Where the halves and the insert are. Closed until `openAt`; the gap opens accelerating to `gap`; from `insertAt` the
 * insert grows and the halves make room (part) or, once it is full, are thrown off the edges (fling).
 */
export const splitState = (frame: number, o: SplitOptions): SplitState => {
  const opened = progress(frame, o.openAt, o.openFrames, splitCurves.open) * o.gap;
  const grow = progress(frame, o.insertAt, o.settleFrames, splitCurves.settle);
  if (o.mode === "fling") {
    // The throw starts the frame the insert is full: the pop and the jump to the edges are one event.
    const fling = flingProgress(frame, o.insertAt + o.settleFrames, o.flingFrames, o.flingJump ?? 0.65);
    const [toLeft, toRight] =
      typeof o.flingDistance === "number" ? [o.flingDistance, o.flingDistance] : o.flingDistance;
    // Until the throw, the halves make just enough room for the growing insert.
    const base = Math.max(opened, grow * o.insertWidth + o.margin * 2 * grow) / 2;
    // The distances are from the closed line, so the throw covers what is left of them after the room already made.
    return {
      left: -(base + fling * Math.max(0, toLeft - base)),
      right: base + fling * Math.max(0, toRight - base),
      scale: 1 + (o.flingScale - 1) * fling,
      insert: grow,
    };
  }
  const roomNeeded = Math.max(opened, o.insertWidth + o.margin * 2);
  const half = (opened + (roomNeeded - opened) * grow) / 2;
  return { left: -half, right: half, scale: 1, insert: grow };
};

// --- Giant word pull-out ---

/**
 * nexaa's pull-out, fitted to the word's width frame by frame (F0-F14 at 24 fps): it holds near full size for the first
 * fifth, then brakes hard into place (half the travel by a third of the time, 93% by 0.7). The camera fit in its
 * motion.json, bezier(0.306, 0.311, 0.028, 1.046), runs about 3 frames ahead of the type and is not used.
 */
export const pullOutCurve: Curve = Easing.bezier(0.5, 0.2, 0.15, 1);

/**
 * Scale of a word pulled back from `from` (times its settled size) to 1 over `frames`. nexaa: 2.5x to 43% of the frame
 * width, settled by 14 frames at 24 fps (17-18 at 30). Linear in scale, as the camera fit measured it: the word stays
 * frame-filling for the first few frames, then brakes into place.
 */
export const pullOutScale = (
  frame: number,
  { at, frames, from }: { at: number; frames: number; from: number },
): number => {
  const t = progress(frame, at, frames, pullOutCurve);
  return from + (1 - from) * t;
};
