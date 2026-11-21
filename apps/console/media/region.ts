/**
 * Region selection for frame comments (RFC 0004 US11): a rectangle normalised to the picture (0–1, origin top left),
 * not to the element box, so a letterboxed 9:16 render in a 16:9 slot still gives picture coordinates.
 */
import { FrameCommentSchema, type FrameComment, type FrameMark, type MediaRef } from "@contract";

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Drags smaller than this (fraction of the picture) select no region. */
export const MIN_REGION = 0.01;

/** Where an `object-fit: contain` picture of `mediaW`×`mediaH` sits inside `box`. */
export function containRect(box: Box, mediaW: number | undefined, mediaH: number | undefined): Box {
  if (!mediaW || !mediaH || box.width <= 0 || box.height <= 0) return box;
  const scale = Math.min(box.width / mediaW, box.height / mediaH);
  const width = mediaW * scale;
  const height = mediaH * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** A region clamped inside the picture and rounded to four decimals; undefined when it is too small. */
export function clampRegion(region: Region): Region | undefined {
  if (![region.x, region.y, region.w, region.h].every(Number.isFinite)) return undefined;
  const x = round4(clamp01(region.x));
  const y = round4(clamp01(region.y));
  const w = round4(Math.min(clamp01(region.w), 1 - x));
  const h = round4(Math.min(clamp01(region.h), 1 - y));
  if (w < MIN_REGION || h < MIN_REGION) return undefined;
  return { x, y, w, h };
}

/** The region between two pointer positions (client coordinates) over `picture` (client box of the picture). */
export function regionFromDrag(
  start: { x: number; y: number },
  end: { x: number; y: number },
  picture: Box,
): Region | undefined {
  if (picture.width <= 0 || picture.height <= 0) return undefined;
  const ax = clamp01((start.x - picture.left) / picture.width);
  const ay = clamp01((start.y - picture.top) / picture.height);
  const bx = clamp01((end.x - picture.left) / picture.width);
  const by = clamp01((end.y - picture.top) / picture.height);
  return clampRegion({ x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) });
}

/** Region values as percentages for the `style` prop (CSP: no `<style>`). */
export function regionStyle(region: Region) {
  return {
    left: `${region.x * 100}%`,
    top: `${region.y * 100}%`,
    width: `${region.w * 100}%`,
    height: `${region.h * 100}%`,
  };
}

export type FrameCommentResult =
  { ok: true; comment: FrameComment } | { ok: false; problem: "text" | "frame" | "region" | "marks" };

/** A contract-valid frame comment, or what is wrong with the input. */
export function buildFrameComment(input: {
  media: MediaRef;
  frame: number;
  region?: Region;
  marks?: FrameMark[];
  text: string;
}): FrameCommentResult {
  const text = input.text.trim();
  if (!text) return { ok: false, problem: "text" };
  if (!Number.isInteger(input.frame) || input.frame < 0) return { ok: false, problem: "frame" };
  let region: Region | undefined;
  if (input.region) {
    region = clampRegion(input.region);
    if (!region) return { ok: false, problem: "region" };
  }
  const parsed = FrameCommentSchema.safeParse({
    media: input.media,
    frame: input.frame,
    text,
    ...(region ? { region } : {}),
    ...(input.marks?.length ? { marks: input.marks } : {}),
  });
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path[0];
    return {
      ok: false,
      problem: path === "frame" ? "frame" : path === "region" ? "region" : path === "marks" ? "marks" : "text",
    };
  }
  return { ok: true, comment: parsed.data };
}

/** One line a person can paste to the agent when no handler takes the comment. */
export function frameCommentText(comment: FrameComment, timecodeText: string): string {
  const region = comment.region
    ? ` region x=${comment.region.x} y=${comment.region.y} w=${comment.region.w} h=${comment.region.h}`
    : "";
  const marks = (comment.marks ?? [])
    .map(
      (mark, index) =>
        `\n  ${index + 1}. ${mark.w !== undefined ? `box x=${mark.x} y=${mark.y} w=${mark.w} h=${mark.h}` : `point x=${mark.x} y=${mark.y}`}: ${mark.text}`,
    )
    .join("");
  return `${comment.media.root === "out" ? "out/" : ""}${comment.media.path} frame ${comment.frame} (${timecodeText})${region}: ${comment.text}${marks}`;
}
