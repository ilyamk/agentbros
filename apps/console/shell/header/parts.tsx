/**
 * Project header concepts (docs/console-steps.md#project-header): the facts every concept shows and the parts they
 * share. One fact, one element: identity (title, route, playbook), live state (control, agent, current step), what
 * waits for the user, money, and the project's actions (pause/resume, then stop and autonomy behind a menu).
 */
import { useState } from "react";
import type { ControlState, ProjectView } from "@contract";
import { CirclePause, CirclePlay, CircleStop, Ellipsis, Gauge, Hand, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useNow } from "@/lib/clock";
import { formatDuration, formatUsd } from "@/lib/format";
import { projectHref } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { runDuration } from "@/panels/generic/agents";
import { ceilingOf } from "@/panels/generic/money";
import { railProgress, railInput } from "@/components/step-rail/model";
import { StudioHeaderButton } from "@/media/studio-action";
import { EditingTableActions } from "../editing-table";
import { ControlDialog } from "../control";
import { AutonomyDialog } from "../autonomy";

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
    agent: active ? { name: active.name, elapsed: formatDuration(runDuration(active, now), d.units) } : undefined,
    step: progress.currentStep,
    progress,
    waiting: view.waiting.length,
    spent: formatUsd(view.money.spentUsd, locale),
    ceiling: ceiling !== undefined ? formatUsd(ceiling, locale) : undefined,
    ratio: ceiling ? Math.min(1, view.money.spentUsd / ceiling) : undefined,
    autonomy: `${view.autonomy.mode === "autonomous" ? d.autonomy.autonomous : d.autonomy.interactive}${
      view.autonomy.finalReviewOnly ? ` · ${d.autonomy.finalReviewOnly}` : ""
    }`,
    liveText:
      live === "working" && active
        ? f(d.header.working, { name: active.name, elapsed: formatDuration(runDuration(active, now), d.units) })
        : live === "paused"
          ? d.header.paused
          : live === "stopped"
            ? d.header.stopped
            : d.header.idle,
  };
}
export type HeaderFacts = ReturnType<typeof useHeaderFacts>;

export const LIVE_TEXT: Record<Live, string> = {
  working: "text-status-current",
  idle: "text-muted-foreground",
  paused: "text-status-paused",
  stopped: "text-status-blocked",
};
export const LIVE_BG: Record<Live, string> = {
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

/** Scrolls the canvas to the pinned decisions (the canvas's own section; on other pages, the canvas link). */
export function WaitingButton({
  view,
  count,
  page,
  variant = "pill",
  className,
}: {
  view: ProjectView;
  count: number;
  page: Page;
  variant?: "pill" | "plain";
  className?: string;
}) {
  const { d, p } = useI18n();
  if (!count) return null;
  const label = p(d.header.waiting, count);
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
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        variant === "pill"
          ? "border border-status-waiting/50 bg-status-waiting/10 px-2.5 py-1 text-foreground hover:bg-status-waiting/20"
          : "text-status-waiting hover:underline",
        className,
      )}
    >
      <Hand aria-hidden="true" className="size-3.5 text-status-waiting" />
      <span key={count} className="motion-safe:animate-rail-pop">
        {label}
      </span>
    </button>
  );
}

/** Spend against the ceiling: a number and, when there is a ceiling, a bar that fills (amber past 80 %). */
export function SpendMeter({
  facts,
  size = "sm",
  className,
}: {
  facts: HeaderFacts;
  size?: "sm" | "lg";
  className?: string;
}) {
  const { d, f } = useI18n();
  const ratio = facts.ratio;
  return (
    <span data-header-spend className={cn("inline-flex min-w-0 flex-col gap-1", className)}>
      <span className={cn("inline-flex items-baseline gap-1 tabular-nums", size === "lg" ? "text-base" : "text-xs")}>
        <Wallet aria-hidden="true" className="size-3.5 shrink-0 self-center text-muted-foreground" />
        <span className="sr-only">{d.topbar.spend}: </span>
        <span className="font-semibold">{facts.spent}</span>
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

/**
 * The project's actions: the one that fits the state (pause while running, resume while paused or stopped) stays in
 * view; stop and autonomy live behind "more", since they are rare and stop is consequential.
 */
export function ProjectActions({
  view,
  compact,
  primaryClassName,
}: {
  view: ProjectView;
  compact?: boolean;
  primaryClassName?: string;
}) {
  const { d } = useI18n();
  const [target, setTarget] = useState<ControlState | null>(null);
  const [autonomy, setAutonomy] = useState(false);
  const state = view.control.state;
  const primary: ControlState = state === "running" ? "paused" : "running";
  const PrimaryIcon = primary === "paused" ? CirclePause : CirclePlay;
  const primaryText = primary === "paused" ? d.control.pause : d.control.resume;
  return (
    <div role="group" aria-label={d.control.label} className="flex items-center gap-1">
      <Button
        variant={primary === "running" ? "default" : "outline"}
        size={compact ? "icon-sm" : "sm"}
        data-control={primary}
        aria-label={compact ? primaryText : undefined}
        title={primaryText}
        onClick={() => setTarget(primary)}
        className={primaryClassName}
      >
        <PrimaryIcon aria-hidden="true" />
        {compact ? null : primaryText}
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={d.header.more} title={d.header.more} data-header-more>
            <Ellipsis aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setAutonomy(true)}>
            <Gauge aria-hidden="true" />
            {d.autonomy.change}
          </DropdownMenuItem>
          {state !== "stopped" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-control="stopped"
                className="text-status-blocked focus:text-status-blocked"
                onSelect={() => setTarget("stopped")}
              >
                <CircleStop aria-hidden="true" />
                {d.control.stop}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {target ? <ControlDialog view={view} target={target} onClose={() => setTarget(null)} /> : null}
      {autonomy ? <AutonomyDialog view={view} onClose={() => setAutonomy(false)} /> : null}
    </div>
  );
}

const PAGES: Page[] = ["canvas", "history", "timeline"];

/** Canvas, History, Timeline: an underlined tab row or a segmented control. */
export function ProjectTabs({
  view,
  page,
  variant = "underline",
  className,
}: {
  view: ProjectView;
  page: Page;
  variant?: "underline" | "segmented";
  className?: string;
}) {
  const { d } = useI18n();
  const name = (item: Page) =>
    item === "canvas" ? d.canvas.canvas : item === "history" ? d.canvas.history : d.canvas.timeline;
  return (
    <nav
      aria-label={view.project.title ?? view.project.id}
      className={cn(
        "flex min-w-0",
        variant === "segmented" ? "w-fit gap-0.5 rounded-lg bg-muted p-[3px]" : "gap-1",
        className,
      )}
    >
      {PAGES.map((item) => (
        <a
          key={item}
          href={projectHref(view.project.id, item)}
          aria-current={page === item ? "page" : undefined}
          className={cn(
            "text-sm whitespace-nowrap transition-colors duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
            variant === "segmented"
              ? cn(
                  "rounded-md px-3 py-1",
                  page === item
                    ? "bg-background font-medium shadow-sm dark:bg-input/30"
                    : "text-muted-foreground hover:text-foreground",
                )
              : cn(
                  "-mb-px border-b-2 px-3 py-2.5",
                  page === item
                    ? "border-primary font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                ),
          )}
        >
          {name(item)}
        </a>
      ))}
    </nav>
  );
}

/**
 * Tools that open something outside the console: Remotion Studio and the editing table. Desktop work, so the concepts
 * show them from the md breakpoint up and keep phones to status and decisions.
 */
export function ProjectTools({ view, className }: { view: ProjectView; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
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
