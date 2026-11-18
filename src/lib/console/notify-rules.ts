/**
 * What deserves a notification (RFC 0004 D23, WP14), as pure functions of a journal event or a waiting decision. A
 * notice carries only fixed English templates and identifiers that match {@link SAFE_TOKEN}: never decision summaries,
 * card bodies, error messages, commands, agent text or the user's words, so nothing secret or personal reaches the OS.
 */
import type { ConsoleEvent, Decision } from "../../types/console";

export const NOTIFY_KINDS = ["decision", "card", "failure", "render", "job", "agent"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** Where a notice is shown: the focused page only, a browser notification by an open tab, or the OS. */
export type NotifyChannel = "page" | "browser" | "os";

export interface Notice {
  /** Dedupe key: a decision id, a card, a job or an event id (each sent at most once). */
  key: string;
  kind: NotifyKind;
  project?: string;
  /** Fixed template, at most {@link TITLE_MAX} characters. */
  title: string;
  /** Project id, step and a code or alias, joined by " · ". */
  body: string;
  /** Hash route the click opens: `/projects/<id>` or `/projects/<id>/decision/<decision id>`. */
  route: string;
  /** Per-situation cooldown key (same gate re-keyed by a file change, a repeated idle prompt). */
  cooldown?: string;
  /**
   * Derived again on every scan while it holds (a waiting decision or card), so a cooldown only postpones it; a
   * journal event is seen once, and one held by a cooldown is folded into the notice that started it.
   */
  standing?: true;
}

export const TITLE_MAX = 64;
/** Identifiers shown in a notice: project ids, step ids, aliases, error codes, job states. */
export const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
/** Decision ids in a route (the contract's console id). */
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const APP = "Agent Bros.";
const safe = (value: unknown): string | undefined =>
  typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;
const line = (...parts: (string | undefined)[]) =>
  parts
    .map(safe)
    .filter((part): part is string => !!part)
    .join(" · ");
const title = (text: string) => `${APP}: ${text}`.slice(0, TITLE_MAX);

export const projectRoute = (project?: string) => (safe(project) ? `/projects/${project}` : "/");
export const decisionRoute = (project: string, decisionId: string) =>
  ROUTE_ID.test(decisionId) && safe(project)
    ? `/projects/${project}/decision/${encodeURIComponent(decisionId)}`
    : projectRoute(project);

/** A waiting decision (a gate, a quote, the verdict) or an agent card awaiting an answer. */
export function decisionNotice(decision: Decision): Notice {
  const card = decision.kind === "card-answer";
  return {
    key: card && decision.cardId ? `card:${decision.project}:${decision.cardId}` : `decision:${decision.id}`,
    kind: card ? "card" : "decision",
    project: decision.project,
    title: title(card ? "an agent card is waiting" : "a decision is waiting"),
    body: line(decision.project, decision.step),
    route: decisionRoute(decision.project, decision.id),
    cooldown: card ? undefined : `decision:${decision.project}:${decision.kind}:${decision.step}`,
    standing: true,
  };
}

/** Failures that need the user whether or not a step lease names the current step. */
const ALWAYS_FAILURES = new Set(["BUDGET_EXCEEDED", "FFMPEG_MISSING"]);
/** Codes the CLI contract has the agent retry by itself: the user is not needed. */
const SELF_RETRIED = new Set(["RATE_LIMIT", "NETWORK", "TIMEOUT", "ASSET_MISSING"]);
const RENDER_ALIASES = new Set(["render", "film:render"]);
/** A paid job's end states (one notice per job, whichever comes first). */
const JOB_ENDS = new Set(["validated", "published", "failed", "cancelled"]);
const AGENT_PROMPTS: Record<string, string> = {
  "permission-prompt": "the agent waits for permission",
  "idle-prompt": "the agent waits for your input",
  "stop-failure": "the agent stopped on an error",
};

/**
 * The notice a journal event deserves, or undefined. `pausedAt` names the current pause (the control file's `at`), so
 * every refusal of one pause shares a key: one notice per pause, never one per refused command.
 */
export function eventNotice(event: ConsoleEvent, context: { pausedAt?: string } = {}): Notice | undefined {
  const project = event.project;
  if (!project) return undefined;
  const route = projectRoute(project);
  const data = (event.data ?? {}) as Record<string, unknown>;
  switch (event.kind) {
    case "cli.end": {
      if (event.ok === false && event.error === "PAUSED")
        return {
          key: `paused:${project}:${context.pausedAt ?? "current"}`,
          kind: "failure",
          project,
          title: title("the project is paused"),
          body: line(project, event.alias, "refused"),
          route,
        };
      if (event.ok === false) {
        // The user saw their own console action fail in the page.
        if (event.channel === "console" || event.actor === "user") return undefined;
        if (SELF_RETRIED.has(event.error ?? "")) return undefined;
        if (!event.step && !ALWAYS_FAILURES.has(event.error ?? "")) return undefined;
        return {
          key: `event:${event.id}`,
          kind: "failure",
          project,
          title: title("a command failed"),
          body: line(project, event.step, event.alias, event.error),
          route,
          cooldown: `failure:${project}:${event.step ?? ""}:${event.alias ?? ""}`,
        };
      }
      if (event.ok !== true) return undefined;
      if (RENDER_ALIASES.has(event.alias ?? ""))
        return {
          key: `event:${event.id}`,
          kind: "render",
          project,
          title: title("render finished"),
          body: line(project, event.step),
          route,
        };
      if (event.alias === "delivery" && event.argv?.includes("check"))
        return {
          key: `event:${event.id}`,
          kind: "render",
          project,
          title: title("delivery check passed"),
          body: line(project),
          route,
        };
      return undefined;
    }
    case "job.state": {
      const state = safe(data.state);
      if (!state || !JOB_ENDS.has(state)) return undefined;
      const job = typeof data.jobId === "string" ? data.jobId : event.id;
      return {
        key: `job:${project}:${job}`,
        kind: "job",
        project,
        title: title(state === "failed" || state === "cancelled" ? `a paid job ${state}` : "a paid job finished"),
        body: line(project, event.step, state),
        route,
      };
    }
    case "agent.notification": {
      const type = typeof data.type === "string" ? data.type : "";
      const text = AGENT_PROMPTS[type];
      if (!text) return undefined;
      return {
        key: `event:${event.id}`,
        kind: "agent",
        project,
        title: title(text),
        body: line(project, event.step),
        route,
        cooldown: `agent:${project}:${type}`,
      };
    }
    default:
      return undefined;
  }
}

/** The one notice that stands for items the rate limit held back. */
export function overflowNotice(count: number, seq: number): Notice {
  return {
    key: `overflow:${seq}`,
    kind: "decision",
    title: title(`${count} more ${count === 1 ? "item needs" : "items need"} you`),
    body: "Open the console",
    route: "/",
  };
}
