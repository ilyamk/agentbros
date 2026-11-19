/**
 * Remotion Studio on the user's request (RFC 0004 §17, D21 as amended 2026-11-18): what Studio opens for a project,
 * the props it opens it with, and the lifecycle of the Studio processes `studio:open` starts.
 *
 * - Target: a bespoke film opens `pipeline/build.json`'s entry and composition, with its `props` file (under
 *   `public/`, as `film:render` passes it) when it names one; a project.json project opens
 *   `src/index.ts` and `PROJECT_COMPOSITION_IDS[format]` with exactly the props `pnpm render` would pass, written to
 *   `out/console/studio/<project>/props.<format>.json`. Studio watches that file, so writing it again updates an open
 *   Studio live. Campaign containers and projects with nothing to open are unavailable, with an English reason.
 * - Process: one Studio per (project, entry, props file), detached, under the loopback preload
 *   (`scripts/studio/loopback.cjs`): bound to 127.0.0.1 only and refusing requests from other sites. State in
 *   `out/console/studio/<key>.json` (0600), log beside it. A recorded pid is acted on only when it is still that Studio
 *   (alive, a `remotion studio` process, started when the state says); status and stop act only on the project's own
 *   states.
 *
 * {@link resolveStudioTarget} and {@link studioStatus} are cheap (no props, no spawn): the console's GET runs them
 * in-process. Opening and stopping run in `scripts/studio-open.ts`.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { DEFAULT_CONSOLE_PORT, type StudioStatusResponse, type StudioTarget } from "../../types/console";
import type { VideoFormat } from "../../types/video";
import { CliErrorObject, isBespokeBrief, isCampaignContainer } from "../cli";
import { PROJECT_COMPOSITION_IDS } from "../project-props";

/** Where the code lives: Studio's cwd, the entry's root, the Remotion CLI and the preload. */
export const STUDIO_CODE_ROOT = path.resolve(import.meta.dirname, "../../..");
export const STUDIO_DIR = "out/console/studio";
export const DEFAULT_ENTRY = "src/index.ts";
export const STUDIO_FIRST_PORT = 3000;
const STUDIO_LAST_PORT = 3999;
export const STUDIO_READY_TIMEOUT_MS = 90_000;
const FORMATS: readonly VideoFormat[] = ["vertical", "square", "landscape"];
/** Remotion's own composition id rule (letters, digits, hyphens), which also keeps the URL path plain. */
const COMPOSITION_ID = /^[A-Za-z0-9-]{1,128}$/;
const ENTRY_EXTENSION = /\.(?:tsx?|jsx?|mjs|cjs)$/;
/** The identity route the preload answers (loopback-core.cjs). */
export const STUDIO_IDENTITY_PATH = "/__agentbros/studio";

export type StudioResolution =
  | {
      available: true;
      target: StudioTarget;
      /** Formats a project target can open (its configured ones); absent for a film. */
      formats?: VideoFormat[];
      /** Absolute props file: a project target's (written by Studio's open), a film's build.json `props` (read). */
      propsFile?: string;
    }
  | { available: false; reason: string; code: "PROJECT_NOT_FOUND" | "INVALID_INPUT" | "STAGE_INCOMPLETE" };

export interface StudioState {
  v: 1;
  key: string;
  pid: number;
  port: number;
  entry: string;
  composition: string;
  /** Props file relative to the data root; absent for a film. */
  propsFile?: string;
  project: string;
  format?: VideoFormat;
  startedAt: string;
  /** `console`: started from the console for the user (verified grant); the console's shutdown stops these. */
  owner: "console" | "cli";
}

const isWithin = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * A relative file inside `base`: no absolute path, backslash or `..`, no segment starting with `-` (it goes on the
 * Remotion CLI's argv, so it must never read as a flag), a regular file whose real path (symlinks resolved) stays
 * inside `base`. Returns the normalised relative path or the reason it is refused, worded for `what`.
 */
function checkRelativeFile(
  base: string,
  value: unknown,
  what: string,
  where: string,
  extension?: RegExp,
): { file: string } | { reason: string } {
  if (typeof value !== "string" || !value || value.length > 512) return { reason: `the ${what} is not a path` };
  if (value.includes("\\") || value.includes("\0") || path.isAbsolute(value) || /^[a-zA-Z]:/.test(value))
    return { reason: `the ${what} ${JSON.stringify(value)} is not a ${where}-relative path` };
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === "")) return { reason: `the ${what} ${value} leaves the ${where}` };
  if (parts.some((part) => part.startsWith("-")))
    return { reason: `the ${what} ${JSON.stringify(value)} has a path segment starting with "-"` };
  const normalised = parts.filter((part) => part !== ".").join("/");
  if (extension && !extension.test(normalised)) return { reason: `the ${what} ${value} is not a script file` };
  let real: string;
  try {
    real = realpathSync(path.join(base, normalised));
  } catch {
    return { reason: `the ${what} ${value} does not exist` };
  }
  if (!isWithin(realpathSync(base), real)) return { reason: `the ${what} ${value} resolves outside the ${where}` };
  if (!statSync(real).isFile()) return { reason: `the ${what} ${value} is not a file` };
  return { file: normalised };
}

