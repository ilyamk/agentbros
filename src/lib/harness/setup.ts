/**
 * Plans and applies the per-harness wiring of this checkout: links from a harness's own folder to the
 * canonical `.agents/` definitions, and the `agentbros` MCP server in the harness's config file.
 * Canonical content never moves or gets copied; generated files are git-ignored (they hold absolute paths).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HARNESSES, MCP_SERVER_NAME, type AgentTarget, type HarnessSpec, type McpTarget } from "./registry";

export type ActionKind = "link" | "agents" | "mcp" | "manual";
export type ActionState = "ok" | "todo" | "conflict" | "manual";

export interface HarnessAction {
  harness: string;
  kind: ActionKind;
  /** Repository-relative for project files; `~/…` for user files. */
  path: string;
  state: ActionState;
  detail: string;
  /** Global (user-scope) changes are applied only with --global. */
  scope: "project" | "user";
}

export interface HarnessStatus {
  id: string;
  name: string;
  detected: boolean;
  detectedBy: string | null;
  selected: boolean;
  actions: HarnessAction[];
}

export interface PlanOptions {
  codeRoot: string;
  /** Harness ids to wire; default: the detected ones (Claude Code and Codex are always wired). */
  only?: readonly string[];
  /** Wire every known harness, detected or not. */
  all?: boolean;
  home?: string;
  /** Node binary the configs launch; default: the one running setup (the pinned runtime). */
  nodePath?: string;
  /** Overrides PATH lookup in tests. */
  which?: (bin: string) => boolean;
  /** Overrides the application-bundle check in tests. */
  appExists?: (file: string) => boolean;
}

const ALWAYS = new Set(["claude-code", "codex"]);

function onPath(bin: string): boolean {
  const probe =
    process.platform === "win32"
      ? spawnSync("where", [bin], { stdio: "ignore" })
      : spawnSync("sh", ["-c", 'command -v "$1"', "sh", bin], { stdio: "ignore" });
  return probe.status === 0;
}

function detect(
  spec: HarnessSpec,
  home: string,
  which: (bin: string) => boolean,
  appExists: (file: string) => boolean,
): string | null {
  for (const bin of spec.detect.bins) if (which(bin)) return `${bin} on PATH`;
  for (const dir of spec.detect.homeDirs) if (existsSync(path.join(home, dir))) return `~/${dir}`;
  for (const app of spec.detect.apps ?? []) if (appExists(app)) return app;
  return null;
}

/** The launch line every generated config uses: absolute pinned Node, absolute tsx and server, --root the checkout. */
export function serverLaunch(codeRoot: string, nodePath: string, toolsets: string) {
  return {
    command: nodePath,
    args: [
      path.join(codeRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(codeRoot, "src", "mcp", "stdio.ts"),
      "--root",
      codeRoot,
      "--toolsets",
      toolsets,
    ],
  };
}

export function serverEntry(target: McpTarget, codeRoot: string, nodePath: string): unknown {
  const { command, args } = serverLaunch(codeRoot, nodePath, target.toolsets);
  switch (target.format) {
    case "mcpServers":
    case "amp":
      return { command, args };
    case "vscode":
      return { type: "stdio", command, args };
    case "opencode":
      return { type: "local", command: [command, ...args] };
    case "kilo":
      return { type: "local", command: [command, ...args], enabled: true };
    case "codex-toml":
      return { command, args };
  }
}

export const KEY_PATH: Record<McpTarget["format"], string[]> = {
  mcpServers: ["mcpServers"],
  vscode: ["servers"],
  opencode: ["mcp", "servers"],
  kilo: ["mcp"],
  amp: ["amp.mcpServers"],
  "codex-toml": ["mcp_servers"],
};

export type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

export function readJson(file: string): Json | "invalid" | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isObject(parsed) ? parsed : "invalid";
  } catch {
    return "invalid";
  }
}

export function getPath(object: Json, keys: readonly string[]): unknown {
  let current: unknown = object;
  for (const key of keys) current = isObject(current) ? current[key] : undefined;
  return current;
}

function setPath(object: Json, keys: readonly string[], value: unknown): void {
  let current = object;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(current[key])) current[key] = {};
    current = current[key] as Json;
  }
  current[keys.at(-1)!] = value;
}

const stable = (value: unknown) => JSON.stringify(value);

