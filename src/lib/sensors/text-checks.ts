import { spacing } from "../design-tokens";
import type { Occurrence } from "./findings";
import type { MeasuredText, PageMeasurement, Rect } from "./page-measure";

/** Crossfades keep the two opacities summing to about 1, so this threshold sees at most one side of one. */
export const OVERLAP_MIN_OPACITY = 0.6;
const TOLERANCE_PX = 1;
const MIN_OVERLAP_PX = 2;
const MIN_OVERLAP_SHARE = 0.03;
const LAYERED_SHARE = 0.9;

export type SafeZone = { top: number; bottom: number; sides: number };
export const SAFE_ZONE_PROFILES = ["vertical", "square", "landscape"] as const;
export function safeZoneOf(profile: string | undefined): (SafeZone & { name: string }) | undefined {
  if (!profile || profile === "none") return undefined;
  const key = profile as (typeof SAFE_ZONE_PROFILES)[number];
  return { name: key, top: spacing.safeTop[key], bottom: spacing.safeBottom[key], sides: spacing.sidePadding[key] };
}

const quote = (text: string) => `"${text.length > 48 ? `${text.slice(0, 45)}...` : text}"`;
const box = ({ x, y, width, height }: Rect) =>
  `x=${Math.round(x)} y=${Math.round(y)} w=${Math.round(width)} h=${Math.round(height)}`;

