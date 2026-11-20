/**
 * Project header parts (docs/console-steps.md#project-header). One fact, one element: identity (title, route,
 * playbook), live state (control, agent, current step), what waits for the user, money and autonomy, and the project's
 * actions (the fitting one in view, stop behind "more").
 */
import { useState } from "react";
import type { ControlState, ProjectView } from "@contract";
import {
  ChartGantt,
  CirclePause,
  CirclePlay,
  CircleStop,
  Coins,
  Ellipsis,
  Gauge,
  Hand,
  History,
  LayoutDashboard,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useNow } from "@/lib/clock";
import { formatDuration, formatUsd } from "@/lib/format";
import { projectHref } from "@/lib/router";
import { snapshotMode } from "@/lib/snapshot-mode";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { runDuration } from "@/panels/generic/agents";
import { ceilingOf } from "@/panels/generic/money";
import { railProgress, railInput } from "@/components/step-rail/model";
import { StudioHeaderButton } from "@/media/studio-action";
import { EditingTableActions } from "../editing-table";
import { ControlDialog } from "../control";
import { AutonomyDialog } from "../autonomy";
import { PaidJobs, inFlightJobs } from "../paid-jobs";

export type Page = "canvas" | "history" | "timeline";

/** The live state in one word: what the project is doing right now. */
export type Live = "working" | "idle" | "paused" | "stopped";

export function useHeaderFacts(view: ProjectView) {
  const { d, f, locale } = useI18n();
  const now = useNow();
  const active = view.agents.active;
  const progress = railProgress(railInput(view));
  const live: Live =
    view.control.state === "paused"
      ? "paused"
      : view.control.state === "stopped"
        ? "stopped"
        : active
          ? "working"
          : "idle";
  const ceiling = ceilingOf(view);
  return {
    title: view.project.title ?? view.project.id,
    meta: [view.project.route, view.project.filmType, view.project.playbook].filter(Boolean) as string[],
    live,
    step: progress.currentStep,
    progress,
    waiting: view.waiting.length,
    spent: formatUsd(view.money.spentUsd, locale),
    ceiling: ceiling !== undefined ? formatUsd(ceiling, locale) : undefined,
    ratio: ceiling ? Math.min(1, view.money.spentUsd / ceiling) : undefined,
    liveText:
      live === "working" && active
        ? f(d.topbar.active, { name: active.name, elapsed: formatDuration(runDuration(active, now), d.units) })
        : live === "paused"
          ? d.header.paused
          : live === "stopped"
            ? d.header.stopped
            : d.topbar.idle,
  };
}
export type HeaderFacts = ReturnType<typeof useHeaderFacts>;

export const LIVE_TEXT: Record<Live, string> = {
  working: "text-status-current",
  idle: "text-muted-foreground",
  paused: "text-status-paused",
  stopped: "text-status-blocked",
};
const LIVE_BG: Record<Live, string> = {
  working: "bg-status-current",
  idle: "bg-muted-foreground/60",
  paused: "bg-status-paused",
  stopped: "bg-status-blocked",
};

/** A dot that breathes while an agent works; still otherwise. */
export function LiveDot({ live, className }: { live: Live; className?: string }) {
  return (
    <span data-live={live} aria-hidden="true" className={cn("relative inline-flex size-2.5 shrink-0", className)}>
      {live === "working" ? (
        <span className={cn("absolute inset-0 rounded-full motion-safe:animate-rail-pulse", LIVE_BG[live])} />
      ) : null}
      <span className={cn("relative size-2.5 rounded-full", LIVE_BG[live])} />
    </span>
  );
}