/**
 * An entry is a repo-relative source file inside the code root (see {@link checkRelativeFile}) with a script
 * extension. Returns the normalised relative path or the reason it is refused.
 */
export function checkEntry(codeRoot: string, entry: unknown): { entry: string } | { reason: string } {
  const checked = checkRelativeFile(codeRoot, entry, "entry", "repository", ENTRY_EXTENSION);
  return "reason" in checked ? checked : { entry: checked.file };
}

/**
 * A film's build.json `props`: a file under the data root's `public/` (as `film:render` resolves it), checked like an
 * entry. Returns its absolute path (`<rootDir>/public/<props>`) or the reason it is refused.
 */
export function checkFilmProps(rootDir: string, props: unknown): { propsFile: string } | { reason: string } {
  const publicDir = path.join(rootDir, "public");
  const checked = checkRelativeFile(publicDir, props, "props file", "public folder");
  return "reason" in checked ? checked : { propsFile: path.join(publicDir, checked.file) };
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

/** `out/console/studio/<project>/props.<format>.json` under the data root. */
export const propsFileOf = (rootDir: string, project: string, format: VideoFormat) =>
  path.join(rootDir, STUDIO_DIR, project, `props.${format}.json`);

/**
 * What Studio opens for `project` (cheap: reads build.json or project.json, writes nothing). Order: campaign
 * container (never a video), bespoke build.json, project.json; otherwise unavailable. `format` picks a project's
 * composition (default: its first configured format) and must be one of its formats.
 */
export function resolveStudioTarget(
  rootDir: string,
  project: string,
  options: { format?: VideoFormat; codeRoot?: string } = {},
): StudioResolution {
  const codeRoot = options.codeRoot ?? STUDIO_CODE_ROOT;
  const projectDir = path.join(rootDir, "public", "projects", project);
  const stat = lstatSync(projectDir, { throwIfNoEntry: false });
  if (!stat?.isDirectory())
    return { available: false, code: "PROJECT_NOT_FOUND", reason: `Project ${project} not found.` };
  let campaign = false;
  try {
    campaign = isCampaignContainer(projectDir);
  } catch {
    campaign = true; // an owner file that escapes or does not parse: treat as a container, never open it
  }
  if (campaign)
    return {
      available: false,
      code: "INVALID_INPUT",
      reason: `${project} is a campaign container, not a video: open one of its variant projects in Studio.`,
    };
  const buildFile = path.join(projectDir, "pipeline", "build.json");
  if (existsSync(buildFile)) {
    let build: unknown;
    try {
      build = readJson(buildFile);
    } catch {
      return { available: false, code: "INVALID_INPUT", reason: "pipeline/build.json is not valid JSON." };
    }
    const record = (build && typeof build === "object" ? build : {}) as {
      composition?: unknown;
      entry?: unknown;
      props?: unknown;
    };
    if (typeof record.composition !== "string" || !COMPOSITION_ID.test(record.composition))
      return {
        available: false,
        code: "INVALID_INPUT",
        reason: "pipeline/build.json names no valid composition id (letters, digits and hyphens).",
      };
    const entry = checkEntry(codeRoot, record.entry ?? DEFAULT_ENTRY);
    if ("reason" in entry)
      return { available: false, code: "INVALID_INPUT", reason: `pipeline/build.json: ${entry.reason}.` };
    const props = record.props === undefined ? undefined : checkFilmProps(rootDir, record.props);
    if (props && "reason" in props)
      return { available: false, code: "INVALID_INPUT", reason: `pipeline/build.json: ${props.reason}.` };
    if (options.format)
      return {
        available: false,
        code: "INVALID_INPUT",
        reason: `${project} is a bespoke film: its composition has its own format, so --format does not apply.`,
      };
    return {
      available: true,
      target: { kind: "film", entry: entry.entry, composition: record.composition },
      ...(props ? { propsFile: props.propsFile } : {}),
    };
  }
  const configFile = path.join(projectDir, "project.json");
  if (!existsSync(configFile)) {
    const bespoke = isBespokeBrief(path.join(projectDir, "pipeline", "brief.json"));
    return {
      available: false,
      code: "STAGE_INCOMPLETE",
      reason: bespoke
        ? `${project} is a bespoke film with no build yet: Studio opens it once pipeline/build.json names its composition.`
        : `${project} has neither pipeline/build.json nor project.json: there is nothing to open in Studio yet.`,
    };
  }
  let config: unknown;
  try {
    config = readJson(configFile);
  } catch {
    return { available: false, code: "INVALID_INPUT", reason: "project.json is not valid JSON." };
  }
  const declared = (config as { formats?: unknown })?.formats;
  const formats = [
    ...new Set(
      (Array.isArray(declared) ? declared : []).filter((value): value is VideoFormat =>
        (FORMATS as readonly unknown[]).includes(value),
      ),
    ),
  ];
  if (!formats.length)
    return { available: false, code: "INVALID_INPUT", reason: "project.json configures no output format." };
  if (options.format && !formats.includes(options.format))
    return {
      available: false,
      code: "INVALID_INPUT",
      reason: `${project} is not configured for ${options.format}; its formats: ${formats.join(", ")}.`,
    };
  const format = options.format ?? formats[0]!;
  const entry = checkEntry(codeRoot, DEFAULT_ENTRY);
  if ("reason" in entry) return { available: false, code: "INVALID_INPUT", reason: `${entry.reason}.` };
  return {
    available: true,
    target: { kind: "project", entry: entry.entry, composition: PROJECT_COMPOSITION_IDS[format], format },
    formats,
    propsFile: propsFileOf(rootDir, project, format),
  };
}

/** Whether the project's timeline journal is what `pnpm render` renders (as timeline-next decides). */
export function rendersTimeline(rootDir: string, project: string): boolean {
  return ["timeline-edit.json", "workflow-render.json"].some((file) =>
    existsSync(path.join(rootDir, "public", "projects", project, "pipeline", file)),
  );
}

/**
 * The props `pnpm render --project <id> --format <format>` passes (with `--timeline` when the route renders the
 * journal; captions on, no audio master): the exact `--props` argument of the planned render command.
 */
export async function studioProps(rootDir: string, project: string, format: VideoFormat): Promise<unknown> {
  const { planProjectRender } = await import("../render-plan");
  const job = planProjectRender(project, format, rootDir, {
    timeline: rendersTimeline(rootDir, project),
    captions: "on",
  }).jobs[0]!;
  return JSON.parse(job.args[job.args.indexOf("--props") + 1]!);
}

/** Writes `text` atomically (temp file, then rename) unless the file already holds it; true when it changed. */
export function writeIfChanged(file: string, text: string, mode = 0o600): boolean {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (readFileSync(file, "utf8") === text) return false;
  } catch {
    // absent: write it
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode });
  renameSync(temp, file);
  return true;
}

