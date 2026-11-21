/**
 * Project header (RFC 0004 §5.1; docs/console-steps.md#project-header, the user's pick of three concepts, 2026-11-20).
 * A thin full-width live strip carries only what is happening now, tinted by it (violet: an agent works, grey: idle,
 * amber: paused, red: stopped): the live line, the current step with the step rail's marker, what waits for the user
 * and the fitting action. Below: the title with route and playbook, spend and autonomy, a segmented page switch with
 * icons and the desktop tools. Motion: the dot breathes only while an agent works, the live line and the waiting count
 * slide or pop in when they change, the strip's tint and the spend bar ease; all off under reduced motion.
 */
import type { ProjectView } from "@contract";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { TONE_TEXT } from "@/lib/status";
import { snapshotMode } from "@/lib/snapshot-mode";
import { StepMarker } from "@/components/step-rail/marker";
import { motionTone } from "@/components/step-rail/model";
import {
  AutonomySetting,
  LIVE_TEXT,
  LiveDot,
  MetaLine,
  ProjectActions,
  ProjectTabs,
  ProjectTools,
  SpendMeter,
  useHeaderFacts,
  WaitingButton,
  type HeaderFacts,
  type Page,
} from "./parts";

export type { Page } from "./parts";

/** "n · Step title · Running · Step n of N" with the rail's own marker. */
function NowStep({ facts, className }: { facts: HeaderFacts; className?: string }) {
  const { d, f } = useI18n();
  const step = facts.step;
  if (!step)
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        {facts.progress.total && facts.progress.closed === facts.progress.total ? d.header.allDone : d.topbar.noStep}
      </span>
    );
  return (
    <span data-header-step={step.id} className={cn("min-w-0 items-center gap-2", className)}>
      <span className="sr-only">{d.topbar.step}: </span>
      <StepMarker status={step.status} isCurrent number={facts.progress.position} size="sm" />
      <span className="min-w-0 truncate text-sm font-medium">{step.title}</span>
      <span className={cn("shrink-0 text-xs", TONE_TEXT[motionTone(step.status, true)])}>
        {d.stepStatus[step.status]}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {f(d.stepRail.position, { n: facts.progress.position ?? 0, total: facts.progress.total })}
      </span>
    </span>
  );
}

export function ProjectHeader({ view, page }: { view: ProjectView; page: Page }) {
  const { d } = useI18n();
  const facts = useHeaderFacts(view);
  const snapshot = !!snapshotMode();
  return (
    <header aria-label={d.topbar.project} className="border-b">
      <div
        data-live-strip={facts.live}
        className={cn(
          "flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-1.5 transition-colors duration-250 lg:px-6",
          facts.live === "working" && "bg-status-current/10",
          facts.live === "idle" && "bg-muted/50",
          facts.live === "paused" && "bg-status-paused/12",
          facts.live === "stopped" && "bg-status-blocked/10",
        )}
      >
        <span className={cn("flex min-w-0 items-center gap-2 text-sm font-medium", LIVE_TEXT[facts.live])}>
          <LiveDot live={facts.live} />
          <span key={facts.liveText} className="truncate motion-safe:animate-rail-enter">
            {facts.liveText}
          </span>
        </span>
        <NowStep facts={facts} className="hidden md:flex" />
        <span className="ms-auto flex items-center gap-3">
          <WaitingButton view={view} count={facts.waiting} page={page} />
          {snapshot ? null : <ProjectActions view={view} />}
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 px-4 py-3 lg:px-6">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5">
          <h1 className="truncate font-display text-xl leading-tight font-semibold">{facts.title}</h1>
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <MetaLine facts={facts} />
            <SpendMeter facts={facts} className="w-36" />
            <AutonomySetting view={view} />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProjectTabs view={view} page={page} />
          <ProjectTools view={view} />
        </div>
      </div>
    </header>
  );
}
