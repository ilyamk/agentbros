/**
 * Thumbnail URLs for frame strips and posters. The server rounds `t` to 0.1 s and `w` up to a width bucket
 * (src/lib/console/thumbs.ts); the client rounds the same way, so equal frames share one URL and the browser cache.
 */
import type { MediaRef } from "@contract";
import { thumbUrl } from "../../../src/lib/console/urls";

/** Mirrors `THUMB_WIDTHS` and `THUMB_TIME_STEP` of src/lib/console/thumbs.ts (a test keeps them equal). */
export const THUMB_WIDTHS = [96, 160, 240, 320, 480, 640, 960, 1280, 1920] as const;
export const THUMB_TIME_STEP = 0.1;

export const widthBucket = (w: number) => THUMB_WIDTHS.find((bucket) => bucket >= w) ?? THUMB_WIDTHS.at(-1)!;

/** `t` rounded to the server's step and kept inside the media (as the server does). */
export function quantizeTime(t: number, durationSec: number | undefined): number {
  const last = durationSec !== undefined && durationSec > 0 ? Math.max(0, durationSec - THUMB_TIME_STEP) : t;
  const steps = Math.round(Math.min(Math.max(0, t), last) / THUMB_TIME_STEP);
  return Number((steps * THUMB_TIME_STEP).toFixed(3));
}

/** Times of `count` evenly spaced frames, each in the middle of its slice of the duration. */
export function stripTimes(durationSec: number, count: number): number[] {
  if (!(durationSec > 0) || count < 1) return [];
  const slice = durationSec / count;
  return Array.from({ length: count }, (_, index) => quantizeTime(slice * (index + 0.5), durationSec));
}

/** A frame of `media` near `t` seconds, about `width` CSS pixels wide (doubled for sharp screens, then bucketed). */
export function frameSrc(project: string, media: MediaRef, t: number, width: number): string {
  return thumbUrl(project, media, { t: quantizeTime(t, media.durationSec), w: widthBucket(width * 2) });
}

/** The poster of a video: one second in, or its middle when shorter. */
export function posterTime(durationSec: number | undefined): number {
  if (!durationSec || durationSec <= 0) return 0;
  return quantizeTime(Math.min(1, durationSec / 2), durationSec);
}
