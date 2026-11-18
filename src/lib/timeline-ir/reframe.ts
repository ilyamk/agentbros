import { VisualReframesSchema } from "../../types/timeline";
import { mediaTiming } from "./render";

type Keyframe = { frame: number; x: number; y: number };

/** Cover alignment at a source frame: linear between keyframes, held outside them; equal neighbours make shot steps. */
export function positionAt(keyframes: readonly Keyframe[], frame: number): { x: number; y: number } {
  const first = keyframes[0]!,
    last = keyframes.at(-1)!;
  if (frame <= first.frame) return { x: first.x, y: first.y };
  if (frame >= last.frame) return { x: last.x, y: last.y };
  let low = 0,
    high = keyframes.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (keyframes[mid]!.frame <= frame) low = mid;
    else high = mid;
  }
  const a = keyframes[low]!,
    b = keyframes[high]!,
    t = (frame - a.frame) / (b.frame - a.frame);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Decoded source frame the renderer shows at a clip's local output frame. It starts from the same rounded
 * `trimBefore` as `mediaTiming` (output frames), then floors, so a crop path never reads between two source frames
 * or one frame off the picture at a shot step. Frames past the owned span hold the last one.
 */
export function clipSourceFrame(
  source: {
    start: { num: number; den: number };
    end?: { num: number; den: number };
    timebase: { num: number; den: number };
  },
  rate: { num: number; den: number },
  localFrame: number,
  fps: number,
  ownedFrames: number,
): number {
  const frame = Math.min(localFrame, Math.max(0, ownedFrames - 1));
  const { trimBefore, playbackRate } = mediaTiming(
    { start: source.start, end: source.end ?? source.start, timebase: source.timebase },
    rate,
    fps,
  );
  return Math.floor(((trimBefore + frame * playbackRate) * source.timebase.num) / (fps * source.timebase.den) + 1e-6);
}

/** CSS cover alignment: normalized endpoints select an edge; omitted format stays legacy center. A crop path is read at `sourceFrame`. */
export function visualObjectPosition(
  payload: Record<string, unknown> | undefined,
  format: "vertical" | "square" | "landscape",
  sourceFrame = 0,
): string | undefined {
  const setting = VisualReframesSchema.parse(payload?.reframe ?? {})[format];
  if (!setting) return undefined;
  const position = "keyframes" in setting ? positionAt(setting.keyframes, sourceFrame) : setting;
  return `${position.x * 100}% ${position.y * 100}%`;
}
