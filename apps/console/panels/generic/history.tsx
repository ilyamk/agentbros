/**
 * History (RFC 0004 §5.1, US17, FR5): the project's journal from `/events`, live from the stream, with filters, and a
 * compare of two versions the view carries (compare-versions.tsx).
 */
import { useEffect, useMemo, useState } from "react";
import type { ConsoleEvent, EventKind } from "@contract";
import { Bot, CircleCheck, CircleX, Coins, Gavel, Hand, History as HistoryIcon, Terminal } from "lucide-react";
import { useI18n, type I18n } from "@/i18n";
import { useConsole, useConsoleStore } from "@/store/context";
import { EVENTS_SHOWN } from "@/store/store";
import { useNow } from "@/lib/clock";
import { commandLine, formatDuration, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Timeline, type TimelineEvent } from "@/components/timeline";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { PanelProps } from "../registry";
import { snapshotMode } from "@/lib/snapshot-mode";
import { CompareVersions } from "./compare-versions";

export const EVENT_GROUPS = {
  all: [] as EventKind[],
  commands: ["cli.start", "cli.end", "cli.progress"],
  agents: ["agent.dispatch", "agent.start", "agent.end", "agent.notification"],
  decisions: ["decision.applied", "decision.refused"],
  control: ["control.changed"],
  cards: ["card.posted", "card.answered"],
  jobs: ["job.state"],
} satisfies Record<string, EventKind[]>;
export type EventGroup = keyof typeof EVENT_GROUPS;

const failed = (event: ConsoleEvent) =>
  event.ok === false ||
  event.kind === "decision.refused" ||
  (event.kind === "agent.end" && event.data?.outcome === "failed") ||
  (event.kind === "job.state" && event.data?.state === "failed");

function iconOf(kind: EventKind) {
  if (kind.startsWith("cli.")) return <Terminal />;
  if (kind.startsWith("agent.")) return <Bot />;
  if (kind.startsWith("decision.")) return <Gavel />;
  if (kind === "control.changed") return <Hand />;
  if (kind === "job.state") return <Coins />;
  return <HistoryIcon />;
}

function data<T = string>(event: ConsoleEvent, key: string): T | undefined {
  return event.data?.[key] as T | undefined;
}

