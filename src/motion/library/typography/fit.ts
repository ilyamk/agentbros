import { fitText, measureText } from "@remotion/layout-utils";
import { useLayoutEffect, useState } from "react";
import { continueRender, delayRender } from "remotion";

/** `additionalStyles` carries what the measuring span needs beyond the font, e.g. `{ fontVariationSettings }`. */
export type TextRun = {
  text: string;
  fontFamily: string;
  fontWeight: number;
  letterSpacing?: string;
  additionalStyles?: Record<string, string>;
};

const loadAll = (runs: readonly TextRun[]): Promise<unknown> =>
  Promise.all(
    runs.map((run) =>
      document.fonts.load(
        `${run.additionalStyles?.fontStyle === "italic" ? "italic " : ""}${run.fontWeight} 100px ${run.fontFamily}`,
        run.text,
      ),
    ),
  );

/**
 * One font size at which every run fits `withinWidth`, capped at `max`; null until the fonts are ready. Measuring only
 * after the load keeps layout-utils from caching a fallback face's widths.
 */
export const useSharedFit = (runs: readonly TextRun[], withinWidth: number, max: number): number | null => {
  const [size, setSize] = useState<number | null>(null);
  const key = JSON.stringify(runs);
  useLayoutEffect(() => {
    const handle = delayRender(`Fitting ${key}`);
    let live = true;
    void loadAll(runs)
      .then(() => {
        if (!live) return;
        const sizes = runs
          .filter((run) => run.text.trim() !== "")
          .map((run) => fitText({ ...run, withinWidth }).fontSize);
        setSize(Math.min(max, ...sizes));
      })
      .finally(() => continueRender(handle));
    return () => {
      live = false;
      continueRender(handle);
    };
    // `key` stands for `runs`, which callers rebuild every render, so `runs` is left out of the dependencies.
  }, [key, withinWidth, max]);
  return size;
};

/** Rendered widths of runs at one size, in pixels; null until the fonts are ready. */
export const useTextWidths = (runs: readonly TextRun[], fontSize: number): number[] | null => {
  const [widths, setWidths] = useState<number[] | null>(null);
  const key = JSON.stringify(runs);
  useLayoutEffect(() => {
    const handle = delayRender(`Measuring ${key}`);
    let live = true;
    void loadAll(runs)
      .then(() => {
        if (live) setWidths(runs.map((run) => measureText({ ...run, fontSize, validateFontIsLoaded: true }).width));
      })
      .finally(() => continueRender(handle));
    return () => {
      live = false;
      continueRender(handle);
    };
  }, [key, fontSize]);
  return widths;
};

/**
 * A font size per run so that run `i` is `targets[i]` pixels wide, capped by `caps[i]`; null until the fonts are ready.
 * One measurement at 100 px serves every run, since width scales linearly with size.
 */
export const useFitSizes = (
  runs: readonly TextRun[],
  targets: readonly number[],
  caps: readonly number[],
): number[] | null => {
  const widths = useTextWidths(runs, 100);
  if (widths === null) return null;
  return widths.map((width, index) =>
    Math.min(caps[index] ?? Number.POSITIVE_INFINITY, ((targets[index] ?? 0) * 100) / Math.max(width, 1)),
  );
};
