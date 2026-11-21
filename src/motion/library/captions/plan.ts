import { interpolate, spring } from "remotion";
import { pageTiers } from "../../../lib/captions/emphasis";
import { pageAt, type CaptionPage, type CaptionWord } from "../../../lib/captions/pages";
import {
  checkCaptionBackground,
  checkCaptionSizes,
  type Box,
  type ContrastBacking,
  type ContrastPair,
  type ReadabilityFinding,
} from "../../../lib/captions/readability";
import { progress } from "../../timing";
import { faceMetrics, type FaceId } from "./faces";
import { captionLayout, displayText, keywordOf, type CaptionLayout, type CaptionMetrics } from "./layout";
import { escalate, legibilityLevel, positionAt, type CaptionBacking, type CaptionStyleProps } from "./style";

/** Width of `text` set in `face` at 1 px, and the face's ascent and descent in em: measured in the browser, faked in tests. */
export type Measure = {
  width: (text: string, face: FaceId) => number;
  ascent: (face: FaceId) => number;
  descent: (face: FaceId) => number;
};

export type PlannedWord = {
  key: string;
  /** Displayed text (a typed prefix while typing). */
  text: string;
  face: FaceId;
  fontSize: number;
  /** The word's slot, frame pixels, before its transform. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Horizontal padding inside the slot, px. */
  padX: number;
  colour: string;
  opacity: number;
  scale: number;
  translateY: number;
  blurPx: number;
  /** Outline and shadow are drawn only where no box stands behind the word. */
  treated: boolean;
  /** `small`: a connective word set below the base size in a mixed page; minimum sizes differ. */
  role: WordRole;
};

export type PlannedBox = {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
  fill: string;
  opacity: number;
};

export type CaptionFrame = {
  words: PlannedWord[];
  boxes: PlannedBox[];
  /** The accent box behind the spoken word. */
  activeBox: PlannedBox | null;
  cursor: { left: number; top: number; width: number; height: number; colour: string } | null;
  emoji: { text: string; centreX: number; bottom: number; size: number; rise: number } | null;
  /** Transform of the whole page (page reveal). */
  page: { opacity: number; scale: number; translateY: number; blurPx: number; originX: number; originY: number };
  lineHeight: number;
  /** Where the page sits: the props' position, or the measured one for this page. */
  position: CaptionStyleProps["position"];
  /** The backing this page draws: the preset's, or a rung of its ladder when the page's legibility level is above 0. */
  backing: CaptionBacking;
  level: number;
};

const LINE_HEIGHT = { lines: 1.12, stack: 1.0, mixed: 1.04 } as const;
const MIXED_SIZE = { small: 0.62, base: 1, serif: 1.25 } as const;

/** Metrics the page builder and the safe-zone box use for a preset; fitting later measures the real widths. */
export const presetMetrics = (p: CaptionStyleProps): CaptionMetrics => {
  const metrics = faceMetrics(p.face);
  const box = p.backing.kind === "box" && p.backing.scope === "word" ? p.backing.padX : p.active.box ? 0.14 : 0;
  return {
    fontShare: p.size,
    charWidthEm: metrics.charWidthEm,
    lineHeight: LINE_HEIGHT[p.layout],
    uppercase: p.uppercase,
    wordPadEm: box,
    activeScale: Math.max(p.active.scale, p.layout === "lines" ? p.emphasis.scale : 1),
    maxLines: p.maxLines,
    strictWords: p.layout !== "lines",
  };
};

// Stacked and mixed pages put words on their own lines, so a page needs only its word limit, not a character budget.
export const presetLayout = (p: CaptionStyleProps, width: number, height: number): CaptionLayout =>
  captionLayout(p, p.layout === "lines" ? presetMetrics(p) : { ...presetMetrics(p), charWidthEm: 0.01 }, width, height);

export type WordRole = "small" | "base" | "key" | "serif";

