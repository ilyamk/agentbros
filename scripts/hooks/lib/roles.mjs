/**
 * The synchronous hook roles (RFC 0004 §7.1): observe, surface, guard, orient, relay and present; wake lives in wake.mjs.
 * Each takes a normalised payload and a context ({ root, env, now }) and returns `{ stdout?, stderr?, exit? }`, or
 * nothing. Only guard denies, and only on PreToolUse (H4).
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { readCursor, writeCursor } from "./cursor.mjs";
import { itemsBlock, sessionFacts, subagentFacts } from "./facts.mjs";
import { decide, denyOutput } from "./guard.mjs";
import { appendEvent, appendRefusal, buildEvent, EVENTS_FILE, redactText } from "./journal.mjs";
import { childAgentId } from "./payload.mjs";
import { consolePresentationEnabled, present } from "./present.mjs";
import { oneLine, ownAgents, projectDirOf, resolveProject, sha256, ulid, ulidTime } from "./runtime.mjs";
import { consoleItemsSince, readLease } from "./state.mjs";

const contextOutput = (event, text) => ({
  stdout: { hookSpecificOutput: { hookEventName: event, additionalContext: text } },
});

/** The step runScript's journal names (leasedStep): only from an unexpired lease. */
const liveStep = (root, project, now) => {
  const loaded = readLease(projectDirOf(root, project));
  const lease = loaded && "lease" in loaded ? loaded.lease : undefined;
  return lease && !(Date.parse(lease.expiresAt) <= now.getTime()) ? lease.step : undefined;
};

const stepOf = (root, project) => {
  const loaded = readLease(projectDirOf(root, project));
  return loaded && "lease" in loaded ? loaded.lease.step : undefined;
};

/** The project a payload is about and the session's cursor (H6). */
function scope(payload, ctx) {
  const cursor = readCursor(ctx.root, payload.sessionId);
  const project = resolveProject({
    root: ctx.root,
    command: payload.tool?.command,
    cursor,
    env: ctx.env,
    now: ctx.now,
  });
  return { cursor, project };
}

/** Milliseconds since the newest `agent.start` of an agent id in the journal tail (512 KB), when there is one. */
function sinceStart(root, project, agentId, now) {
  let text;
  try {
    const file = path.join(projectDirOf(root, project), EVENTS_FILE);
    const size = statSync(file).size;
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString("utf8");
  } catch {
    return undefined;
  }
  const needle = JSON.stringify(agentId);
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"agent.start"') || !line.includes(needle)) continue;
    try {
      const event = JSON.parse(line);
      if (event.kind === "agent.start" && event.data?.agentId === agentId) {
        const ms = now.getTime() - Date.parse(event.at);
        return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
      }
    } catch {
      // a torn line is skipped
    }
  }
  return undefined;
}

/** One redacted line: secrets scrubbed before the text is cut (§6.1). */
const safeLine = (text, max) => oneLine(redactText(text), max);

const NOTIFICATION_TYPES = { permission_prompt: "permission-prompt", idle_prompt: "idle-prompt" };

/** The `agent.notification` data for a surfaced event (D23 consumes these journal lines), or undefined. */
export function surfaceData(payload) {
  switch (payload.event) {
    case "Notification": {
      const raw = payload.notification?.type;
      if (!raw) return undefined;
      const type = NOTIFICATION_TYPES[raw] ?? oneLine(raw.replace(/[^\w.-]/g, "-"), 64);
      return { type, text: safeLine(payload.notification.message ?? payload.notification.title ?? raw, 512) };
    }
    case "PostToolUseFailure":
      return {
        type: payload.tool?.isInterrupt ? "interrupt" : "tool-failure",
        text: safeLine(`${payload.tool?.name ?? "tool"} failed: ${payload.tool?.error ?? "no error text"}`, 512),
        tool: payload.tool?.name,
        ...(payload.tool?.command ? { command: safeLine(payload.tool.command, 300) } : {}),
      };
    case "StopFailure":
      return {
        type: "stop-failure",
        text: safeLine(
          `${payload.failure?.type ?? "unknown"}${payload.failure?.details ? `: ${payload.failure.details}` : ""}`,
          512,
        ),
      };
    case "Interrupt":
      return { type: "interrupt", text: "The user interrupted the turn." };
    default:
      return undefined;
  }
}

