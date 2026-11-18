/**
 * Is the harness wiring this checkout already has still good? Generated configs pin an absolute Node and the
 * checkout's path, so a Node upgrade or a moved folder breaks them silently; `pnpm preflight` reports it here.
 * Read-only: nothing is fixed (that is `pnpm harness:setup --apply`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { runtimeStatus } from "../runtime";
import { HARNESSES, MCP_SERVER_NAME, type McpTarget } from "./registry";
import {
  agentDiff,
  display,
  getPath,
  KEY_PATH,
  readJson,
  resolveTarget,
  TOML_BEGIN,
  TOML_END,
  type Json,
} from "./setup";

export interface HarnessProblem {
  harness: string;
  path: string;
  problem: string;
}

export interface HarnessHealth {
  /** Harness names with an agentbros entry in a config this checkout can see. */
  wired: string[];
  problems: HarnessProblem[];
}

export interface HealthOptions {
  codeRoot: string;
  home?: string;
  /** Node version of an executable; overridden in tests. */
  versionOf?: (executable: string) => string | null;
}

function nodeVersion(executable: string): string | null {
  const result = spawnSync(executable, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 10000 });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}

/** The launch line of the agentbros entry in one config, or null when the file has none. */
export function launchOf(target: McpTarget, file: string): { command: string; args: string[] } | null {
  if (!existsSync(file)) return null;
  if (target.format === "codex-toml") {
    const text = readFileSync(file, "utf8");
    const begin = text.indexOf(TOML_BEGIN),
      end = text.indexOf(TOML_END);
    if (begin < 0 || end < begin) return null;
    const block = text.slice(begin, end);
    const command = /^command = (".*")$/m.exec(block)?.[1];
    const args = /^args = (\[.*\])$/m.exec(block)?.[1];
    if (!command || !args) return null;
    return { command: JSON.parse(command) as string, args: JSON.parse(args) as string[] };
  }
  const parsed = readJson(file);
  if (!parsed || parsed === "invalid") return null;
  const entry = getPath(parsed, [...KEY_PATH[target.format], MCP_SERVER_NAME]) as Json | undefined;
  if (!entry) return null;
  if (Array.isArray(entry.command)) {
    const [command, ...args] = entry.command as string[];
    return command ? { command, args } : null;
  }
  return typeof entry.command === "string"
    ? { command: entry.command, args: Array.isArray(entry.args) ? (entry.args as string[]) : [] }
    : null;
}

export function harnessHealth(options: HealthOptions): HarnessHealth {
  const home = options.home ?? homedir();
  const versionOf = options.versionOf ?? nodeVersion;
  const root = realpathSync(options.codeRoot);
  const wired = new Set<string>();
  const problems: HarnessProblem[] = [];
  const versions = new Map<string, string | null>();
  for (const spec of HARNESSES) {
    for (const link of spec.links) {
      const file = path.join(options.codeRoot, link.path);
      if (!lstatSync(file, { throwIfNoEntry: false })) continue;
      let resolved: string | null = null;
      try {
        resolved = realpathSync(file);
      } catch {
        resolved = null;
      }
      if (resolved !== realpathSync(path.join(options.codeRoot, link.target)))
        problems.push({ harness: spec.id, path: link.path, problem: `does not resolve to ${link.target}` });
    }
    if (spec.agents && existsSync(path.join(options.codeRoot, spec.agents.dir))) {
      const diff = agentDiff(options.codeRoot, spec.agents);
      if (diff.write.length + diff.remove.length > 0)
        problems.push({
          harness: spec.id,
          path: spec.agents.dir,
          problem: `${diff.write.length + diff.remove.length} generated agent file(s) out of date with .agents/agents`,
        });
    }
    for (const target of spec.mcp) {
      const file = resolveTarget(target, options.codeRoot, home);
      const shown = display(options.codeRoot, home, file);
      const launch = launchOf(target, file);
      if (!launch) {
        if (target.committed)
          problems.push({ harness: spec.id, path: shown, problem: `tracked config lacks ${MCP_SERVER_NAME}` });
        continue;
      }
      wired.add(spec.name);
      if (target.committed) continue; // relative launch: the node on PATH is checked by preflight's own node line
      const report = (problem: string) => problems.push({ harness: spec.id, path: shown, problem });
      if (!existsSync(launch.command)) {
        report(`Node ${launch.command} no longer exists`);
        continue;
      }
      if (!versions.has(launch.command)) versions.set(launch.command, versionOf(launch.command));
      const version = versions.get(launch.command);
      if (!version) report(`${launch.command} does not run`);
      else if (runtimeStatus(version).role === "unsupported") report(`Node ${version} is outside the runtime policy`);
      for (const script of launch.args.filter((arg) => arg.endsWith("cli.mjs") || arg.endsWith("stdio.ts")))
        if (!existsSync(script)) report(`${script} is missing`);
      const rootArg = launch.args[launch.args.indexOf("--root") + 1];
      const resolvedRoot = rootArg && existsSync(rootArg) ? realpathSync(rootArg) : rootArg;
      if (launch.args.includes("--root") && resolvedRoot !== root)
        report(`--root ${rootArg} is not this checkout (moved?)`);
    }
  }
  return { wired: [...wired], problems };
}
