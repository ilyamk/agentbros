/**
 * Marks on a frame (2026-11-20): a click puts a point the arrow points at, a drag a box; each carries the user's words.
 * The same drawing is the preview over the player and the overlay the agent receives: a transparent PNG at the video's
 * size that `frame:note` lays over the frame taken from the file, so the still shows exactly what the user saw.
 * Coordinates are normalised to the picture (0–1, origin top left), as regions are.
 */
import { FRAME_OVERLAY_MAX_BASE64, MAX_FRAME_MARKS, type FrameMark } from "@contract";
import { MIN_REGION, regionFromDrag, type Box } from "./region";

/** A mark being edited: its words may still be empty. */
export type DraftMark = Omit<FrameMark, "text"> & { text: string };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** The mark a pointer gesture over `picture` makes: a box when dragged far enough, else a point. */
export function markFromGesture(
  start: { x: number; y: number },
  end: { x: number; y: number },
  picture: Box,
): DraftMark | undefined {
  if (picture.width <= 0 || picture.height <= 0) return undefined;
  const dx = Math.abs(end.x - start.x) / picture.width;
  const dy = Math.abs(end.y - start.y) / picture.height;
  if (dx >= MIN_REGION * 2 || dy >= MIN_REGION * 2) {
    const region = regionFromDrag(start, end, picture);
    if (region) return { x: region.x, y: region.y, w: region.w, h: region.h, text: "" };
  }
  return {
    x: round4(clamp01((end.x - picture.left) / picture.width)),
    y: round4(clamp01((end.y - picture.top) / picture.height)),
    text: "",
  };
}

export const isBox = (mark: Pick<FrameMark, "w" | "h">): boolean => mark.w !== undefined && mark.h !== undefined;

/** The words sent as the comment: the user's comment, then each mark's words by number. */
export function commentWords(general: string, marks: readonly DraftMark[]): string {
  const lines = marks.map((mark, index) => `${index + 1}. ${mark.text.trim()}`);
  const text = general.trim();
  return [text, lines.join("\n")].filter(Boolean).join("\n\n");
}

/** Marks as the contract carries them (words trimmed); undefined when there are none. */
export function contractMarks(marks: readonly DraftMark[]): FrameMark[] | undefined {
  if (!marks.length) return undefined;
  return marks.slice(0, MAX_FRAME_MARKS).map((mark) => ({ ...mark, text: mark.text.trim() }));
}

export const MARK_COLOR = "#ff3b30";

type Ctx = Pick<
  CanvasRenderingContext2D,
  | "beginPath"
  | "arc"
  | "fill"
  | "stroke"
  | "moveTo"
  | "lineTo"
  | "closePath"
  | "strokeRect"
  | "fillText"
  | "measureText"
  | "roundRect"
  | "clearRect"
  | "save"
  | "restore"
> & {
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  lineWidth: number;
  font: string;
  textBaseline: CanvasTextBaseline;
  lineJoin: CanvasLineJoin;
};

/** Words wrapped to `maxWidth`, at most `maxLines` lines (the last ends with "…" when cut). */
export function wrapWords(ctx: Pick<Ctx, "measureText">, text: string, maxWidth: number, maxLines = 4): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && lines.join(" ").length < text.trim().length) {
    let last = lines[maxLines - 1]!;
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1).trimEnd();
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

/**
 * Draws the marks on a `width`×`height` canvas: boxes and points in red, each with a numbered label holding its words
 * (a point's label sits towards the middle of the frame, with an arrow to the point). Pure drawing: no frame pixels.
 */
