/**
 * Project canvas (RFC 0004 §5.1, §5.3): Waiting (pinned) → step rail → panels from the registry → collapsed done steps.
 * Also the project's History and Timeline pages.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ProjectView, StepRow } from "@contract";
import { FolderX, Terminal } from "lucide-react";
import { useI18n } from "@/i18n";
import { useConsole, useConsoleStore } from "@/store/context";
import { commandLine, formatDuration } from "@/lib/format";
import { projectHref, type ProjectPageName } from "@/lib/router";
import { cn } from "@/lib/utils";
import { DecisionCard } from "@/components/decision-card";
import { EmptyState } from "@/components/empty-state";
import { StepRail } from "@/components/step-rail";
import { StepStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { onPanelsChanged, panelsFor, registeredPanels } from "@/panels/registry";
import { HistoryPanel } from "@/panels/generic/history";
import { TimelineView } from "@/views/timeline";
import { CampaignView } from "@/views/campaign";
import { MediaView } from "@/views/media/media-view";
import { PanelSection } from "./panel-section";
import { SnapshotBanner } from "./snapshot-banner";
import { snapshotMode } from "@/lib/snapshot-mode";
import { EditingBanner } from "./editing-table";
import { ProjectHeader } from "./header";

function usePanelRegistry() {
  return useSyncExternalStore(onPanelsChanged, () => registeredPanels().length);
}

export function ProjectPage({
  project,
  view: page,
  decision,
}: {
  project: string;
  view: ProjectPageName;
  /** A notification's click (`#/projects/<id>/decision/<id>`): focus that card once the view is there. */
  decision?: string;
}) {
  const { d } = useI18n();
  const store = useConsoleStore();
  const resource = useConsole((s) => s.views[project]);
  const loaded = !!resource?.data;
  const [revision, setRevision] = useState<number | null>();

  useEffect(() => {
    store.watch(project);
  }, [store, project]);

  useEffect(() => {
    if (!loaded || !decision || page !== "canvas") return;
    // The id changes when a bound file changes: then the first waiting card stands in for it.
    const cards = [...document.querySelectorAll<HTMLElement>('[data-card="decision"]')];
    const card = cards.find((element) => element.dataset.decision === decision) ?? cards[0];
    card?.scrollIntoView?.({ block: "center" });
    card?.focus({ preventScroll: true });
  }, [loaded, decision, page]);

  if (!resource?.data) {
    if (resource?.status === "error") {
      const notFound = resource.error?.status === 404 || resource.error?.code === "PROJECT_NOT_FOUND";
      return (
        <main id="main" tabIndex={-1} className="outline-none p-4 lg:p-6">
          <EmptyState
            icon={<FolderX />}
            title={notFound ? d.canvas.notFound : d.canvas.loadFailed}
            description={notFound ? d.canvas.notFoundHint : resource.error?.message}
            action={
              notFound ? undefined : (
                <Button variant="outline" onClick={() => void store.loadView(project)}>
                  {d.app.retry}
                </Button>
              )
            }
          />
        </main>
      );
    }
    return (
      <main id="main" tabIndex={-1} aria-busy="true" className="outline-none flex flex-col gap-4 p-4 lg:p-6">
        <span className="sr-only">{d.app.loading}</span>
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </main>
    );
  }

  const view = resource.data;
  const snapshot = snapshotMode();
  return (
    <div className="flex min-w-0 flex-col">
      <ProjectHeader view={view} page={page} />
      {snapshot ? <SnapshotBanner project={view.project.title ?? view.project.id} takenAt={snapshot.takenAt} /> : null}
      <main id="main" tabIndex={-1} className="outline-none flex min-w-0 flex-col gap-5 p-4 lg:p-6">
        {snapshot ? (
          <Canvas view={view} />
        ) : page === "history" ? (
          <section aria-label={d.history.title} className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{d.history.title}</h2>
            <HistoryPanel view={view} />
          </section>
        ) : page === "media" ? (
          <MediaView view={view} />
        ) : page === "timeline" ? (
          <>
            <EditingBanner view={view} revision={revision} />
            {view.project.route === "campaign" ? (
              <CampaignView project={project} />
            ) : (
              <TimelineView project={project} onRevision={setRevision} />
            )}
          </>
        ) : (
          <Canvas view={view} />
        )}
      </main>
    </div>
  );
}