/** Scrolls the canvas to the pinned decisions and focuses the first card; on other pages, opens the canvas. */
export function WaitingButton({ view, count, page }: { view: ProjectView; count: number; page: Page }) {
  const { d, p } = useI18n();
  if (!count) return null;
  const go = () => {
    if (page !== "canvas") {
      window.location.hash = projectHref(view.project.id).slice(1);
      return;
    }
    const section = document.getElementById("waiting-heading");
    section?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    (document.querySelector<HTMLElement>('[data-card="decision"]') ?? section)?.focus?.({ preventScroll: true });
  };
  return (
    <button
      type="button"
      data-header-waiting={count}
      onClick={go}
      className="inline-flex items-center gap-1.5 rounded-full border border-status-waiting/50 bg-status-waiting/10 px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-150 hover:bg-status-waiting/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <Hand aria-hidden="true" className="size-3.5 text-status-waiting" />
      <span key={count} className="motion-safe:animate-rail-pop">
        {p(d.header.waiting, count)}
      </span>
    </button>
  );
}

/** Spend against the ceiling: a number and, when there is a ceiling, a bar that fills (amber past 80 %). */
export function SpendMeter({ facts, className }: { facts: HeaderFacts; className?: string }) {
  const { d, f } = useI18n();
  const ratio = facts.ratio;
  return (
    <span data-header-spend className={cn("inline-flex min-w-0 flex-col gap-1", className)}>
      <span className="inline-flex items-baseline gap-1 text-xs tabular-nums">
        <Wallet aria-hidden="true" className="size-3.5 shrink-0 self-center text-muted-foreground" />
        <span className="sr-only">{d.topbar.spend}: </span>
        <span className="font-semibold">{facts.spent}</span>{" "}
        <span className="text-muted-foreground">
          {facts.ceiling ? f(d.header.of, { ceiling: facts.ceiling }) : d.header.noCeiling}
        </span>
      </span>
      {ratio !== undefined ? (
        <span aria-hidden="true" className="h-1 w-full min-w-16 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              "block h-full rounded-full transition-[width] duration-250 ease-(--ease-standard)",
              ratio >= 0.8 ? "bg-status-waiting" : "bg-status-done",
            )}
            style={{ width: `${Math.max(2, ratio * 100)}%` }}
          />
        </span>
      ) : null}
    </span>
  );
}