/** Roles for one page: key words from `pageTiers`, and in mixed layout with `serif` the runner-up as the serif word. */
export const pageRoles = (p: CaptionStyleProps, words: readonly CaptionWord[]): WordRole[] => {
  const keywords = p.keywords.map((keyword) => keyword.word);
  const mixedSerif = p.layout === "mixed" && p.emphasis.serif && words.length >= 3;
  const tiers = pageTiers(words, p.language, { keywords, source: p.emphasis.source, maxKeys: mixedSerif ? 2 : 1 });
  if (!mixedSerif) return tiers;
  const keys = tiers.flatMap((tier, index) => (tier === "key" ? [index] : []));
  if (keys.length < 2) return tiers;
  const solo = pageTiers(words, p.language, { keywords, source: p.emphasis.source, maxKeys: 1 });
  return tiers.map((tier, index) => (tier === "key" && solo[index] !== "key" ? "serif" : tier));
};

const arrange = (p: CaptionStyleProps, page: CaptionPage, roles: readonly WordRole[]): number[][] => {
  if (p.layout === "stack") return page.words.map((_, index) => [index]);
  if (p.layout === "lines") return page.lines;
  const key = roles.indexOf("key");
  const lines =
    key < 0
      ? page.lines.map((line) => [...line])
      : [
          page.words.slice(0, key).map((_, index) => index),
          [key],
          page.words.slice(key + 1).map((_, index) => key + 1 + index),
        ].filter((line) => line.length);
  // A run of small words on one line would shrink the whole page to fit the width; split the longest while lines remain.
  while (lines.length < p.maxLines) {
    const longest = lines.reduce((best, line, index) => (line.length > lines[best]!.length ? index : best), 0);
    const line = lines[longest]!;
    if (line.length < 3) break;
    const half = Math.ceil(line.length / 2);
    lines.splice(longest, 1, line.slice(0, half), line.slice(half));
  }
  return lines;
};

const frameOf = (seconds: number, p: CaptionStyleProps, fps: number) => Math.round((seconds - p.startOffsetSec) * fps);

/** Entry of one element arriving at frame `at`: opacity, scale, rise (em) and blur (em). Every value is a function of the frame. */
export const entryAt = (
  entry: CaptionStyleProps["entry"],
  frame: number,
  at: number,
  fps: number,
): { opacity: number; scale: number; riseEm: number; blurEm: number } => {
  if (frame < at) return { opacity: 0, scale: 1, riseEm: 0, blurEm: 0 };
  const appear = progress(frame, at, 2, "linear");
  switch (entry) {
    case "pop":
      return { opacity: appear, scale: 0.55 + 0.45 * progress(frame, at, 6, "overshoot"), riseEm: 0, blurEm: 0 };
    case "rise": {
      const t = progress(frame, at, 6, "expoOut");
      return { opacity: progress(frame, at, 4, "linear"), scale: 1, riseEm: (1 - t) * 0.4, blurEm: 0 };
    }
    case "fade":
      return { opacity: progress(frame, at, 4, "linear"), scale: 1, riseEm: 0, blurEm: 0 };
    case "blur": {
      const t = progress(frame, at, 7, "expoOut");
      return {
        opacity: progress(frame, at, 5, "linear"),
        scale: interpolate(t, [0, 1], [1.06, 1]),
        riseEm: (1 - t) * 0.12,
        blurEm: (1 - t) * 0.16,
      };
    }
    case "bounce": {
      const s = spring({ frame: frame - at, fps, config: { damping: 14, stiffness: 300, mass: 0.5 } });
      return { opacity: appear, scale: 1, riseEm: (1 - s) * 0.55, blurEm: 0 };
    }
    case "slam": {
      const t = progress(frame, at, 5, "expoOut");
      return { opacity: appear, scale: 1 + 0.45 * (1 - t), riseEm: 0, blurEm: (1 - t) * 0.05 };
    }
    default:
      return { opacity: 1, scale: 1, riseEm: 0, blurEm: 0 };
  }
};

/** Characters of a word typed by `time`: the word types over its spoken length, at most 45 ms a character. */
export const typedCount = (word: CaptionWord, text: string, time: number): number => {
  if (time < word.start) return 0;
  const duration = Math.max(0.05, Math.min(word.end - word.start, text.length * 0.045));
  return Math.min(text.length, Math.ceil(((time - word.start) / duration) * text.length));
};

type BoxRect = Pick<PlannedBox, "left" | "top" | "width" | "height">;

