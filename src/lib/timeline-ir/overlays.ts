import { z } from "zod";
import type { EditCommand, Rational, TimelineIR, TimelineOverlay } from "../../types/timeline";
import { renderBoundary } from "./render";
import { add, compare, fraction, numeric, sub } from "./rational";

/** Library categories whose blocks stand on their own over a picture. Captions belong to `caption-style`. */
export const OVERLAY_CATEGORIES = ["typography", "data", "ui", "kinetic"] as const;

/** Props through which a block paints its own background; an overlay must set each one, so a default never hides the footage. */
export const BACKGROUND_PROPS = ["ground", "groundBefore", "background", "backdrop"] as const;

type CatalogueEntry = { id: string; category: string; propsSchema: unknown };

/** Overlay IDs a command adds or changes, through batches. Undo and redo re-check the original command against the current catalogue, as render does. */
export function touchedOverlayIds(command: EditCommand): string[] {
  if (command.type === "batch") return command.commands.flatMap(touchedOverlayIds);
  if (command.type === "add-overlay") return [command.overlay.id];
  if (command.type === "update-overlay") return [command.overlayId];
  return [];
}

/**
 * Checks each named overlay against the motion library catalogue: the block exists, stands on its own
 * (`OVERLAY_CATEGORIES`), every given prop matches the block's props schema (unknown props are refused), and every
 * background prop (`BACKGROUND_PROPS`) is set.
 */
export function assertOverlayBlocks(timeline: TimelineIR, items: readonly CatalogueEntry[], ids?: readonly string[]) {
  for (const overlay of timeline.overlays ?? []) {
    if (ids && !ids.includes(overlay.id)) continue;
    const item = items.find((entry) => entry.id === overlay.block);
    if (!item) throw new Error(`Overlay ${overlay.id}: unknown library block ${overlay.block}; see pnpm library:list`);
    if (!(OVERLAY_CATEGORIES as readonly string[]).includes(item.category))
      throw new Error(
        `Overlay ${overlay.id}: ${item.category} block ${item.id} cannot stand over a picture; use one of ${OVERLAY_CATEGORIES.join(", ")}`,
      );
    const schema = z.fromJSONSchema(item.propsSchema as Parameters<typeof z.fromJSONSchema>[0]);
    if (!(schema instanceof z.ZodObject))
      throw new Error(`Overlay ${overlay.id}: block ${item.id} has no object props schema`);
    const parsed = schema.partial().safeParse(overlay.props);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new Error(
        `Overlay ${overlay.id}: prop ${issue.path.join(".") || "(root)"} of ${item.id}: ${issue.message}`,
      );
    }
    const unset = BACKGROUND_PROPS.filter((prop) => prop in schema.shape && !(prop in overlay.props));
    if (unset.length)
      throw new Error(
        `Overlay ${overlay.id}: ${item.id} paints its default ${unset.join(" and ")} over the picture; set ${unset.map((prop) => `${prop}: "${prop === "backdrop" ? "none" : "transparent"}"`).join(", ")} (or a colour deliberately)`,
      );
  }
}

export type OverlayRender = {
  id: string;
  block: string;
  props: Record<string, unknown>;
  from: number;
  durationInFrames: number;
  /** Frames of the block already played before `from`. */
  offsetFrames: number;
};

/** Output-frame spans of one layer's overlays, ordered by start; overlays that round to nothing at this fps are skipped. */
export function overlayRenders(
  overlays: readonly TimelineOverlay[] | undefined,
  layer: TimelineOverlay["layer"],
  timebase: Rational,
  fps: number,
): OverlayRender[] {
  return (overlays ?? [])
    .filter((overlay) => overlay.layer === layer)
    .sort((a, b) => compare(a.start, b.start))
    .flatMap((overlay) => {
      const from = renderBoundary(overlay.start, timebase, fps);
      const durationInFrames = renderBoundary(overlay.end, timebase, fps) - from;
      if (durationInFrames <= 0) return [];
      const offsetFrames = overlay.offset ? Math.round((numeric(overlay.offset) * fps) / numeric(timebase)) : 0;
      return [{ id: overlay.id, block: overlay.block, props: overlay.props, from, durationInFrames, offsetFrames }];
    });
}

export type OverlayPiece = { start: Rational; end: Rational; at: Rational };

/**
 * Keeps each overlay where it overlaps a selected [start, end) piece, moved to `at` on the new clock. A part cut
 * at its start carries the played frames in `offset`, so the block continues rather than restarting.
 */
export function rebaseOverlays(
  overlays: readonly TimelineOverlay[] | undefined,
  pieces: readonly OverlayPiece[],
  rename: (id: string, piece: number) => string = (id) => id,
): TimelineOverlay[] | undefined {
  const result = (overlays ?? []).flatMap((overlay) =>
    pieces.flatMap((piece, index) => {
      const start = compare(overlay.start, piece.start) > 0 ? overlay.start : piece.start;
      const end = compare(overlay.end, piece.end) < 0 ? overlay.end : piece.end;
      if (compare(start, end) >= 0) return [];
      const offset = add(overlay.offset ?? fraction(0), sub(start, overlay.start));
      const { offset: _old, ...rest } = overlay;
      return [
        {
          ...structuredClone(rest),
          id: rename(overlay.id, index),
          start: add(sub(start, piece.start), piece.at),
          end: add(sub(end, piece.start), piece.at),
          ...(compare(offset, fraction(0)) > 0 ? { offset } : {}),
        },
      ];
    }),
  );
  return result.length ? result.sort((a, b) => compare(a.start, b.start)) : undefined;
}