export function drawMarks(ctx: Ctx, marks: readonly DraftMark[], width: number, height: number) {
  ctx.clearRect(0, 0, width, height);
  const unit = Math.max(width, height) / 1000;
  const line = Math.max(2, Math.round(3 * unit));
  const fontSize = Math.max(14, Math.round(20 * unit));
  const pad = Math.round(fontSize * 0.45);
  const badge = Math.round(fontSize * 0.75);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.textBaseline = "top";
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  marks.forEach((mark, index) => {
    const x = mark.x * width;
    const y = mark.y * height;
    const label = `${index + 1}`;
    const words = wrapWords(ctx, mark.text.trim() || "…", width * 0.38);
    const textWidth = Math.max(...words.map((text) => ctx.measureText(text).width));
    const lineHeight = Math.round(fontSize * 1.25);
    const boxW = badge * 2 + pad * 3 + textWidth;
    const boxH = Math.max(badge * 2, words.length * lineHeight) + pad * 2;
    let target: { x: number; y: number } | undefined;
    ctx.strokeStyle = MARK_COLOR;
    ctx.fillStyle = MARK_COLOR;
    ctx.lineWidth = line;
    // Where the label may go, best first; the first that stays clear of the labels already drawn wins.
    const candidates: { x: number; y: number }[] = [];
    if (isBox(mark)) {
      const w = mark.w! * width;
      const h = mark.h! * height;
      ctx.strokeRect(x, y, w, h);
      candidates.push(
        { x, y: y - boxH - line * 2 },
        { x, y: y + h + line * 2 },
        { x: x + w - boxW, y: y - boxH - line * 2 },
        { x: x + w - boxW, y: y + h + line * 2 },
        { x: x + line * 2, y: y + line * 2 },
      );
    } else {
      // The label towards the middle of the frame, the arrow from it to the point; then the other three sides.
      const gap = 90 * unit;
      const right = x <= width / 2;
      const down = y <= height / 2;
      const at = (r: boolean, d: boolean) => ({ x: r ? x + gap : x - gap - boxW, y: d ? y + gap : y - gap - boxH });
      candidates.push(at(right, down), at(right, !down), at(!right, down), at(!right, !down));
      target = { x, y };
    }
    const fit = (spot: { x: number; y: number }) => ({
      x: Math.min(Math.max(line, spot.x), width - boxW - line),
      y: Math.min(Math.max(line, spot.y), height - boxH - line),
    });
    const apart = (spot: { x: number; y: number }, other: (typeof placed)[number]) =>
      spot.x + boxW + line <= other.x ||
      other.x + other.w + line <= spot.x ||
      spot.y + boxH + line <= other.y ||
      other.y + other.h + line <= spot.y;
    const clear = (spot: { x: number; y: number }) => placed.every((other) => apart(spot, other));
    const fitted = candidates.map(fit);
    let { x: labelX, y: labelY } = fitted.find(clear) ?? fitted[0]!;
    // Every spot taken: move down past the labels it overlaps (each step moves strictly down, so this ends).
    const overlapping = () => placed.filter((other) => !apart({ x: labelX, y: labelY }, other));
    for (let hits = overlapping(); hits.length && labelY + boxH < height; hits = overlapping()) {
      labelY = Math.max(...hits.map((other) => other.y + other.h + line));
    }
    placed.push({ x: labelX, y: labelY, w: boxW, h: boxH });
    if (target) {
      const fromX = Math.min(Math.max(target.x, labelX), labelX + boxW);
      const fromY = Math.min(Math.max(target.y, labelY), labelY + boxH);
      const angle = Math.atan2(target.y - fromY, target.x - fromX);
      const head = Math.max(10, 16 * unit);
      const tipX = target.x - Math.cos(angle) * line;
      const tipY = target.y - Math.sin(angle) * line;
      // a dark outline under the arrow keeps it visible on red or bright frames
      for (const [style, extra] of [
        ["rgba(0,0,0,0.55)", line * 1.6],
        [MARK_COLOR, 0],
      ] as const) {
        ctx.strokeStyle = style;
        ctx.fillStyle = style;
        ctx.lineWidth = line + extra;
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(tipX - Math.cos(angle) * head * 0.6, tipY - Math.sin(angle) * head * 0.6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - head * Math.cos(angle - 0.45), tipY - head * Math.sin(angle - 0.45));
        ctx.lineTo(tipX - head * Math.cos(angle + 0.45), tipY - head * Math.sin(angle + 0.45));
        ctx.closePath();
        ctx.fill();
        if (extra) ctx.stroke();
      }
      ctx.fillStyle = MARK_COLOR;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(1.5, line * 0.6);
      ctx.beginPath();
      ctx.arc(target.x, target.y, Math.max(4, 6 * unit), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // label: a dark plate, the red numbered badge, the words in white
    ctx.fillStyle = "rgba(10,10,12,0.82)";
    ctx.beginPath();
    ctx.roundRect(labelX, labelY, boxW, boxH, Math.round(pad * 0.8));
    ctx.fill();
    ctx.fillStyle = MARK_COLOR;
    ctx.beginPath();
    ctx.arc(labelX + pad + badge, labelY + pad + badge, badge, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    const numberWidth = ctx.measureText(label).width;
    ctx.fillText(label, labelX + pad + badge - numberWidth / 2, labelY + pad + badge - fontSize * 0.5);
    words.forEach((text, row) => ctx.fillText(text, labelX + pad * 2 + badge * 2, labelY + pad + row * lineHeight));
  });
  ctx.restore();
}

/**
 * The marks as a transparent PNG at the video's size, base64 without the data-URL prefix; halved until it fits the
 * request (`frame:note` scales it back over the frame). Undefined where the browser draws no canvas (tests).
 */
export function overlayBase64(marks: readonly DraftMark[], width: number, height: number): string | undefined {
  if (!marks.length || !(width > 0) || !(height > 0)) return undefined;
  for (let scale = 1; scale >= 0.25; scale /= 2) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      return undefined;
    }
    if (!ctx) return undefined;
    drawMarks(ctx, marks, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
    if (data.length <= FRAME_OVERLAY_MAX_BASE64) return data;
  }
  return undefined;
}