export const TOML_BEGIN = `# >>> ${MCP_SERVER_NAME} (pnpm harness:setup; edits inside this block are replaced)`;
export const TOML_END = `# <<< ${MCP_SERVER_NAME}`;
const tomlString = (value: string) => JSON.stringify(value);
function tomlBlock(entry: { command: string; args: string[] }): string {
  return [
    TOML_BEGIN,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
    `startup_timeout_sec = 30`,
    TOML_END,
    "",
  ].join("\n");
}
function mergeToml(existing: string, block: string): string | "conflict" {
  const begin = existing.indexOf(TOML_BEGIN),
    end = existing.indexOf(TOML_END);
  if (begin >= 0 && end > begin) return existing.slice(0, begin) + block + existing.slice(end + TOML_END.length + 1);
  if (new RegExp(`^\\[mcp_servers\\.${MCP_SERVER_NAME}\\]`, "m").test(existing)) return "conflict";
  return (existing && !existing.endsWith("\n") ? existing + "\n" : existing) + (existing ? "\n" : "") + block;
}

export const display = (codeRoot: string, home: string, file: string) =>
  file.startsWith(codeRoot + path.sep)
    ? path.relative(codeRoot, file).split(path.sep).join("/")
    : file.startsWith(home + path.sep)
      ? "~/" + path.relative(home, file).split(path.sep).join("/")
      : file;

/** What a config file would contain after the merge, or a conflict reason. */
function mergedConfig(
  target: McpTarget,
  file: string,
  codeRoot: string,
  nodePath: string,
): { next: string | null; current: string | null; conflict?: string } {
  const entry = serverEntry(target, codeRoot, nodePath);
  if (target.format === "codex-toml") {
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    const next = mergeToml(current ?? "", tomlBlock(entry as { command: string; args: string[] }));
    if (next === "conflict")
      return {
        next: null,
        current,
        conflict: `[mcp_servers.${MCP_SERVER_NAME}] exists outside the managed block; remove it or edit it by hand`,
      };
    return { next, current };
  }
  const parsed = readJson(file);
  if (parsed === "invalid")
    return { next: null, current: null, conflict: "not plain JSON (comments?); add the entry by hand" };
  const current = parsed === null ? null : stable(parsed);
  const object: Json = parsed === null ? {} : (JSON.parse(current!) as Json);
  setPath(object, [...KEY_PATH[target.format], MCP_SERVER_NAME], entry);
  for (const [key, value] of Object.entries(target.settings ?? {})) setPath(object, key.split("."), value);
  return { next: JSON.stringify(object, null, 2) + "\n", current };
}

function linkAction(spec: HarnessSpec, codeRoot: string, link: { path: string; target: string }): HarnessAction {
  const file = path.join(codeRoot, link.path);
  const canonical = path.join(codeRoot, link.target);
  const base = { harness: spec.id, kind: "link" as const, path: link.path, scope: "project" as const };
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { ...base, state: "todo", detail: `link to ${link.target}` };
  if (stat.isSymbolicLink() || (process.platform === "win32" && stat.isDirectory())) {
    try {
      if (realpathSync(file) === realpathSync(canonical)) return { ...base, state: "ok", detail: `→ ${link.target}` };
    } catch {
      return { ...base, state: "todo", detail: `dangling link (${readlinkSync(file)}); relink to ${link.target}` };
    }
    return { ...base, state: "conflict", detail: `points elsewhere (${readlinkSync(file)}); left untouched` };
  }
  // A checkout without symlink support (Windows, core.symlinks=false) writes the link as a text file holding its target.
  if (stat.isFile() && stat.size < 512) {
    const text = readFileSync(file, "utf8").trim();
    if (path.resolve(path.dirname(file), text) === canonical)
      return {
        ...base,
        state: "todo",
        detail: `placeholder file from a checkout without symlinks; replace with a link`,
      };
  }
  return { ...base, state: "conflict", detail: "a real file or folder is there; left untouched (never a second copy)" };
}

const GENERATED = "Generated by pnpm harness:setup from";

interface AgentSource {
  name: string;
  description: string;
  body: string;
  source: string;
}

/** The canonical leaf agents (`.agents/agents/*.md`, README excluded). */
export function agentSources(codeRoot: string): AgentSource[] {
  const dir = path.join(codeRoot, ".agents", "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort()
    .map((file) => {
      const text = readFileSync(path.join(dir, file), "utf8");
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
      const fields: Record<string, string> = {};
      for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
        const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (pair) fields[pair[1]!] = pair[2]!.trim();
      }
      return {
        name: fields.name ?? file.slice(0, -3),
        description: fields.description ?? "",
        body: text.slice(match?.[0].length ?? 0).trimStart(),
        source: `.agents/agents/${file}`,
      };
    });
}

