/**
 * Concept A, "Orbit": a horizontal track with even columns. Each step is a ring that traces itself while running;
 * the connector to the next step fills when the step closes. One-line labels (full text in the tooltip) with the
 * status under them; a header with "Step n of total", a thin overall bar, the origin badge and the legend.
 */
import { cn } from "@/lib/utils";
import { TONE_TEXT } from "@/lib/status";
import { useI18n } from "@/i18n";
import { CLOSED, focusIndexOf, motionTone, railProgress, useAddedSteps, useRailKeys, type ConceptProps } from "./model";
import { StepMarker } from "./marker";
import { OriginBadge, RailLegend, StepTip } from "./parts";

export function ConceptA({ input, selected, onSelect, label, className }: ConceptProps) {
  const { d, f, p } = useI18n();
  const { steps, current } = input;
  const progress = railProgress(input);
  const added = useAddedSteps(steps);
  const { list, onKeyDown } = useRailKeys(steps.length);
  const focusIndex = focusIndexOf(input, selected);
  const percent = progress.total ? Math.round((progress.closed / progress.total) * 100) : 0;

  return (
    <div data-concept="a" className={cn("flex flex-col gap-3", className)}>
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
          className="h-full rounded-full bg-status-done transition-[width] duration-250 ease-(--ease-standard)"
          style={{ width: `${percent}%` }}
        />
      </div>

      <nav aria-label={label} className="relative -mx-1 overflow-x-auto px-1 pt-1 pb-2">
        <ol
          ref={list}
          className="grid min-w-full auto-cols-[minmax(7.5rem,1fr)] grid-flow-col"
          style={{ minWidth: `${steps.length * 7.5}rem` }}
        >
          {steps.map((step, index) => {
            const isCurrent = step.id === current;
            const tone = motionTone(step.status, isCurrent);
            const isNew = added.has(step.id);
            const closed = CLOSED.has(step.status);
            return (
              <li
                key={step.id}
                data-entering={isNew ? "true" : undefined}
                className={cn("relative flex min-w-0 flex-col items-center", isNew && "motion-safe:animate-rail-enter")}
              >
                {index < steps.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-[calc(1.125rem+0.25rem)] right-[calc(-50%+1.5rem)] left-[calc(50%+1.5rem)] h-0.5 overflow-hidden rounded-full bg-border"
                  >
                    <span
                      data-part="connector"
                      className={cn(
                        "block h-full rounded-full bg-status-done transition-[width] duration-250 ease-(--ease-standard)",
                        closed ? "w-full" : step.status === "running" || isCurrent ? "w-1/3" : "w-0",
                        !closed && "bg-status-current/60",
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
                      "group flex w-full min-w-0 flex-col items-center gap-1.5 rounded-lg px-2 py-1 text-center transition-colors duration-150 hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                      selected === step.id && "bg-muted",
                    )}
                  >
                    <span
                      key={`${step.status}:${isCurrent}`}
                      className={cn(isCurrent && "motion-safe:animate-rail-pop")}
                    >
                      <StepMarker status={step.status} isCurrent={isCurrent} number={index + 1} />
                    </span>
                    <span
                      className={cn(
                        "w-full truncate text-sm leading-tight",
                        isCurrent
                          ? "font-semibold"
                          : step.status === "skipped"
                            ? "text-muted-foreground line-through"
                            : "",
                      )}
                    >
                      {step.title}
                    </span>
                    <span className={cn("w-full truncate text-[0.6875rem] leading-none", TONE_TEXT[tone])}>
                      {d.stepStatus[step.status]}
                      {step.gate && step.status !== "done" ? ` · ${d.stepRail.gate}` : ""}
                    </span>
                    {isNew ? <span className="sr-only">{d.stepRail.added}</span> : null}
                  </button>
                </StepTip>
              </li>
            );
          })}
        </ol>
      </nav>
      <RailLegend />
    </div>
  );
}
