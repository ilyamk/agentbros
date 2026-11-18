/** Project top bar (RFC 0004 §5.1): route · step · active agent and elapsed · pause/stop · autonomy · spend / ceiling. */
import type { ProjectView } from "@contract";
import { Bot, Gauge, Wallet } from "lucide-react";
import { useI18n } from "@/i18n";
import { useNow } from "@/lib/clock";
import { formatDuration, formatUsd } from "@/lib/format";
import { CONTROL_TONE } from "@/lib/status";
import { ToneBadge, StepStatusBadge } from "@/components/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { runDuration } from "@/panels/generic/agents";
import { ceilingOf } from "@/panels/generic/money";
import { AutonomyControl } from "./autonomy";
import { ControlButtons } from "./control";
import { snapshotMode } from "@/lib/snapshot-mode";

export function TopBar({ view }: { view: ProjectView }) {
  const { d, f, locale } = useI18n();
  const now = useNow();
  const step = view.steps.find((row) => row.id === view.current?.step);
  const active = view.agents.active;
  const ceiling = ceilingOf(view);
  const spent = formatUsd(view.money.spentUsd, locale);
  const autonomy = view.autonomy;
  return (
    <header
      aria-label={d.topbar.project}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-background/95 px-4 py-3 lg:px-6"
    >
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate font-display text-lg leading-tight font-semibold">
          {view.project.title ?? view.project.id}
        </h1>
        <p className="truncate text-xs text-muted-foreground">
          <span className="sr-only">{d.topbar.route}: </span>
          {[view.project.route, view.project.filmType, view.project.playbook].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="sr-only">{d.topbar.step}:</span>
        {step ? (
          <span className="flex items-center gap-1.5">
            <span className="font-medium">{step.title}</span>
            <StepStatusBadge status={step.status} current />
          </span>
        ) : (
          <span className="text-muted-foreground">{d.topbar.noStep}</span>
        )}
        {view.control.state !== "running" ? (
          <ToneBadge tone={CONTROL_TONE[view.control.state]}>{d.control[view.control.state]}</ToneBadge>
        ) : null}
      </div>
      <p className="flex min-w-0 items-center gap-1.5 text-sm" aria-live="off">
        {active ? (
          <>
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full bg-status-current ring-4 ring-status-current/20"
            />
            <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">
              {f(d.topbar.active, { name: active.name, elapsed: formatDuration(runDuration(active, now), d.units) })}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">{d.topbar.idle}</span>
        )}
      </p>
      {/* Pushes the controls right while they share the first line; once they wrap, it stays behind and they start at the left edge. */}
      <span aria-hidden="true" className="-me-4 grow" />
      <div className="flex flex-wrap items-center gap-2">
        {snapshotMode() ? null : <ControlButtons view={view} />}
        {snapshotMode() ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Gauge className="size-3.5" aria-hidden="true" />
                <span className="sr-only">{d.autonomy.label}: </span>
                {autonomy.mode === "autonomous" ? d.autonomy.autonomous : d.autonomy.interactive}
                {autonomy.finalReviewOnly ? ` · ${d.autonomy.finalReviewOnly}` : ""}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {d.autonomy.label}: {d.autonomy.source[autonomy.source]}.
            </TooltipContent>
          </Tooltip>
        ) : (
          <AutonomyControl view={view} />
        )}
        <span className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs tabular-nums">
          <Wallet className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{d.topbar.spend}: </span>
          {ceiling !== undefined
            ? f(d.topbar.spent, { spent, ceiling: formatUsd(ceiling, locale) })
            : f(d.topbar.spentNoCeiling, { spent })}
        </span>
      </div>
    </header>
  );
}