/** Writes the project's props file for Studio; true when it changed (an open Studio then reloads its props). */
export async function writeStudioProps(
  rootDir: string,
  project: string,
  format: VideoFormat,
): Promise<{ file: string; changed: boolean }> {
  const props = await studioProps(rootDir, project, format);
  const file = propsFileOf(rootDir, project, format);
  return { file, changed: writeIfChanged(file, `${JSON.stringify(props, null, 2)}\n`, 0o644) };
}

// ---------------------------------------------------------------------------
// State and identity
// ---------------------------------------------------------------------------

/**
 * One Studio per (project, entry, props file): the props file relative to the data root, so the key is stable. The
 * project is part of it, so two films on the same entry never share (or stop) one Studio.
 */
export function studioKey(rootDir: string, project: string, entry: string, propsFile?: string): string {
  const props = propsFile ? path.relative(rootDir, propsFile).split(path.sep).join("/") : null;
  return createHash("sha256")
    .update(JSON.stringify([project, entry, props]))
    .digest("hex")
    .slice(0, 16);
}

/** The key of the Studio that opens `resolution` (the chosen format's, for a project): open, status and stop agree. */
export const targetKey = (
  rootDir: string,
  project: string,
  resolution: Extract<StudioResolution, { available: true }>,
): string => studioKey(rootDir, project, resolution.target.entry, resolution.propsFile);

export const stateFileOf = (rootDir: string, key: string) => path.join(rootDir, STUDIO_DIR, `${key}.json`);
export const logFileOf = (rootDir: string, key: string) => path.join(rootDir, STUDIO_DIR, `${key}.log`);

const isState = (value: unknown): value is StudioState => {
  const state = value as StudioState;
  return (
    !!state &&
    state.v === 1 &&
    typeof state.key === "string" &&
    /^[0-9a-f]{16}$/.test(state.key) &&
    Number.isInteger(state.pid) &&
    state.pid > 1 &&
    Number.isInteger(state.port) &&
    state.port > 0 &&
    state.port < 65_536 &&
    typeof state.entry === "string" &&
    typeof state.composition === "string" &&
    COMPOSITION_ID.test(state.composition) &&
    typeof state.startedAt === "string" &&
    !Number.isNaN(Date.parse(state.startedAt)) &&
    typeof state.project === "string" &&
    (state.owner === "console" || state.owner === "cli")
  );
};