/** One converted agent file: name and text. Tools and model labels are Claude's, so neither is carried over. */
export function renderAgent(format: AgentTarget["format"], agent: AgentSource): { file: string; text: string } {
  const note = `${GENERATED} ${agent.source}; edit that file and rerun.`;
  const quoted = JSON.stringify(agent.description);
  switch (format) {
    case "codex-toml":
      return {
        file: `${agent.name}.toml`,
        text: `# ${note}\nname = ${JSON.stringify(agent.name)}\ndescription = ${quoted}\ndeveloper_instructions = ${JSON.stringify(agent.body)}\n`,
      };
    case "copilot":
      return {
        file: `${agent.name}.agent.md`,
        text: `---\nname: ${agent.name}\ndescription: ${quoted}\n---\n<!-- ${note} -->\n\n${agent.body}`,
      };
    case "opencode":
      return {
        file: `${agent.name}.md`,
        text: `---\ndescription: ${quoted}\nmode: subagent\n---\n<!-- ${note} -->\n\n${agent.body}`,
      };
  }
}

/** Files to write and stale generated files to remove in a harness's agent folder. */
export function agentDiff(codeRoot: string, target: AgentTarget) {
  const dir = path.join(codeRoot, target.dir);
  const wanted = agentSources(codeRoot).map((agent) => renderAgent(target.format, agent));
  const write = wanted.filter(
    ({ file, text }) => !existsSync(path.join(dir, file)) || readFileSync(path.join(dir, file), "utf8") !== text,
  );
  const names = new Set(wanted.map(({ file }) => file));
  const remove = existsSync(dir)
    ? readdirSync(dir).filter(
        (file) =>
          !names.has(file) &&
          lstatSync(path.join(dir, file)).isFile() &&
          readFileSync(path.join(dir, file), "utf8").includes(GENERATED),
      )
    : [];
  return { dir, total: wanted.length, write, remove };
}

export function planHarnesses(options: PlanOptions): HarnessStatus[] {
  const home = options.home ?? homedir();
  const nodePath = options.nodePath ?? process.execPath;
  const which = options.which ?? onPath;
  const only = options.only ? new Set(options.only) : null;
  if (only)
    for (const id of only) if (!HARNESSES.some((spec) => spec.id === id)) throw new Error(`Unknown harness: ${id}`);
  return HARNESSES.map((spec) => {
    const detectedBy = detect(spec, home, which, options.appExists ?? existsSync);
    const selected = only ? only.has(spec.id) : !!options.all || ALWAYS.has(spec.id) || detectedBy !== null;
    const actions: HarnessAction[] = [];
    if (selected) {
      for (const link of spec.links) actions.push(linkAction(spec, options.codeRoot, link));
      if (spec.agents) {
        const diff = agentDiff(options.codeRoot, spec.agents);
        const stale = diff.write.length + diff.remove.length;
        actions.push({
          harness: spec.id,
          kind: "agents",
          path: spec.agents.dir,
          scope: "project",
          state: stale ? "todo" : "ok",
          detail: stale
            ? `generate ${diff.write.length} of ${diff.total} agents from .agents/agents${diff.remove.length ? `, remove ${diff.remove.length} stale` : ""}`
            : `${diff.total} agents generated from .agents/agents`,
        });
      }
      for (const target of spec.mcp) {
        const file =
          target.scope === "project" ? path.join(options.codeRoot, target.file) : path.join(home, target.file);
        const shown = display(options.codeRoot, home, file);
        const base = { harness: spec.id, kind: "mcp" as const, path: shown, scope: target.scope };
        if (target.committed) {
          const has = getPath((readJson(file) as Json | null) ?? {}, [...KEY_PATH[target.format], MCP_SERVER_NAME]);
          actions.push({
            ...base,
            state: has ? "ok" : "conflict",
            detail: has
              ? "tracked config (relative launch from the repository root)"
              : "tracked config lacks the server",
          });
          continue;
        }
        const merged = mergedConfig(target, file, options.codeRoot, nodePath);
        if (merged.conflict) actions.push({ ...base, state: "conflict", detail: merged.conflict });
        else {
          const same =
            target.format === "codex-toml"
              ? merged.current === merged.next
              : merged.current !== null && stable(JSON.parse(merged.next!)) === merged.current;
          actions.push({
            ...base,
            state: same ? "ok" : target.scope === "user" ? "manual" : "todo",
            detail: same
              ? `server ${MCP_SERVER_NAME} (--toolsets ${target.toolsets})`
              : target.scope === "user"
                ? `user config: run with --global to add ${MCP_SERVER_NAME}, or add the printed entry by hand`
                : `add ${MCP_SERVER_NAME} (--toolsets ${target.toolsets})${target.settings ? " and " + Object.keys(target.settings).join(", ") : ""}`,
          });
        }
      }
      for (const note of spec.manual ?? [])
        actions.push({
          harness: spec.id,
          kind: "manual",
          path: note.where,
          state: "manual",
          detail: note.detail,
          scope: "user",
        });
    }
    return { id: spec.id, name: spec.name, detected: detectedBy !== null, detectedBy, selected, actions };
  });
}

