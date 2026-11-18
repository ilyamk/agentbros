/**
 * Pause, resume and stop (RFC 0004 D12, §6.5): `pipeline/session/control.json`, its lenient reader (the one the pause
 * check uses, a port of the guard hook's `readControl` in scripts/hooks/lib/state.mjs so hook and runScript agree),
 * the `PAUSED` message (byte for byte the hook's `pauseRefusal`), the strict atomic writer behind `console:control`,
 * and the soft-pause exception: a command naming an already-submitted paid job by `--operation-id` may complete it.
 * Light on purpose: runScript loads it only when a project has a control file.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  CONTROL_FILE,
  ControlFileSchema,
  ControlChangeSchema,
  type ControlFile,
  type ControlState,
} from "../../types/console";
import { ALWAYS_ADMITTED } from "../step-lease/lease";

const STATES: readonly string[] = ["running", "paused", "stopped"];
const HISTORY_MAX = 10_000;

/** The control file as the pause check reads it: lenient, like the hook (an odd extra field still pauses). */
export type ControlReading = {
  state: ControlState;
  at: string;
  answer?: string;
  reason?: string;
  channel?: string;
};

export const controlFileOf = (projectDir: string) => path.join(projectDir, CONTROL_FILE);

const str = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function change(value: unknown): ControlReading | undefined {
  if (!isObject(value) || !STATES.includes(value.state as string) || !str(value.at)) return undefined;
  if (!Number.isFinite(Date.parse(value.at))) return undefined;
  return {
    state: value.state as ControlState,
    at: value.at,
    ...(str(value.answer) ? { answer: value.answer } : {}),
    ...(str(value.reason) ? { reason: value.reason } : {}),
    ...(str(value.channel) ? { channel: value.channel } : {}),
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Port of the hook's readControl: current state, or undefined (missing or malformed: the project runs). */
export function readControlLenient(projectDir: string): ControlReading | undefined {
  const value = readJson(controlFileOf(projectDir));
  if (!isObject(value) || value.v !== 1) return undefined;
  return change(value);
}

/** The control file when it matches {@link ControlFileSchema}, else undefined. */
export function readControlFile(projectDir: string): ControlFile | undefined {
  const parsed = ControlFileSchema.safeParse(readJson(controlFileOf(projectDir)));
  return parsed.success ? parsed.data : undefined;
}

/** Port of the hook's clamp. */
const clamp = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`);

/** The refusal's words, identical to the guard hook's `pauseRefusal` (tests/console-control.test.ts). */
export function pauseMessage(project: string, control: ControlReading, alias: string): string {
  const why = control.answer ?? control.reason;
  return [
    `PAUSED: project ${project} is ${control.state} by the user since ${control.at}${why ? ` ("${clamp(why.replace(/\s+/g, " "), 200)}")` : ""}.`,
    `\`pnpm ${alias}\` is not a control command, so it does not run until the user resumes the project in the console.`,
    `Control commands still run (${ALWAYS_ADMITTED.join(", ")}, feedback, memory, ...). Do not retry; tell the user.`,
    ONLY_THE_USER_RESUMES,
  ].join(" ");
}

export const ONLY_THE_USER_RESUMES = "Only the user resumes; never run console:control yourself.";

/** The job store's refusal at the submit point: no new paid job while paused or stopped (D12). */
export function submitPauseMessage(project: string, control: ControlReading): string {
  return [
    `PAUSED: project ${project} is ${control.state} by the user since ${control.at}; no new paid job is reserved or submitted until the user resumes it.`,
    `Jobs already submitted still complete. Do not retry; tell the user.`,
    ONLY_THE_USER_RESUMES,
  ].join(" ");
}

/** A paused or stopped control state (lenient read), else undefined: a missing or unreadable file means running. */
export function pausedControl(projectDir: string): ControlReading | undefined {
  try {
    const control = readControlLenient(projectDir);
    return control && control.state !== "running" ? control : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every value a flag takes on this command line, in every form parseArgs accepts: `--name X`, `--name=X`, and the
 * short forms given (`-p X`, `-p=X`). Repeated flags give several values; the pause judges them all, so neither a
 * decoy first value nor a short form can hide the project the script will use (parseArgs keeps the last).
 */
export function flagValues(args: readonly string[], name: string, shorts: readonly string[] = []): string[] {
  const forms = [`--${name}`, ...shorts.map((short) => `-${short}`)];
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const equal = token.indexOf("=");
    const flag = equal < 0 ? token : token.slice(0, equal);
    if (!forms.includes(flag)) continue;
    const value = equal < 0 ? args[i + 1] : token.slice(equal + 1);
    if (value !== undefined) values.push(value);
    if (equal < 0) i++;
  }
  return values;
}

/** Every project a command line names (`--project`, `-p`, any form, every occurrence). */
export const projectsFromArgv = (args: readonly string[]) => flagValues(args, "project", ["p"]);

/** Any id projectDir() resolves (pipeline/paths.ts): letters, digits, hyphens, underscores. */
const RESOLVABLE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * The ids whose control files the pause judges for these --project values: each resolvable id as the script will
 * resolve it (projectDir keeps its case, and a case-insensitive disk maps `MyFilm` onto `myfilm`) and lowercased, so
 * neither case nor a case-sensitive disk lets a differently written id slip past a paused project. Port in the hook.
 */
export function pauseCandidates(ids: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of ids)
    if (RESOLVABLE_ID.test(id) && id.length <= 128) {
      out.add(id);
      out.add(id.toLowerCase());
    }
  return [...out];
}

