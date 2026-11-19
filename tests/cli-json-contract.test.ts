import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { COMMAND_REGISTRY } from "../src/lib/cli/commands";

/**
 * The root CLI JSON contract: every registered production script answers `--help` with
 * exactly one JSON line on stdout and exit code 0, offline, from a foreign cwd and without
 * credentials. Scripts run in parallel batches so the whole registry stays well under a minute.
 */
const repo = process.cwd();
const tsx = path.join(repo, "node_modules/tsx/dist/cli.mjs");

/** Registered entries that are not production JSON CLIs, with the reason. */
const EXEMPT: Record<string, string> = {
  "src/mcp/stdio.ts": "MCP server: stdout belongs to JSON-RPC, not the CLI envelope",
};

const scripts = [
  ...new Set(COMMAND_REGISTRY.map((entry) => entry.script).filter((script): script is string => Boolean(script))),
].filter((script) => !(script in EXEMPT));

interface HelpRun {
  script: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runHelp(script: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<HelpRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsx, path.join(repo, script), "--help"], {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ script, code, stdout, stderr, timedOut });
    });
  });
}

test("every exemption names a registered script", () => {
  const registered = new Set(COMMAND_REGISTRY.map((entry) => entry.script));
  for (const script of Object.keys(EXEMPT)) assert.ok(registered.has(script), `stale exemption: ${script}`);
  for (const script of scripts)
    assert.ok(existsSync(path.join(repo, script)), `registered script is missing: ${script}`);
});

test(
  "every registered script answers --help with exactly one JSON envelope and exit 0",
  // About 300 scripts, each bounded at 60 s; on Node 24 runners the run takes 180–290 s, so 300 s was routinely missed.
  { timeout: 600_000 },
  async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env))
      if (!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE/i.test(key)) env[key] = value;
    const cwd = mkdtempSync(path.join(tmpdir(), "cli-contract-"));
    const concurrency = Math.max(2, Math.min(8, availableParallelism() - 1));
    const queue = [...scripts];
    const failures: string[] = [];
    try {
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          for (let script = queue.shift(); script; script = queue.shift()) {
            const run = await runHelp(script, cwd, env, 60_000);
            const lines = run.stdout.trimEnd().split(/\r?\n/);
            let envelope: { ok?: unknown; elapsedMs?: unknown } | undefined;
            try {
              envelope = lines.length === 1 ? (JSON.parse(lines[0]!) as typeof envelope) : undefined;
            } catch {
              envelope = undefined;
            }
            if (
              run.timedOut ||
              run.code !== 0 ||
              !envelope ||
              envelope.ok !== true ||
              typeof envelope.elapsedMs !== "number"
            )
              failures.push(
                `${script}: exit=${run.code}${run.timedOut ? " (timed out)" : ""} lines=${lines.length} stdout=${run.stdout.slice(0, 200)} stderr=${run.stderr.slice(-300)}`,
              );
          }
        }),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    assert.deepEqual(failures, [], failures.join("\n"));
  },
);
