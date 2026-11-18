/**
 * Crop maths for a moving still (Ken Burns): boxes and crops are in image-normalised coordinates
 * (0..1 on each axis of the displayed, EXIF-rotated image). Shared by `photo:focus` and the
 * `photo-move` library block, so a suggested crop renders exactly as planned.
 */

export type PhotoFormat = "vertical" | "square" | "landscape";
export type Rect = { x: number; y: number; w: number; h: number };
export type PhotoFill = "cover" | "blur";
export type PhotoEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out";

export const FRAME_ASPECT: Record<PhotoFormat, number> = { vertical: 9 / 16, square: 1, landscape: 16 / 9 };
export const FRAME_WIDTH_PX: Record<PhotoFormat, number> = { vertical: 1080, square: 1080, landscape: 1920 };
/** Measured with film:targets on a portrait: 2% scale a second leaves no stretch frozen (playbooks/photo-slideshow). */
export const MIN_SPEED = 0.02;
/** Share of the average speed an eased move keeps at its slowest, so its tails never read as frozen. */
export const EASE_FLOOR = 0.35;
/** House rule: a push stops before the source shows more than 1.5x enlarged, unless the minimum speed needs more. */
export const MAX_UPSCALE = 1.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Frame-aspect crop that contains `rect`, centred on it. Cover stays inside the image; blur may extend past it on an axis the image does not fill, never past the whole image. */
export function frameCrop(rect: Rect, imageAspect: number, frameAspect: number, fill: PhotoFill): Rect {
  let cw = Math.max(rect.w * imageAspect, rect.h * frameAspect);
  const max = fill === "cover" ? Math.min(imageAspect, frameAspect) : Math.max(imageAspect, frameAspect);
  cw = clamp(cw, 1e-4, max);
  const ch = cw / frameAspect;
  const place = (centre: number, size: number, extent: number) =>
    size >= extent ? (extent - size) / 2 : clamp(centre - size / 2, 0, extent - size);
  const x = place((rect.x + rect.w / 2) * imageAspect, cw, imageAspect);
  const y = place(rect.y + rect.h / 2, ch, 1);
  return { x: x / imageAspect, y, w: cw / imageAspect, h: ch };
}

/** The widest crop the fill allows, centred on `centre` (normalised point). */
export const widestCrop = (
  centre: { x: number; y: number },
  imageAspect: number,
  frameAspect: number,
  fill: PhotoFill,
) => frameCrop({ x: centre.x - 50, y: centre.y - 50, w: 100, h: 100 }, imageAspect, frameAspect, fill);