/** One journal line as a timeline row, in the UI language; the user's words and agent text stay as written. */
export function toTimelineEvent(
  event: ConsoleEvent,
  { d, f, locale }: Pick<I18n, "d" | "f" | "locale">,
): TimelineEvent {
  const kinds = d.history.kinds;
  const alias = event.alias ?? "";
  let title: string;
  switch (event.kind) {
    case "cli.end":
      title =
        event.ok === false
          ? f(kinds["cli.failed"], { alias, error: event.error ?? "" })
          : f(kinds["cli.end"], { alias });
      break;
    case "cli.progress":
      title = f(kinds["cli.progress"], { alias, text: data(event, "text") ?? "" });
      break;
    case "agent.dispatch":
      title = f(kinds["agent.dispatch"], { step: event.step ?? "" });
      break;
    case "agent.notification":
      title = f(kinds["agent.notification"], { text: data(event, "text") ?? data(event, "type") ?? "" });
      break;
    case "control.changed":
      title = f(kinds["control.changed"], {
        state: d.control[data<"running" | "paused" | "stopped">(event, "state") ?? "running"],
      });
      break;
    case "job.state":
      title = f(kinds["job.state"], { job: data(event, "jobId") ?? "", state: data(event, "state") ?? "" });
      break;
    default:
      title = f(kinds[event.kind], { alias });
  }
  const actor = event.agent?.name ?? (event.actor ? d.history.actor[event.actor] : undefined);
  const meta = [
    event.step,
    event.elapsedMs !== undefined ? f(d.history.took, { time: formatDuration(event.elapsedMs, d.units) }) : undefined,
    event.costUsd !== undefined ? f(d.history.cost, { amount: formatUsd(event.costUsd, locale) }) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const answer = data(event, "answer");
  const detailLines = [
    answer ? f(d.history.words, { answer }) : undefined,
    event.message,
    event.argv?.length
      ? commandLine([event.alias ? `pnpm ${event.alias}` : "", ...event.argv].filter(Boolean))
      : undefined,
    event.outputs?.length ? event.outputs.join("\n") : undefined,
  ].filter((line): line is string => !!line);
  return {
    id: event.id,
    at: event.at,
    actor,
    title,
    meta: meta || undefined,
    icon: failed(event) ? (
      <CircleX />
    ) : event.kind === "decision.applied" || (event.kind === "cli.end" && event.ok) ? (
      <CircleCheck />
    ) : (
      iconOf(event.kind)
    ),
    tone: failed(event) ? "danger" : event.kind === "decision.applied" ? "success" : "neutral",
    detail: detailLines.length ? (
      <pre className="font-mono text-xs break-words whitespace-pre-wrap">{detailLines.join("\n")}</pre>
    ) : undefined,
  };
}

export function filterEvents(
  events: ConsoleEvent[],
  group: EventGroup,
  failuresOnly: boolean,
  query: string,
): ConsoleEvent[] {
  const kinds = EVENT_GROUPS[group] as EventKind[];
  const needle = query.trim().toLowerCase();
  return events.filter(
    (event) =>
      (!kinds.length || kinds.includes(event.kind)) &&
      (!failuresOnly || failed(event)) &&
      (!needle || JSON.stringify(event).toLowerCase().includes(needle)),
  );
}

export function HistoryPanel({ view }: PanelProps) {
  const i18n = useI18n();
  const { d, locale } = i18n;
  const store = useConsoleStore();
  const project = view.project.id;
  const state = useConsole((s) => s.events[project]);
  const now = useNow();
  const [group, setGroup] = useState<EventGroup>("all");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void store.loadEvents(project);
  }, [store, project]);

  // The newest `shown` events of what the store holds; "Load older" reveals more.
  const held = state?.items ?? [];
  const shown = state?.shown ?? EVENTS_SHOWN;
  const hasOlder = held.length > shown;
  const items = useMemo(
    () =>
      filterEvents(held.slice(Math.max(0, held.length - shown)), group, failuresOnly, query).map((event) =>
        toTimelineEvent(event, i18n),
      ),
    [held, shown, group, failuresOnly, query, i18n],
  );

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label={d.history.filters} className="flex flex-wrap items-center gap-2">
        {(Object.keys(EVENT_GROUPS) as EventGroup[]).map((name) => (
          <Button
            key={name}
            size="sm"
            variant={group === name ? "secondary" : "ghost"}
            aria-pressed={group === name}
            onClick={() => setGroup(name)}
          >
            {d.history.groups[name]}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={d.history.search}
          aria-label={d.history.search}
          className="max-w-xs"
        />
        <Label className="font-normal">
          <Switch checked={failuresOnly} onCheckedChange={setFailuresOnly} />
          {d.history.failuresOnly}
        </Label>
      </div>
      {state?.status === "error" && !state.items.length ? (
        <p role="alert" className="text-sm text-status-blocked">
          {state.error?.message}
        </p>
      ) : items.length ? (
        <Timeline events={items} now={now} label={d.history.feed} locale={locale} />
      ) : state?.status === "loading" ? (
        <p className="text-sm text-muted-foreground">{d.app.loading}</p>
      ) : (
        <EmptyState compact icon={<HistoryIcon />} title={d.history.empty} description={d.history.emptyHint} />
      )}
      {hasOlder ? (
        <Button
          variant="outline"
          size="sm"
          className={cn("self-start")}
          onClick={() => void store.loadEvents(project, { older: true })}
        >
          {d.history.loadMore}
        </Button>
      ) : null}
      {state?.partial ? <p className="text-xs text-muted-foreground">{d.history.partial}</p> : null}
      {snapshotMode() ? null : <CompareVersions view={view} />}
    </div>
  );
}
