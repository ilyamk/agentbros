import { resolveCaptionStyle, timelineCaptionWords } from "../../../lib/captions/profiles";
import {
  checkCaptionPlacement,
  detailDensity,
  faceZone,
  type Box,
  type ReadabilityFinding,
} from "../../../lib/captions/readability";
import { compileTimelineIR } from "../../../lib/timeline-ir/compiler";
import { renderBoundary } from "../../../lib/timeline-ir/render";
import type { TimelineIR } from "../../../types/timeline";
import { faceMetrics } from "./faces";
import { captionSizeFindings, planBounds, planCaptionFrame, presetLayout, type Measure } from "./plan";
import {
  captionStyleSchema,
  LEGACY_CAPTION_PROFILES,
  CAPTION_PRESETS,
  resolveCaptionProps,
  type CaptionStyleProps,
  type LegibilityRange,
  type PositionRange,
} from "./style";
import type { CaptionLayout } from "./layout";

/** Widths from each face's average character advance: no browser, deterministic, close enough to place the sample box. */
export const estimateMeasure: Measure = {
  width: (text, face) =>
    [...text].reduce(
      (sum, char) =>
        sum + faceMetrics(face).charWidthEm * (char === char.toUpperCase() && char !== char.toLowerCase() ? 1.15 : 1),
      0,
    ),
  ascent: () => 0.95,
  descent: () => 0.25,
};

export type LegibilityTarget = {
  /** Track and clip of the caption owner. */
  clip: string;
  pageIndex: number;
  /** Page start and end, output seconds (the caption clock). */
  start: number;
  end: number;
  /** Composition frame of the clean still: when the page's last word starts, so the whole page is laid out. */
  frame: number;
  text: string;
  /** Where the page's words sit on that frame at the default position, from the planner with `estimateMeasure`. */
  box: Box;
  /** Composition frame minus the clip's start: the frame the planner sees. */
  local: number;
  p: CaptionStyleProps;
  layout: CaptionLayout;
};

const isPreset = (profile: string): profile is keyof typeof CAPTION_PRESETS | keyof typeof LEGACY_CAPTION_PROFILES =>
  profile in CAPTION_PRESETS || profile in LEGACY_CAPTION_PROFILES;

/**
 * Every caption page a timeline render draws with a library preset, as `TimelineComposition` lays it out: one entry
 * per page with the frame and box to sample. Inline captions (talking-head layouts) are sampled as if full-frame.
 */
export const legibilityTargets = (
  props: { timeline: TimelineIR; captionStyle?: unknown },
  fps: number,
  width: number,
  height: number,
): {
  profile: string;
  explicitPosition: boolean;
  targets: LegibilityTarget[];
  sizeFindings: (ReadabilityFinding & { clip: string })[];
} => {
  const style = resolveCaptionStyle(props);
  if (!isPreset(style.profile))
    throw new Error(
      `Caption style "${style.profile}" is not a library preset; legibility levels apply to the presets only`,
    );
  const snapshot = compileTimelineIR(props.timeline);
  const targets: LegibilityTarget[] = [];
  const sizeFindings: (ReadabilityFinding & { clip: string })[] = [];
  for (const track of snapshot.tracks)
    for (const clip of track.clips) {
      if (!clip.captions.length) continue;
      const clipStart = renderBoundary(clip.start, snapshot.timebase, fps);
      const words = timelineCaptionWords(clip.captions, snapshot.timebase).map(
        ({ translation: _translation, ...word }) => word,
      );
      const p = captionStyleSchema.parse({
        ...resolveCaptionProps(style.profile, { ...(style.options ?? {}), legibility: [], positions: [] }),
        words,
        startOffsetSec: clipStart / fps,
        placement: "safe-zone",
      });
      const layout = presetLayout(p, width, height);
      const key = `${track.id}:${clip.id}`;
      sizeFindings.push(
        ...captionSizeFindings(p, layout, estimateMeasure, fps, height).map((finding) => ({ ...finding, clip: key })),
      );
      layout.pages.forEach((page, pageIndex) => {
        const local = Math.max(
          Math.ceil((page.words.at(-1)!.start - p.startOffsetSec) * fps),
          Math.ceil((page.start - p.startOffsetSec) * fps),
        );
        const plan = planCaptionFrame(p, layout, estimateMeasure, local, fps, height, 0);
        if (!plan?.words.length) return;
        targets.push({
          clip: key,
          pageIndex,
          start: page.start,
          end: page.end,
          frame: clipStart + local,
          text: page.words.map((word) => word.text).join(" "),
          box: planBounds(plan),
          local,
          p,
          layout,
        });
      });
    }
  return {
    profile: style.profile,
    explicitPosition: typeof style.options?.position === "string",
    targets,
    sizeFindings,
  };
};