function makeLink(codeRoot: string, link: { path: string; target: string }): void {
  const file = path.join(codeRoot, link.path);
  mkdirSync(path.dirname(file), { recursive: true });
  if (lstatSync(file, { throwIfNoEntry: false })) rmSync(file, { force: true });
  const relative = path.relative(path.dirname(file), path.join(codeRoot, link.target));
  // A directory junction needs no privilege on Windows; it takes an absolute target.
  if (process.platform === "win32") symlinkSync(path.join(codeRoot, link.target), file, "junction");
  else symlinkSync(relative, file, "dir");
  if (process.platform === "win32" && isTracked(codeRoot, link.path))
    spawnSync("git", ["update-index", "--skip-worktree", link.path], { cwd: codeRoot, stdio: "ignore" });
}

function isTracked(codeRoot: string, file: string): boolean {
  return spawnSync("git", ["ls-files", "--error-unmatch", file], { cwd: codeRoot, stdio: "ignore" }).status === 0;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/** Applies the planned project actions (and user ones with `global`); returns the paths written. */
export function applyHarnesses(
  statuses: readonly HarnessStatus[],
  options: PlanOptions & { global?: boolean },
): { written: string[]; backups: string[] } {
  const home = options.home ?? homedir();
  const nodePath = options.nodePath ?? process.execPath;
  const written: string[] = [],
    backups: string[] = [];
  for (const status of statuses) {
    const spec = HARNESSES.find((entry) => entry.id === status.id)!;
    for (const action of status.actions) {
      if (action.kind === "link" && action.state === "todo") {
        makeLink(
          options.codeRoot,
          spec.links.find((link) => link.path === action.path)!,
        );
        written.push(action.path);
      }
      if (action.kind === "agents" && action.state === "todo") {
        const diff = agentDiff(options.codeRoot, spec.agents!);
        mkdirSync(diff.dir, { recursive: true });
        for (const { file, text } of diff.write) writeAtomic(path.join(diff.dir, file), text);
        for (const file of diff.remove) rmSync(path.join(diff.dir, file));
        written.push(action.path);
      }
      if (action.kind !== "mcp") continue;
      const writeUser = action.scope === "user" && action.state === "manual" && options.global;
      if (action.state !== "todo" && !writeUser) continue;
      const target = spec.mcp.find(
        (entry) => display(options.codeRoot, home, resolveTarget(entry, options.codeRoot, home)) === action.path,
      )!;
      const file = resolveTarget(target, options.codeRoot, home);
      const merged = mergedConfig(target, file, options.codeRoot, nodePath);
      if (!merged.next) continue;
      if (action.scope === "user" && existsSync(file)) {
        const backup = `${file}.agentbros-backup`;
        writeFileSync(backup, readFileSync(file));
        backups.push(display(options.codeRoot, home, backup));
      }
      writeAtomic(file, merged.next);
      written.push(action.path);
    }
  }
  return { written, backups };
}

export const resolveTarget = (target: McpTarget, codeRoot: string, home: string) =>
  target.scope === "project" ? path.join(codeRoot, target.file) : path.join(home, target.file);

/** The entry a person pastes by hand for a harness whose config this tool does not write. */
export function manualSnippet(target: McpTarget, codeRoot: string, nodePath = process.execPath): string {
  const entry = serverEntry(target, codeRoot, nodePath);
  if (target.format === "codex-toml") return tomlBlock(entry as { command: string; args: string[] });
  const object: Json = {};
  setPath(object, [...KEY_PATH[target.format], MCP_SERVER_NAME], entry);
  return JSON.stringify(object, null, 2);
}
