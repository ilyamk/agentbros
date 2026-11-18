/**
 * Step rail. Built on shadcn primitives with uiarc (Arc UI) free `stepper` as the reference (MIT, Copyright (c) 2026
 * Elia Kuratli; github.com/kuratlielia/arc-library @ 8302b52): a list with one marker per step, connectors, the current
 * step marked `aria-current="step"`, arrow keys moving between steps and Home/End jumping. Changes: a step has one of the
 * console's status tones with an icon (not only complete/current/upcoming/error); the rail scrolls horizontally instead
 * of collapsing labels (the bake-off found uiarc's labels colliding in a narrow pane); no `motion`.
 */
import { useRef, type KeyboardEvent } from "react";
import type { StepRow } from "@contract";
import { cn } from "@/lib/utils";
import { stepTone, TONE_BG, TONE_BORDER } from "@/lib/status";
import { useI18n } from "@/i18n";
import { StatusIcon } from "./status";

export interface StepRailProps {
  steps: StepRow[];
  current?: string;
  selected?: string;
  onSelect?: (id: string) => void;
  label: string;
  className?: string;
}

export function StepRail({ steps, current, selected, onSelect, label, className }: StepRailProps) {
  const { d } = useI18n();
  const list = useRef<HTMLOListElement>(null);
  const focusAt = (index: number) => {
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>("button[data-step]");
    const target = buttons?.[Math.max(0, Math.min((buttons?.length ?? 1) - 1, index))];
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: steps.length - 1,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    focusAt(next);
  };
  const focusIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === (selected ?? current)),
  );

  return (
    <nav aria-label={label} className={cn("relative w-full overflow-x-auto pb-1", className)}>
      <ol ref={list} className="flex min-w-max items-start gap-0">
        {steps.map((step, index) => {
          const isCurrent = step.id === current;
          const tone = stepTone(step.status, isCurrent);
          return (
            <li key={step.id} className="flex items-start">
              <button
                type="button"
                data-step={step.id}
                tabIndex={index === focusIndex ? 0 : -1}
                aria-current={isCurrent ? "step" : undefined}
                aria-pressed={onSelect ? selected === step.id : undefined}
                onClick={() => onSelect?.(step.id)}
                onKeyDown={(event) => onKeyDown(event, index)}
                title={`${step.title}: ${d.stepStatus[step.status]}`}
                className={cn(
                  "group flex w-20 flex-col items-center gap-1 rounded-md px-1 py-1 text-center transition-colors duration-150 hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none sm:w-24",
                  selected === step.id && "bg-muted",
                )}
              >
                <span
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full border-2 bg-card",
                    TONE_BORDER[tone],
                    isCurrent && "ring-2 ring-ring/40 ring-offset-1 ring-offset-background",
                  )}
                >
                  <StatusIcon tone={tone} />
                </span>
                <span
                  className={cn(
                    "line-clamp-2 text-xs leading-tight",
                    isCurrent ? "font-semibold" : "text-muted-foreground",
                  )}
                >
                  {step.title}
                </span>
                <span className="sr-only">{d.stepStatus[step.status]}</span>
              </button>
              {index < steps.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-4 h-0.5 w-3 shrink-0 rounded sm:w-5",
                    step.status === "done" || step.status === "skipped" ? TONE_BG.done : "bg-border",
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
