/**
 * What the projector takes from the event journal, and only that (RFC 0004 §6.2): agent runs (hooks, `film:brief`
 * dispatches, CLI-only work) and when each step started. Everything else comes from project files. The journal is
 * read incrementally per project (a byte cursor, see events-reader.ts); a rotation restarts from the live file.
 */
import path from "node:path";
import { AgentRunSchema, EVENTS_FILE, type AgentRun, type ConsoleEvent } from "../../../types/console";
import { readEventsAfter, type EventsCursor } from "../events-reader";

/** Events kept per project in memory (the newest win); a 10 MB journal holds far fewer. */
const MAX_EVENTS = 50_000;

/** Incremental reader of one project's journal. */
export class JournalCache {
  private cursor: EventsCursor = { offset: 0 };
  private events: ConsoleEvent[] = [];
  readonly file: string;
  constructor(projectDir: string) {
    this.file = path.join(projectDir, EVENTS_FILE);
  }
  /** Every event read so far plus the new complete lines, oldest first. */
  read(): ConsoleEvent[] {
    try {
      for (let round = 0; round < 64; round++) {
        const { events, cursor, reset } = readEventsAfter(this.file, this.cursor);
        if (reset) this.events = [];
        const moved = cursor.offset !== this.cursor.offset || reset;
        this.cursor = cursor;
        if (events.length) this.events.push(...events);
        if (!moved || !events.length) break;
      }
      if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    } catch {
      // The journal enriches; a read failure leaves what was read.
    }
    return this.events;
  }
}

const ms = (iso: string) => Date.parse(iso);

/** First event time per step (cli runs and dispatches carry `step` from the lease). */
export function stepStarts(events: readonly ConsoleEvent[]): Map<string, string> {
  const starts = new Map<string, string>();
  for (const event of events)
    if (event.step && (event.kind === "cli.start" || event.kind === "agent.dispatch" || event.kind === "agent.start"))
      if (!starts.has(event.step) || ms(event.at) < ms(starts.get(event.step)!)) starts.set(event.step, event.at);
  return starts;
}

/** Last event time per step. */
export function stepLastSeen(events: readonly ConsoleEvent[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const event of events)
    if (event.step && (!last.has(event.step) || ms(event.at) > ms(last.get(event.step)!)))
      last.set(event.step, event.at);
  return last;
}

const safeId = (value: string) => {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return (cleaned || "run").slice(0, 128);
};

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

type Draft = Omit<AgentRun, "id" | "name"> & { id: string; name: string; sessionId?: string; agentType?: string };

/** How long after a dispatch a hook subagent of the same type counts as that dispatch (the same run). */
const DISPATCH_JOIN_MS = 15 * 60 * 1000;

/**
 * Agent runs from the journal. Hook `agent.start`/`agent.end` pairs by agent id; `agent.notification` of type
 * `agent-link` joins a child to its parent; a `film:brief` dispatch is a run of its own until a hook run of the same
 * agent type starts after it (then the hook run takes its step and lane); CLI events naming an agent nobody else covers
 * become a `cli` run per agent and step. `openSteps` are the steps not closed yet: a dispatch to a closed step is done.
 */