const cubic = {
  "ease-in": (t: number) => t ** 3,
  "ease-out": (t: number) => 1 - (1 - t) ** 3,
  "ease-in-out": (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
};

/** Move progress 0..1 at time share `t`. Eased curves keep `floor` of the linear slope everywhere, so no tail stops. */
export function moveProgress(t: number, easing: PhotoEasing, floor = EASE_FLOOR): number {
  const x = clamp(t, 0, 1);
  if (easing === "linear") return x;
  return floor * x + (1 - floor) * cubic[easing](x);
}

/** Slowest slope of the progress curve relative to linear (1 for linear). */
export const minSlope = (easing: PhotoEasing, floor = EASE_FLOOR) => (easing === "linear" ? 1 : floor);

/** Crop at progress `p`: size interpolated geometrically (constant zoom rate), position so the zoom keeps its fixed point. */
export function cropAt(from: Rect, to: Rect, p: number): Rect {
  const w = from.w * (to.w / from.w) ** p;
  const h = from.h * (to.h / from.h) ** p;
  const k = Math.abs(to.w - from.w) > 1e-9 ? (w - from.w) / (to.w - from.w) : p;
  const cx = from.x + from.w / 2 + (to.x + to.w / 2 - from.x - from.w / 2) * k;
  const cy = from.y + from.h / 2 + (to.y + to.h / 2 - from.y - from.h / 2) * k;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Average motion per second as a share of the frame: the larger of the zoom (log scale) and the pan (in crop sizes). */
export function moveRate(from: Rect, to: Rect, durationSec: number): number {
  const zoom = Math.abs(Math.log(to.w / from.w));
  const mw = Math.sqrt(from.w * to.w),
    mh = Math.sqrt(from.h * to.h);
  const pan = Math.hypot((to.x + to.w / 2 - from.x - from.w / 2) / mw, (to.y + to.h / 2 - from.y - from.h / 2) / mh);
  return Math.max(zoom, pan) / Math.max(durationSec, 1e-6);
}

/** Similarity of `rect` about the fixed point of the move from→to, carried `factor` times as far. */
function extend(from: Rect, to: Rect, factor: number): Rect {
  const scale = to.w / from.w;
  const cf = { x: from.x + from.w / 2, y: from.y + from.h / 2 },
    ct = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  if (Math.abs(scale - 1) < 1e-6) {
    const c = { x: cf.x + (ct.x - cf.x) * factor, y: cf.y + (ct.y - cf.y) * factor };
    return { x: c.x - to.w / 2, y: c.y - to.h / 2, w: to.w, h: to.h };
  }
  const s = scale ** factor;
  const fixed = { x: (ct.x - scale * cf.x) / (1 - scale), y: (ct.y - scale * cf.y) / (1 - scale) };
  const c = { x: fixed.x + (cf.x - fixed.x) * s, y: fixed.y + (cf.y - fixed.y) * s };
  return { x: c.x - (from.w * s) / 2, y: c.y - (from.h * s) / 2, w: from.w * s, h: from.h * s };
}

export type PlannedMove = {
  from: Rect;
  to: Rect;
  ratePerSec: number;
  slowestPerSec: number;
  adjusted: boolean;
  tooSlow: boolean;
};

/**
 * Fits both crops to the frame and makes the slowest instant of the move at least `minSpeed` a second.
 * A move that is too slow is carried further along its own path (a still becomes a push-in on its end crop's centre);
 * `tooSlow` says the image bounds stopped it short.
 */
export function planMove(opts: {
  from: Rect;
  to: Rect;
  imageAspect: number;
  frameAspect: number;
  fill: PhotoFill;
  durationSec: number;
  easing: PhotoEasing;
  minSpeed?: number;
}): PlannedMove {
  const fa = opts.frameAspect,
    minSpeed = opts.minSpeed ?? MIN_SPEED;
  const fit = (r: Rect) => frameCrop(r, opts.imageAspect, fa, opts.fill);
  const from = fit(opts.from);
  let to = fit(opts.to);
  const need = minSpeed / minSlope(opts.easing);
  let rate = moveRate(from, to, opts.durationSec);
  let adjusted = false;
  if (need > 0 && rate < need - 1e-9) {
    adjusted = true;
    if (rate < 1e-6) {
      const c = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
      const w = from.w * Math.exp(-need * opts.durationSec * 1.001);
      to = fit({ x: c.x - w / 2, y: c.y - (w * opts.imageAspect) / fa / 2, w, h: (w * opts.imageAspect) / fa });
    } else {
      for (let factor = need / rate, i = 0; i < 6 && rate < need - 1e-9; i++, factor *= need / Math.max(rate, 1e-6)) {
        to = fit(extend(from, fit(opts.to), factor * 1.001));
        rate = moveRate(from, to, opts.durationSec);
      }
    }
    rate = moveRate(from, to, opts.durationSec);
  }
  return {
    from,
    to,
    ratePerSec: rate,
    slowestPerSec: rate * minSlope(opts.easing),
    adjusted,
    tooSlow: rate * minSlope(opts.easing) < minSpeed - 1e-6,
  };
}

export const union = (boxes: Rect[]): Rect | null => {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x)),
    y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)),
    y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** A face box grown to head and shoulders (house rule), clipped to the image. */
