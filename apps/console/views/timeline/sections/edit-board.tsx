/**
 * Storyboard cards (RU-T01) and proportional track lanes with pointer proposals (RU-T02, T03, T16–T18; RU-K03–K06,
 * K10). Lanes keep review:ui's hit-test contract: `.lane` elements with `data-track-id` / `data-kind`, `.clip`
 * buttons and `.trim-handle` edges with `touch-action: none`; only visual lanes take pointer drags. Keyboard users
 * select with the clip button and edit through the Move / Trim source / Transfer forms (the handles say so).
 */
import { useRef, type CSSProperties, type PointerEvent } from "react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import type { ReviewClip, ReviewTrack } from "../api";
import { number, type ClipRef } from "./edit-commands";
import type { LaneBox } from "./edit-pointer";
import type { EditPartProps } from "./edit-session";

const same = (a: ClipRef | undefined, track: ReviewTrack, clip: ReviewClip) =>
  a?.trackId === track.id && a.clipId === clip.id;

export function Storyboard({ state, api, session, snap, t }: EditPartProps) {
  const { f } = useI18n();
  const cards = state.tracks
    .filter((track) => track.kind === "visual" || track.kind === "presenter")
    .flatMap((track) => track.clips.map((clip) => ({ track, clip })));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-sm font-semibold">{t.storyboard}</h4>
      {cards.length ? (
        <ul id="board" className="flex min-w-0 gap-3 overflow-x-auto pb-2" aria-label={t.storyboard}>
          {cards.map(({ track, clip }) => {
            const asset = state.assets.find((candidate) => candidate.id === clip.assetId);
            const headline = clip.payload?.headline;
            const selected = same(snap.selected, track, clip);
            return (
              <li
                key={`${track.id}/${clip.id}`}
                className={cn(
                  "card flex w-56 shrink-0 flex-col gap-1 rounded-lg border bg-muted/40 p-2 [overflow-wrap:anywhere]",
                  selected && "border-primary",
                )}
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  className="rounded-sm text-start text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/60"
                  onClick={() => session.select({ trackId: track.id, clipId: clip.id })}
                >
                  {typeof headline === "string" && headline ? headline : clip.id}
                </button>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {f(t.cardSpan, { asset: clip.assetId, start: number(clip.start), end: number(clip.end) })}
                </p>
                {asset?.kind === "image" ? (
                  <img
                    src={api.fileUrl(api.originalPath(asset))}
                    loading="lazy"
                    alt=""
                    className="max-h-40 w-full rounded-sm object-contain"
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t.storyboardEmpty}</p>
      )}
    </div>
  );
}

export function TrackLanes({ state, session, snap, t }: EditPartProps) {
  const { f } = useI18n();
  const lanes = useRef(new Map<string, HTMLDivElement>());
  /** The click after a drag is suppressed (RU-K06). */
  const ignoreClick = useRef(false);
  const boxes = (): LaneBox[] =>
    [...lanes.current].map(([trackId, element]) => ({
      trackId,
      kind: element.dataset.kind ?? "",
      rect: element.getBoundingClientRect(),
    }));
  const duration = Math.max(1, state.durationInFrames);

  const pointerHandlers = (track: ReviewTrack, clip: ReviewClip) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !event.isPrimary) return;
      const button = event.currentTarget;
      const lane = lanes.current.get(track.id);
      if (!lane) return;
      const edge = (event.target as HTMLElement).dataset.edge;
      const pointerId = event.pointerId;
      const started = session.pointerDown({
        ref: { trackId: track.id, clipId: clip.id },
        mode: edge === "start" || edge === "end" ? edge : "move",
        pointerId,
        x: event.clientX,
        y: event.clientY,
        grabFrames:
          ((event.clientX - button.getBoundingClientRect().left) / (lane.getBoundingClientRect().width || 1)) *
          state.durationInFrames,
        release: () => {
          if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
        },
      });
      if (started) button.setPointerCapture(pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) =>
      session.pointerMove(event.pointerId, event.clientX, event.clientY, boxes()),
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      if (session.pointerUp(event.pointerId, event.clientX, event.clientY, boxes())) ignoreClick.current = true;
    },
    onPointerCancel: () => session.pointerCancel(),
    onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => session.pointerCancel(event.pointerId),
  });

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-sm font-semibold">{t.tracks}</h4>
      <p className="text-sm text-muted-foreground">{t.tracksHint}</p>
      {state.tracks.length ? null : <p className="text-sm text-muted-foreground">{t.tracksEmpty}</p>}
      <div id="tracks" className="flex min-w-0 flex-col gap-3 overflow-x-auto pb-1">
        {state.tracks.map((track) => (
          <div key={track.id} className="track flex min-w-80 flex-col gap-1 rounded-lg bg-muted/40 p-2">
            <strong className="text-xs font-semibold">{f(t.trackHeading, { kind: track.kind, id: track.id })}</strong>
            <div
              ref={(element) => {
                if (element) lanes.current.set(track.id, element);
                else lanes.current.delete(track.id);
              }}
              className="lane relative h-13 min-w-80"
              data-track-id={track.id}
              data-kind={track.kind}
              role="group"
              aria-label={f(t.trackHeading, { kind: track.kind, id: track.id })}
            >
              {track.clips.map((clip) => {
                const label = f(t.clipLabel, {
                  id: clip.id,
                  asset: clip.assetId,
                  start: number(clip.start),
                  end: number(clip.end),
                });
                const visual = track.kind === "visual";
                const dragging = same(snap.drag, track, clip);
                const preview = dragging ? snap.drag?.preview : undefined;
                const style: CSSProperties = preview ?? {
                  left: `${(100 * number(clip.start)) / duration}%`,
                  width: `${(100 * (number(clip.end) - number(clip.start))) / duration}%`,
                };
                return (
                  <button
                    key={clip.id}
                    type="button"
                    title={label}
                    aria-label={label}
                    aria-pressed={same(snap.selected, track, clip)}
                    className={cn(
                      "clip absolute top-1 h-11 min-w-[3px] touch-none overflow-hidden rounded-md border bg-primary/15 text-start text-xs whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60 aria-pressed:border-primary aria-pressed:bg-primary/25",
                      dragging && "dragging ring-2 ring-primary",
                    )}
                    style={style}
                    onClick={() => {
                      if (ignoreClick.current) {
                        ignoreClick.current = false;
                        return;
                      }
                      session.select({ trackId: track.id, clipId: clip.id });
                    }}
                    {...(visual ? pointerHandlers(track, clip) : {})}
                  >
                    <span className="clip-label block truncate px-3 leading-11">{label}</span>
                    {visual
                      ? (["start", "end"] as const).map((side) => (
                          <span
                            key={side}
                            aria-hidden="true"
                            data-edge={side}
                            title={f(t.trimHandle, { side: t.side[side] })}
                            className={cn(
                              "trim-handle absolute inset-y-0 w-3 cursor-ew-resize touch-none bg-primary/70",
                              side === "start" ? "trim-start left-0" : "trim-end right-0",
                            )}
                          />
                        ))
                      : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