/** Pages' chosen levels as ranges: consecutive pages at the same level merge across the gaps between them; level 0 needs no range. */
export const legibilityRanges = (
  levels: readonly { start: number; end: number; level: number }[],
): LegibilityRange[] => {
  const ranges: LegibilityRange[] = [];
  let open: LegibilityRange | null = null;
  for (const page of [...levels].sort((a, b) => a.start - b.start)) {
    // Millisecond bounds, rounded outwards so the range still covers its page's start.
    const from = Math.floor(page.start * 1000) / 1000;
    const to = Math.ceil(page.end * 1000) / 1000;
    if (page.level === 0) open = null;
    else if (open && open.level === page.level) open.to = Math.max(open.to, to);
    else ranges.push((open = { from, to, level: page.level }));
  }
  return ranges;
};

/** Above this share of sharp edges the footage under a caption reads as printed text or a busy graphic (calibrated on the QA stills: plain shirts and walls 0–0.03, a printed T-shirt 0.07, a bookshelf 0.06–0.12). */
export const TEXT_DETAIL = 0.06;

export const POSITION_ORDER: Record<CaptionStyleProps["position"], CaptionStyleProps["position"][]> = {
  lower: ["lower", "middle", "upper"],
  middle: ["middle", "lower", "upper"],
  upper: ["upper", "lower", "middle"],
};

export type PositionChoice = {
  position: CaptionStyleProps["position"];
  box: Box;
  /** Every candidate tried, in preference order, with why it lost. */
  candidates: {
    position: CaptionStyleProps["position"];
    face: boolean;
    nearFace: boolean;
    detail: number;
    ui: boolean;
    cost: number;
  }[];
  findings: ReadabilityFinding[];
};

/**
 * Where one page should sit: the preset's own position unless it would run under the platform interface (cost 1000),
 * cover a face (100), sit on printed text or a busy graphic (`TEXT_DETAIL`, 10) or touch the margin round a face (5);
 * each step down the preference order costs 1.
 * Ties keep the preference order, so with nothing in the way a page never moves; `previous` (the page before, in the
 * same clip) is tried first. Pure and deterministic.
 */
export const choosePosition = (
  p: CaptionStyleProps,
  layout: CaptionLayout,
  local: number,
  fps: number,
  height: number,
  probe: {
    faces: readonly Box[];
    still?: { rgb: Uint8Array; width: number; height: number };
    previous?: CaptionStyleProps["position"];
  },
): PositionChoice => {
  // The previous page's position comes first when it is still clear, so captions do not hop between pages of a shot.
  const order = probe.previous
    ? [probe.previous, ...POSITION_ORDER[p.position].filter((position) => position !== probe.previous)]
    : POSITION_ORDER[p.position];
  const candidates = order.map((position, rank) => {
    const plan = planCaptionFrame(p, layout, estimateMeasure, local, fps, height, 0, position);
    const box = plan?.words.length ? planBounds(plan) : layout.boxes[position];
    // Faces and detail are judged on the band any page at this position may fill (the zone, less its padding), not on
    // this page's own outline, so pages of one shot reach the same answer and do not hop; a taller page adds its own.
    const zone = layout.boxes[position];
    const band = {
      left: zone.left,
      right: zone.right,
      top: Math.min(zone.top + layout.padPx, box.top),
      bottom: Math.max(zone.bottom - layout.padPx, box.bottom),
    };
    // Covering the face itself (5% of its area or more) is the worst outcome; only touching the margin round it
    // (below the chin, beside the ear) costs less than sitting on printed text.
    const share = (f: Box) => overlapArea(band, f) / Math.max(1, (f.right - f.left) * (f.bottom - f.top));
    const face = probe.faces.some((f) => share(f) >= 0.05);
    const nearFace = !face && probe.faces.some((f) => overlapArea(band, faceZone(f)) > 0);
    const detail = probe.still ? detailDensity(probe.still, band) : 0;
    const ui = checkCaptionPlacement(box, { format: layout.format, ui: layout.uiZone }).length > 0;
    return {
      position,
      box,
      face,
      nearFace,
      detail: Number(detail.toFixed(3)),
      ui,
      cost: (ui ? 1000 : 0) + (face ? 100 : 0) + (detail > TEXT_DETAIL ? 10 : 0) + (nearFace ? 5 : 0) + rank,
    };
  });
  const best = candidates.reduce((a, b) => (b.cost < a.cost ? b : a));
  return {
    position: best.position,
    box: best.box,
    candidates: candidates.map(({ box: _box, ...rest }) => rest),
    findings: checkCaptionPlacement(best.box, { format: layout.format, faces: probe.faces, ui: layout.uiZone }),
  };
};

const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** Pages' chosen positions as ranges, consecutive pages at one position merged; pages at the default need none. */
export const positionRanges = (
  pages: readonly { start: number; end: number; position: CaptionStyleProps["position"] }[],
  fallback: CaptionStyleProps["position"],
): PositionRange[] => {
  const ranges: PositionRange[] = [];
  let open: PositionRange | null = null;
  for (const page of [...pages].sort((a, b) => a.start - b.start)) {
    const from = Math.floor(page.start * 1000) / 1000;
    const to = Math.ceil(page.end * 1000) / 1000;
    if (page.position === fallback) open = null;
    else if (open && open.position === page.position) open.to = Math.max(open.to, to);
    else ranges.push((open = { from, to, position: page.position }));
  }
  return ranges;
};
