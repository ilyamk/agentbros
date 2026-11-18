/**
 * Shared set-up of the harness hook tests (tests/console-hooks*.test.ts, RFC 0004 §7.1): a temporary checkout that
 * the hook recognises (package.json, the hook script, own agents), a film project with a lease, fixture loading and
 * runners for the hook in-process and as the real child process.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chainHash, writeLease } from "../../src/lib/step-lease/lease";
import type { StepLease } from "../../src/types/step-lease";
// @ts-expect-error plain Node hook without types
import { runHook as runHookUntyped } from "../../scripts/hooks/agentbros-hook.mjs";

export const REPO = path.resolve(import.meta.dirname, "../..");
export const HOOK = path.join(REPO, "scripts/hooks/agentbros-hook.mjs");
export const FIXTURES = path.join(REPO, "tests/fixtures/hooks");
export const PROJECT = "demo-film";

export type HookResult = { stdout?: Record<string, unknown>; stderr?: string; exit?: number };
export const runHook = runHookUntyped as (
  harness: string,
  role: string,
  raw: unknown,
  options?: { env?: NodeJS.ProcessEnv; now?: Date },
) => Promise<HookResult>;

/** A hook payload fixture: `documented` follows the harness's docs or source, `recorded` a live session. */
export type Fixture = {
  provenance: "documented" | "recorded" | "synthetic";
  source: string;
  checked: string;
  payload: Record<string, unknown>;
};
export const fixture = (harness: "claude" | "codex", name: string): Fixture =>
  JSON.parse(readFileSync(path.join(FIXTURES, harness, `${name}.json`), "utf8")) as Fixture;

/** The env a hook test runs with: hooks and journal on, step guard and project unset. */
export const hookEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTBROS_HOOKS: "on", AGENTBROS_EVENTS: "on", ...extra };
  for (const name of [
    "AGENTBROS_STEP_GUARD",
    "AGENTBROS_PROJECT",
    "AGENTBROS_INTERACTION_MODE",
    "AGENTBROS_STEP_ADMITTED",
  ])
    if (!(name in extra)) delete env[name];
  return env;
};

export interface Workspace {
  root: string;
  dir: string;
  cleanup: () => void;
  /** A fixture payload with cwd set to the workspace (and any overrides). */
  payload: (harness: "claude" | "codex", name: string, overrides?: Record<string, unknown>) => Record<string, unknown>;
  lease: (overrides?: Partial<StepLease>) => StepLease;
  events: () => Record<string, unknown>[];
}

export function workspace(options: { project?: boolean } = {}): Workspace {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "console-hooks-")));
  writeFileSync(path.join(root, "package.json"), '{ "name": "checkout" }\n');
  mkdirSync(path.join(root, "scripts/hooks"), { recursive: true });
  writeFileSync(path.join(root, "scripts/hooks/agentbros-hook.mjs"), "// marker\n");
  mkdirSync(path.join(root, ".agents/agents"), { recursive: true });
  writeFileSync(path.join(root, ".agents/agents/fixer.md"), "---\nname: fixer\ndescription: Fixes.\n---\nBody\n");
  writeFileSync(path.join(root, ".agents/agents/README.md"), "# Agents\n");
  const dir = path.join(root, "public/projects", PROJECT);
  if (options.project !== false) mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  const now = Date.now();
  return {
    root,
    dir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    payload: (harness, name, overrides = {}) => ({ ...fixture(harness, name).payload, cwd: root, ...overrides }),
    lease: (overrides = {}) => {
      const lease: StepLease = {
        schemaVersion: 1,
        project: PROJECT,
        route: "film",
        step: "material",
        owner: "asset-planner",
        role: "owner",
        lanes: [],
        allow: ["next", "film:next", "film:done", "feedback", "asset:import", "generate:model"],
        spending: ["generate:model"],
        paidAllowed: false,
        chainHash: chainHash(dir, "film"),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
        issuedBy: "film:next",
        ...overrides,
      };
      writeLease(dir, lease);
      return lease;
    },
    events: () => {
      try {
        return readFileSync(path.join(dir, "pipeline/events.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
  };
}

/** The real hook as a child process: exit status, stdout, stderr and wall time. */
export function spawnHook(
  harness: string,
  role: string,
  input: string,
  env: NodeJS.ProcessEnv = hookEnv(),
  cwd = tmpdir(),
) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [HOOK, harness, role], { input, encoding: "utf8", env, cwd });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: performance.now() - started };
}
