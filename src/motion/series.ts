export type SeriesItem = { id: string; frames: number } | { transition: number };

export type SeriesLayout = {
  totalFrames: number;
  scenes: { id: string; from: number; to: number; frames: number }[];
  transitions: { from: number; to: number; frames: number }[];
};

/**
 * The timeline a `<TransitionSeries>` produces: transitions overlap both neighbours, so total = scenes - transitions.
 * Use `totalFrames` for the composition and `scenes[n].from` for anything drawn above the series.
 */
export const layoutSeries = (items: readonly SeriesItem[]): SeriesLayout => {
  const scenes: SeriesLayout["scenes"] = [];
  const transitions: SeriesLayout["transitions"] = [];
  let cursor = 0;
  items.forEach((item, i) => {
    if ("transition" in item) {
      const before = items[i - 1];
      const after = items[i + 1];
      if (!before || !after || "transition" in before || "transition" in after)
        throw new Error("A transition must sit between two scenes.");
      if (item.transition > before.frames || item.transition > after.frames)
        throw new Error(
          `A ${item.transition}-frame transition is longer than a neighbouring scene (${before.id}, ${after.id}).`,
        );
      cursor -= item.transition;
      transitions.push({ from: cursor, to: cursor + item.transition, frames: item.transition });
      return;
    }
    scenes.push({ id: item.id, from: cursor, to: cursor + item.frames, frames: item.frames });
    cursor += item.frames;
  });
  return { totalFrames: cursor, scenes, transitions };
};