const agentOf = (payload) =>
  payload.agentId
    ? { name: payload.agentType ?? "subagent", role: "subagent" }
    : { name: payload.agentType ?? "main", role: "orchestrator" };

export function surface(payload, ctx) {
  const data = surfaceData(payload);
  if (!data) return;
  const { project } = scope(payload, ctx);
  if (!project) return;
  appendEvent(
    ctx.root,
    buildEvent({
      project,
      kind: "agent.notification",
      data,
      step: stepOf(ctx.root, project),
      payload,
      agent: agentOf(payload),
      now: ctx.now,
    }),
    ctx.env,
  );
}

/** One journal line per lifecycle event (agent.start, agent.end, links, turn ends); failures through surface. */
export function observe(payload, ctx) {
  if (surfaceData(payload)) return surface(payload, ctx);
  const { project, cursor } = scope(payload, ctx);
  if (!project) return;
  const { root, now } = ctx;
  let kind;
  let data;
  let agent = agentOf(payload);
  switch (payload.event) {
    case "SessionStart":
      if (!payload.sessionId) return;
      kind = "agent.start";
      data = { agentId: payload.sessionId, scope: "session", source: payload.source, agentType: payload.agentType };
      break;
    case "SessionEnd":
      if (!payload.sessionId) return;
      kind = "agent.end";
      data = {
        agentId: payload.sessionId,
        scope: "session",
        durationMs: sinceStart(root, project, payload.sessionId, now),
        outcome: "done",
        reason: payload.reason,
      };
      writeCursor(root, { session: payload.sessionId, harness: payload.harness }, cursor, { project }, now);
      break;
    case "SubagentStart":
      if (!payload.agentId) return;
      kind = "agent.start";
      data = { agentId: payload.agentId, agentType: payload.agentType, scope: "subagent" };
      break;
    case "SubagentStop":
      if (!payload.agentId) return;
      kind = "agent.end";
      data = {
        agentId: payload.agentId,
        agentType: payload.agentType,
        scope: "subagent",
        durationMs: sinceStart(root, project, payload.agentId, now),
        outcome: "done",
        lastMessage: payload.lastMessage ? safeLine(payload.lastMessage, 500) : undefined,
      };
      break;
    case "PostToolUse":
      if (payload.tool?.kind !== "agent") return;
      kind = "agent.notification";
      data = {
        type: "agent-link",
        text: payload.tool.description ? safeLine(payload.tool.description, 512) : undefined,
        agentId: childAgentId(payload.tool) ?? payload.tool.useId,
        agentType: payload.tool.subagentType,
        parentAgentId: payload.agentId ?? payload.sessionId,
        toolUseId: payload.tool.useId,
        durationMs: payload.tool.durationMs,
      };
      break;
    case "Stop":
      kind = "agent.notification";
      data = { type: "turn-end", text: payload.lastMessage ? safeLine(payload.lastMessage, 280) : undefined };
      agent = { name: payload.agentType ?? "main", role: "orchestrator" };
      break;
    default:
      return;
  }
  appendEvent(root, buildEvent({ project, kind, data, step: stepOf(root, project), payload, agent, now }), ctx.env);
}

/** PreToolUse on the shell tool: deny with the lease's or the pause's reason; remember the session's project. */
export function guard(payload, ctx) {
  if (payload.event !== "PreToolUse") return;
  const verdict = decide(payload, ctx);
  if (verdict.project && payload.sessionId) {
    const cursor = readCursor(ctx.root, payload.sessionId);
    if (cursor?.project !== verdict.project)
      writeCursor(
        ctx.root,
        { session: payload.sessionId, harness: payload.harness },
        cursor,
        { project: verdict.project },
        ctx.now,
      );
  }
  if (!verdict.deny) return undefined;
  // The same journal lines runScript writes for this refusal, so the console and its notifications see it (WP14).
  if (verdict.code && verdict.call)
    appendRefusal(
      ctx.root,
      {
        project: verdict.project,
        code: verdict.code,
        message: verdict.deny,
        alias: verdict.call.typed,
        args: verdict.call.args,
        step: liveStep(ctx.root, verdict.project, ctx.now),
        payload,
        now: ctx.now,
      },
      ctx.env,
    );
  return { stdout: denyOutput(verdict.deny) };
}

