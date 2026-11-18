/**
 * Timeline view (`#/projects/<id>/timeline`), the review:ui replacement (RFC 0004 D2, WP13). This frame loads the
 * review state from `/api/review/<id>/state`, shows the identity line, Refresh, the non-approval notice and the status
 * line (G1/G2), handles an uninitialized journal (RU-SE07), and renders the sections of `sections/index.ts`. Escape
 * and window resize cancel the current proposal (G4, RU-K01/K02).
 */
import { useEffect, useMemo } from "react";
import { FolderX, RefreshCw, ServerOff } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { useConsoleStore } from "@/store/context";
import { ReviewApi, type ReviewStatus } from "./api";
import { TimelineContext, TimelineController, useTimeline } from "./controller";
import { TIMELINE_SECTIONS } from "./sections";

export function TimelineView({
  project,
  onRevision,
}: {
  project: string;
  /** Told the journal revision on every display (the editing banner's hand-back names it). */
  onRevision?: (revision: number | null) => void;
}) {
  const { d } = useI18n();
  const transport = useConsoleStore().client.text;
  const controller = useMemo(
    () => (transport ? new TimelineController(new ReviewApi(project, transport)) : undefined),
    [project, transport],
  );
  if (!controller)
    return (
      <EmptyState
        icon={<ServerOff />}
        title={d.timeline.common.needsServer}
        description={d.timeline.common.needsServerHint}
      />
    );
  return (
    <TimelineContext.Provider value={controller}>
      <TimelineBody project={project} controller={controller} onRevision={onRevision} />
    </TimelineContext.Provider>
  );
}

function statusText(status: ReviewStatus, labels: { idle: string; working: string; ready: string }): string {
  return status.kind === "error" || status.kind === "conflict" ? status.message : labels[status.kind];
}

function TimelineBody({
  project,
  controller,
  onRevision,
}: {
  project: string;
  controller: TimelineController;
  onRevision?: (revision: number | null) => void;
}) {
  const { d, f } = useI18n();
  const t = d.timeline.common;
  const snapshot = useTimeline();
  const revision = snapshot.state?.revision;

  useEffect(() => {
    if (revision !== undefined) onRevision?.(revision);
  }, [revision, onRevision]);

  useEffect(() => {
    void controller.load();
  }, [controller]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) controller.proposals.cancel();
    };
    const onResize = () => controller.proposals.cancel();
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [controller]);

  const state = snapshot.state;
  const refresh = () => void controller.run(() => controller.refresh());

  if (!state) {
    if (snapshot.load === "error")
      return (
        <EmptyState
          icon={<FolderX />}
          title={t.loadFailed}
          description={snapshot.loadError?.message}
          action={
            <Button id="refresh" variant="outline" onClick={() => void controller.load()}>
              {t.retry}
            </Button>
          }
        />
      );
    return (
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const identity =
    state.revision === null
      ? f(t.identityUninitialized, { project: state.projectId })
      : f(t.identity, { project: state.projectId, revision: state.revision, frames: state.durationInFrames });
  const status = snapshot.status;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="timeline-view">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{t.title}</h2>
          <p id="identity" className="font-mono text-sm tabular-nums">
            {identity}
          </p>
        </div>
        <Button id="refresh" variant="outline" onClick={refresh} disabled={status.kind === "working"}>
          <RefreshCw aria-hidden="true" />
          {t.refresh}
        </Button>
      </header>
      <p id="non-approval" className="text-sm text-muted-foreground">
        {t.nonApproval}
      </p>
      <output
        id="status"
        role="status"
        aria-label={t.statusLabel}
        data-kind={status.kind}
        className={cn(
          "block rounded-md border px-3 py-2 text-sm",
          (status.kind === "error" || status.kind === "conflict") && "border-destructive text-destructive",
        )}
      >
        {statusText(status, t.status)}
      </output>
      {status.kind === "conflict" ? (
        <p id="conflict-notice" className="text-sm">
          {t.conflict}
        </p>
      ) : null}
      {state.revision === null ? (
        <EmptyState
          compact
          className="[&]:items-start [&]:text-start"
          label={t.uninitializedTitle}
          title={t.uninitializedTitle}
          description={f(t.uninitializedHint, { project })}
        />
      ) : null}
      <div aria-label={t.sections} role="group" className="grid min-w-0 gap-4 lg:grid-cols-2">
        {TIMELINE_SECTIONS.map(({ id, component: Section, wide }) => (
          <div key={id} className={cn("min-w-0", wide && "lg:col-span-2")}>
            <Section project={project} state={state} api={controller.api} controller={controller} />
          </div>
        ))}
      </div>
    </div>
  );
}