export const elasticBoxRect = (
  from: BoxRect | undefined,
  to: BoxRect,
  frame: number,
  at: number,
  frames: number,
): BoxRect => {
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  if (!from) {
    const open = mix(0.8, 1, progress(frame, at, Math.max(1, frames * 0.5), "expoOut"));
    return { ...to, left: to.left + (to.width * (1 - open)) / 2, width: to.width * open };
  }
  const ahead = progress(frame + 1, at, Math.max(1, frames * 0.45), "expoOut");
  const behind = progress(frame, at, frames, "drift");
  const rightward = to.left + to.width / 2 >= from.left + from.width / 2;
  const left = mix(from.left, to.left, rightward ? behind : ahead);
  const right = mix(from.left + from.width, to.left + to.width, rightward ? ahead : behind);
  return { ...to, left, width: Math.max(1, right - left) };
};

/**
 * Everything one frame of a caption preset draws, in frame pixels: word slots with their animation, boxes, the active
 * box, a typing cursor and an emoji. Pure: the same props, measurements and frame give the same plan.
 */
export const planCaptionFrame = (
  preset: CaptionStyleProps,
  layout: CaptionLayout,
  measure: Measure,
  frame: number,
  fps: number,
  frameHeight: number,
  forceLevel?: number,
  forcePosition?: CaptionStyleProps["position"],
): CaptionFrame | null => {
  const time = frame / fps + preset.startOffsetSec;
  const state = pageAt(layout.pages, time);
  if (!state) return null;
  const { page, activeIndex } = state;
  // Pages were built from the preset; a level changes only colours and the backing, so the page stays the same.
  const level = forceLevel ?? legibilityLevel(preset, page.start);
  const position = forcePosition ?? positionAt(preset, page.start);
  const p = { ...escalate(preset, level), position };
  const zone = layout.boxes[position];
  const roles = pageRoles(p, page.words);
  const lines = arrange(p, page, roles);
  const backing = p.backing;
  const lineHeight = LINE_HEIGHT[p.layout];
  const faceOf = (role: WordRole): FaceId => (role === "serif" ? "serif-italic" : p.face);
  const texts = page.words.map((word) => displayText(word.text, p.uppercase, p.language));
  const wordPadEm = backing.kind === "box" && backing.scope === "word" ? backing.padX : p.active.box ? 0.14 : 0;
  const gapEm = p.uppercase ? 0.3 : 0.26;
  const grow = Math.max(p.active.scale, p.entry === "pop" ? 1.05 : 1) - 1;
  // The widest edge any rung of the ladder draws, so a page has the same geometry at every legibility level.
  const edgeEm = Math.max(
    ...[preset.backing, ...preset.fallbacks.flatMap((rung) => (rung.backing ? [rung.backing] : []))].map((b) =>
      b.kind === "box" && b.scope !== "word" ? b.padX * 2 : b.kind === "outline" ? b.width * 2 : 0.1,
    ),
  );
  const staggerEm = p.layout === "mixed" && lines.length > 1 ? 0.35 : 0;
  const lineGapEm =
    backing.kind === "box" && backing.scope !== "word" ? backing.padY * 2 : p.layout === "mixed" ? -0.04 : 0.02;
  const boxWidth = zone.right - zone.left;
  const maxHeight = (zone.bottom - zone.top) * (p.placement === "inline" ? 1 : 1.4);
  const fit = (keyScale: number) => {
    const sizeOf = (role: WordRole) =>
      p.layout === "mixed"
        ? role === "key"
          ? keyScale
          : MIXED_SIZE[role]
        : role === "key" && p.layout === "lines"
          ? keyScale
          : 1;
    // Width of each word at a 1 px font: text, its padding and the room its pop needs on both sides.
    const wordEm = page.words.map((_, index) => {
      const role = roles[index]!;
      const em = measure.width(texts[index]!, faceOf(role));
      return { text: em * sizeOf(role), pad: wordPadEm * sizeOf(role), reserve: (grow * em * sizeOf(role)) / 2 };
    });
    const lineEm = lines.map((line) =>
      line.reduce((sum, index, position) => {
        const w = wordEm[index]!;
        const gap = position ? (gapEm * (sizeOf(roles[line[position - 1]!]!) + sizeOf(roles[index]!))) / 2 : 0;
        return sum + w.text + w.pad * 2 + w.reserve * 2 + gap;
      }, 0),
    );
    const lineSize = lines.map((line) => Math.max(...line.map((index) => sizeOf(roles[index]!))));
    const heightEm = lineSize.reduce((sum, size) => sum + size * lineHeight, 0) + lineGapEm * (lines.length - 1);
    const byWidth = lineEm.map((em) => (boxWidth * 0.97) / (em + edgeEm + staggerEm * (lines.length - 1)));
    const fontSize = Math.min(layout.maxFontPx, ...byWidth, maxHeight / heightEm);
    const binding = byWidth.indexOf(Math.min(...byWidth));
    return {
      sizeOf,
      wordEm,
      lineEm,
      lineSize,
      heightEm,
      fontSize,
      keyBinds: fontSize === byWidth[binding] && lines[binding]!.some((index) => roles[index] === "key"),
    };
  };
  // A long key word in a mixed page would shrink every other word below the readable minimum: it gives up scale
  // first, down to 1.3x, before the page shrinks.
  let keyScale = p.emphasis.scale;
  let fitted = fit(keyScale);
  for (let step = 0; p.layout === "mixed" && fitted.keyBinds && keyScale > 1.3 && step < 4; step++) {
    keyScale = Math.max(1.3, (keyScale * fitted.fontSize) / layout.maxFontPx);
    const next = fit(keyScale);
    if (next.fontSize <= fitted.fontSize + 0.01) break;
    fitted = next;
  }
  const { sizeOf, wordEm, lineEm, lineSize, heightEm, fontSize } = fitted;

  // Vertical placement: lower pages sit on the bottom of the box, upper on its top, middle on the frame centre.
  const blockHeight = heightEm * fontSize;
  const safeTop = zone.top + layout.padPx;
  const safeBottom = zone.bottom - layout.padPx;
  const top =
    p.placement === "inline"
      ? 0
      : p.position === "upper"
        ? safeTop
        : p.position === "middle"
          ? Math.min(Math.max(frameHeight / 2 - blockHeight / 2, safeTop), safeBottom - blockHeight)
          : safeBottom - blockHeight;
  const centreX = p.placement === "inline" ? boxWidth / 2 : (zone.left + zone.right) / 2;

  const pageFrame = frameOf(page.start, p, fps);
  const words: PlannedWord[] = [];
  const boxes: PlannedBox[] = [];
  const slots: { left: number; top: number; width: number; height: number }[] = [];
  let y = top;
  lines.forEach((line, lineIndex) => {
    const size = lineSize[lineIndex]!;
    const height = size * lineHeight * fontSize;
    // Baselines align across sizes and faces: the tallest baseline in the line sets it.
    const baseline = (role: WordRole) => {
      const face = faceOf(role);
      const s = sizeOf(role) * fontSize;
      const contentEm = measure.ascent(face) + measure.descent(face);
      return ((lineHeight - contentEm) / 2 + measure.ascent(face)) * s;
    };
    const lineBaseline = Math.max(...line.map((index) => baseline(roles[index]!)));
    const offset = (lineIndex - (lines.length - 1) / 2) * staggerEm * fontSize;
    // Typed lines share a left edge, so the text grows rightwards from one margin like a typewriter's.
    const lineStartEm = p.entry === "typewriter" ? Math.max(...lineEm) : lineEm[lineIndex]!;
    let x = centreX + offset - (lineStartEm * fontSize) / 2;
    line.forEach((index, position) => {
      const role = roles[index]!;
      const s = sizeOf(role);
      const w = wordEm[index]!;
      if (position) x += (gapEm * (sizeOf(roles[line[position - 1]!]!) + s) * fontSize) / 2;
      x += w.reserve * fontSize;
      const slotHeight = s * lineHeight * fontSize;
      slots[index] = {
        left: x,
        top: y + lineBaseline - baseline(role),
        width: (w.text + w.pad * 2) * fontSize,
        height: slotHeight,
      };
      x += (w.text + w.pad * 2 + w.reserve) * fontSize;
    });
    if (backing.kind === "box" && backing.scope === "line") {
      const visible = line.filter((index) => p.reveal === "page" || frame >= frameOf(page.words[index]!.start, p, fps));
      if (visible.length) {
        const first = slots[line[0]!]!;
        const last = slots[visible.at(-1)!]!;
        const typedRight =
          p.entry === "typewriter"
            ? (() => {
                const index = visible.at(-1)!;
                const count = typedCount(page.words[index]!, texts[index]!, time);
                return (
                  slots[index]!.left +
                  measure.width(texts[index]!.slice(0, count), faceOf(roles[index]!)) *
                    sizeOf(roles[index]!) *
                    fontSize +
                  0.62 * fontSize
                );
              })()
            : last.left + last.width;
        const padX = backing.padX * fontSize;
        const padY = backing.padY * fontSize;
        boxes.push({
          key: `line-${lineIndex}`,
          left: first.left - padX,
          top: y - padY,
          width: typedRight - first.left + padX * 2,
          height: height + padY * 2,
          radius: backing.radius * fontSize,
          fill: backing.fill,
          opacity: 1,
        });
      }
    }
    y += height + lineGapEm * fontSize;
  });
  if (backing.kind === "box" && backing.scope === "page" && boxes.length === 0) {
    const padX = backing.padX * fontSize;
    const padY = backing.padY * fontSize;
    const left = Math.min(...slots.map((slot) => slot.left));
    const right = Math.max(...slots.map((slot) => slot.left + slot.width));
    boxes.push({
      key: "page",
      left: left - padX,
      top: top - padY,
      width: right - left + padX * 2,
      height: blockHeight + padY * 2,
      radius: backing.radius * fontSize,
      fill: backing.fill,
      opacity: 1,
    });
  }

  // When each word stopped being the spoken one: the next word's start, or the end of the page.
  const releaseFrame = (index: number) => frameOf(page.words[index + 1]?.start ?? page.end, p, fps);
  page.words.forEach((word, index) => {
    const role = roles[index]!;
    const slot = slots[index]!;
    const s = sizeOf(role);
    const wordFrame = frameOf(word.start, p, fps);
    const spoken = time >= word.start;
    const active = index === activeIndex;
    let scale = 1;
    if (p.active.scale > 1 && spoken) {
      scale = active
        ? 1 + (p.active.scale - 1) * progress(frame, wordFrame, 6, "overshoot")
        : 1 +
          (p.active.scale - 1) *
            (1 - progress(frame, releaseFrame(index), 4, "expoOut")) *
            (frame >= releaseFrame(index) ? 1 : 0);
    }
    const switched = p.active.fill === "switch";
    let opacity = p.reveal === "page" && !spoken && !switched ? p.active.upcomingOpacity : 1;
    let translateY = 0;
    let blurPx = 0;
    let text = texts[index]!;
    if (p.reveal === "word") {
      if (p.entry === "typewriter") text = text.slice(0, typedCount(word, text, time));
      else {
        const e = entryAt(p.entry, frame, wordFrame, fps);
        opacity *= e.opacity;
        scale *= e.scale;
        translateY = e.riseEm * fontSize * s;
        blurPx = e.blurEm * fontSize * s;
      }
    } else if (p.entry !== "typewriter" && p.entry !== "none" && p.entry !== "fade") {
      // A page that pops arrives word by word, one frame apart, so it lands with a ripple instead of a block.
      const e = entryAt(p.entry, frame, pageFrame + Math.min(index, 4), fps);
      if (p.entry === "pop" || p.entry === "bounce") {
        opacity *= e.opacity;
        scale *= e.scale;
        translateY = e.riseEm * fontSize * s;
      }
    }
    const inActiveBox = p.active.box && active;
    const colour = inActiveBox
      ? p.active.boxText
      : (active && p.active.recolour) || (switched && spoken)
        ? p.accent
        : role === "serif"
          ? p.accent2
          : role === "key" && p.emphasis.recolour
            ? p.accent
            : p.textColor;
    words.push({
      key: `${index}`,
      text,
      face: faceOf(role),
      fontSize: s * fontSize,
      left: slot.left,
      top: slot.top,
      width: slot.width,
      height: slot.height,
      padX: wordEm[index]!.pad * fontSize,
      colour,
      opacity,
      scale,
      translateY,
      blurPx,
      treated: !(backing.kind === "box") && !inActiveBox,
      role,
    });
    if (backing.kind === "box" && backing.scope === "word" && opacity > 0)
      boxes.push({
        key: `word-${index}`,
        left: slot.left,
        top: slot.top + slot.height * 0.04,
        width: slot.width,
        height: slot.height * 0.92,
        radius: backing.radius * s * fontSize,
        fill: backing.fill,
        opacity,
      });
  });

  // The cursor follows the last word typed; it blinks every 8 frames once that word is complete.
  let cursor: CaptionFrame["cursor"] = null;
  const typing =
    p.entry === "typewriter" ? page.words.reduce((last, word, index) => (time >= word.start ? index : last), -1) : -1;
  if (typing >= 0) {
    const word = words[typing]!;
    const done = word.text.length === texts[typing]!.length;
    const doneFrame = frameOf(
      page.words[typing]!.start +
        Math.min(page.words[typing]!.end - page.words[typing]!.start, texts[typing]!.length * 0.045),
      p,
      fps,
    );
    if (!done || Math.floor((frame - doneFrame) / 8) % 2 === 0)
      cursor = {
        left: word.left + measure.width(word.text, word.face) * word.fontSize + 0.06 * fontSize,
        top: word.top + word.height * 0.14,
        width: 0.5 * word.fontSize,
        height: word.height * 0.72,
        colour: p.accent,
      };
  }

  // The accent box glides from the previous word to the spoken one over four frames.
  let activeBox: PlannedBox | null = null;
  if (p.active.box && activeIndex >= 0) {
    const word = words[activeIndex]!;
    const at = frameOf(page.words[activeIndex]!.start, p, fps);
    const rect = (w: PlannedWord) => {
      const grow = (w.scale - 1) / 2;
      return {
        left: w.left - w.width * grow,
        top: w.top + w.height * 0.06 - w.height * grow,
        width: w.width * w.scale,
        height: w.height * 0.88 * w.scale,
      };
    };
    const to = rect(word);
    const previous = activeIndex > 0 ? words[activeIndex - 1] : undefined;
    const t = progress(frame, at, 4, "expoOut");
    const from = previous
      ? rect({ ...previous, scale: 1 })
      : {
          left: to.left + to.width * 0.2,
          top: to.top + to.height * 0.2,
          width: to.width * 0.6,
          height: to.height * 0.6,
        };
    const lerp = (a: number, b: number) => a + (b - a) * (previous ? t : progress(frame, at, 5, "overshoot"));
    const box =
      p.active.boxMotion === "elastic"
        ? elasticBoxRect(
            previous && lines.some((line) => line.includes(activeIndex) && line.includes(activeIndex - 1))
              ? rect({ ...previous, scale: 1 })
              : undefined,
            to,
            frame,
            at,
            Math.max(2, Math.round(fps * 0.2)),
          )
        : {
            left: lerp(from.left, to.left),
            top: lerp(from.top, to.top),
            width: lerp(from.width, to.width),
            height: lerp(from.height, to.height),
          };
    activeBox = {
      key: "active",
      ...box,
      radius: 0.2 * word.fontSize,
      fill: p.accent,
      opacity: 1,
    };
  }

  let emoji: CaptionFrame["emoji"] = null;
  const spokenWord = page.words[activeIndex];
  const emojiText = spokenWord ? keywordOf(spokenWord, p.keywords, p.language)?.emoji : undefined;
  if (spokenWord && emojiText)
    emoji = {
      text: emojiText,
      centreX,
      bottom: top - fontSize * 0.15,
      size: fontSize * 1.2,
      rise: progress(frame, frameOf(spokenWord.start, p, fps), 8, "overshoot"),
    };

  const pageEntry =
    p.reveal === "page" && (p.entry === "rise" || p.entry === "fade" || p.entry === "slam" || p.entry === "blur")
      ? entryAt(p.entry, frame, pageFrame, fps)
      : { opacity: 1, scale: 1, riseEm: 0, blurEm: 0 };
  return {
    words,
    boxes,
    activeBox,
    cursor,
    emoji,
    page: {
      opacity: pageEntry.opacity,
      scale: pageEntry.scale,
      translateY: pageEntry.riseEm * fontSize,
      blurPx: pageEntry.blurEm * fontSize,
      originX: centreX,
      originY: top + blockHeight / 2,
    },
    lineHeight,
    backing,
    level,
    position,
  };
};

