/**
 * Campaign view (RFC 0004 WP13e): the Timeline page of a campaign container, the console's replacement of review:ui's
 * campaign server (parity rows RU-CP01–06). The console session stands in for the bare `#<token>` fragment (RU-CP01).
 * It shows the campaign identity, a member filter, each member's facts and rendered variants, and a review-draft form
 * per member. Every action goes through `runReviewTask` (G1); a 409 refreshes and never re-sends (G2), and the note a
 * person typed stays in the form.
 */
import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { FolderX, RefreshCw, Save, ServerOff } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { ToneBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n";
import type { Tone } from "@/lib/status";
import { cn } from "@/lib/utils";
import { useConsoleStore } from "@/store/context";
import { runReviewTask, type ReviewStatus } from "../timeline/api";
import {
  CAMPAIGN_CHOICES,
  CampaignReviewApi,
  defaultChoice,
  memberMatches,
  NOTE_LIMIT,
  previousChoice,
  type CampaignChoice,
  type CampaignMember,
  type CampaignState,
} from "./api";

interface Snapshot {
  load: "loading" | "ready" | "error";
  state?: CampaignState;
  loadError?: string;
  status: ReviewStatus;
}

/** State of one campaign view: the last campaign state and the status line. */
export class CampaignController {
  private snapshot: Snapshot = { load: "loading", status: { kind: "idle" } };
  private readonly listeners = new Set<() => void>();

  constructor(readonly api: CampaignReviewApi) {}

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
  readonly setStatus = (status: ReviewStatus) => this.set({ status });

  async refresh(): Promise<void> {
    this.set({ state: await this.api.state(), load: "ready", loadError: undefined });
  }

  async load(): Promise<void> {
    this.set({ load: "loading" });
    try {
      await this.refresh();
      this.setStatus({ kind: "ready" });
    } catch (error) {
      this.set({ load: "error", loadError: error instanceof Error ? error.message : String(error) });
    }
  }

  /** G1/G2: resolves true on success; a 409 refreshes the state and shows the conflict. */
  run(task: () => Promise<unknown>): Promise<boolean> {
    return runReviewTask(task, { setStatus: this.setStatus, onConflict: () => this.refresh() });
  }
}

const TASK_TONE: Record<string, Tone> = {
  complete: "done",
  running: "current",
  waiting: "waiting",
  capacity: "waiting",
  blocked: "blocked",
  failed: "invalid",
};

export function CampaignView({ project }: { project: string }) {
  const { d } = useI18n();
  const transport = useConsoleStore().client.text;
  const controller = useMemo(
    () => (transport ? new CampaignController(new CampaignReviewApi(project, transport)) : undefined),
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
  return <CampaignBody controller={controller} />;
}

function statusText(status: ReviewStatus, labels: { idle: string; working: string; ready: string }): string {
  return status.kind === "error" || status.kind === "conflict" ? status.message : labels[status.kind];
}

function CampaignBody({ controller }: { controller: CampaignController }) {
  const { d, f } = useI18n();
  const t = d.campaign;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [filter, setFilter] = useState("");
  const filterId = useId();

  useEffect(() => {
    void controller.load();
  }, [controller]);

  const state = snapshot.state;
  if (!state) {
    if (snapshot.load === "error")
      return (
        <EmptyState
          icon={<FolderX />}
          title={t.loadFailed}
          description={snapshot.loadError}
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

  const status = snapshot.status;
  const visible = state.members.filter((member) => memberMatches(member, filter));
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="campaign-view">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{t.title}</h2>
          <p id="campaign-identity" className="font-mono text-sm break-all tabular-nums">
            {f(t.identity, {
              campaign: state.campaignId,
              plan: state.planHash.slice(0, 12),
              revision: state.selection.revision,
            })}
          </p>
        </div>
        <Button
          id="refresh"
          variant="outline"
          onClick={() => void controller.run(() => controller.refresh())}
          disabled={status.kind === "working"}
        >
          <RefreshCw aria-hidden="true" />
          {t.refresh}
        </Button>
      </header>
      <p id="campaign-intro" className="text-sm text-muted-foreground">
        {t.intro}
      </p>
      <output
        id="status"
        role="status"
        aria-label={t.statusLabel}
        data-kind={status.kind}
        className={cn(
          "block rounded-md border px-3 py-2 text-sm break-words",
          (status.kind === "error" || status.kind === "conflict") && "error border-destructive text-destructive",
        )}
      >
        {statusText(status, t.status)}
      </output>
      {status.kind === "conflict" ? (
        <p id="conflict-notice" className="text-sm">
          {t.conflict}
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={filterId}>{t.filter}</Label>
        <Input
          id={filterId}
          data-testid="campaign-filter"
          type="search"
          value={filter}
          placeholder={t.filterPlaceholder}
          onChange={(event) => setFilter(event.target.value)}
          className="max-w-md"
        />
      </div>
      <section aria-label={t.members} className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((member) => (
          // A new plan remounts the card (its saved choice means something else); a refresh keeps typed notes.
          <MemberCard key={`${state.planHash}:${member.id}`} member={member} state={state} controller={controller} />
        ))}
      </section>
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{state.members.length ? t.noMatch : t.noMembers}</p>
      ) : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function MemberCard({
  member,
  state,
  controller,
}: {
  member: CampaignMember;
  state: CampaignState;
  controller: CampaignController;
}) {
  const { d, f } = useI18n();
  const t = d.campaign;
  const heading = useId();
  const choiceId = useId();
  const noteId = useId();
  const [choice, setChoice] = useState<CampaignChoice>(() => defaultChoice(state, member));
  const [note, setNote] = useState(() => previousChoice(state, member.id)?.note ?? "");
  const busy = controller.getSnapshot().status.kind === "working";
  const yesNo = (value: boolean) => (value ? t.facts.yes : t.facts.no);
  const factors = Object.entries(member.factors);

  const save = useCallback(
    () =>
      void controller.run(async () => {
        // The latest state the page shows, its revision as the CAS and the outputs exactly as received.
        const current = controller.getSnapshot().state ?? state;
        const shown = current.members.find((item) => item.id === member.id) ?? member;
        await controller.api.save({
          planHash: current.planHash,
          expectedRevision: current.selection.revision,
          memberId: member.id,
          choice,
          note,
          outputs: shown.outputs,
        });
        await controller.refresh();
      }),
    [controller, state, member, choice, note],
  );

  return (
    <article
      aria-labelledby={heading}
      data-testid={`campaign-member-${member.id}`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card/40 p-4"
    >
      <h3 id={heading} className="font-mono text-base font-semibold break-all">
        {member.id}
      </h3>
      <dl className="flex flex-col gap-1 text-sm">
        <Fact label={t.facts.product}>{member.productId ?? t.facts.none}</Fact>
        <Fact label={t.facts.language}>{member.language}</Fact>
        <Fact label={t.facts.factors}>
          {factors.length ? (
            <ul className="flex flex-col">
              {factors.map(([key, value]) => (
                <li key={key} className="font-mono text-xs break-all">
                  {key}: {typeof value === "string" ? value : JSON.stringify(value)}
                </li>
              ))}
            </ul>
          ) : (
            t.facts.none
          )}
        </Fact>
        <Fact label={t.facts.excluded}>{yesNo(member.excluded)}</Fact>
        <Fact label={t.facts.heldForPilot}>{yesNo(member.heldForPilot)}</Fact>
        <Fact label={t.facts.saved}>{member.choice ?? t.facts.none}</Fact>
        <Fact label={t.facts.tasks}>
          {member.tasks.length ? (
            <ul className="flex min-w-0 flex-wrap gap-1">
              {member.tasks.map((task) => (
                <li key={task.id} className="max-w-full min-w-0">
                  <ToneBadge
                    tone={TASK_TONE[task.state] ?? "upcoming"}
                    className="max-w-full whitespace-normal [overflow-wrap:anywhere]"
                  >
                    <span className="font-mono">{task.id}</span>: {task.state}
                  </ToneBadge>
                </li>
              ))}
            </ul>
          ) : (
            t.facts.none
          )}
        </Fact>
      </dl>
      {member.outputs.length ? (
        member.outputs.map((output) => (
          <figure key={`${output.path}:${output.sha256}`} className="flex min-w-0 flex-col gap-1">
            <video
              controls
              preload="metadata"
              src={controller.api.fileUrl(output)}
              aria-label={f(t.output, { path: output.path })}
              className="max-h-[420px] w-full rounded-md bg-black"
            />
            <figcaption className="font-mono text-xs break-all text-muted-foreground">
              {output.path} · {output.sha256.slice(0, 12)}
            </figcaption>
          </figure>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">{t.noOutputs}</p>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={choiceId}>{t.choice}</Label>
        <SelectField
          id={choiceId}
          data-testid="campaign-choice"
          value={choice}
          onValueChange={(value) => setChoice(value as CampaignChoice)}
          options={CAMPAIGN_CHOICES.map((value) => ({ value, label: t.choices[value] }))}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={noteId}>{t.note}</Label>
        <Textarea
          id={noteId}
          data-testid="campaign-note"
          value={note}
          maxLength={NOTE_LIMIT}
          placeholder={t.notePlaceholder}
          onChange={(event) => setNote(event.target.value)}
          aria-describedby={`${noteId}-count`}
        />
        <p id={`${noteId}-count`} className="text-xs text-muted-foreground tabular-nums">
          {f(t.noteCount, { count: note.length, limit: NOTE_LIMIT })}
        </p>
      </div>
      <Button data-testid="campaign-save" onClick={save} disabled={busy} className="w-fit">
        <Save aria-hidden="true" />
        {t.save}
      </Button>
    </article>
  );
}