export function boundsOf(lines: Rect[]): Rect {
  const left = Math.min(...lines.map((line) => line.x));
  const top = Math.min(...lines.map((line) => line.y));
  const right = Math.max(...lines.map((line) => line.x + line.width));
  const bottom = Math.max(...lines.map((line) => line.y + line.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Whole pixels the rectangle pokes past each edge of `inner`; up to TOLERANCE_PX counts as none. */
export function excess(rect: Rect, inner: Rect) {
  const over = (value: number) => (value > TOLERANCE_PX ? Math.ceil(value) : 0);
  return {
    left: over(inner.x - rect.x),
    top: over(inner.y - rect.y),
    right: over(rect.x + rect.width - (inner.x + inner.width)),
    bottom: over(rect.y + rect.height - (inner.y + inner.height)),
  };
}
const describeExcess = (edges: ReturnType<typeof excess>) =>
  Object.entries(edges)
    .filter(([, value]) => value > 0)
    .map(([edge, value]) => `${value}px past the ${edge}`)
    .join(", ");
const isOutside = (edges: ReturnType<typeof excess>) => Object.values(edges).some((value) => value > 0);

const related = (a: MeasuredText, b: MeasuredText) =>
  a.elementId === b.elementId || a.ancestorIds.includes(b.elementId) || b.ancestorIds.includes(a.elementId);

export function findOverlap(a: MeasuredText, b: MeasuredText): { rect: Rect; share: number } | undefined {
  if (a.opacity < OVERLAP_MIN_OPACITY || b.opacity < OVERLAP_MIN_OPACITY || a.clipPath || b.clipPath || related(a, b))
    return undefined;
  let worst: { rect: Rect; share: number } | undefined;
  for (const lineA of a.lines)
    for (const lineB of b.lines) {
      const width = Math.min(lineA.x + lineA.width, lineB.x + lineB.width) - Math.max(lineA.x, lineB.x);
      const height = Math.min(lineA.y + lineA.height, lineB.y + lineB.height) - Math.max(lineA.y, lineB.y);
      if (width < MIN_OVERLAP_PX || height < MIN_OVERLAP_PX) continue;
      const share = (width * height) / Math.min(lineA.width * lineA.height, lineB.width * lineB.height);
      if (share < MIN_OVERLAP_SHARE) continue;
      // Two copies of the same text in the same place is a stroke-and-fill or shadow stack.
      if (a.text === b.text && share >= LAYERED_SHARE) return undefined;
      if (!worst || share > worst.share)
        worst = { rect: { x: Math.max(lineA.x, lineB.x), y: Math.max(lineA.y, lineB.y), width, height }, share };
    }
  return worst;
}

/** Text wholly beyond the stage cannot be seen, whether it is waiting to enter or has left. */
const isWhollyOffStage = ({ x, y, width, height }: Rect, stage: { width: number; height: number }) =>
  x + width <= 0 || y + height <= 0 || x >= stage.width || y >= stage.height;

export function checkText(
  frame: number,
  all: MeasuredText[],
  stage: { width: number; height: number },
  safe?: SafeZone,
): Occurrence[] {
  const found: Occurrence[] = [];
  const measured = all.filter((item) => !isWhollyOffStage(boundsOf(item.lines), stage));
  const stageRect = { x: 0, y: 0, width: stage.width, height: stage.height };
  for (const item of measured) {
    const bounds = boundsOf(item.lines);
    const shared = { frame, text: [item.text], elements: item.names };
    const intended = item.overflow ? { intended: item.overflow } : {};
    const offStage = excess(bounds, stageRect);
    if (isOutside(offStage))
      found.push({
        ...shared,
        ...intended,
        code: "TEXT_OFF_STAGE",
        key: item.text,
        message: `Text ${quote(item.text)} in <${item.label}> sits at ${box(bounds)}, ${describeExcess(offStage)} of the ${stage.width}x${stage.height} stage.`,
        fix: `Keep it on stage: reduce the font size of ${quote(item.text)}, wrap it within ${stage.width}px or move it by the amounts given. Text crossing an edge at speed is treated as motion and not counted, so this one is resting or drifting there.`,
      });
    else if (safe) {
      const zone = {
        x: safe.sides,
        y: safe.top,
        width: stage.width - safe.sides * 2,
        height: stage.height - safe.top - safe.bottom,
      };
      const outside = excess(bounds, zone);
      if (isOutside(outside))
        found.push({
          ...shared,
          ...intended,
          code: "TEXT_OUTSIDE_SAFE_ZONE",
          key: item.text,
          message: `Text ${quote(item.text)} in <${item.label}> sits at ${box(bounds)}, ${describeExcess(outside)} of the safe zone (${box(zone)}).`,
          fix: `Platform interface will cover it. Move ${quote(item.text)} inside ${box(zone)} using spacing.safeTop, safeBottom and sidePadding from design-tokens.`,
        });
    }
    if (item.region && item.regionLines.length) {
      const regionBounds = boundsOf(item.regionLines);
      const outside = excess(regionBounds, item.region.rect);
      if (isOutside(outside))
        found.push({
          ...shared,
          code: "TEXT_OUTSIDE_REGION",
          key: `${item.region.name}\0${item.text}`,
          message: `Text ${quote(item.text)} at ${box(regionBounds)} is ${describeExcess(outside)} of its region "${item.region.name}" (${box(item.region.rect)}).`,
          fix: `Shrink or shorten ${quote(item.text)} to fit ${Math.round(item.region.rect.width)}x${Math.round(item.region.rect.height)}, or enlarge the data-region="${item.region.name}" element.`,
        });
    }
  }
  for (let first = 0; first < measured.length; first++)
    for (let second = first + 1; second < measured.length; second++) {
      const a = measured[first]!;
      const b = measured[second]!;
      const overlap = findOverlap(a, b);
      if (!overlap) continue;
      found.push({
        frame,
        code: "TEXT_OVERLAP",
        key: [a.text, b.text].sort().join("\0"),
        text: [a.text, b.text],
        elements: [...a.names, ...b.names],
        message: `Text ${quote(a.text)} (${box(boundsOf(a.lines))}) overlaps ${quote(b.text)} (${box(boundsOf(b.lines))}) by ${Math.round(overlap.share * 100)}% of the smaller line, around ${box(overlap.rect)}.`,
        fix: `Move one apart by at least ${Math.ceil(overlap.rect.height)}px vertically or ${Math.ceil(overlap.rect.width)}px horizontally, or fade one below opacity ${OVERLAP_MIN_OPACITY} before the other arrives. If the overlap is deliberate, add {"code":"TEXT_OVERLAP","text":${JSON.stringify(a.text.slice(0, 24))},"reason":"..."} to --allow.`,
      });
    }
  return found;
}

export type TextPositions = Map<string, Map<number, { x: number; y: number }>>;

export function recordPositions(positions: TextPositions, frame: number, measured: MeasuredText[]): void {
  for (const item of measured) {
    const bounds = boundsOf(item.lines);
    const frames = positions.get(item.text) ?? new Map<number, { x: number; y: number }>();
    if (!frames.has(frame)) frames.set(frame, { x: bounds.x, y: bounds.y });
    positions.set(item.text, frames);
  }
}

/** A share of the stage's long side per frame: a whip or a fast exit, not a slow drift or a resting layout. */
const TRANSIT_STAGE_SHARE_PER_FRAME = 0.01;

/** Text passing an edge at speed is a transition. Only text resting or drifting across a boundary is a layout fault. */
export function dropTransits(
  occurrences: Occurrence[],
  positions: TextPositions,
  stage: { width: number; height: number },
): Occurrence[] {
  const limit = Math.max(stage.width, stage.height) * TRANSIT_STAGE_SHARE_PER_FRAME;
  return occurrences.filter((occurrence) => {
    if (occurrence.code !== "TEXT_OFF_STAGE" && occurrence.code !== "TEXT_OUTSIDE_SAFE_ZONE") return true;
    const frames = positions.get(occurrence.text?.[0] ?? "");
    const here = frames?.get(occurrence.frame);
    if (!frames || !here) return true;
    const checked = [...frames.keys()].sort((a, b) => a - b);
    const index = checked.indexOf(occurrence.frame);
    return ![checked[index - 1], checked[index + 1]].some((neighbour) => {
      if (neighbour === undefined) return false;
      const other = frames.get(neighbour)!;
      return Math.hypot(other.x - here.x, other.y - here.y) / Math.abs(neighbour - occurrence.frame) > limit;
    });
  });
}

export type PlatformFont = { familyName: string; isCustomFont: boolean; glyphCount: number };
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "math",
  "emoji",
  "fangsong",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "-apple-system",
  "blinkmacsystemfont",
]);
const normalise = (family: string) => family.replace(/["'\s_-]/g, "").toLowerCase();
const sameFamily = (a: string, b: string) =>
  normalise(a).startsWith(normalise(b)) || normalise(b).startsWith(normalise(a));

export function parseFamilies(stack: string): string[] {
  return stack
    .split(",")
    .map((family) => family.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** The runs drawn with something other than the first font in the stack. */
export function fallbackRuns(
  stack: string,
  used: PlatformFont[],
  customFamilies: PageMeasurement["customFamilies"],
): PlatformFont[] {
  const families = parseFamilies(stack);
  const requested = families[0];
  if (!requested || GENERIC_FAMILIES.has(requested.toLowerCase())) return [];
  const custom = customFamilies.filter((family) => families.includes(family));
  const requestedIsCustom = custom.includes(requested);
  return used.filter((run) => {
    if (/emoji/i.test(run.familyName)) return false;
    if (sameFamily(run.familyName, requested)) return false;
    // A custom font's internal name may differ from its CSS alias, which is only unambiguous if the stack holds one custom family.
    return !(requestedIsCustom && run.isCustomFont && custom.length === 1);
  });
}

export function fallbackOccurrence(frame: number, item: MeasuredText, runs: PlatformFont[]): Occurrence {
  const requested = parseFamilies(item.family)[0]!;
  const drawn = runs.map((run) => `"${run.familyName}" (${run.glyphCount} glyphs)`).join(", ");
  const script = /\p{Script=Cyrillic}/u.test(item.text)
    ? "Cyrillic"
    : /\p{Script=Greek}/u.test(item.text)
      ? "Greek"
      : "these";
  return {
    code: "FALLBACK_FONT",
    frame,
    key: `${requested}\0${item.text}`,
    text: [item.text],
    elements: item.names,
    message: `Text ${quote(item.text)} in <${item.label}> asks for "${requested}" but Chromium drew it with ${drawn}.`,
    fix: `"${requested}" has no ${script} glyphs here or did not load. Load a font or subset covering them (for Google fonts, request the subset, such as cyrillic), or set a family that does.`,
  };
}
