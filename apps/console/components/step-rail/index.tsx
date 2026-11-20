/**
 * Step rail (docs/console-steps.md; the user's pick of three concepts, 2026-11-20). A horizontal track with even
 * columns: one ring per step whose motion says the status (marker.tsx), connectors that fill as steps close, one-line
 * labels with the status under them (full title, reason and owner in the tooltip). The header says "Step n of total",
 * how many are closed and where the steps come from (template or chain, route, playbook); a legend explains the icons.
 * The current step scrolls into view inside the track when it advances; a step added later animates in once.
 * Keyboard: one tab stop, arrows and Home/End move, `aria-current="step"` on the current step.
 * Started from uiarc (Arc UI) free `stepper` (MIT, Copyright (c) 2026 Elia Kuratli; github.com/kuratlielia/arc-library
 * @ 8302b52): list, connectors, roving focus; rewritten on the console's status tones, no `motion`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectView } from "@contract";
import { cn } from "@/lib/utils";
import { TONE_TEXT } from "@/lib/status";
import { useI18n } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  CLOSED,
  focusIndexOf,
  motionTone,
  railInput,
  railProgress,
  useAddedSteps,
  useRailKeys,
  type RailInput,
} from "./model";
import { StepMarker } from "./marker";
import { OriginBadge, RailLegend, StepTip } from "./parts";

/** Width of one step column; the track scrolls when the steps need more than the pane has. */
const COLUMN_REM = 8;

export interface StepTrackProps {
  input: RailInput;
  selected?: string;
  onSelect?: (id: string) => void;
  label: string;
  className?: string;
}

export interface StepRailProps extends Omit<StepTrackProps, "input"> {
  view: ProjectView;
}

export function StepRail({ view, ...props }: StepRailProps) {
  return <StepTrack input={railInput(view)} {...props} />;
}

export function StepTrack({ input, selected, onSelect, label, className }: StepTrackProps) {
  const { d, f, p } = useI18n();
  const { steps, current } = input;
  const progress = railProgress(input);
  const added = useAddedSteps(steps);
  const { list, onKeyDown } = useRailKeys(steps.length);
  const nav = useRef<HTMLElement>(null);
  const focusIndex = focusIndexOf(input, selected);
  const percent = progress.total ? Math.round((progress.closed / progress.total) * 100) : 0;

  // Which edges hide more steps: the track fades there so a scrollable rail reads as one.
  const [edges, setEdges] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const track = nav.current;
    if (!track) return;
    const start = track.scrollLeft > 4;
    const end = track.scrollLeft + track.clientWidth < track.scrollWidth - 4;
    setEdges((old) => (old.start === start && old.end === end ? old : { start, end }));
  }, []);
  useEffect(() => {
    measure();
    const track = nav.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [measure, steps.length]);

  // Keep the current step visible inside the track (never scrolls the page).
  useEffect(() => {
    const track = nav.current;
    const item = [...(track?.querySelectorAll<HTMLElement>("li[data-step-item]") ?? [])].find(
      (element) => element.dataset.stepItem === current,
    );
    if (!track || !item || track.scrollWidth <= track.clientWidth) return;
    const left = item.offsetLeft - (track.clientWidth - item.offsetWidth) / 2;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    track.scrollTo?.({ left: Math.max(0, left), behavior: reduce ? "auto" : "smooth" });
  }, [current, steps.length]);

  return (
    <TooltipProvider>
      <div data-slot="step-rail" className={cn("flex min-w-0 flex-col gap-3", className)}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-baseline gap-3">
            <span data-part="position" className="text-sm font-semibold tabular-nums">
              {progress.position
                ? f(d.stepRail.position, { n: progress.position, total: progress.total })
                : progress.closed === progress.total
                  ? p(d.stepRail.allClosed, progress.total)
                  : d.stepRail.noCurrent}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {f(d.stepRail.closed, { n: progress.closed, total: progress.total })}
            </span>
          </div>
          <OriginBadge input={input} />
        </div>
        <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            data-part="progress"
            className="h-full rounded-full bg-status-done transition-[width] duration-250 ease-(--ease-standard)"
            style={{ width: `${percent}%` }}
          />
        </div>

        <nav
          ref={nav}
          aria-label={label}
          onScroll={measure}
          data-edges={[edges.start && "start", edges.end && "end"].filter(Boolean).join(" ") || undefined}
          className={cn(
            "relative -mx-1 overflow-x-auto px-1 pt-1 pb-2",
            edges.start && edges.end
              ? "mask-x-from-90% mask-x-to-100%"
              : edges.start
                ? "mask-l-from-90% mask-l-to-100%"
                : edges.end && "mask-r-from-90% mask-r-to-100%",
          )}
        >
          <ol
            ref={list}
            className="grid auto-cols-[minmax(8rem,1fr)] grid-flow-col"
            style={{ minWidth: `${steps.length * COLUMN_REM}rem` }}
          >
            {steps.map((step, index) => {
              const isCurrent = step.id === current;
              const tone = motionTone(step.status, isCurrent);
              const isAdded = added.has(step.id);
              const closed = CLOSED.has(step.status);
              return (
                <li
                  key={step.id}
                  data-step-item={step.id}
                  data-added={isAdded ? "true" : undefined}
                  className={cn(
                    "relative flex min-w-0 flex-col items-center",
                    isAdded && "motion-safe:animate-rail-enter",
                  )}
                >
                  {index < steps.length - 1 ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-[calc(1.125rem+0.25rem)] right-[calc(-50%+1.5rem)] left-[calc(50%+1.5rem)] h-0.5 overflow-hidden rounded-full bg-border"
                    >
                      <span
                        data-part="connector"
                        className={cn(
                          "block h-full rounded-full transition-[width,background-color] duration-250 ease-(--ease-standard)",
                          closed
                            ? "w-full bg-status-done"
                            : isCurrent
                              ? "w-1/3 bg-status-current/60"
                              : "w-0 bg-status-current/60",
                        )}
                      />
                    </span>
                  ) : null}
                  <StepTip step={step}>
                    <button
                      type="button"
                      data-step={step.id}
                      data-status={step.status}
                      tabIndex={index === focusIndex ? 0 : -1}
                      aria-current={isCurrent ? "step" : undefined}
                      aria-pressed={onSelect ? selected === step.id : undefined}
                      onClick={() => onSelect?.(step.id)}
                      onKeyDown={(event) => onKeyDown(event, index)}
                      className={cn(
                        "flex w-full min-w-0 flex-col items-center gap-1.5 rounded-lg px-2 py-1.5 text-center transition-colors duration-150 hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                        selected === step.id && "bg-muted",
                      )}
                    >
                      <span
                        key={`${step.status}:${isCurrent}`}
                        className={cn("flex", isCurrent && "motion-safe:animate-rail-pop")}
                      >
                        <StepMarker status={step.status} isCurrent={isCurrent} number={index + 1} />
                      </span>
                      <span
                        className={cn(
                          "w-full truncate text-sm leading-tight",
                          isCurrent && "font-semibold",
                          step.status === "skipped" && "text-muted-foreground line-through",
                        )}
                      >
                        {step.title}
                      </span>
                      <span className={cn("w-full truncate text-[0.6875rem] leading-none", TONE_TEXT[tone])}>
                        {d.stepStatus[step.status]}
                        {step.gate && !closed && step.status !== "awaiting-gate" ? ` · ${d.stepRail.gate}` : ""}
                      </span>
                    </button>
                  </StepTip>
                </li>
              );
            })}
          </ol>
        </nav>
        <RailLegend />
      </div>
    </TooltipProvider>
  );
}
