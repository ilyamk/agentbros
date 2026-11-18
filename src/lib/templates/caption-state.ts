import { CaptionWordsSchema } from "../../types/templates";
export function captionState(input: unknown, frame: number, fps: number, maxWords = 3) {
  const words = CaptionWordsSchema.parse(input);
  if (!Number.isInteger(frame) || !Number.isFinite(fps) || fps <= 0 || !Number.isInteger(maxWords) || maxWords < 1)
    throw new Error("Invalid caption frame/fps/group size");
  const time = frame / fps;
  const activeIndex = words.findIndex((w) => time >= w.start && time < w.end);
  if (time < (words[0]?.start ?? Infinity) || time >= (words.at(-1)?.end ?? 0))
    return { visible: false, activeIndex: -1, group: [] as typeof words };
  // Hold the last readable phrase during a short pause, without inventing a spoken word.
  const anchor =
    activeIndex >= 0 ? activeIndex : words.reduce((last, word, index) => (word.end <= time ? index : last), -1);
  const start = Math.floor(Math.max(0, anchor) / maxWords) * maxWords;
  return {
    visible: true,
    activeIndex: activeIndex < 0 ? -1 : activeIndex - start,
    group: words.slice(start, start + maxWords),
  };
}