export function Canvas({ view }: { view: ProjectView }) {
  const { d, f, p, locale } = useI18n();
  const registryVersion = usePanelRegistry();
  const current = view.current?.step;
  const [selected, setSelected] = useState<string | undefined>(current);
  const selectedStep = view.steps.find((step) => step.id === (selected ?? current));
  const panels = useMemo(() => panelsFor(view), [view, registryVersion]);
  const done = view.steps.filter((step) => step.status === "done" || step.status === "skipped");

  return (
    <>
      {view.waiting.length ? (
        <section aria-labelledby="waiting-heading" className="flex flex-col gap-3">
          <h2
            id="waiting-heading"
            className="flex items-center gap-2 text-sm font-semibold tracking-wide text-status-waiting uppercase"
          >
            <span className="text-foreground">
              {d.canvas.waiting} ({view.waiting.length})
            </span>
          </h2>
          {/* A static snapshot shows the cards without their actions (WP15, D18). */}
          <fieldset disabled={!!snapshotMode()} className="m-0 grid min-w-0 gap-3 border-0 p-0 xl:grid-cols-2">
            {view.waiting.map((decision) => (
              <DecisionCard key={decision.id} decision={decision} />
            ))}
          </fieldset>
        </section>
      ) : null}

      {view.steps.length ? (
        <section aria-labelledby="steps-heading" className="flex flex-col gap-3">
          <h2 id="steps-heading" className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            {d.canvas.steps}
          </h2>
          <StepRail view={view} selected={selected ?? current} onSelect={setSelected} label={d.canvas.steps} />
          {selectedStep ? <StepDetails step={selectedStep} view={view} /> : null}
        </section>
      ) : null}

      <section aria-label={d.canvas.panels} className="flex flex-col gap-3">
        {panels.map(({ def, collapsed }) => (
          <PanelSection
            key={def.id}
            id={def.id}
            title={def.title?.(d, view) ?? def.id}
            summary={def.summary?.(d, view, locale)}
            defaultOpen={!collapsed}
          >
            <def.component view={view} />
          </PanelSection>
        ))}
      </section>

      {done.length ? (
        <PanelSection id="done-steps" title={p(d.canvas.doneSteps, done.length)} defaultOpen={false}>
          <ul className="flex flex-col divide-y">
            {done.map((step) => (
              <li key={step.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <StepStatusBadge status={step.status} />
                <span className="font-medium">{step.title}</span>
                {step.owner ? (
                  <span className="text-muted-foreground">{f(d.canvas.owner, { owner: step.owner })}</span>
                ) : null}
                {step.durationMs !== undefined ? (
                  <span className="text-muted-foreground">
                    {f(d.canvas.duration, { time: formatDuration(step.durationMs, d.units) })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </PanelSection>
      ) : null}
    </>
  );
}

function StepDetails({ step, view }: { step: StepRow; view: ProjectView }) {
  const { d, f } = useI18n();
  const isCurrent = step.id === view.current?.step;
  return (
    <div
      aria-label={d.canvas.stepDetails}
      role="region"
      className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{step.title}</h3>
        <StepStatusBadge status={step.status} current={isCurrent} />
        {isCurrent ? <span className="text-xs text-muted-foreground">{d.canvas.current}</span> : null}
        {step.gate ? <span className="text-xs text-muted-foreground">· {d.canvas.gate}</span> : null}
        {step.skippable ? <span className="text-xs text-muted-foreground">· {d.canvas.skippable}</span> : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        {step.owner ? <span>{f(d.canvas.owner, { owner: step.owner })}</span> : null}
        {step.durationMs !== undefined ? (
          <span>{f(d.canvas.duration, { time: formatDuration(step.durationMs, d.units) })}</span>
        ) : null}
        {step.critic ? (
          <span>
            {step.critic.score !== undefined
              ? f(d.canvas.criticScore, { round: step.critic.round, score: step.critic.score })
              : f(d.canvas.critic, { round: step.critic.round })}
          </span>
        ) : null}
      </div>
      {step.reasons.length ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">{d.canvas.reasons}</p>
          <ul className="list-disc ps-5">
            {step.reasons.map((reason, index) => (
              <li key={index} className="break-words">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {isCurrent && view.current ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">{d.canvas.next}</p>
          {view.current.next.argv.length ? (
            <pre
              tabIndex={0}
              className="flex gap-2 overflow-x-auto focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none rounded-md bg-muted px-3 py-2 font-mono text-xs"
            >
              <Terminal className="size-4 shrink-0" aria-hidden="true" />
              <code>{commandLine(view.current.next.argv)}</code>
            </pre>
          ) : null}
          {view.current.next.why ? <p className="break-words">{view.current.next.why}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