export function readState(rootDir: string, key: string): StudioState | undefined {
  try {
    const value = readJson(stateFileOf(rootDir, key));
    return isState(value) && value.key === key ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeState(rootDir: string, state: StudioState): void {
  writeIfChanged(stateFileOf(rootDir, state.key), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export function removeState(rootDir: string, key: string): void {
  rmSync(stateFileOf(rootDir, key), { force: true });
}

/** Every recorded state under the data root. */
export function listStates(rootDir: string): StudioState[] {
  const dir = path.join(rootDir, STUDIO_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^[0-9a-f]{16}\.json$/.test(name))
    .map((name) => readState(rootDir, name.slice(0, 16)))
    .filter((state): state is StudioState => !!state);
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** What `ps` reports for a pid: its command (Studio sets the title `node (npx remotion studio)`) and start time. */
export type ProcessInfo = (pid: number) => { command: string; startedAt: number } | undefined;

export const psInfo: ProcessInfo = (pid) => {
  if (process.platform === "win32") return undefined;
  const result = spawnSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    timeout: 5_000,
  });
  const line = result.status === 0 ? result.stdout.trim() : "";
  // lstart is a fixed 24-character date: "Wed Nov 18 10:12:03 2026"
  const match = /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
  if (!match) return undefined;
  const startedAt = Date.parse(match[1]!.replace(/\s+/g, " "));
  return Number.isNaN(startedAt) ? undefined : { command: match[2]!, startedAt };
};

/**
 * What the recorded pid is now: `dead`; `unknown` when `ps` says nothing about a live pid (it failed, or this is not
 * POSIX); `other` when it is another program or was started at another time (a reused pid); `ours` when it is a
 * `remotion studio` process (by its title or our preload on its command line) started within 10 s of the recorded time.
 */
export function studioProcess(state: StudioState, info: ProcessInfo = psInfo): "dead" | "unknown" | "other" | "ours" {
  if (!pidAlive(state.pid)) return "dead";
  const process_ = info(state.pid);
  if (!process_) return "unknown";
  const studio =
    /remotion studio/.test(process_.command) ||
    (/loopback\.cjs/.test(process_.command) && /remotion-cli\.js studio/.test(process_.command));
  return studio && Math.abs(process_.startedAt - Date.parse(state.startedAt)) <= 10_000 ? "ours" : "other";
}

/** Whether the recorded pid is still the Studio we started (see {@link studioProcess}). */
export const isOurStudio = (state: StudioState, info: ProcessInfo = psInfo): boolean =>
  studioProcess(state, info) === "ours";

/** GET on 127.0.0.1:<port>; resolves the status and body, or undefined when nothing answers in time. */
export function httpGet(
  port: number,
  pathname: string,
  timeoutMs = 2_000,
): Promise<{ status: number; body: string } | undefined> {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", headers: { Host: `127.0.0.1:${port}` }, agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 65_536) body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", () => resolve(undefined));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

/**
 * The preload's identity reply on the state's port: `ours` when it names the state's pid and key, `other` for any other
 * answer, `silent` when nothing answered within `timeoutMs`.
 */
export async function identityOf(state: StudioState, timeoutMs = 2_000): Promise<"ours" | "other" | "silent"> {
  const reply = await httpGet(state.port, STUDIO_IDENTITY_PATH, timeoutMs);
  if (!reply) return "silent";
  if (reply.status !== 200) return "other";
  try {
    const identity = JSON.parse(reply.body) as { pid?: unknown; key?: unknown };
    return identity.pid === state.pid && identity.key === state.key ? "ours" : "other";
  } catch {
    return "other";
  }
}

/** The preload's identity reply on the state's port names the state's pid and key. */
export async function answersAsOurs(state: StudioState): Promise<boolean> {
  return (await identityOf(state)) === "ours";
}

/** Identity probes of a running Studio before giving up: a busy Studio (bundling) can be slow to answer. */
export const IDENTITY_TIMEOUTS_MS: readonly number[] = [2_000, 5_000, 10_000];

/** {@link identityOf}, asked again with each timeout while nothing answers. */
export async function probeIdentity(
  state: StudioState,
  timeoutsMs: readonly number[] = IDENTITY_TIMEOUTS_MS,
): Promise<"ours" | "other" | "silent"> {
  let answer: "ours" | "other" | "silent" = "silent";
  for (const timeoutMs of timeoutsMs) {
    answer = await identityOf(state, timeoutMs);
    if (answer !== "silent") return answer;
  }
  return answer;
}

/** Studio serves the page (it answers 503 "Studio is starting..." until it is ready). */
export async function studioReady(state: StudioState): Promise<boolean> {
  if (!(await answersAsOurs(state))) return false;
  return (await httpGet(state.port, "/", 5_000))?.status === 200;
}

export const studioUrl = (port: number, composition: string) => `http://127.0.0.1:${port}/${composition}`;

/**
 * Stops a recorded Studio (its whole process group) when it is still ours; true when it was ours and is gone. The state
 * goes when the pid is dead, belongs to another program (never signalled) or was stopped; it stays when `ps` could not
 * tell (a live pid that may still be ours) or the Studio outlived SIGKILL, so a later stop can still find it.
 */
export async function stopStudio(
  rootDir: string,
  state: StudioState,
  options: { info?: ProcessInfo; waitMs?: number } = {},
): Promise<boolean> {
  const process_ = studioProcess(state, options.info);
  if (process_ === "unknown") return false;
  if (process_ !== "ours") {
    removeState(rootDir, state.key);
    return false;
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-state.pid, name); // detached: the pid leads its own group (esbuild and other children)
    } catch {
      try {
        process.kill(state.pid, name);
      } catch {
        // gone already
      }
    }
  };
  const waitGone = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (pidAlive(state.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  };
  signal("SIGTERM");
  await waitGone(options.waitMs ?? 5_000);
  if (pidAlive(state.pid)) {
    signal("SIGKILL");
    await waitGone(1_000);
  }
  if (pidAlive(state.pid)) return false;
  removeState(rootDir, state.key);
  return true;
}

/** Stops the Studios the console started (owner `console`); the console daemon calls this on shutdown. */
export async function stopConsoleStudios(rootDir: string, info?: ProcessInfo): Promise<number> {
  let stopped = 0;
  for (const state of listStates(rootDir).filter((item) => item.owner === "console"))
    if (await stopStudio(rootDir, state, { info, waitMs: 2_000 })) stopped++;
  return stopped;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Every (format, key) a project's Studio could run under. */
function projectKeys(
  rootDir: string,
  project: string,
  resolution: Extract<StudioResolution, { available: true }>,
): { key: string; format?: VideoFormat; composition: string }[] {
  const { target } = resolution;
  if (target.kind === "film")
    return [{ key: targetKey(rootDir, project, resolution), composition: target.composition }];
  return (resolution.formats ?? []).map((format) => ({
    key: studioKey(rootDir, project, target.entry, propsFileOf(rootDir, project, format)),
    format,
    composition: PROJECT_COMPOSITION_IDS[format],
  }));
}

/** The live Studios of a project, newest first (cheap: state files and `ps`, no HTTP). */
export function runningStudios(
  rootDir: string,
  project: string,
  resolution: Extract<StudioResolution, { available: true }>,
  info?: ProcessInfo,
): { state: StudioState; format?: VideoFormat; url: string }[] {
  return projectKeys(rootDir, project, resolution)
    .map(({ key, format, composition }) => {
      const state = readState(rootDir, key);
      return state && state.project === project && isOurStudio(state, info)
        ? { state, ...(format ? { format } : {}), url: studioUrl(state.port, composition) }
        : undefined;
    })
    .filter((item) => !!item)
    .sort((a, b) => Date.parse(b.state.startedAt) - Date.parse(a.state.startedAt));
}

/** `GET /api/projects/<id>/studio` and `studio:open --status`: whether Studio can open the project, and the running one. */
export function studioStatus(
  rootDir: string,
  project: string,
  options: { codeRoot?: string; info?: ProcessInfo } = {},
): StudioStatusResponse {
  const resolution = resolveStudioTarget(rootDir, project, { codeRoot: options.codeRoot });
  if (!resolution.available) return { ok: true, available: false, reason: resolution.reason.slice(0, 500) };
  const [running] = runningStudios(rootDir, project, resolution, options.info);
  const target =
    running?.format && resolution.target.kind === "project"
      ? { ...resolution.target, format: running.format, composition: PROJECT_COMPOSITION_IDS[running.format] }
      : resolution.target;
  return {
    ok: true,
    available: true,
    target,
    ...(resolution.formats ? { formats: resolution.formats } : {}),
    ...(running
      ? {
          running: {
            url: running.url,
            startedAt: running.state.startedAt,
            ...(running.format ? { format: running.format } : {}),
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Ports, lock and launch
// ---------------------------------------------------------------------------

/** Whether nothing listens on `port` on any of the hosts Remotion binds (wildcards included). */
export async function portFree(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "0.0.0.0", "::1", "::"]) {
    const outcome = await new Promise<"free" | "busy" | "absent">((resolve) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) =>
        resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT" ? "absent" : "busy"),
      );
      server.listen({ port, host, exclusive: true }, () => server.close(() => resolve("free")));
    });
    if (outcome === "busy") return false;
  }
  return true;
}

/** The first free port from 3000 upwards, never the console's, skipping `taken`. */
export async function choosePort(
  taken: ReadonlySet<number> = new Set(),
  from = STUDIO_FIRST_PORT,
  to = STUDIO_LAST_PORT,
): Promise<number> {
  for (let port = from; port <= to; port++) {
    if (port === DEFAULT_CONSOLE_PORT || taken.has(port)) continue;
    if (await portFree(port)) return port;
  }
  throw new CliErrorObject({
    code: "INTERNAL",
    message: `No free port for Studio between ${from} and ${to}.`,
  });
}

/**
 * Moves a lock judged stale out of the way, atomically: renamed to a unique name first, then removed only when it is
 * still the file that was judged (same inode and text; a freed inode can be reused at once, a fresh lock holds a live
 * pid). A fresh lock another opener created meanwhile is put back. True when the stale lock is gone. Exported for tests.
 */
export function takeOverStaleLock(file: string, judged: { ino: number; text: string }): boolean {
  const aside = `${file}.${process.pid}.${randomUUID()}.stale`;
  try {
    renameSync(file, aside);
  } catch {
    return false; // another opener moved it first
  }
  let same = false;
  try {
    same = statSync(aside).ino === judged.ino && readFileSync(aside, "utf8").trim() === judged.text;
  } catch {
    // unreadable: treat as not ours to remove
  }
  if (same) {
    rmSync(aside, { force: true });
    return true;
  }
  try {
    linkSync(aside, file); // not the lock we judged: a fresh one, put it back
  } catch {
    // a third opener holds the name now; theirs stands
  }
  rmSync(aside, { force: true });
  return false;
}

/**
 * An exclusive per-key lock (`<key>.lock`, O_EXCL) so two quick clicks start one Studio. A lock whose pid is gone or
 * that is older than the start timeout is stale and taken over ({@link takeOverStaleLock}). Waits up to `waitMs` for a
 * live holder. The lock holds `<pid> <uuid>`; the holder removes it only while both its inode and that token are its
 * own, since Linux file systems reuse a freed inode at once for the next lock created under the same name.
 */
export async function withStudioLock<T>(
  rootDir: string,
  key: string,
  fn: () => Promise<T>,
  waitMs = STUDIO_READY_TIMEOUT_MS + 30_000,
): Promise<T> {
  const file = path.join(rootDir, STUDIO_DIR, `${key}.lock`);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  const token = `${process.pid} ${randomUUID()}`;
  let ownIno: number;
  for (;;) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, token);
      ownIno = fstatSync(fd).ino;
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale: { ino: number; text: string } | undefined;
      try {
        const fd = openSync(file, "r");
        try {
          const stat = fstatSync(fd);
          const text = readFileSync(fd, "utf8").trim();
          const holder = Number(text.split(/\s+/)[0]); // `<pid> <uuid>`, or a bare pid from an older lock
          const age = Date.now() - stat.mtimeMs;
          if (
            age > STUDIO_READY_TIMEOUT_MS + 60_000 ||
            (text === "" ? age > 5_000 : !Number.isInteger(holder) || holder <= 0 || !pidAlive(holder))
          )
            stale = { ino: stat.ino, text };
        } finally {
          closeSync(fd);
        }
      } catch {
        continue; // gone between the open and the read: try again at once
      }
      if (stale) takeOverStaleLock(file, stale);
      else if (Date.now() > deadline)
        throw new CliErrorObject({
          code: "TIMEOUT",
          message: "Another studio:open for this project is still starting.",
        });
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    return await fn();
  } finally {
    if (statSync(file, { throwIfNoEntry: false })?.ino === ownIno && readLockText(file) === token)
      rmSync(file, { force: true });
  }
}

function readLockText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** `node_modules/@remotion/cli/remotion-cli.js` of the code root. */
export function remotionCli(codeRoot = STUDIO_CODE_ROOT): string {
  const file = path.join(codeRoot, "node_modules", "@remotion", "cli", "remotion-cli.js");
  if (!existsSync(file))
    throw new CliErrorObject({ code: "INTERNAL", message: "@remotion/cli is not installed; run pnpm install." });
  return file;
}

export const loopbackPreload = (codeRoot = STUDIO_CODE_ROOT) =>
  path.join(codeRoot, "scripts", "studio", "loopback.cjs");

/** The argv after `node`: the preload, the Remotion CLI and the studio flags (pure; exported for tests). */
export function studioArgv(options: { codeRoot: string; entry: string; port: number; propsFile?: string }): string[] {
  return [
    "--require",
    loopbackPreload(options.codeRoot),
    remotionCli(options.codeRoot),
    "studio",
    options.entry,
    "--port",
    String(options.port),
    "--no-open",
    "--ipv4",
    "--force-new",
    ...(options.propsFile ? ["--props", options.propsFile] : []),
  ];
}

/**
 * Studio's environment: this process's, without the console grant, the step admission or the actor and channel
 * claims (Studio is not the user's decision, and Node children it starts must not inherit them), with the preload in
 * NODE_OPTIONS, no browser, and the identity key. Pure; exported for tests.
 */
export function studioEnv(base: NodeJS.ProcessEnv, preload: string, key: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of STUDIO_STRIPPED_ENV) delete env[name];
  env.NODE_OPTIONS = nodeOptionsWith(preload, env.NODE_OPTIONS);
  env.BROWSER = "none";
  env.AGENTBROS_STUDIO_KEY = key;
  return env;
}

