/**
 * Blender live session: a background Blender that keeps a scene in memory between commands.
 *
 * The server (scripts/workers/blender/avc_live.py) binds 127.0.0.1 on an OS-assigned port and requires
 * a 256-bit token from a mode-0600 session file. It runs typed ops only (no caller Python), journals every
 * scene change, and `export` writes that journal as a recipe that blender:run replays through
 * scripts/workers/blender/avc_live_replay.py. Callers name outputs; they never pass output paths.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "../assets/registry";
import { assertPathWithin, CliErrorObject, type ErrorCode } from "../cli";
import { RgbImage } from "../vision/image";
import { composeGrid } from "../vision/sheets";
import { writeImage } from "../vision/media";
import { resolveBlender } from "./blender-run";
import { approvedExtensions, extensionEnvironment } from "../blender-arsenal/extensions";
import { arsenalPaths } from "../blender-arsenal/paths";
import { ARSENAL_OP_SCHEMAS } from "./blender-live-schema";

export const CODE_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const LIVE_SERVER = path.join(CODE_ROOT, "scripts/workers/blender/avc_live.py");
export const REPLAY_SCRIPT = "scripts/workers/blender/avc_live_replay.py";
export const KIT_DIR = path.join(CODE_ROOT, "scripts/blender");
export const PROTOCOL = 1;
export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DEFAULT_IDLE_MINUTES = 30;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const QA_KEY = "_qa";

export type LivePaths = {
  key: string;
  session: string;
  project?: string;
  sessionDir: string;
  sessionFile: string;
  configFile: string;
  readyFile: string;
  logFile: string;
  outDir: string;
  assetsDir?: string;
};
export type SessionRecord = {
  protocol: number;
  session: string;
  project: string | null;
  pid: number;
  port: number;
  token: string;
  outDir: string;
  assetsDir: string | null;
  logFile: string;
  startedAt: string;
  blenderVersion: string;
  executable: string;
  base: Base;
  ui: boolean;
  extensions?: Array<{ id: string; version: string }>;
};
export type Base = { kind: "empty" } | { kind: "blend"; path: string; sha256: string };
type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string; message: string } };

const invalid = (message: string) => new CliErrorObject({ code: "INVALID_INPUT", message });

export function checkName(value: string | undefined, what: string): string {
  if (value === undefined || !NAME.test(value))
    throw invalid(`${what} must match [a-z0-9][a-z0-9-]{0,63} (a name, never a path); got ${JSON.stringify(value)}.`);
  return value;
}

/** Every location a session uses, from the workspace root. Session state is git-ignored under .cache, renders under out/. */
export function livePaths(workspace: string, project: string | undefined, session = "main"): LivePaths {
  checkName(session, "--session");
  const key = project ?? QA_KEY;
  const sessionDir = path.join(workspace, ".cache/blender-live", key, session);
  const outDir = project
    ? path.join(workspace, "out", project, "blender-live", session)
    : path.join(workspace, "out/qa/blender-live", session);
  const assetsDir = project ? path.join(workspace, "public/projects", project, "assets/blender") : undefined;
  for (const [root, target] of [
    [path.join(workspace, ".cache"), sessionDir],
    [path.join(workspace, "out"), outDir],
    ...(assetsDir ? [[path.join(workspace, "public/projects"), assetsDir]] : []),
  ] as const)
    assertPathWithin(root, target);
  return {
    key,
    session,
    project,
    sessionDir,
    sessionFile: path.join(sessionDir, "session.json"),
    configFile: path.join(sessionDir, "config.json"),
    readyFile: path.join(sessionDir, "ready.json"),
    logFile: path.join(sessionDir, "blender.log"),
    outDir,
    assetsDir,
  };
}

