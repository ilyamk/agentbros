/** Home (RFC 0004 §5.1, US1): project cards, the global "Waiting for you", recent deliveries and month spend. */
import { useEffect } from "react";
import type { ProjectSummary } from "@contract";
import { Bot, CalendarClock, CircleDollarSign, Clapperboard, FolderOpen, Inbox, PackageCheck } from "lucide-react";
import { useI18n } from "@/i18n";
import { useConsole, useConsoleStore } from "@/store/context";
import { useNow } from "@/lib/clock";
import { formatRelative, formatUsd } from "@/lib/format";
import { projectHref } from "@/lib/router";
import { CONTROL_TONE } from "@/lib/status";
import { DecisionCard } from "@/components/decision-card";
import { EmptyState } from "@/components/empty-state";
import { MetricCard } from "@/components/metric-card";
import { StepStatusBadge, ToneBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { MediaSlot } from "@/media";
import { ProjectSettings } from "./project-settings";

export function HomePage() {
  const { d, f, locale } = useI18n();
  const store = useConsoleStore();
  const home = useConsole((s) => s.home);
  const now = useNow();

  useEffect(() => {
    store.watch(undefined);
  }, [store]);

  const data = home.data;
  const showSettings = !!(store.client.renameProject && store.client.removeProject);
  const titles = new Map(data?.projects.map((project) => [project.id, project.title ?? project.id]));
  return (
    <main id="main" tabIndex={-1} className="outline-none flex min-w-0 flex-col gap-6 p-4 lg:p-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-semibold">{d.home.title}</h1>
        <p className="text-sm text-muted-foreground">{d.home.subtitle}</p>
      </header>

      {!data ? (
        home.status === "error" ? (
          <EmptyState
            title={home.error?.code === "UNAUTHORIZED" ? d.errors.unauthorized : d.errors.network}
            description={home.error?.message}
            action={
              <Button variant="outline" onClick={() => void store.loadHome()}>
                {d.app.retry}
              </Button>
            }
          />
        ) : (
          <div aria-busy="true" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <span className="sr-only">{d.app.loading}</span>
            <Skeleton className="h-36" />
            <Skeleton className="h-36" />
            <Skeleton className="h-36" />
          </div>
        )
      ) : (
        <>
          <section aria-labelledby="home-waiting" className="flex flex-col gap-3">
            <h2 id="home-waiting" className="flex items-center gap-2 text-lg font-semibold">
              <Inbox className="size-5 text-status-waiting" aria-hidden="true" />
              {d.home.waiting}
              {data.waiting.length ? <span className="text-muted-foreground">({data.waiting.length})</span> : null}
            </h2>
            {data.waiting.length ? (
              <div className="grid gap-3 xl:grid-cols-2">
                {data.waiting.map((decision) => (
                  <DecisionCard key={`${decision.project}:${decision.id}`} decision={decision} />
                ))}
              </div>
            ) : (
              <EmptyState compact icon={<Inbox />} title={d.home.noWaiting} description={d.home.noWaitingHint} />
            )}
          </section>

          <section aria-labelledby="home-projects" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="home-projects" className="flex items-center gap-2 text-lg font-semibold">
                <FolderOpen className="size-5 text-muted-foreground" aria-hidden="true" />
                {d.home.projects}
              </h2>
              {data.monthSpentUsd !== undefined ? (
                <MetricCard
                  className="min-w-56 p-3"
                  icon={<CircleDollarSign />}
                  label={d.home.monthSpend}
                  value={formatUsd(data.monthSpentUsd, locale)}
                  context={d.home.monthSpendContext}
                />
              ) : null}
            </div>
            {data.projects.length ? (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {data.projects.map((project) => (
                  <li key={project.id} className="relative min-w-0">
                    <ProjectCard project={project} now={now} showSettings={showSettings} />
                    {showSettings ? <ProjectSettings project={project.id} title={project.title ?? project.id} /> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Clapperboard />} title={d.home.noProjects} description={d.home.noProjectsHint} />
            )}
          </section>

          <section aria-labelledby="home-deliveries" className="flex flex-col gap-3">
            <h2 id="home-deliveries" className="flex items-center gap-2 text-lg font-semibold">
              <PackageCheck className="size-5 text-muted-foreground" aria-hidden="true" />
              {d.home.deliveries}
            </h2>
            {data.recentDeliveries?.length ? (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
                {data.recentDeliveries.map((delivery) => (
                  <li key={`${delivery.project}:${delivery.media.path}`} className="flex flex-col gap-1">
                    <MediaSlot project={delivery.project} media={delivery.media} variant="thumb" />
                    <a
                      href={projectHref(delivery.project)}
                      className="text-xs text-link underline-offset-2 hover:underline"
                    >
                      {titles.get(delivery.project) ?? delivery.project}
                    </a>
                    <span className="text-xs text-muted-foreground">
                      {f(d.home.checked, { time: formatRelative(delivery.checkedAt, now, locale) })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact title={d.home.noDeliveries} />
            )}
          </section>
        </>
      )}
    </main>
  );
}

function ProjectCard({ project, now, showSettings }: { project: ProjectSummary; now: number; showSettings: boolean }) {
  const { d, f, p, locale } = useI18n();
  const title = project.title ?? project.id;
  const share = project.ceilingUsd ? Math.min(100, (project.spentUsd / project.ceilingUsd) * 100) : undefined;
  return (
    <a
      href={projectHref(project.id)}
      className="flex h-full flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-xs transition-colors duration-150 hover:border-ring/60 focus-visible:ring-[3px] focus-visible:ring-ring/60 focus-visible:outline-none"
    >
      <div className={`flex items-start justify-between gap-2 ${showSettings ? "pe-9" : ""}`}>
        <div className="min-w-0">
          <p className="truncate font-semibold">{title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {[project.route, project.filmType, project.playbook].filter(Boolean).join(" · ")}
          </p>
        </div>
        {project.waiting ? <ToneBadge tone="waiting">{p(d.home.waitingCount, project.waiting)}</ToneBadge> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {project.stepTitle || project.step ? <span>{project.stepTitle ?? project.step}</span> : null}
        {project.stepStatus ? <StepStatusBadge status={project.stepStatus} current /> : null}
        {project.control !== "running" ? (
          <ToneBadge tone={CONTROL_TONE[project.control]}>{d.control[project.control]}</ToneBadge>
        ) : null}
      </div>
      {project.activeAgent ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Bot className="size-3.5" aria-hidden="true" />
          <span className="text-foreground">{project.activeAgent.name}</span>·{" "}
          {formatRelative(project.activeAgent.since, now, locale)}
        </p>
      ) : null}
      <div className="mt-auto flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="tabular-nums">
            {project.ceilingUsd !== undefined
              ? f(d.topbar.spent, {
                  spent: formatUsd(project.spentUsd, locale),
                  ceiling: formatUsd(project.ceilingUsd, locale),
                })
              : f(d.topbar.spentNoCeiling, { spent: formatUsd(project.spentUsd, locale) })}
          </span>
          <span className="flex items-center gap-1">
            <CalendarClock className="size-3.5" aria-hidden="true" />
            {f(d.home.updated, { time: formatRelative(project.updatedAt, now, locale) })}
          </span>
        </div>
        {share !== undefined ? <Progress value={share} aria-label={d.money.budget} /> : null}
      </div>
    </a>
  );
}