export const STUDIO_STRIPPED_ENV = [
  "AGENTBROS_CONSOLE_GRANT",
  "AGENTBROS_CONSOLE_GRANT_AT",
  "AGENTBROS_STEP_ADMITTED",
  "AGENTBROS_ACTOR",
  "AGENTBROS_CHANNEL",
] as const;

/** NODE_OPTIONS with the preload added, so Node grandchildren bind to loopback too. */
export function nodeOptionsWith(preload: string, existing = ""): string {
  const quoted = `"${preload.replace(/(["\\])/g, "\\$1")}"`;
  return [existing.trim(), `--require ${quoted}`].filter(Boolean).join(" ");
}

export interface OpenStudioOptions {
  rootDir: string;
  project: string;
  format?: VideoFormat;
  owner: StudioState["owner"];
  codeRoot?: string;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** Timeouts of the identity probes of a running Studio (default {@link IDENTITY_TIMEOUTS_MS}). */
  identityTimeoutsMs?: readonly number[];
  /** What `ps` reports (tests). */
  info?: ProcessInfo;
}

export interface OpenStudioResult {
  url: string;
  reused: boolean;
  target: StudioTarget;
  state: StudioState;
  /** A project target's props file, written for this open (a film's build props are an input, not listed). */
  propsFile?: string;
  propsChanged?: boolean;
}

