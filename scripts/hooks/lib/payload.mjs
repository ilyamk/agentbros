/**
 * Versioned payload adapter (RFC 0004 §7.1 H1): one JSON object from Claude Code or Codex on stdin becomes one
 * harness-neutral record. Unknown fields are ignored; a missing field leaves its key undefined, and a role that needs
 * it does nothing. Sources (checked 2026-11-17): https://code.claude.com/docs/en/hooks,
 * https://learn.chatgpt.com/docs/hooks and the Codex source (openai/codex codex-rs/core/src/tools/hook_names.rs,
 * registry.rs); fixtures in tests/fixtures/hooks/ name their provenance.
 */
import { HARNESS_IDS, isObject, str } from "./runtime.mjs";

export const ADAPTER_VERSION = 1;

/**
 * Shell tools. Claude Code: `Bash`. Codex reports shell and unified exec (`exec_command`) under the canonical hook
 * name `Bash` (pinned from its docs; the raw names are accepted too in case an older build reports them).
 */
export const SHELL_TOOLS = ["Bash", "exec_command", "shell", "local_shell", "unified_exec"];
/** Codex file edits: hook input reports `tool_name: "apply_patch"` (matched by `apply_patch`, `Edit` or `Write`). */
export const PATCH_TOOLS = ["apply_patch"];

/**
 * The files an apply_patch envelope touches (`*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`),
 * from `tool_input.command` (a string, or an argv whose last element is the patch, as Codex's exec form).
 */
export function patchFiles(input) {
  const text = Array.isArray(input?.command)
    ? input.command.filter((part) => typeof part === "string").join("\n")
    : (str(input?.command) ?? str(input?.patch) ?? str(input?.input) ?? "");
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim());
    if (match?.[1]?.trim()) files.push(match[1].trim());
  }
  return files;
}
/**
 * Subagent tools. Claude Code: `Agent` (`Task` before its rename). Codex reports `spawn_agent` as `tool_name` (the
 * matcher alias `Agent` selects it but never appears in the payload); a spawn tool outside the default and
 * `multi_agent_v1` namespaces is reported as `<namespace>spawn_agent`, which {@link isAgentTool} accepts too.
 */
export const AGENT_TOOLS = ["Agent", "Task", "spawn_agent"];
export const isAgentTool = (name) =>
  AGENT_TOOLS.includes(name) || (/^[A-Za-z0-9_]*spawn_agent$/.test(name) && !name.startsWith("mcp__"));

/** A shell command from `tool_input.command`: a string, or Codex's argv form (`["bash", "-lc", "…"]`). */
export function shellCommand(input) {
  const command = isObject(input) ? input.command : undefined;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    const flag = command.findIndex((part) => /^-\w*c$/.test(part));
    return flag >= 0 && flag === command.length - 2 ? command.at(-1) : command.join(" ");
  }
  return undefined;
}

const bool = (value) => value === true;
const num = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

const filePathOf = (input) => str(input?.file_path) ?? str(input?.notebook_path) ?? str(input?.path);

/**
 * The normalised payload, or undefined when the input is not an object or names no event.
 * `harness` is the argv name (`claude` or `codex`).
 */
export function normalise(harness, raw) {
  if (!isObject(raw) || !Object.hasOwn(HARNESS_IDS, String(harness))) return undefined;
  const event = str(raw.hook_event_name);
  if (!event) return undefined;
  const toolName = str(raw.tool_name);
  const toolInput = isObject(raw.tool_input) ? raw.tool_input : undefined;
  const kind = !toolName
    ? undefined
    : SHELL_TOOLS.includes(toolName)
      ? "shell"
      : PATCH_TOOLS.includes(toolName)
        ? "patch"
        : isAgentTool(toolName)
          ? "agent"
          : "other";
  return {
    adapter: ADAPTER_VERSION,
    harness: HARNESS_IDS[harness],
    event,
    sessionId: str(raw.session_id),
    cwd: str(raw.cwd),
    turnId: str(raw.turn_id),
    source: str(raw.source),
    reason: str(raw.reason),
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    agentId: str(raw.agent_id),
    agentType: str(raw.agent_type),
    stopHookActive: bool(raw.stop_hook_active),
    lastMessage: str(raw.last_assistant_message),
    tool: toolName
      ? {
          name: toolName,
          kind,
          useId: str(raw.tool_use_id),
          command: kind === "shell" ? shellCommand(toolInput) : undefined,
          // The file a file tool names (Read, Write, Edit, NotebookEdit, Grep): the guard keeps the console's token out.
          ...(kind === "other" && filePathOf(toolInput) ? { filePath: filePathOf(toolInput) } : {}),
          // The files a Codex apply_patch touches: judged like the Claude Code file tools (guard.mjs).
          ...(kind === "patch" ? { files: patchFiles(toolInput) } : {}),
          subagentType: kind === "agent" ? (str(toolInput?.subagent_type) ?? str(toolInput?.agent_type)) : undefined,
          description: str(toolInput?.description),
          response: raw.tool_response,
          ...(kind === "other" && { input: toolInput }),
          error: str(raw.error),
          isInterrupt: bool(raw.is_interrupt),
          durationMs: num(raw.duration_ms),
        }
      : undefined,
    notification:
      event === "Notification"
        ? { type: str(raw.notification_type), message: str(raw.message), title: str(raw.title) }
        : undefined,
    failure: event === "StopFailure" ? { type: str(raw.error), details: str(raw.error_details) } : undefined,
  };
}

/**
 * The child agent id an `Agent`/`spawn_agent` call reports in its response, when it does. Claude Code sends an object
 * (`agentId`); Codex sends the tool's output text, the result as a JSON string (`{"agent_id":…,"nickname":…}`).
 */
export function childAgentId(tool) {
  let response = tool?.response;
  if (typeof response === "string" && response.length <= 64 * 1024 && response.trimStart().startsWith("{")) {
    try {
      response = JSON.parse(response);
    } catch {
      return undefined;
    }
  }
  if (!isObject(response)) return undefined;
  return str(response.agentId) ?? str(response.agent_id) ?? str(response.id);
}
