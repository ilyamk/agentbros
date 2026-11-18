import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithin, validateProjectId } from "../lib/cli";
import { guardTool } from "../lib/step-lease/guard";
import type { ToolCommand } from "./catalog";
export interface BridgeOptions {
  root: string;
  codeRoot: string;
  projectScope?: string;
  allowPaid: boolean;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  stderr?: (chunk: Buffer) => void;
}
const EnvelopeSchema = z
  .object({
    ok: z.boolean(),
    outputs: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    elapsedMs: z.number().nonnegative(),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();
export function scopedPath(root: string, value: string): string {
  if (value.includes("\0")) throw new Error("File path contains NUL.");
  const resolved = path.resolve(root, value);
  let ancestor = resolved;
  while (!lstatSync(ancestor, { throwIfNoEntry: false }) && path.dirname(ancestor) !== ancestor)
    ancestor = path.dirname(ancestor);
  const canonical = path.resolve(realpathSync(ancestor), path.relative(ancestor, resolved));
  assertPathWithin(realpathSync(root), canonical);
  return canonical;
}
export function prepareCommand(definition: ToolCommand, raw: unknown, options: BridgeOptions) {
  const flags = definition.schema.parse(raw) as Record<string, string | number | boolean | string[] | undefined>;
  if (definition.name === "delivery") {
    if (
      flags.action !== "handoff" &&
      (options.projectScope || flags.project !== undefined || flags.recover !== undefined)
    )
      throw new Error("Legacy delivery snapshot/check require workspace scope without project/recover flags.");
    if (flags.action === "handoff" && flags.snapshot === undefined)
      throw new Error("Native handoff requires the existing source snapshot.");
  }
  if (options.projectScope && flags.project !== undefined && flags.project !== options.projectScope)
    throw new Error("Project is outside the server project scope.");
  if (
    options.projectScope &&
    ["video_recipe", "campaign", "video_workflow", "campaign_production", "campaign_next", "campaign_brief"].includes(
      definition.name,
    )
  )
    throw new Error(
      "Manifest-driven project creation is disabled in single-project scope; use workspace-root authority explicitly.",
    );
  if (options.projectScope && flags.project === undefined)
    throw new Error("Tool requires the scoped project argument.");
  if (flags.project !== undefined) validateProjectId(String(flags.project));
  for (const field of definition.paths) {
    const value = flags[field];
    if (typeof value === "string") flags[field] = scopedPath(options.root, value);
    else if (Array.isArray(value))
      flags[field] = value
        .map((item) => {
          const scoped = scopedPath(options.root, item);
          if (scoped.includes(",")) throw new Error(`A listed path cannot contain a comma: ${item}`);
          return scoped;
        })
        .join(",");
  }
  // The step lease comes first: --allow-paid can only narrow what the current step allows (docs/step-lease.md).
  if (typeof flags.project === "string" && guardTool(definition.name, flags, options.root, definition.paid).forceDryRun)
    flags["dry-run"] = true;
  if (!options.allowPaid && definition.paid === "blocked")
    throw new Error(
      "Paid-capable tool is disabled. Launch the trusted local server with --allow-paid to enable it; underlying budget guards still apply.",
    );
  const enforcedDryRun = definition.paid === "dry-run" && !options.allowPaid;
  if (enforcedDryRun || (definition.paid === "dry-run" && flags["dry-run"] === undefined)) flags["dry-run"] = true;
  // Request files may contain nested filesystem paths; only the trusted launcher supplies their boundary.
  if (definition.scopeRoot) flags["scope-root"] = realpathSync(options.root);
  const argv = Object.entries(flags)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => (key === "help" && value === true ? "--help" : `--${key}=${String(value)}`));
  const script = path.resolve(options.codeRoot, "scripts", definition.script);
  assertPathWithin(path.resolve(options.codeRoot, "scripts"), script);
  if (!existsSync(script)) throw new Error("Whitelisted tool implementation is unavailable in this checkout.");
  return { script, argv, enforcedDryRun, flags };
}
/** Fixed code path, literal argv, scoped cwd; never executes a caller shell string. */
export async function invokeCommand(
  definition: ToolCommand,
  raw: unknown,
  options: BridgeOptions,
  signal?: AbortSignal,
) {
  const plan = prepareCommand(definition, raw, options);
  const timeout = options.timeoutMs ?? 60000,
    maxBytes = options.maxStdoutBytes ?? 64 * 1024 * 1024;
  const output = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
    const runner = path.resolve(options.codeRoot, "node_modules/tsx/dist/cli.mjs");
    const child = spawn(process.execPath, [runner, plan.script, ...plan.argv], {
      cwd: realpathSync(options.root),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      // The journal labels what the CLI did as coming through MCP (RFC 0004 §6.1).
      env: { ...process.env, AGENTBROS_CHANNEL: "mcp" },
    });
    const chunks: Buffer[] = [];
    let bytes = 0,
      failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error as Error;
      }
    };
    const abort = (message: string) => {
      if (failure) return;
      failure = new Error(message);
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const timer = setTimeout(
      () => abort("CLI timed out. A paid job may remain pending; resume the same operation ID."),
      timeout,
    );
    timer.unref();
    const cancel = () => abort("MCP request cancelled. Reconcile pending operations before any replacement submit.");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) abort("CLI stdout exceeds the configured limit.");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => (options.stderr ? options.stderr(chunk) : process.stderr.write(chunk)));
    child.on("error", (error) => {
      failure = error;
    });
    child.on("exit", () => {
      if (process.platform !== "win32") kill("SIGKILL");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(chunks).toString("utf8"), code });
    });
  });
  const lines = output.stdout.trimEnd().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0]) throw new Error("CLI contract violation: expected exactly one JSON envelope.");
  const envelope = EnvelopeSchema.parse(JSON.parse(lines[0]));
  if (output.code !== (envelope.ok ? 0 : 1)) throw new Error("CLI exit status disagrees with the JSON envelope.");
  return {
    ...envelope,
    metadata: {
      ...envelope.metadata,
      bridge: { tool: definition.name, enforcedDryRun: plan.enforcedDryRun, allowPaid: options.allowPaid },
    },
  };
}

/** Inline media stays in the child request, not duplicated as huge MCP wire content. */
export function summarizeInlineMedia(value: unknown): unknown {
  if (typeof value === "string") {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
    if (!match) return value;
    const bytes = Buffer.from(match[2]!, "base64");
    return {
      kind: "inline-media-summary",
      mime: match[1],
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      omittedFromWire: true,
    };
  }
  if (Array.isArray(value)) return value.map(summarizeInlineMedia);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, summarizeInlineMedia(item)]));
  return value;
}
