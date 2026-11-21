/**
 * The viewer's visual timeline (2026-11-20), as an editor's: the frame strip with a ruler under it, the playhead, the
 * frames that already carry a note, and under the pointer the exact frame and its time to the millisecond. A click or a
 * drag lands on the frame under the pointer, not on the middle of a thumbnail. The strip's buttons stay the keyboard
 * path (the slider above is the precise one).
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { MediaRef } from "@contract";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { clock, frameAtPointer, frameClock } from "./frame-math";
import { FrameStrip } from "./frame-strip";

/** Seconds between labelled ticks: the first step that keeps at most `max` labels. */
export function rulerStep(durationSec: number, max = 8): number {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((step) => durationSec / step <= max) ?? steps.at(-1)!;
}

export interface TimelineProps {
  project: string;
  media: MediaRef;
  durationSec: number;
  fps: number;
  frames: number;
  /** Seconds on screen (the playhead). */
  time: number;
  onSeekFrame: (frame: number) => void;
  /** Frames that carry a note sent from this viewer. */
  noted?: readonly number[];
  count?: number;
  frameWidth?: number;
}

export function Timeline({
  project,
  media,
  durationSec,
  fps,
  frames,
  time,
  onSeekFrame,
  noted = [],
  count = 12,
  frameWidth = 120,
}: TimelineProps) {
  const { d, f } = useI18n();
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | undefined>();
  const dragging = useRef(false);
  const at = (event: ReactPointerEvent) =>
    frameAtPointer(event.clientX, track.current?.getBoundingClientRect() ?? { left: 0, width: 0 }, frames);
  const percent = (value: number) => `${frames > 1 ? (value / (frames - 1)) * 100 : 0}%`;
  const step = rulerStep(durationSec);
  const ticks = Array.from({ length: Math.floor(durationSec / step) + 1 }, (_, index) => index * step).filter(
    // the last label would hang past the right edge
    (t) => t <= durationSec * 0.92,
  );

  return (
    <div className="flex min-w-0 flex-col gap-1" data-timeline>
      <div ref={track} className="relative">
        <FrameStrip
          project={project}
          media={media}
          durationSec={durationSec}
          time={time}
          count={count}
          frameWidth={frameWidth}
          onSeek={(t) => onSeekFrame(Math.floor(t * fps))}
        />
        {/* Pointer layer over the strip: hover reads the frame, a click or drag seeks to it. */}
        <div
          aria-hidden="true"
          data-timeline-pointer
          className="absolute inset-0 cursor-ew-resize touch-none"
          onPointerMove={(event) => {
            const value = at(event);
            setHover(value);
            if (dragging.current) onSeekFrame(value);
          }}
          onPointerLeave={() => {
            if (!dragging.current) setHover(undefined);
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            dragging.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            onSeekFrame(at(event));
          }}
          onPointerUp={(event) => {
            dragging.current = false;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = false;
            setHover(undefined);
          }}
        />
        {noted.map((value) => (
          <span
            key={value}
            aria-hidden="true"
            data-noted-frame={value}
            className="pointer-events-none absolute -top-1 size-2 -translate-x-1/2 rotate-45 bg-destructive"
            style={{ left: percent(value) }}
          />
        ))}
        {hover !== undefined ? (
          <>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-foreground/70"
              style={{ left: percent(hover) }}
            />
            <span
              data-timeline-readout
              className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 rounded-md border bg-popover px-2 py-1 font-mono text-xs whitespace-nowrap text-popover-foreground tabular-nums shadow-sm"
              style={{ left: `clamp(4.5rem, ${percent(hover)}, calc(100% - 4.5rem))` }}
            >
              {frameClock(hover, fps)} · {f(d.media.frameShort, { frame: hover })}
            </span>
          </>
        ) : null}
      </div>
      <div className="relative h-4 text-[0.65rem] text-muted-foreground tabular-nums" aria-hidden="true">
        {ticks.map((t) => (
          <span
            key={t}
            className={cn(
              "absolute top-0 border-s border-border ps-0.5 leading-none",
              t === 0 ? "translate-x-0" : "-translate-x-px",
            )}
            style={{ left: `${(t / durationSec) * 100}%` }}
          >
            {step < 1 ? `${clock(t)}.${Math.round((t % 1) * 10)}` : clock(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