const contrastBacking = (p: CaptionStyleProps): ContrastBacking =>
  p.backing.kind === "outline"
    ? { kind: "outline", colour: p.backing.colour, width: p.backing.width }
    : p.backing.kind === "shadow"
      ? { kind: "shadow", colour: p.backing.colour, blur: p.backing.blur, opacity: p.backing.opacity }
      : { kind: "box", fill: p.backing.fill };

/** Every colour the preset draws and what stands behind it, for `checkCaptionBackground`. */
export const contrastPairs = (p: CaptionStyleProps): ContrastPair[] => {
  const backing = contrastBacking(p);
  const pairs: ContrastPair[] = [{ label: "text", text: p.textColor, backing }];
  if (p.active.recolour || p.active.fill === "switch" || (p.emphasis.source !== "off" && p.emphasis.recolour))
    pairs.push({ label: "accent", text: p.accent, backing });
  if (p.layout === "mixed" && p.emphasis.serif && p.emphasis.source !== "off")
    pairs.push({ label: "serif accent", text: p.accent2, backing });
  if (p.active.box)
    pairs.push({ label: "active word", text: p.active.boxText, backing: { kind: "box", fill: p.accent } });
  return pairs;
};

/** Readability limits for a preset's own page shape, for `checkCaptionPages`. */
export const presetLimits = (p: CaptionStyleProps, layout: CaptionLayout) => ({
  maxWordsPerPage: p.maxWords + (p.maxWords >= 3 && p.layout === "lines" ? 1 : 0),
  maxLines: p.layout === "lines" ? Math.min(p.maxLines, 2) : 3,
  minPageSec: Math.min(p.minPageSec, 0.8),
  // One word at a time is read as it is heard, so the page reading speed does not apply.
  maxCharsPerSec: p.maxWords === 1 ? Infinity : 17,
  maxCharsPerLine: p.layout === "lines" ? layout.maxCharsPerLine : undefined,
});