/** The project's target or the CLI error that says why Studio cannot open it. */
export function requireStudioTarget(
  rootDir: string,
  project: string,
  options: { format?: VideoFormat; codeRoot?: string } = {},
): Extract<StudioResolution, { available: true }> {
  const resolution = resolveStudioTarget(rootDir, project, options);
  if (!resolution.available) throw new CliErrorObject({ code: resolution.code, message: resolution.reason });
  return resolution;
}

/**
 * Opens Studio for the project in its current state: writes the props (a running Studio reloads them live), reuses a
 * live Studio of the same key, else starts one under the loopback preload and waits until it serves the page.
 */
export async function openStudio(options: OpenStudioOptions): Promise<OpenStudioResult> {
  const codeRoot = options.codeRoot ?? STUDIO_CODE_ROOT;
  const log = options.log ?? (() => {});
  const resolution = requireStudioTarget(options.rootDir, options.project, { format: options.format, codeRoot });
  const { target } = resolution;
  let propsChanged: boolean | undefined;
  if (target.kind === "project") {
    const written = await writeStudioProps(options.rootDir, options.project, target.format!);
    propsChanged = written.changed;
  }
  /** Studio's --props: the project's written file, or the film's build props. */
  const propsFile = resolution.propsFile;
  const written = target.kind === "project" && propsFile ? { propsFile, propsChanged } : {};
  const key = targetKey(options.rootDir, options.project, resolution);
  return withStudioLock(options.rootDir, key, async () => {
    // A film's build props or entry changed since: its earlier Studio shows the old picture, so it goes.
    await stopSupersededStudios(options.rootDir, options.project, resolution, options.info);
    const existing = readState(options.rootDir, key);
    const process_ = existing ? studioProcess(existing, options.info) : "dead";
    if (existing && (process_ === "ours" || process_ === "unknown")) {
      const identity = await probeIdentity(existing, options.identityTimeoutsMs);
      if (identity === "ours") {
        log(`Reusing Studio on port ${existing.port} (pid ${existing.pid}).`);
        return { url: studioUrl(existing.port, target.composition), reused: true, target, state: existing, ...written };
      }
      // Our process by ps, yet silent: busy, never killed on a timed-out probe. Live but unknown to ps: its state is
      // kept (never overwritten by a new launch), so it can still be stopped once ps answers.
      if (identity === "silent" || process_ === "unknown")
        throw new CliErrorObject({
          code: "TIMEOUT",
          message:
            process_ === "unknown"
              ? `Could not tell whether pid ${existing.pid} is still the Studio of ${options.project} (ps gave no answer); try again in a moment.`
              : `Remotion Studio for ${options.project} (pid ${existing.pid}, port ${existing.port}) is running but not answering; try again in a moment, or stop it with pnpm studio:open --project ${options.project} --stop.`,
        });
    }
    if (existing) await stopStudio(options.rootDir, existing, { info: options.info });
    const taken = new Set(listStates(options.rootDir).map((state) => state.port));
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = await choosePort(taken);
      try {
        const state = await launch({ ...options, codeRoot, key, port, target, propsFile, log });
        return { url: studioUrl(state.port, target.composition), reused: false, target, state, ...written };
      } catch (error) {
        lastError = error;
        if (!(error instanceof PortRaceError)) throw error;
        taken.add(port);
        log(`Port ${port} was taken while Studio started; trying another.`);
      }
    }
    throw lastError;
  });
}

