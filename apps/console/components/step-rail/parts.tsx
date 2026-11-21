/**
 * Step rail parts: the origin badge (which route or playbook produced the steps, template or real), the
 * legend of the eight motions, and the step tooltip.
 */
import type { ReactNode } from "react";
import { Info, Layers } from "lucide-react";
import type { StepRow } from "@contract";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Disclosure } from "@/components/ui/disclosure";
import { MOTIONS, stepOrigin, type Motion, type RailInput } from "./model";
import { StepMarker } from "./marker";

/** A status that shows each motion in the legend. */
const SAMPLE: Record<Motion, { status: StepRow["status"]; current?: boolean }> = {
  orbit: { status: "running", current: true },
  pulse: { status: "awaiting-gate" },
  check: { status: "done" },
  error: { status: "failing" },
  stale: { status: "stale" },
  skipped: { status: "skipped" },
  ready: { status: "ready" },
  pending: { status: "pending" },
};

export function OriginBadge({ input, className }: { input: RailInput; className?: string }) {
  const { d, f, p } = useI18n();
  const origin = stepOrigin(input);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-origin={origin}
          className={cn(
            "inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors duration-150 hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
            origin === "template" ? "border-dashed border-status-waiting/60" : "border-border",
            className,
          )}
        >
          <Layers aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {d.stepRail.origin[origin]} · {p(d.stepRail.count, input.steps.length)}
          </span>
          <Info aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="flex max-w-sm flex-col gap-1 text-left">
        <span>{d.stepRail.originHint[origin]}</span>
        <span className="text-muted-foreground">
          {f(d.stepRail.route, { route: input.route })} ·{" "}
          {input.playbook ? f(d.stepRail.playbook, { playbook: input.playbook }) : d.stepRail.noPlaybook}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export function RailLegend({ className }: { className?: string }) {
  const { d } = useI18n();
  return (
    <Disclosure variant="plain" size="xs" muted className={className} summary={d.stepRail.legend}>
      <ul className="grid gap-x-6 gap-y-2 pt-2 sm:grid-cols-2 xl:grid-cols-4">
        {MOTIONS.map((motion) => (
          <li key={motion} data-legend={motion} className="flex items-center gap-2 text-xs">
            <StepMarker
              status={SAMPLE[motion].status}
              isCurrent={SAMPLE[motion].current}
              number={motion === "orbit" || motion === "ready" || motion === "pending" ? 2 : undefined}
              size="sm"
            />
            <span className="text-muted-foreground">{d.stepRail.motions[motion]}</span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

/** Tooltip of one step: title in full, status, the first reason, owner. */
export function StepTip({ step, children }: { step: StepRow; children: ReactNode }) {
  const { d } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="flex max-w-xs flex-col gap-0.5 text-left">
        <span className="font-semibold">{step.title}</span>
        <span>{d.stepStatus[step.status]}</span>
        {step.reasons[0] ? <span className="text-muted-foreground line-clamp-3">{step.reasons[0]}</span> : null}
        {step.owner ? <span className="text-muted-foreground">{step.owner}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