/** Where a planned page's words sit, frame pixels: the box `checkCaptionBackground` samples. */
export const planBounds = (plan: CaptionFrame): Box => ({
  left: Math.min(...plan.words.map((w) => w.left)),
  right: Math.max(...plan.words.map((w) => w.left + w.width)),
  top: Math.min(...plan.words.map((w) => w.top)),
  bottom: Math.max(...plan.words.map((w) => w.top + w.height)),
});

/**
 * The mildest legibility level at which every colour of the page reads over a clean still of the footage under it.
 * When even the top rung fails, the top level and its `LOW_CONTRAST` finding come back, so nothing passes silently.
 */
export const chooseLevel = (
  p: CaptionStyleProps,
  still: { rgb: Uint8Array; width: number; height: number },
  box: Box,
): { level: number; finding: ReadabilityFinding | null } => {
  let finding: ReadabilityFinding | null = null;
  for (let level = 0; level <= p.fallbacks.length; level++) {
    finding = checkCaptionBackground(still, box, { pairs: contrastPairs(escalate(p, level)) });
    if (!finding) return { level, finding: null };
  }
  return { level: p.fallbacks.length, finding };
};

/**
 * Minimum-size check of every page as laid out, at the frame its last word starts (all words placed and settled
 * enough for size; scale animations do not count). Uses the given measure: the browser's in a render, a fake in tests.
 */
export const captionSizeFindings = (
  p: CaptionStyleProps,
  layout: CaptionLayout,
  measure: Measure,
  fps: number,
  frameHeight: number,
): ReadabilityFinding[] =>
  checkCaptionSizes(
    layout.pages.flatMap((page, pageIndex) => {
      const at = Math.max(
        Math.ceil((page.words.at(-1)!.start - p.startOffsetSec) * fps),
        Math.ceil((page.start - p.startOffsetSec) * fps),
      );
      const plan = planCaptionFrame(p, layout, measure, at, fps, frameHeight);
      if (!plan) return [];
      return [
        {
          pageIndex,
          words: plan.words.map((w, index) => ({
            text: page.words[index]?.text ?? w.text,
            fontSize: w.fontSize,
            capHeightEm: faceMetrics(w.face).capHeightEm,
            small: w.role === "small",
          })),
        },
      ];
    }),
    frameHeight,
  );
