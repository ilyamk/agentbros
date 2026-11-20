/**
 * Concept C, "Checklist": a vertical list, one row per step, with room for what the horizontal rails hide (status in
 * words, owner, time, the first reason on the current row). A source card on top explains where the steps come from.
 * The running row's outline is traced by a moving line; a gate row breathes; closed rows sit quieter.
 */
import { Hand, Timer, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { TONE_TEXT } from "@/lib/status";
import { formatDuration } from "@/lib/format";
import { useI18n } from "@/i18n";
import {
  CLOSED,
  focusIndexOf,
  motionTone,
  railProgress,
  stepMotion,
  stepOrigin,
  useAddedSteps,
  useRailKeys,
  type ConceptProps,
} from "./model";
import { StepMarker } from "./marker";
import { OriginBadge, RailLegend, SourceLine } from "./parts";

export function ConceptC({ input, selected, onSelect, label, className }: ConceptProps) {
  const { d, f, p } = useI18n();
  const { steps, current } = input;
  const progress = railProgress(input);
  const added = useAddedSteps(steps);
  const { list, onKeyDown } = useRailKeys(steps.length);
  const focusIndex = focusIndexOf(input, selected);
  const origin = stepOrigin(input);
  const percent = progress.total ? (progress.closed / progress.total) * 100 : 0;

  return (
    <div data-concept="c" className={cn("flex flex-col gap-3", className)}>
      <div
        className={cn(
          "flex flex-col gap-2 rounded-lg border bg-card px-3 py-2.5",
          origin === "template" && "border-dashed border-status-waiting/50",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <OriginBadge input={input} />
          <span data-part="position" className="text-sm font-semibold tabular-nums">
            {progress.position
              ? f(d.stepRail.position, { n: progress.position, total: progress.total })
              : progress.closed === progress.total
                ? p(d.stepRail.allClosed, progress.total)
                : d.stepRail.noCurrent}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{d.stepRail.originHint[origin]}</p>
        <div className="flex items-center gap-3">
          <SourceLine input={input} />
          <span aria-hidden="true" className="ms-auto h-1.5 w-32 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-status-done transition-[width] duration-250 ease-(--ease-standard)"
              style={{ width: `${percent}%` }}
            />
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {f(d.stepRail.closed, { n: progress.closed, total: progress.total })}
          </span>
        </div>
      </div>

      <nav aria-label={label}>
        <ol ref={list} className="flex flex-col">
          {steps.map((step, index) => {
            const isCurrent = step.id === current;
            const motion = stepMotion(step.status, isCurrent);
            const tone = motionTone(step.status, isCurrent);
            const isNew = added.has(step.id);
            const closed = CLOSED.has(step.status);
            return (
              <li
                key={step.id}
                data-entering={isNew ? "true" : undefined}
                className={cn("relative flex min-w-0 gap-3", isNew && "motion-safe:animate-rail-enter")}
              >
                {index < steps.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute top-[2.375rem] bottom-[-0.375rem] left-[1.3125rem] w-0.5 rounded-full transition-colors duration-250",
                      closed ? "bg-status-done/70" : "bg-border",
                    )}
                  />
                ) : null}
                <button
                  type="button"
                  data-step={step.id}
                  data-status={step.status}
                  data-motion={motion}
                  tabIndex={index === focusIndex ? 0 : -1}
                  aria-current={isCurrent ? "step" : undefined}
                  aria-pressed={onSelect ? selected === step.id : undefined}
                  onClick={() => onSelect?.(step.id)}
                  onKeyDown={(event) => onKeyDown(event, index)}
                  className={cn(
                    "relative my-0.5 flex w-full min-w-0 items-center gap-3 rounded-lg px-1.5 py-1.5 text-start transition-colors duration-150 hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                    selected === step.id && "bg-muted",
                    motion === "pulse" && "bg-status-waiting/8",
                    motion === "error" && "bg-status-blocked/6",
                  )}
                >
                  {motion === "orbit" ? (
                    <svg
                      aria-hidden="true"
                      data-part="trace"
                      className="pointer-events-none absolute inset-[0.75px] h-[calc(100%-1.5px)] w-[calc(100%-1.5px)] overflow-visible text-status-current"
                    >
                      <rect
                        width="100%"
                        height="100%"
                        rx="8"
                        fill="none"
                        stroke="currentColor"
                        strokeOpacity="0.18"
                        strokeWidth="1.5"
                      />
                      <rect
                        width="100%"
                        height="100%"
                        rx="8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        pathLength={100}
                        strokeDasharray="18 82"
                        className="motion-safe:animate-rail-trace motion-safe:[animation-duration:2.4s]"
                      />
                    </svg>
                  ) : null}
                  <span key={`${step.status}:${isCurrent}`} className={cn(isCurrent && "motion-safe:animate-rail-pop")}>
                    <StepMarker status={step.status} isCurrent={isCurrent} number={index + 1} shape="square" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          "min-w-0 truncate text-sm",
                          isCurrent ? "font-semibold" : closed ? "text-muted-foreground" : "",
                          step.status === "skipped" && "line-through",
                        )}
                      >
                        {step.title}
                      </span>
                      {origin === "template" ? (
                        <span className="shrink-0 rounded border border-dashed px-1 text-[0.625rem] text-muted-foreground uppercase">
                          {d.stepRail.template}
                        </span>
                      ) : null}
                      {isNew ? (
                        <span className="shrink-0 rounded bg-status-current/15 px-1 text-[0.625rem] font-medium text-status-current uppercase">
                          {d.stepRail.added}
                        </span>
                      ) : null}
                    </span>
                    {isCurrent && step.reasons[0] ? (
                      <span className="line-clamp-1 text-xs text-muted-foreground">{step.reasons[0]}</span>
                    ) : null}
                  </span>
                  <span className="hidden shrink-0 items-center gap-3 text-xs text-muted-foreground sm:flex">
                    {step.owner ? (
                      <span className="flex max-w-40 items-center gap-1">
                        <User aria-hidden="true" className="size-3.5 shrink-0" />
                        <span className="truncate">{step.owner}</span>
                      </span>
                    ) : null}
                    {step.durationMs !== undefined ? (
                      <span className="flex items-center gap-1 tabular-nums">
                        <Timer aria-hidden="true" className="size-3.5" />
                        {formatDuration(step.durationMs, d.units)}
                      </span>
                    ) : null}
                    {step.gate && !closed ? (
                      <span className="flex items-center gap-1">
                        <Hand aria-hidden="true" className="size-3.5" />
                        {d.stepRail.gate}
                      </span>
                    ) : null}
                  </span>
                  <span className={cn("w-28 shrink-0 text-end text-xs font-medium", TONE_TEXT[tone])}>
                    {d.stepStatus[step.status]}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <RailLegend />
    </div>
  );
}
