/** Dashboard handoff from project command output to the current desktop harness. */
import { readCursor, writeCursor } from "./cursor.mjs";
import { CONSOLE_ID, existingProject, isObject, projectInCommand, sha256 } from "./runtime.mjs";
import { commandOf, splitShell } from "./shell.mjs";

const ALIASES = new Set(["next", "film:init", "film:next", "footage:next", "project:new"]);
const MCP_TOOLS = /^(?:mcp__[A-Za-z0-9_.-]+__)?avc_(next|film_init|film_next|footage_next|project_create|call)$/;
const MCP_COMMANDS = new Set(["next", "film_init", "film_next", "footage_next", "project_create"]);

export function consolePresentationEnabled(env) {
  return (
    String(env.AGENTBROS_CONSOLE ?? "")
      .trim()
      .toLowerCase() !== "off"
  );
}

/** Which project invocation generated the result, or undefined for unrelated tools. */
function projectInvocation(tool) {
  if (!tool) return undefined;
  if (tool.kind === "shell") {
    const parsed = splitShell(tool.command);
    if (parsed.segments?.length !== 1) return undefined;
    const { words, env } = commandOf(parsed.segments[0].words);
    if (!consolePresentationEnabled(env)) return undefined;
    const [command, ...args] = words;
    if (command !== "pnpm") return undefined;
    if (args[0] === "run") args.shift();
    const [alias, positional] = args;
    if (!ALIASES.has(alias)) return undefined;
    const expected =
      projectInCommand(tool.command) ??
      (alias === "project:new" && !positional?.startsWith("-") ? positional : undefined);
    return { expected };
  }
  const match = MCP_TOOLS.exec(tool.name);
  if (!match) return undefined;
  if (match[1] !== "call") return { expected: tool.input?.project };
  if (!MCP_COMMANDS.has(String(tool.input?.tool ?? "").replace(/^avc_/, ""))) return undefined;
  return { expected: tool.input?.arguments?.project };
}

function* envelopes(value, depth = 0) {
  if (depth > 4) return;
  if (typeof value === "string") {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Shell wrappers can prefix the one-line result with progress.
    }
    if (parsed !== undefined) {
      yield* envelopes(parsed, depth + 1);
      return;
    }
    for (const line of value.trim().split(/\r?\n/).reverse()) {
      if (!line.trimStart().startsWith("{")) continue;
      try {
        yield* envelopes(JSON.parse(line), depth + 1);
      } catch {
        // Progress and partial lines carry no command result.
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) if (item?.type === "text") yield* envelopes(item.text, depth + 1);
  } else if (isObject(value) && value.isError !== true) {
    if (typeof value.ok === "boolean" && isObject(value.metadata)) yield value;
    if (value.structuredContent !== undefined) yield* envelopes(value.structuredContent, depth + 1);
    if (typeof value.stdout === "string") yield* envelopes(value.stdout, depth + 1);
    if (typeof value.output === "string") yield* envelopes(value.output, depth + 1);
    if (Array.isArray(value.content)) yield* envelopes(value.content, depth + 1);
  }
}

/** Accept only the console's loopback page and a project-bound, one-use pairing link. */
function targetOf(url, project) {
  if (typeof url !== "string") return undefined;
  try {
    const target = new URL(url);
    if (
      target.protocol !== "http:" ||
      target.hostname !== "127.0.0.1" ||
      !target.port ||
      target.username ||
      target.password ||
      target.pathname !== "/" ||
      target.search
    )
      return undefined;
    const projectRoute = `#/projects/${project}`;
    const pairing = new RegExp(`^#pair=[a-f0-9]{32}&project=${project}$`);
    if (target.hash !== projectRoute && !pairing.test(target.hash)) return undefined;
    return { url: target.href, page: `${target.origin}/${projectRoute}`, origin: target.origin };
  } catch {
    return undefined;
  }
}

export function present(payload, { root, env, now }) {
  if (payload.event !== "PostToolUse" || payload.agentId || !consolePresentationEnabled(env)) return;
  if (!CONSOLE_ID.test(payload.sessionId ?? "")) return;
  const invocation = projectInvocation(payload.tool);
  if (!invocation) return;
  const cursor = readCursor(root, payload.sessionId);
  for (const result of envelopes(payload.tool.response)) {
    const { projectId, console: block } = result.metadata;
    if (!result.ok || !isObject(block) || !existingProject(root, projectId)) continue;
    if (invocation.expected && invocation.expected !== projectId) continue;
    const target = targetOf(block.url, projectId);
    const key = sha256(`${projectId}\n${target?.origin ?? "unavailable"}`);
    if (cursor?.lastConsoleTarget === key) return;
    writeCursor(
      root,
      { session: payload.sessionId, harness: payload.harness },
      cursor,
      { project: projectId, lastConsoleTarget: key },
      now,
    );
    const opener =
      payload.harness === "codex"
        ? 'Use the Codex Desktop browser. If open_in_codex is available, use target.type "browser", placement "right", and the existing tabId when available.'
        : "Use the Claude Code Desktop Browser pane and attach it to the running Studio Console.";
    const how = target
      ? `${opener} Reuse the dashboard tab at ${target.origin}. If it already shows the connected project at ${target.page}, focus it. Otherwise navigate that same tab to ${target.url}; use that link for a fresh pane as well. Verify the project and connection, then continue. If the pane is unavailable, give the project link to the user.`
      : "The dashboard is unavailable. Read the console error in the command result, tell the user briefly, and continue the project.";
    const warning =
      target && block.error
        ? " The server reported a problem. Read console.error and disclose it without stopping this project."
        : "";
    return {
      stdout: {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `Agent Bros. console: Project ${projectId}. ${how}${warning}`,
        },
      },
    };
  }
}