/** Writes a file only its owner can read, in a directory only its owner can list. */
export function writeSecret(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function readSession(paths: LivePaths): SessionRecord | undefined {
  if (!existsSync(paths.sessionFile)) return undefined;
  const mode = statSync(paths.sessionFile).mode & 0o077;
  if (mode)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${paths.sessionFile} is readable by other users (mode ${(statSync(paths.sessionFile).mode & 0o777).toString(8)}); stop the session and start a new one.`,
    });
  return JSON.parse(readFileSync(paths.sessionFile, "utf8")) as SessionRecord;
}

/** Contract codes for the server's own codes. */
export function contractCode(code: string): ErrorCode {
  if (code === "AUTH") return "VALIDATION";
  if (code === "NOT_FOUND") return "INVALID_INPUT";
  return (
    (["VALIDATION", "INVALID_INPUT", "INTERNAL", "TIMEOUT", "FILE_EXISTS", "ASSET_MISSING"] as const).find(
      (known) => known === code,
    ) ?? "INTERNAL"
  );
}

export function encodeRequest(token: string, op: string, params: Record<string, unknown>): string {
  return `${JSON.stringify({ v: PROTOCOL, token, op, params })}\n`;
}

export function parseReply(line: string): Reply {
  const reply = JSON.parse(line) as Reply;
  if (!reply || typeof reply !== "object" || typeof reply.ok !== "boolean")
    throw new CliErrorObject({ code: "INTERNAL", message: "The live session answered without an ok field." });
  return reply;
}

/** One request, one reply line, over 127.0.0.1 only. */
export function liveRequest(
  port: number,
  token: string,
  op: string,
  params: Record<string, unknown> = {},
  timeoutMs = 600000,
): Promise<Record<string, unknown>> {
  const parsed = ARSENAL_OP_SCHEMAS[op]?.safeParse(params);
  if (parsed && !parsed.success) return Promise.reject(invalid(parsed.error.message));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(invalid(`Bad session port ${port}.`));
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let bytes = 0,
      settled = false;
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () =>
        finish(
          new CliErrorObject({
            code: "TIMEOUT",
            message: `The live session did not answer ${op} within ${Math.round(timeoutMs / 1000)}s. It keeps running; check status, or stop it.`,
          }),
        ),
      timeoutMs,
    );
    socket.on("connect", () => socket.write(encodeRequest(token, op, params)));
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES)
        return finish(new CliErrorObject({ code: "INTERNAL", message: "The live session reply exceeds 16 MiB." }));
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const end = text.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = parseReply(text.slice(0, end));
        if (reply.ok) finish(undefined, reply.result);
        else
          finish(
            new CliErrorObject({
              code: contractCode(reply.error.code),
              message: reply.error.message,
              details: { liveCode: reply.error.code },
            }),
          );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) =>
      finish(
        new CliErrorObject({
          code: "NETWORK",
          message: `No live session answers on 127.0.0.1:${port} (${error.message}). Start one with --action start.`,
        }),
      ),
    );
    socket.on("close", () =>
      finish(
        new CliErrorObject({ code: "INTERNAL", message: "The live session closed the connection without a reply." }),
      ),
    );
  });
}

/** Is this pid a running Blender serving our live script? Guards against a reused pid. */
export function isLiveProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.includes("avc_live.py");
}

/** Sessions recorded under .cache/blender-live, with whether their Blender still runs. Never returns tokens. */
export function listSessions(
  workspace: string,
): Array<{ key: string; session: string; pid: number; port: number; running: boolean; startedAt: string }> {
  const base = path.join(workspace, ".cache/blender-live");
  if (!existsSync(base)) return [];
  const found = [];
  for (const key of readdirSync(base))
    for (const session of existsSync(path.join(base, key)) && statSync(path.join(base, key)).isDirectory()
      ? readdirSync(path.join(base, key))
      : []) {
      const file = path.join(base, key, session, "session.json");
      if (!existsSync(file)) continue;
      try {
        const record = JSON.parse(readFileSync(file, "utf8")) as SessionRecord;
        found.push({
          key,
          session,
          pid: record.pid,
          port: record.port,
          running: isLiveProcess(record.pid),
          startedAt: record.startedAt,
        });
      } catch {
        /* an unreadable record is not a session */
      }
    }
  return found;
}

export type StartOptions = {
  workspace: string;
  paths: LivePaths;
  blend?: string;
  executable?: string;
  extensions?: string;
  idleMinutes: number;
  ui: boolean;
  waitMs?: number;
};

export function blendBase(workspace: string, blend?: string): Base & { absolutePath?: string } {
  if (!blend) return { kind: "empty" };
  const absolute = path.resolve(workspace, blend);
  assertPathWithin(workspace, absolute);
  if (!absolute.endsWith(".blend") || !existsSync(absolute) || !statSync(absolute).isFile())
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `--blend must be an existing .blend inside the workspace: ${blend}`,
    });
  return {
    kind: "blend",
    path: path.relative(workspace, absolute),
    sha256: hashFile(absolute),
    absolutePath: absolute,
  };
}

/** Background Blender with no user add-ons, no auto-run scripts and Online Access off. */
export function liveArguments(ui: boolean, blend?: string): string[] {
  return [
    ...(ui ? [] : ["--background"]),
    "--factory-startup",
    "--disable-autoexec",
    "--offline-mode",
    ...(blend ? [blend] : []),
    "--python",
    LIVE_SERVER,
  ];
}

export async function startSession(options: StartOptions): Promise<{ record: SessionRecord; reused: boolean }> {
  const { paths, workspace } = options;
  const extensions = approvedExtensions(workspace, options.extensions);
  const existing = readSession(paths);
  if (existing && isLiveProcess(existing.pid)) {
    try {
      await liveRequest(existing.port, existing.token, "ping", {}, 5000);
      if (options.extensions !== undefined && JSON.stringify(existing.extensions) !== JSON.stringify(extensions))
        throw invalid("The running session has different extensions; stop it and start again.");
      return { record: existing, reused: true };
    } catch (error) {
      if (error instanceof CliErrorObject && error.code === "INVALID_INPUT")
        throw error; /* a stale record is replaced below */
    }
  }
  if (!Number.isFinite(options.idleMinutes) || options.idleMinutes < 1 || options.idleMinutes > 24 * 60)
    throw invalid("--idle-minutes must be from 1 to 1440.");
  const profile =
    options.extensions !== undefined
      ? arsenalPaths(workspace).blenderUser
      : path.join(arsenalPaths(workspace).local, "trials", `live-${paths.key}-${paths.session}`, "blender-user");
  const environment = extensionEnvironment(workspace, profile);
  const probe = resolveBlender(options.executable, environment);
  const base = blendBase(workspace, options.blend);
  rmSync(paths.readyFile, { force: true });
  mkdirSync(paths.outDir, { recursive: true });
  const token = newToken();
  const config = {
    sessionId: paths.session,
    sessionDir: paths.sessionDir,
    outDir: paths.outDir,
    assetsDir: paths.assetsDir ?? null,
    kitDir: KIT_DIR,
    workspaceRoot: workspace,
    project: paths.project,
    extensionsProfile: options.extensions !== undefined,
    extensions,
    idleSec: Math.round(options.idleMinutes * 60),
    base,
  };
  writeSecret(paths.configFile, JSON.stringify(config));
  const log = openSync(paths.logFile, "w", 0o600);
  const env = {
    ...environment,
    AGENTBROS_REPO_ROOT: workspace,
    ...(paths.project ? { AGENTBROS_PROJECT_ID: paths.project } : {}),
    AGENTBROS_LIVE_CONFIG: paths.configFile,
    AGENTBROS_LIVE_TOKEN: token,
  };
  const child = spawn(probe.path!, liveArguments(options.ui), {
    cwd: workspace,
    detached: true,
    shell: false,
    stdio: ["ignore", log, log],
    env,
  });
  closeSync(log);
  let exited: number | null = null;
  child.once("exit", (code) => {
    exited = code ?? -1;
  });
  child.unref();
  const deadline = Date.now() + (options.waitMs ?? 120000);
  while (!existsSync(paths.readyFile)) {
    if (exited !== null)
      throw new CliErrorObject({
        code: "INTERNAL",
        message: `Blender exited (code ${exited}) before the live session was ready. Log: ${paths.logFile}\n${tail(paths.logFile)}`,
      });
    if (Date.now() > deadline) {
      if (child.pid)
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      throw new CliErrorObject({
        code: "TIMEOUT",
        message: `The live session was not ready within ${Math.round((options.waitMs ?? 120000) / 1000)}s. Log: ${paths.logFile}`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const ready = JSON.parse(readFileSync(paths.readyFile, "utf8")) as {
    port: number;
    pid: number;
    blenderVersion: string;
    protocol: number;
  };
  if (ready.protocol !== PROTOCOL || ready.pid !== child.pid)
    throw new CliErrorObject({ code: "INTERNAL", message: `Unexpected ready file ${paths.readyFile}.` });
  const record: SessionRecord = {
    protocol: PROTOCOL,
    session: paths.session,
    project: paths.project ?? null,
    pid: ready.pid,
    port: ready.port,
    token,
    outDir: paths.outDir,
    assetsDir: paths.assetsDir ?? null,
    logFile: paths.logFile,
    startedAt: new Date().toISOString(),
    blenderVersion: ready.blenderVersion,
    executable: probe.path!,
    base: base.kind === "blend" ? { kind: "blend", path: base.path, sha256: base.sha256 } : base,
    ui: options.ui,
    ...(options.extensions !== undefined ? { extensions } : {}),
  };
  writeSecret(paths.sessionFile, JSON.stringify(record, null, 2));
  await liveRequest(record.port, token, "ping", {}, 10000);
  return { record, reused: false };
}

export async function stopSession(paths: LivePaths): Promise<{ stopped: boolean; pid?: number; forced: boolean }> {
  const record = readSession(paths);
  if (!record) return { stopped: false, forced: false };
  let forced = false;
  try {
    await liveRequest(record.port, record.token, "shutdown", {}, 10000);
  } catch {
    /* the process check below decides */
  }
  const deadline = Date.now() + 10000;
  while (isLiveProcess(record.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (isLiveProcess(record.pid)) {
    forced = true;
    try {
      process.kill(record.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  rmSync(paths.sessionFile, { force: true });
  rmSync(paths.configFile, { force: true });
  rmSync(paths.readyFile, { force: true });
  return { stopped: true, pid: record.pid, forced };
}

function tail(file: string): string {
  try {
    return readFileSync(file, "utf8").slice(-1500);
  } catch {
    return "";
  }
}

/** Where `save` and `export` write: the project's assets/blender, else the session's output folder. */
export function artefactPath(
  paths: LivePaths,
  name: string,
  extension: ".blend" | ".live.json" | ".py",
  overwrite: boolean,
): string {
  checkName(name, "name");
  const root = paths.assetsDir ?? paths.outDir;
  const target = path.join(root, `${name}${extension}`);
  assertPathWithin(root, target);
  if (existsSync(target) && !overwrite)
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: `${target} exists. Pick another name, or pass overwrite after the user agrees.`,
    });
  return target;
}

export type ReplaySettings = {
  frame: number;
  width?: number;
  height?: number;
  samples?: number | null;
  engine?: "cycles" | "eevee";
};

/** A readable shot using the same pin checks and helper calls as the live journal. */
export function replayShotScript(recipe: unknown): string {
  return `"""Exported Blender live look. Render with pnpm blender:run; local arsenal pins are required."""\nimport json\nimport os\nimport avc_assets\nimport avc_recipes\nimport avc_live_ops as ops\nimport avc_live_arsenal as arsenal\n\nrecipe = json.loads(${JSON.stringify(JSON.stringify(recipe))})\nworkspace = os.getcwd()\nos.environ["AGENTBROS_REPO_ROOT"] = workspace\ncontext = {"workspaceRoot": workspace, "kitDir": os.path.join(workspace, "scripts", "blender"), "extensionsProfile": os.path.realpath(os.environ.get("BLENDER_USER_RESOURCES", "")) == os.path.join(workspace, "blender-arsenal", "local", "blender-user")}\nops.validate_recipe(recipe, context)\n# Register extension RNA before opening the base, then replay typed edits.\nops.apply_recipe({**recipe, "ops": [step for step in recipe["ops"] if step["op"] == "enable-extension"]}, context)\nfor step in recipe["ops"]:\n    op, params = step["op"], step["params"]\n    if op in ops.ARSENAL_OPS:\n        arsenal.verify_step(step, context)\n    if op == "append-asset":\n        arsenal.append_asset(params, context, append=avc_assets.append)\n    elif op == "apply-recipe":\n        avc_recipes.apply(params["id"], params["params"])\n    else:\n        ops.apply_step(step, context)\n`;
}

/** The blender:run command that renders a recipe with a still's settings; `--device cpu` matches the session's CPU stills pixel for pixel. */
export function replayCommand(workspace: string, recipe: string, output: string, settings: ReplaySettings): string[] {
  const { frame, width, height, samples, engine } = settings;
  return [
    "pnpm",
    "blender:run",
    "--script",
    REPLAY_SCRIPT,
    "--script-args",
    JSON.stringify([path.relative(workspace, recipe)]),
    "--output",
    path.relative(workspace, output),
    "--frames",
    `${frame}-${frame}`,
    "--device",
    "cpu",
    ...(engine ? ["--engine", engine] : []),
    ...(width && height ? ["--resolution", `${width}x${height}`] : []),
    ...(samples ? ["--samples", String(samples)] : []),
  ];
}

/** Quotes argv for a POSIX shell, for people who paste the command. */
export function shellLine(argv: string[]): string {
  return argv.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** A contact sheet of a preview strip, tiles 320 px wide, labelled with their frame. */
export function stripSheet(
  frames: Array<{ frame: number; path: string }>,
  size: [number, number],
  output: string,
): string {
  const width = 320,
    height = 2 * Math.max(1, Math.round((width * size[1]) / size[0] / 2));
  const cells = frames.map((item) => {
    const result = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-i",
        item.path,
        "-vf",
        `scale=${width}:${height}`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: width * height * 3 + 1024 },
    );
    if (result.error || result.status !== 0 || result.stdout.length !== width * height * 3)
      throw new CliErrorObject({
        code: "FFMPEG_FAILED",
        message: `Could not read ${item.path}: ${result.error?.message ?? result.stderr?.toString().slice(-300)}`,
      });
    return { image: new RgbImage(width, height, result.stdout), label: `f${item.frame}` };
  });
  return writeImage(
    composeGrid(cells, { title: `blender:live strip, ${frames.length} frames`, columns: Math.min(6, cells.length) }),
    output,
  );
}