export function agentRuns(
  events: readonly ConsoleEvent[],
  options: { now: number; openSteps?: ReadonlySet<string> } = { now: Date.now() },
): AgentRun[] {
  const runs = new Map<string, Draft>();
  const links = new Map<string, string>();
  const dispatches: Draft[] = [];
  for (const event of events) {
    const data = event.data ?? {};
    if (event.kind === "agent.start") {
      const agentId = str(data.agentId);
      if (!agentId) continue;
      const agentType = str(data.agentType);
      const parent = str(data.parentAgentId);
      runs.set(agentId, {
        id: safeId(agentId),
        name: (agentType ?? event.agent?.name ?? (data.scope === "session" ? "session" : "agent")).slice(0, 128),
        ...(event.agent?.role ? { role: event.agent.role.slice(0, 64) } : {}),
        ...(event.agent?.harness ? { harness: event.agent.harness } : {}),
        ...(event.step ? { step: event.step } : {}),
        ...(parent ? { parentId: safeId(parent) } : {}),
        startedAt: event.at,
        status: "running",
        source: "hook",
        ...(event.agent?.sessionId ? { sessionId: event.agent.sessionId } : {}),
        ...(agentType ? { agentType } : {}),
      });
    } else if (event.kind === "agent.end") {
      const agentId = str(data.agentId);
      const run = agentId ? runs.get(agentId) : undefined;
      if (!run) continue;
      run.endedAt = event.at;
      run.durationMs =
        typeof data.durationMs === "number" && data.durationMs >= 0
          ? data.durationMs
          : Math.max(0, ms(event.at) - ms(run.startedAt));
      run.status = data.outcome === "failed" ? "failed" : data.outcome === "interrupted" ? "interrupted" : "done";
    } else if (event.kind === "agent.notification" && data.type === "agent-link") {
      const child = str(data.agentId);
      const parent = str(data.parentAgentId);
      if (child && parent) links.set(child, parent);
    } else if (event.kind === "agent.dispatch") {
      const name = event.agent?.name ?? event.agent?.role ?? "agent";
      const lane = str(data.lane) ?? str(data.team) ?? str(data.variant);
      dispatches.push({
        id: safeId(`dispatch-${event.runId ?? event.id}`),
        name: name.slice(0, 128),
        ...(event.agent?.role ? { role: event.agent.role.slice(0, 64) } : {}),
        ...(event.agent?.harness ? { harness: event.agent.harness } : {}),
        ...(event.step ? { step: event.step } : {}),
        ...(lane ? { lane: lane.slice(0, 64) } : {}),
        startedAt: event.at,
        status: "running",
        source: "dispatch",
      });
    }
  }
  for (const [child, parent] of links) {
    const run = runs.get(child);
    if (run) run.parentId = safeId(parent);
  }

  // A hook run of the dispatched agent's type that starts soon after the dispatch is that dispatch.
  const hookRuns = [...runs.values()];
  const claimed = new Set<Draft>();
  const kept: Draft[] = [];
  for (const dispatch of dispatches) {
    const at = ms(dispatch.startedAt);
    const match = hookRuns.find(
      (run) =>
        !claimed.has(run) &&
        run.agentType === dispatch.name &&
        ms(run.startedAt) >= at &&
        ms(run.startedAt) - at <= DISPATCH_JOIN_MS,
    );
    if (match) {
      claimed.add(match);
      if (dispatch.step && !match.step) match.step = dispatch.step;
      if (dispatch.lane) match.lane = dispatch.lane;
      if (dispatch.role && !match.role) match.role = dispatch.role;
      continue;
    }
    kept.push(dispatch);
  }
  // A dispatch ends at the next dispatch of the same step and lane, or with its step; otherwise it is still running.
  kept.forEach((dispatch, index) => {
    const later = kept
      .slice(index + 1)
      .find((other) => other.step === dispatch.step && other.lane === dispatch.lane && other.name === dispatch.name);
    const stepClosed =
      dispatch.step !== undefined && options.openSteps !== undefined && !options.openSteps.has(dispatch.step);
    if (later || stepClosed) {
      const end = later ? later.startedAt : lastStepEvent(events, dispatch.step, dispatch.startedAt);
      dispatch.status = "done";
      dispatch.endedAt = end;
      dispatch.durationMs = Math.max(0, ms(end) - ms(dispatch.startedAt));
    }
  });

  const all: Draft[] = [...hookRuns, ...kept];
  // CLI work by a named agent nobody else covers.
  const cliRuns = new Map<string, Draft>();
  for (const event of events) {
    if (event.kind !== "cli.start" && event.kind !== "cli.end") continue;
    // The innermost owner is the newest run whose interval holds the event (a subagent inside a session).
    const owner = [...all]
      .reverse()
      .find(
        (run) =>
          ms(run.startedAt) <= ms(event.at) &&
          (run.endedAt === undefined || ms(run.endedAt) >= ms(event.at)) &&
          (!event.agent?.sessionId || !run.sessionId || run.sessionId === event.agent.sessionId),
      );
    const target =
      owner ??
      (event.agent?.name
        ? (() => {
            const key = `${event.agent.name}|${event.step ?? ""}`;
            let run = cliRuns.get(key);
            if (!run) {
              run = {
                id: safeId(`cli-${event.runId ?? event.id}`),
                name: event.agent.name.slice(0, 128),
                ...(event.agent.role ? { role: event.agent.role.slice(0, 64) } : {}),
                ...(event.agent.harness ? { harness: event.agent.harness } : {}),
                ...(event.step ? { step: event.step } : {}),
                startedAt: event.at,
                status: "done",
                source: "cli",
              };
              cliRuns.set(key, run);
            }
            run.endedAt = event.at;
            run.durationMs = Math.max(0, ms(event.at) - ms(run.startedAt));
            return run;
          })()
        : undefined);
    if (!target || event.kind !== "cli.start") continue;
    target.commands = (target.commands ?? 0) + 1;
    if (event.alias) target.lastAlias = event.alias.slice(0, 64);
  }
  return [...all, ...cliRuns.values()]
    .map(({ sessionId: _session, agentType: _type, ...run }) => {
      const open = run.status === "running" ? { durationMs: Math.max(0, options.now - ms(run.startedAt)) } : {};
      return AgentRunSchema.safeParse({ ...run, ...open });
    })
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .sort((a, b) => ms(a.startedAt) - ms(b.startedAt) || a.id.localeCompare(b.id));
}

function lastStepEvent(events: readonly ConsoleEvent[], step: string | undefined, after: string): string {
  let last = after;
  for (const event of events) if (event.step === step && ms(event.at) > ms(last)) last = event.at;
  return last;
}

/** The run the user should see as active: the newest running subagent, else the newest running run. */
export function activeRun(runs: readonly AgentRun[]): AgentRun | undefined {
  const running = runs.filter((run) => run.status === "running");
  return running.filter((run) => run.parentId || run.source !== "hook").at(-1) ?? running.at(-1);
}

/** Runs started today (local calendar day of `now`) or still running, newest last, at most `max`. */
export function runsToday(runs: readonly AgentRun[], now: number, max = 500): AgentRun[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return runs.filter((run) => run.status === "running" || ms(run.startedAt) >= start.getTime()).slice(-max);
}
