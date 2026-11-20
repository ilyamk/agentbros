/**
 * Concept B, "Progress bar": built for long chains. A large "n / total" count and the current step's name, one
 * segmented bar (a segment per step: a light sweeps the running one, the gate one breathes, a failing one is striped),
 * and one line naming what runs now and what comes next. Every segment is a focusable button with a tooltip.
 */
import { cn } from "@/lib/utils";
import { TONE_TEXT } from "@/lib/status";
import { useI18n } from "@/i18n";
import {
  focusIndexOf,
  motionTone,
  railProgress,
  stepMotion,
  useAddedSteps,
  useRailKeys,
  type ConceptProps,
  type Motion,
} from "./model";
import { StepMarker } from "./marker";
import { OriginBadge, RailLegend, SourceLine, StepTip } from "./parts";

const SEGMENT: Record<Motion, string> = {
  orbit: "bg-status-current/25",
  pulse: "bg-status-waiting motion-safe:animate-rail-glow",
  check: "bg-status-done",
  error:
    "bg-status-blocked bg-[repeating-linear-gradient(135deg,transparent_0_4px,color-mix(in_oklab,var(--background)_45%,transparent)_4px_8px)]",
  stale:
    "bg-status-stale/70 bg-[repeating-linear-gradient(90deg,transparent_0_6px,color-mix(in_oklab,var(--background)_55%,transparent)_6px_9px)]",
  skipped: "bg-status-skipped/35",
  ready: "bg-muted-foreground/40",
  pending: "bg-muted",
};

export function ConceptB({ input, selected, onSelect, label, className }: ConceptProps) {
  const { d, f } = useI18n();
  const { steps, current } = input;
  const progress = railProgress(input);
  const added = useAddedSteps(steps);
  const { list, onKeyDown } = useRailKeys(steps.length);
  const focusIndex = focusIndexOf(input, selected);
  const now = progress.currentStep;

  return (
    <div data-concept="b" className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          {now ? (
            <span key={now.id} className="motion-safe:animate-rail-pop">
              <StepMarker status={now.status} isCurrent number={progress.position} size="lg" />
            </span>
          ) : null}
          <div className="flex min-w-0 flex-col">
            <span data-part="position" className="text-2xl leading-none font-semibold tabular-nums">
              {progress.position ?? progress.closed}
              <span className="text-base font-normal text-muted-foreground"> / {progress.total}</span>
            </span>
            <span className="truncate text-sm">
              {now ? (
                <>
                  <span className="font-medium">{now.title}</span>
                  <span className={cn("ms-2 text-xs", TONE_TEXT[motionTone(now.status, true)])}>
                    {d.stepStatus[now.status]}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  {f(d.stepRail.closed, { n: progress.closed, total: progress.total })}
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="flex min-w-0 flex-col items-end gap-1">
          <OriginBadge input={input} />
          <SourceLine input={input} />
        </div>
      </div>

      <nav aria-label={label}>
        <ol ref={list} className="flex h-3 items-stretch gap-1">
          {steps.map((step, index) => {
            const isCurrent = step.id === current;
            const motion = stepMotion(step.status, isCurrent);
            const isNew = added.has(step.id);
            return (
              <li
                key={step.id}
                data-entering={isNew ? "true" : undefined}
                className={cn("flex min-w-2 flex-1", isNew && "motion-safe:animate-rail-enter")}
              >
                <StepTip step={step}>
                  <button
                    type="button"
                    data-step={step.id}
                    data-status={step.status}
                    data-motion={motion}
                    tabIndex={index === focusIndex ? 0 : -1}
                    aria-current={isCurrent ? "step" : undefined}
                    aria-pressed={onSelect ? selected === step.id : undefined}
                    aria-label={`${index + 1}. ${step.title}: ${d.stepStatus[step.status]}`}
                    onClick={() => onSelect?.(step.id)}
                    onKeyDown={(event) => onKeyDown(event, index)}
                    className={cn(
                      "relative w-full overflow-hidden rounded-full transition-[background-color,box-shadow] duration-200 hover:brightness-110 focus-visible:ring-[3px] focus-visible:ring-ring/60 focus-visible:outline-none",
                      SEGMENT[motion],
                      (selected === step.id || isCurrent) && "ring-2 ring-ring/50 ring-offset-1 ring-offset-background",
                    )}
                  >
                    {motion === "orbit" ? (
                      <span
                        aria-hidden="true"
                        data-part="sweep"
                        className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-status-current motion-safe:animate-rail-sweep motion-reduce:w-full"
                      />
                    ) : null}
                  </button>
                </StepTip>
              </li>
            );
          })}
        </ol>
      </nav>

      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {now ? (
          <span className="min-w-0 truncate">
            <span className="font-medium text-foreground">{d.stepRail.now}:</span> {now.title}
          </span>
        ) : null}
        {progress.nextStep ? (
          <>
            <span aria-hidden="true">→</span>
            <span className="min-w-0 truncate">
              <span className="font-medium text-foreground">{d.stepRail.next}:</span> {progress.nextStep.title}
            </span>
          </>
        ) : null}
        <span className="ms-auto tabular-nums">
          {f(d.stepRail.closed, { n: progress.closed, total: progress.total })}
        </span>
      </p>
      <RailLegend />
    </div>
  );
}