class PortRaceError extends Error {}

async function launch(options: {
  rootDir: string;
  project: string;
  owner: StudioState["owner"];
  codeRoot: string;
  key: string;
  port: number;
  target: StudioTarget;
  propsFile?: string;
  timeoutMs?: number;
  log: (line: string) => void;
}): Promise<StudioState> {
  const { rootDir, key, port } = options;
  const logFile = logFileOf(rootDir, key);
  mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const fd = openSync(logFile, "a", 0o600);
  const env = studioEnv(process.env, loopbackPreload(options.codeRoot), key);
  options.log(
    `Starting Remotion Studio for ${options.project} on 127.0.0.1:${port} (log ${path.relative(rootDir, logFile)}).`,
  );
  const child = spawn(
    process.execPath,
    studioArgv({ codeRoot: options.codeRoot, entry: options.target.entry, port, propsFile: options.propsFile }),
    { cwd: options.codeRoot, detached: true, stdio: ["ignore", fd, fd], env, shell: false, windowsHide: true },
  );
  closeSync(fd);
  let exited: number | null | undefined;
  child.once("exit", (code) => {
    exited = code;
  });
  const spawned = await new Promise<boolean>((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
  if (!spawned || !child.pid)
    throw new CliErrorObject({ code: "INTERNAL", message: "Remotion Studio could not be started." });
  child.unref();
  // Recorded at once: if this command is killed while Studio bundles, the Studio can still be reused or stopped.
  const state: StudioState = {
    v: 1,
    key,
    pid: child.pid,
    port,
    entry: options.target.entry,
    composition: options.target.composition,
    ...(options.propsFile ? { propsFile: path.relative(rootDir, options.propsFile).split(path.sep).join("/") } : {}),
    project: options.project,
    ...(options.target.format ? { format: options.target.format } : {}),
    startedAt: new Date().toISOString(),
    owner: options.owner,
  };
  writeState(rootDir, state);
  const deadline = Date.now() + (options.timeoutMs ?? STUDIO_READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (exited !== undefined) {
      removeState(rootDir, key);
      const tail = logTail(logFile);
      if (/EADDRINUSE|is not available|already in use/i.test(tail)) throw new PortRaceError(tail);
      throw new CliErrorObject({
        code: "INTERNAL",
        message: `Remotion Studio exited (code ${exited}) before it was ready. Log ${path.relative(rootDir, logFile)}: ${tail}`,
      });
    }
    if (await studioReady(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await stopStudio(rootDir, state);
  throw new CliErrorObject({
    code: "TIMEOUT",
    message: `Remotion Studio did not answer within ${Math.round((options.timeoutMs ?? STUDIO_READY_TIMEOUT_MS) / 1000)} s; it was stopped. Log: ${path.relative(rootDir, logFile)}.`,
  });
}

function logTail(file: string): string {
  try {
    return readFileSync(file, "utf8").slice(-800).trim();
  } catch {
    return "";
  }
}

/**
 * Stops the project's Studios whose key it no longer opens (a film's earlier props file or entry: `mount-film` names
 * the props by content hash); the Studios of its current targets (every format) stay. Returns how many were running.
 */
export async function stopSupersededStudios(
  rootDir: string,
  project: string,
  resolution: Extract<StudioResolution, { available: true }>,
  info?: ProcessInfo,
): Promise<number> {
  const current = new Set(projectKeys(rootDir, project, resolution).map((item) => item.key));
  let stopped = 0;
  for (const state of listStates(rootDir).filter((item) => item.project === project && !current.has(item.key)))
    if (await stopStudio(rootDir, state, { info })) stopped++;
  return stopped;
}

/**
 * Stops the project's Studios (every format, and any left from an earlier entry or props file); returns how many were
 * running. Only states recorded for this project are touched.
 */
export async function stopProjectStudios(
  rootDir: string,
  project: string,
  options: { info?: ProcessInfo } = {},
): Promise<number> {
  let stopped = 0;
  for (const state of listStates(rootDir).filter((item) => item.project === project))
    if (await stopStudio(rootDir, state, { info: options.info })) stopped++;
  return stopped;
}