/** Autonomy as a quiet setting: reads as text, opens the autonomy and budget form; plain text in a snapshot. */
export function AutonomySetting({ view }: { view: ProjectView }) {
  const { d } = useI18n();
  const [open, setOpen] = useState(false);
  const autonomy = view.autonomy;
  const label = `${autonomy.mode === "autonomous" ? d.autonomy.autonomous : d.autonomy.interactive}${
    autonomy.finalReviewOnly ? ` · ${d.autonomy.finalReviewOnly}` : ""
  }`;
  const snapshot = !!snapshotMode();
  const body = (
    <>
      <Gauge aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">{snapshot ? d.autonomy.label : d.autonomy.change}: </span>
      {label}
    </>
  );
  const tone = autonomy.mode === "autonomous" ? "text-status-waiting" : "text-muted-foreground";
  if (snapshot) return <span className={cn("inline-flex items-center gap-1 text-xs", tone)}>{body}</span>;
  return (
    <>
      <button
        type="button"
        data-autonomy-control
        aria-haspopup="dialog"
        title={d.autonomy.change}
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm text-xs underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
          tone,
        )}
      >
        {body}
      </button>
      {open ? <AutonomyDialog view={view} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * The project's actions: the one that fits the state (pause while running, resume while paused or stopped) stays in
 * view; stop lives behind "more", since it is rare and consequential. A stopped project with paid jobs still in flight
 * keeps "Paid jobs" in view.
 */
export function ProjectActions({ view }: { view: ProjectView }) {
  const { d } = useI18n();
  const [target, setTarget] = useState<ControlState | null>(null);
  const [jobsOpen, setJobsOpen] = useState(false);
  const state = view.control.state;
  const primary: ControlState = state === "running" ? "paused" : "running";
  const PrimaryIcon = primary === "paused" ? CirclePause : CirclePlay;
  const inFlight = state === "stopped" ? inFlightJobs(view).length : 0;
  return (
    <div role="group" aria-label={d.control.label} className="flex items-center gap-1">
      {inFlight ? (
        <Button variant="outline" size="sm" data-paid-jobs-open onClick={() => setJobsOpen(true)}>
          <Coins aria-hidden="true" />
          {`${d.control.jobs.open} (${inFlight})`}
        </Button>
      ) : null}
      <Button
        variant={primary === "running" ? "default" : "outline"}
        size="sm"
        data-control={primary}
        onClick={() => setTarget(primary)}
      >
        <PrimaryIcon aria-hidden="true" />
        {primary === "paused" ? d.control.pause : d.control.resume}
      </Button>
      {state !== "stopped" ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={d.header.more} title={d.header.more} data-header-more>
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              data-control="stopped"
              className="text-status-blocked focus:text-status-blocked"
              onSelect={() => setTarget("stopped")}
            >
              <CircleStop aria-hidden="true" />
              {d.control.stop}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {target ? <ControlDialog view={view} target={target} onClose={() => setTarget(null)} /> : null}
      {jobsOpen ? (
        <Dialog open onOpenChange={(open) => (!open ? setJobsOpen(false) : undefined)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{d.control.jobs.title}</DialogTitle>
              <DialogDescription>{d.control.stopBody}</DialogDescription>
            </DialogHeader>
            <PaidJobs view={view} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setJobsOpen(false)}>
                {d.app.close}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

const PAGE_ICON: Record<Page, LucideIcon> = { canvas: LayoutDashboard, history: History, timeline: ChartGantt };

/** Canvas, History, Timeline as a segmented control, each with its icon (only Canvas in a snapshot). */
export function ProjectTabs({ view, page, className }: { view: ProjectView; page: Page; className?: string }) {
  const { d } = useI18n();
  const pages: Page[] = snapshotMode() ? ["canvas"] : ["canvas", "history", "timeline"];
  const name = (item: Page) =>
    item === "canvas" ? d.canvas.canvas : item === "history" ? d.canvas.history : d.canvas.timeline;
  return (
    <nav
      aria-label={view.project.title ?? view.project.id}
      className={cn("flex w-fit min-w-0 gap-0.5 rounded-lg bg-muted p-[3px]", className)}
    >
      {pages.map((item) => {
        const Icon = PAGE_ICON[item];
        return (
          <a
            key={item}
            href={projectHref(view.project.id, item)}
            aria-current={page === item ? "page" : undefined}
            data-page={item}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm whitespace-nowrap transition-colors duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              page === item
                ? "bg-background font-medium shadow-sm dark:bg-input/30"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon aria-hidden="true" className={cn("size-4 shrink-0", page === item && "text-primary")} />
            {name(item)}
          </a>
        );
      })}
    </nav>
  );
}

/**
 * Tools that open something outside the console: Remotion Studio and the editing table. Desktop work, so they show
 * from the md breakpoint up and phones keep to status and decisions.
 */
export function ProjectTools({ view, className }: { view: ProjectView; className?: string }) {
  if (snapshotMode()) return null;
  return (
    <div className={cn("hidden flex-wrap items-center gap-2 md:flex", className)}>
      <StudioHeaderButton project={view.project.id} />
      <EditingTableActions view={view} />
    </div>
  );
}

/** Route, film type and playbook as quiet monospace tokens. */
export function MetaLine({ facts, className }: { facts: HeaderFacts; className?: string }) {
  const { d } = useI18n();
  return (
    <p className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground", className)}>
      <span className="sr-only">{d.topbar.route}: </span>
      {facts.meta.map((part, index) => (
        <span key={part} className="flex items-center gap-1.5">
          {index ? <span aria-hidden="true">·</span> : null}
          <span className="font-mono">{part}</span>
        </span>
      ))}
    </p>
  );
}