/** The single `--operation-id` of a command line, or undefined when there is none or more than one. */
export function operationIdFromArgv(args: readonly string[]): string | undefined {
  const values = flagValues(args, "operation-id");
  return values.length === 1 ? values[0] : undefined;
}

/**
 * Scripts that use `--operation-id` verbatim as the one job they run, so naming a submitted job can only complete it.
 * Others derive ids from it (generate-voiceover, align-captions: `<id>:<unit>`) and stay refused while paused. Kept
 * equal to COMPLETION_SCRIPTS in scripts/hooks/lib/guard.mjs (tests/console-control.test.ts).
 */
export const COMPLETION_SCRIPTS = [
  "scripts/generate-model.ts",
  "scripts/generate-image.ts",
  "scripts/generate-video.ts",
  "scripts/generate-music.ts",
  "scripts/generate-lipsync.ts",
  "scripts/rmbg.ts",
  "scripts/upscale.ts",
] as const;

/** Job states after a submit that only poll, download or publish: resuming them never submits again. */
const COMPLETING = ["queued", "running", "unknown", "result-ready", "downloading", "validated"];

/**
 * Soft pause (D12): the job exists in this project's operation store, reached the provider (it has a request ID) and
 * is still completing, so a run naming it polls, downloads and publishes what is already paid for, and submits
 * nothing. `reserved`, `submitting` and an `unknown` job without a request ID could still submit: not admitted.
 */
export function completesSubmittedJob(projectDir: string, operationId: string | undefined): boolean {
  if (!operationId) return false;
  const database = readJson(path.join(projectDir, "pipeline", "operations.json"));
  const jobs = isObject(database) && isObject(database.jobs) ? database.jobs : undefined;
  const job = jobs && Object.hasOwn(jobs, operationId) ? jobs[operationId] : undefined;
  if (!isObject(job) || !str(job.providerRequestId)) return false;
  return COMPLETING.includes(job.state as string) || (job.state === "failed" && isObject(job.result));
}

/** Writes a file by temp file and rename in the same directory, flushed first. */
export function writeFileAtomic(file: string, text: string, mode = 0o644): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", mode);
  try {
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export type ControlChangeInput = {
  state: ControlState;
  /** The user's words, verbatim. */
  answer: string;
  reason?: string;
  channel: "console" | "cli";
  at?: string;
};

/**
 * Appends a change and writes the file atomically. The previous history is kept when the file is valid; a malformed
 * file keeps its readable entries (a pause is never blocked by an old corrupt file). Returns the file and the state
 * it replaces (`running` when there was none).
 */
export function writeControl(
  projectDir: string,
  input: ControlChangeInput,
  /** Runs while the lock is still held, after the rename (the journal line, so lines follow the file's order). */
  afterWrite?: (result: { control: ControlFile; previous: ControlState }) => void,
): { control: ControlFile; previous: ControlState } {
  const unlock = lockControl(controlFileOf(projectDir));
  try {
    const before = readControlFile(projectDir);
    const lenient = before ? undefined : readJson(controlFileOf(projectDir));
    const history = before
      ? before.history
      : isObject(lenient) && Array.isArray(lenient.history)
        ? lenient.history.flatMap((entry) => {
            const parsed = ControlChangeSchema.safeParse(entry);
            return parsed.success ? [parsed.data] : [];
          })
        : [];
    const previous = before?.state ?? readControlLenient(projectDir)?.state ?? "running";
    const entry = ControlChangeSchema.parse({
      state: input.state,
      by: "user",
      channel: input.channel,
      at: input.at ?? new Date().toISOString(),
      answer: input.answer,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    const control = ControlFileSchema.parse({ v: 1, ...entry, history: [...history, entry].slice(-HISTORY_MAX) });
    writeFileAtomic(controlFileOf(projectDir), `${JSON.stringify(control, null, 2)}\n`);
    const result = { control, previous };
    afterWrite?.(result);
    return result;
  } finally {
    unlock();
  }
}

const LOCK_WAIT_MS = 5000;

/** Whether a process id is alive (a lock held by a dead process is stale). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `<control.json>.lock`, created exclusively with this pid: two writers never interleave read-append-rename. A lock
 * whose owner is gone is taken over; a live one is waited for up to 5 s, then the write fails (nothing is lost).
 */
export function lockControl(file: string, waitMs: number = LOCK_WAIT_MS): () => void {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return () => rmSync(lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number.parseInt(String(readFileSafe(lock)), 10);
      const fresh = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0) < 1000;
      const ownerless = !Number.isSafeInteger(owner) || owner <= 0;
      if ((ownerless && !fresh) || (!ownerless && !alive(owner))) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`The control file is locked by process ${owner}; try again.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function readFileSafe(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