export function headroom(face: Rect): Rect {
  const x0 = clamp(face.x - face.w * 0.6, 0, 1),
    x1 = clamp(face.x + face.w * 1.6, 0, 1);
  const y0 = clamp(face.y - face.h * 0.5, 0, 1),
    y1 = clamp(face.y + face.h * 1.8, 0, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - 1e-6 &&
  inner.y >= outer.y - 1e-6 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-6 &&
  inner.y + inner.h <= outer.y + outer.h + 1e-6;

export type Suggestion = {
  fill: PhotoFill;
  direction: "in" | "out";
  from: Rect;
  to: Rect;
  ratePerSec: number;
  /** How much the tighter crop enlarges the source at the format's frame width (1 = native). */
  upscale: number;
  /** The move cannot reach the minimum speed without cutting into the subject: hold it shorter or choose another move. */
  tooSlow: boolean;
};

const grow = (r: Rect, share: number): Rect => {
  const x0 = clamp(r.x - r.w * share, 0, 1),
    y0 = clamp(r.y - r.h * share, 0, 1);
  const x1 = clamp(r.x + r.w * (1 + share), 0, 1),
    y1 = clamp(r.y + r.h * (1 + share), 0, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/**
 * Start and end crops for one photo in one format. Every face (with a small margin) stays whole in both crops; the push
 * aims for head and shoulders of all faces, else the people found (an aim only: HOG misfires), else the centre. When the widest cover crop cannot
 * hold the faces, the photo goes whole over a blurred fill. The move pushes in; `direction: "out"` reverses it.
 */
export function suggestMove(opts: {
  width: number;
  height: number;
  faces: Rect[];
  people?: Rect[];
  format: PhotoFormat;
  durationSec: number;
  direction?: "in" | "out";
  easing?: PhotoEasing;
  minSpeed?: number;
}): Suggestion {
  const ia = opts.width / opts.height,
    fa = FRAME_ASPECT[opts.format];
  const easing = opts.easing ?? "linear";
  const hard = union(opts.faces.map((f) => grow(f, 0.15)));
  const preferred = union(opts.faces.map(headroom)) ?? union(opts.people ?? []);
  const aim = preferred ?? { x: 0.5, y: 0.5, w: 0, h: 0 };
  const centre = { x: aim.x + aim.w / 2, y: aim.y + aim.h / 2 };
  const coverWide = widestCrop(centre, ia, fa, "cover");
  const fill: PhotoFill = hard && !contains(coverWide, hard) ? "blur" : "cover";
  const wide = fill === "cover" ? coverWide : widestCrop({ x: 0.5, y: 0.5 }, ia, fa, "blur");
  const need = ((opts.minSpeed ?? MIN_SPEED) / minSlope(easing)) * opts.durationSec * 1.02;
  const floorW = Math.max(
    hard ? frameCrop(hard, ia, fa, fill).w : 0,
    Math.min(FRAME_WIDTH_PX[opts.format] / MAX_UPSCALE / opts.width, wide.w * Math.exp(-need)),
  );
  const goal = Math.min(
    wide.w * Math.exp(-need),
    Math.max(frameCrop(aim, ia, fa, fill).w, wide.w * Math.exp(-need * 3)),
  );
  const w = Math.min(wide.w, Math.max(goal, floorW));
  const h = (w * ia) / fa;
  let tight = frameCrop({ x: centre.x - w / 2, y: centre.y - h / 2, w, h }, ia, fa, fill);
  if (hard && !contains(tight, hard)) {
    const shift = (pos: number, size: number, lo: number, hi: number) => clamp(pos, hi - size, lo);
    tight = {
      ...tight,
      x: shift(tight.x, tight.w, hard.x, hard.x + hard.w),
      y: shift(tight.y, tight.h, hard.y, hard.y + hard.h),
    };
  }
  const [from, to] = opts.direction === "out" ? [tight, wide] : [wide, tight];
  const rate = moveRate(from, to, opts.durationSec);
  return {
    fill,
    direction: opts.direction ?? "in",
    from: round(from),
    to: round(to),
    ratePerSec: Number(rate.toFixed(4)),
    upscale: Number((FRAME_WIDTH_PX[opts.format] / (tight.w * opts.width)).toFixed(3)),
    tooSlow: rate * minSlope(easing) < (opts.minSpeed ?? MIN_SPEED) - 1e-6,
  };
}

const round = (r: Rect): Rect => ({
  x: Number(r.x.toFixed(4)),
  y: Number(r.y.toFixed(4)),
  w: Number(r.w.toFixed(4)),
  h: Number(r.h.toFixed(4)),
});

/** A box detected on a padded square canvas (photo scaled to `scaledW`×`scaledH` at its top-left) back into photo-normalised coordinates. */
export function fromCanvas(box: Rect, canvas: number, scaledW: number, scaledH: number): Rect {
  const x0 = clamp((box.x * canvas) / scaledW, 0, 1),
    y0 = clamp((box.y * canvas) / scaledH, 0, 1);
  const x1 = clamp(((box.x + box.w) * canvas) / scaledW, 0, 1),
    y1 = clamp(((box.y + box.h) * canvas) / scaledH, 0, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const orientation = (width: number, height: number) =>
  Math.abs(width - height) / Math.max(width, height) < 0.02 ? "square" : width > height ? "landscape" : "portrait";
