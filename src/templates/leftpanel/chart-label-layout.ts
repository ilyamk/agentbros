/** Terminal labels preserve source text and font size; only placement/line breaks change. */
export interface TerminalLabel {
  seriesIndex: number;
  text: string;
  x: number;
  y: number;
}
export interface TerminalLabelBox extends TerminalLabel {
  left: number;
  top: number;
  width: number;
  height: number;
  lines: string[];
}
export function layoutTerminalLabels(
  labels: TerminalLabel[],
  measure: (text: string) => number,
  bounds: { left: number; right: number; top: number; bottom: number },
  options: { maxWidth?: number; lineHeight?: number; gap?: number } = {},
): TerminalLabelBox[] {
  const maxWidth = Math.min(options.maxWidth ?? 280, bounds.right - bounds.left),
    lineHeight = options.lineHeight ?? 18,
    gap = options.gap ?? 8,
    padding = 6;
  if (
    ![...Object.values(bounds), maxWidth, lineHeight, gap].every(Number.isFinite) ||
    maxWidth <= padding * 2 ||
    lineHeight <= 0 ||
    gap < 0 ||
    bounds.bottom <= bounds.top
  )
    throw Error("Invalid chart label bounds");
  if (labels.length > 24) throw Error("Chart terminal labels exceed readable layout capacity (24)");
  const widthOf = (text: string) => {
    const width = measure(text);
    if (!Number.isFinite(width) || width < 0) throw Error("Invalid chart label text measurement");
    return width;
  };
  const boxes = labels
    .filter((label) => label.text.length > 0)
    .map((label) => {
      if (label.text.length > 2048 || ![label.x, label.y].every(Number.isFinite))
        throw Error("Chart terminal label exceeds supported layout bounds");
      // Segment graphemes so even a long unbroken EN/RU word is retained intact.
      const glyphs = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(label.text)].map(
          (part) => part.segment,
        ),
        lines: string[] = [];
      let cursor = 0;
      while (cursor < glyphs.length) {
        let end = cursor,
          lastSpace = -1;
        while (end < glyphs.length && widthOf(glyphs.slice(cursor, end + 1).join("")) <= maxWidth - padding * 2) {
          if (/\s/u.test(glyphs[end])) lastSpace = end;
          end++;
        }
        if (end === cursor) throw Error("Chart terminal label glyph cannot fit at the existing font size");
        if (end < glyphs.length && lastSpace >= cursor) end = lastSpace + 1;
        lines.push(glyphs.slice(cursor, end).join(""));
        cursor = end;
      }
      const width = Math.max(...lines.map(widthOf)) + padding * 2,
        height = lines.length * lineHeight + padding * 2;
      return {
        ...label,
        lines,
        width,
        height,
        left: Math.max(bounds.left, Math.min(label.x - 12 - width, bounds.right - width)),
        top: Math.max(bounds.top, Math.min(label.y - height / 2, bounds.bottom - height)),
      };
    })
    .sort((a, b) => a.y - b.y || a.seriesIndex - b.seriesIndex);
  if (
    boxes.reduce((sum, box) => sum + box.height, 0) + Math.max(0, boxes.length - 1) * gap >
    bounds.bottom - bounds.top
  )
    throw Error("Chart terminal labels cannot fit without clipping or shrinking; shorten labels or reduce series");
  for (let i = 1; i < boxes.length; i++)
    boxes[i].top = Math.max(boxes[i].top, boxes[i - 1].top + boxes[i - 1].height + gap);
  for (let i = boxes.length - 1; i >= 0; i--)
    boxes[i].top = Math.min(
      boxes[i].top,
      i === boxes.length - 1 ? bounds.bottom - boxes[i].height : boxes[i + 1].top - gap - boxes[i].height,
    );
  return boxes;
}
