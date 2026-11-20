/**
 * Three project header concepts (docs/console-steps.md#project-header). Each one answers, in order: which project is
 * this, what is happening now, does anything wait for me, what has it cost, and what can I do. They differ in where
 * the live state sits and how much room it takes.
 */
import type { ProjectView } from "@contract";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { TONE_TEXT } from "@/lib/status";
import { StepMarker } from "@/components/step-rail/marker";
import { motionTone } from "@/components/step-rail/model";
import {
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

export interface HeaderProps {
  view: ProjectView;
  page: Page;
}

/** "Step title · Running" with the rail's own marker, so the header and the rail speak the same language. */
function NowStep({ facts, className }: { facts: HeaderFacts; className?: string }) {
  const { d, f } = useI18n();
  const step = facts.step;
  if (!step)
    return (
      <span className={cn("text-sm text-muted-foreground", className)}>
        {facts.progress.total && facts.progress.closed === facts.progress.total ? d.header.allDone : d.topbar.noStep}
      </span>
    );
  return (
    <span data-header-step={step.id} className={cn("flex min-w-0 items-center gap-2", className)}>
      <StepMarker status={step.status} isCurrent number={facts.progress.position} size="sm" />
      <span className="min-w-0 truncate text-sm font-medium">{step.title}</span>
      <span className={cn("shrink-0 text-xs", TONE_TEXT[motionTone(step.status, true)])}>
        {d.stepStatus[step.status]}
      </span>
      <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">
        {f(d.stepRail.position, { n: facts.progress.position ?? 0, total: facts.progress.total })}
      </span>
    </span>
  );
}

/**
 * A · Command bar. Two quiet rows: identity and live state on the left, money, waiting and the one fitting action on
 * the right; tabs and tools below. Densest; suits a laptop beside the chat.
 */
export function HeaderA({ view, page }: HeaderProps) {
  const { d } = useI18n();
  const facts = useHeaderFacts(view);
  return (
    <header data-header-concept="a" aria-label={d.topbar.project} className="border-b bg-background/95">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 pt-3 pb-2 lg:px-6">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <h1 className="truncate font-display text-lg leading-tight font-semibold">{facts.title}</h1>
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <MetaLine facts={facts} />
            <span aria-hidden="true" className="hidden h-3 w-px bg-border sm:block" />
            <span className={cn("flex min-w-0 items-center gap-1.5 text-xs", LIVE_TEXT[facts.live])}>
              <LiveDot live={facts.live} className="size-2 [&>span]:size-2" />
              <span key={facts.liveText} className="truncate motion-safe:animate-rail-enter">
                {facts.liveText}
              </span>
            </span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <WaitingButton view={view} count={facts.waiting} page={page} />
          <SpendMeter facts={facts} className="w-32" />
          <ProjectActions view={view} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 lg:px-6">
        <ProjectTabs view={view} page={page} />
        <NowStep facts={facts} className="order-first w-full pt-1 md:order-none md:w-auto md:pt-0" />
        <ProjectTools view={view} className="ms-auto hidden py-1.5 md:flex" />
      </div>
    </header>
  );
}

/**
 * B · Status hero. The project as a summary card: a large title, one "now" sentence with progress, and three tiles
 * (waiting, budget, autonomy) that each lead somewhere. Most explanatory; suits checking in on a long run.
 */
export function HeaderB({ view, page }: HeaderProps) {
  const { d } = useI18n();
  const facts = useHeaderFacts(view);
  const percent = facts.progress.total ? (facts.progress.closed / facts.progress.total) * 100 : 0;
  return (
    <header data-header-concept="b" aria-label={d.topbar.project} className="border-b">
      <div className="grid gap-4 px-4 pt-4 pb-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:px-6">
        <div className="flex min-w-0 flex-col gap-2">
          <MetaLine facts={facts} className="tracking-wide uppercase" />
          <h1 className="truncate font-display text-2xl leading-tight font-semibold">{facts.title}</h1>
          <div className="flex min-w-0 flex-col gap-1.5">
            <NowStep facts={facts} />
            <span className="flex items-center gap-3">
              <span aria-hidden="true" className="h-1 w-full max-w-sm overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-status-done transition-[width] duration-250 ease-(--ease-standard)"
                  style={{ width: `${percent}%` }}
                />
              </span>
              <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", LIVE_TEXT[facts.live])}>
                <LiveDot live={facts.live} />
                <span key={facts.liveText} className="motion-safe:animate-rail-enter">
                  {facts.liveText}
                </span>
              </span>
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-2 lg:items-end">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:w-[30rem]">
            <div className="flex min-w-0 flex-col justify-between gap-1 rounded-lg border bg-card px-3 py-2">
              <span className="text-[0.6875rem] text-muted-foreground uppercase">{d.canvas.waiting}</span>
              {facts.waiting ? (
                <WaitingButton view={view} count={facts.waiting} page={page} variant="plain" />
              ) : (
                <span className="text-xs text-muted-foreground">{d.header.nothingWaits}</span>
              )}
            </div>
            <div className="flex min-w-0 flex-col justify-between gap-1 rounded-lg border bg-card px-3 py-2">
              <span className="text-[0.6875rem] text-muted-foreground uppercase">{d.header.budget}</span>
              <SpendMeter facts={facts} />
            </div>
            <div className="col-span-2 flex min-w-0 flex-col justify-between gap-1 rounded-lg border bg-card px-3 py-2 sm:col-span-1">
              <span className="text-[0.6875rem] text-muted-foreground uppercase">{d.autonomy.label}</span>
              <span className="truncate text-xs font-medium">{facts.autonomy}</span>
            </div>
          </div>
          <ProjectActions view={view} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 px-4 lg:px-6">
        <ProjectTabs view={view} page={page} />
        <ProjectTools view={view} className="ms-auto hidden py-1.5 md:flex" />
      </div>
    </header>
  );
}

/**
 * C · Live strip. A thin full-width strip carries only the live state, tinted by it, with the fitting action; below,
 * identity, a segmented page switch and the tools. Calmest; the strip reads at a glance from across the room.
 */
export function HeaderC({ view, page }: HeaderProps) {
  const { d } = useI18n();
  const facts = useHeaderFacts(view);
  return (
    <header data-header-concept="c" aria-label={d.topbar.project} className="border-b">
      <div
        data-live-strip={facts.live}
        className={cn(
          "flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 transition-colors duration-250 lg:px-6",
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
          <ProjectActions view={view} />
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 px-4 pt-3 pb-3 lg:px-6">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <h1 className="truncate font-display text-xl leading-tight font-semibold">{facts.title}</h1>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <MetaLine facts={facts} />
            <SpendMeter facts={facts} className="w-36" />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProjectTabs view={view} page={page} variant="segmented" />
          <ProjectTools view={view} className="hidden md:flex" />
        </div>
      </div>
    </header>
  );
}

export const HEADER_CONCEPTS = { a: HeaderA, b: HeaderB, c: HeaderC } as const;