const REINJECT_SOURCES = ["compact", "clear"];

/** SessionStart: the project's facts when they changed; SubagentStart: the lease for this repository's own agents. */
export function orient(payload, ctx) {
  const { root, now } = ctx;
  if (payload.event === "SubagentStart") {
    if (!payload.agentType || !ownAgents(root).has(payload.agentType)) return;
    const { project } = scope(payload, ctx);
    return project ? contextOutput("SubagentStart", subagentFacts(root, project, payload.agentType)) : undefined;
  }
  if (payload.event !== "SessionStart") return;
  const { project, cursor } = scope(payload, ctx);
  if (!project) return;
  const resume =
    consolePresentationEnabled(ctx.env) &&
    (payload.source === "resume" || payload.source === "startup") &&
    ((cursor?.project === project && (payload.source === "resume" || cursor.lastConsoleTarget)) ||
      ctx.env.AGENTBROS_PROJECT === project);
  const facts = sessionFacts(root, project, now);
  const text = resume
    ? `Agent Bros. console: Check the dashboard with pnpm next --project ${project}, then follow its opening instructions.\n${facts}`.slice(
        0,
        1200,
      )
    : facts;
  const hash = sha256(`${project}\n${text}`);
  const session = { session: payload.sessionId, harness: payload.harness };
  const same = cursor?.lastInjectedHash === hash && !REINJECT_SOURCES.includes(payload.source);
  writeCursor(
    root,
    session,
    cursor,
    {
      project,
      lastEventId: cursor?.lastEventId ?? ulid(now.getTime()),
      ...(resume ? { lastConsoleTarget: undefined } : {}),
      ...(same ? {} : { lastInjectedHash: hash, lastInjectedAt: now.toISOString() }),
    },
    now,
  );
  return same && !resume ? undefined : contextOutput("SessionStart", text);
}

/** UserPromptSubmit: console decisions, card answers and control changes after the session's watermark. */
export function relay(payload, ctx) {
  if (payload.event !== "UserPromptSubmit") return;
  const { root, now } = ctx;
  const { project, cursor } = scope(payload, ctx);
  if (!project) return;
  const session = { session: payload.sessionId, harness: payload.harness };
  const since = ulidTime(cursor?.lastEventId);
  if (!Number.isFinite(since)) {
    writeCursor(root, session, cursor, { project, lastEventId: ulid(now.getTime()) }, now);
    return;
  }
  const items = consoleItemsSince(projectDirOf(root, project), since);
  if (!items.length) {
    writeCursor(root, session, cursor, { project }, now);
    return;
  }
  const { text, through } = itemsBlock(project, items);
  writeCursor(root, session, cursor, { project, lastEventId: ulid(through) }, now);
  return contextOutput("UserPromptSubmit", text);
}

/** Which events each role acts on; any other event is a no-op for that role. */
export const ROLE_EVENTS = {
  observe: [
    "SessionStart",
    "SessionEnd",
    "SubagentStart",
    "SubagentStop",
    "PostToolUse",
    "PostToolUseFailure",
    "StopFailure",
    "Interrupt",
    "Stop",
  ],
  guard: ["PreToolUse"],
  orient: ["SessionStart", "SubagentStart"],
  relay: ["UserPromptSubmit"],
  present: ["PostToolUse"],
  surface: ["Notification", "PostToolUseFailure", "StopFailure", "Interrupt"],
  wake: ["Stop"],
};

export const SYNC_ROLES = { observe, guard, orient, relay, present, surface };
