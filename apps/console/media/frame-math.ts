/**
 * Frame arithmetic of the media viewer (RFC 0004 §10.2, US6). Frames are numbered from 0; a seek lands in the middle
 * of a frame (`(n + 0.5) / fps`) because seeking to exactly `n / fps` often shows frame `n - 1` in browsers.
 */

/** Frame rate used when neither the MediaRef nor the file tells one; the UI labels it as assumed. */
export const DEFAULT_FPS = 30;

/** The media's frame rate and whether it was assumed. */
export function resolveFps(fps: number | undefined): { fps: number; assumed: boolean } {
  return fps !== undefined && Number.isFinite(fps) && fps > 0
    ? { fps, assumed: false }
    : { fps: DEFAULT_FPS, assumed: true };
}

/** A usable duration in seconds: the element's when finite, else the MediaRef's, else 0. */
export function resolveDuration(elementDuration: number | undefined, refDuration: number | undefined): number {
  if (elementDuration !== undefined && Number.isFinite(elementDuration) && elementDuration > 0) return elementDuration;
  if (refDuration !== undefined && Number.isFinite(refDuration) && refDuration > 0) return refDuration;
  return 0;
}

/** Number of frames in `durationSec` (at least 1). */
export function frameCount(durationSec: number, fps: number): number {
  return Math.max(1, Math.round(durationSec * fps));
}

export function clampFrame(frame: number, durationSec: number, fps: number): number {
  const last = frameCount(durationSec, fps) - 1;
  return Math.min(last, Math.max(0, Math.round(frame)));
}

/** The frame shown at `t` seconds. */
export function frameAt(t: number, fps: number): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.floor(t * fps + 1e-6);
}

/** The time to seek to so that frame `n` shows. */
export function timeOfFrame(frame: number, fps: number): number {
  return (Math.max(0, frame) + 0.5) / fps;
}

/** The frame `delta` frames from the one at `t`, clamped to the media. */
export function stepFrame(t: number, delta: number, durationSec: number, fps: number): number {
  return clampFrame(frameAt(t, fps) + delta, durationSec, fps);
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** `mm:ss:ff` (or `h:mm:ss:ff` past an hour) for frame `n`. */
export function timecode(frame: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps));
  const safe = Math.max(0, Math.floor(frame));
  const ff = safe % rate;
  const totalSeconds = Math.floor(safe / rate);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}:${pad(ff)}` : `${pad(m)}:${pad(s)}:${pad(ff)}`;
}

/** `m:ss` (or `h:mm:ss`) for a duration in seconds. */
export function clock(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const s = safe % 60;
  const m = Math.floor(safe / 60) % 60;
  const h = Math.floor(safe / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Playback rates the viewer offers. */
export const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2] as const;
