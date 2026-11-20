/**
 * Read-only views of a project's console state for the hook roles: the step lease, the control file (pause, stop),
 * agent cards, decided console decisions and the running console server. Shapes follow src/types/console.ts
 * (ControlFileSchema, CardSchema, InboxDecisionFileSchema, ServerLockSchema); a file that does not fit is skipped.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isObject, projectDirOf, readJson, str } from "./runtime.mjs";

export const LEASE_FILE = "pipeline/session/lease.json";
export const CONTROL_FILE = "pipeline/session/control.json";
export const INBOX_DIR = "pipeline/inbox";
export const CARDS_DIR = "pipeline/cards";
export const SERVER_LOCK_FILE = "out/console/server.json";
const CONTROL_STATES = ["running", "paused", "stopped"];
const DECIDED = ["applied", "refused", "superseded"];
const FRAME_NOTES = "/pipeline/frame-notes/";

/**
 * A frame note's files (2026-11-20): the still with the user's marks and its JSON, from the decision's command or a
 * follow-up (`result.metadata.followUps[].outputs`), as `console:wait` gives them; the relay names the still.
 */
export function frameNoteFiles(result) {
  if (!isObject(result)) return {};
  const followUps = Array.isArray(result.metadata?.followUps) ? result.metadata.followUps : [];
  const files = [result.outputs, ...followUps.map((item) => (isObject(item) ? item.outputs : undefined))]
    .flatMap((outputs) => (Array.isArray(outputs) ? outputs : []))
    .filter((file) => typeof file === "string" && file.includes(FRAME_NOTES));
  const note = files.find((file) => file.endsWith(".json"));
  const still = files.find((file) => file.endsWith(".png"));
  return { ...(note ? { note } : {}), ...(still ? { still } : {}) };
}

/** `{ lease, hash }`, `{ invalid, hash }` for an unreadable or malformed lease, or undefined without one. */
export function readLease(projectDir) {
  let bytes;
  try {
    bytes = readFileSync(path.join(projectDir, LEASE_FILE));
  } catch (error) {
    return error?.code === "ENOENT" ? undefined : { invalid: String(error?.code ?? error), hash: "" };
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  try {
    const lease = JSON.parse(bytes.toString("utf8"));
    const ok =
      isObject(lease) &&
      lease.schemaVersion === 1 &&
      ["film", "footage"].includes(lease.route) &&
      str(lease.step) &&
      str(lease.owner) &&
      Array.isArray(lease.allow) &&
      Array.isArray(lease.spending) &&
      typeof lease.paidAllowed === "boolean" &&
      typeof lease.chainHash === "string" &&
      str(lease.expiresAt);
    return ok ? { lease, hash } : { invalid: "does not match StepLeaseSchema", hash };
  } catch (error) {
    return { invalid: String(error?.message ?? error), hash };
  }
}

const change = (value) =>
  isObject(value) && CONTROL_STATES.includes(value.state) && str(value.at) && Number.isFinite(Date.parse(value.at))
    ? {
        state: value.state,
        at: value.at,
        ...(str(value.answer) ? { answer: value.answer } : {}),
        ...(str(value.reason) ? { reason: value.reason } : {}),
        ...(str(value.channel) ? { channel: value.channel } : {}),
      }
    : undefined;

/** The control file: current state and history, or undefined (missing or malformed: treated as running). */
export function readControl(projectDir) {
  const value = readJson(path.join(projectDir, CONTROL_FILE));
  if (!isObject(value) || value.v !== 1) return undefined;
  const current = change(value);
  if (!current) return undefined;
  const history = Array.isArray(value.history) ? value.history.map(change).filter(Boolean) : [];
  return { ...current, history };
}

/** JSON files of a directory changed after `sinceMs` (by modification time), parsed; no directory is no files. */
function recentJson(dir, sinceMs) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (Number.isFinite(sinceMs) && statSync(file).mtimeMs < sinceMs - 2000) continue;
    } catch {
      continue;
    }
    const value = readJson(file);
    if (isObject(value) && value.v === 1) out.push(value);
  }
  return out;
}

const time = (value) => {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : Number.NaN;
};

/** Decided console decisions (`pipeline/inbox/<id>.json`) with decidedAt after `sinceMs`, oldest first. */
export function decisionsSince(projectDir, sinceMs) {
  return recentJson(path.join(projectDir, INBOX_DIR), sinceMs)
    .filter(
      (item) =>
        str(item.id) && DECIDED.includes(item.status) && str(item.answer) && time(item.decidedAt) > (sinceMs || 0),
    )
    .map((item) => ({
      type: "decision",
      at: time(item.decidedAt),
      id: item.id,
      kind: str(item.kind) ?? "decision",
      step: str(item.step),
      title: str(item.title),
      status: item.status,
      answer: item.answer,
      choice: str(item.choice),
      ...frameNoteFiles(item.result),
    }))
    .sort((a, b) => a.at - b.at);
}

/** Answered agent cards (`pipeline/cards/<id>.json`) whose answer is after `sinceMs`, oldest first. */
export function cardAnswersSince(projectDir, sinceMs) {
  return recentJson(path.join(projectDir, CARDS_DIR), sinceMs)
    .filter((card) => str(card.id) && isObject(card.answer) && time(card.answer.at) > (sinceMs || 0))
    .map((card) => ({
      type: "card",
      at: time(card.answer.at),
      id: card.id,
      title: str(card.title),
      choice: str(card.answer.choice),
      choiceLabel: Array.isArray(card.options)
        ? str(card.options.find((option) => option?.id === card.answer.choice)?.label)
        : undefined,
      text: str(card.answer.text),
      ratings: isObject(card.answer.ratings) ? Object.keys(card.answer.ratings).length : 0,
    }))
    .sort((a, b) => a.at - b.at);
}

/** Control changes after `sinceMs`, oldest first. */
export function controlChangesSince(projectDir, sinceMs) {
  const control = readControl(projectDir);
  if (!control) return [];
  const changes = control.history.length ? control.history : [control];
  return changes
    .filter((entry) => time(entry.at) > (sinceMs || 0))
    .map((entry) => ({ type: "control", ...entry, at: time(entry.at) }))
    .sort((a, b) => a.at - b.at);
}

/** Every console item after `sinceMs`: decisions, card answers and control changes, oldest first. */
export const consoleItemsSince = (projectDir, sinceMs) =>
  [
    ...decisionsSince(projectDir, sinceMs),
    ...cardAnswersSince(projectDir, sinceMs),
    ...controlChangesSince(projectDir, sinceMs),
  ].sort((a, b) => a.at - b.at);

/** Cards that wait for the user's answer (expectsAnswer, no answer, not expired). */
export function waitingCards(projectDir, now = new Date()) {
  return recentJson(path.join(projectDir, CARDS_DIR), Number.NaN).filter(
    (card) =>
      card.expectsAnswer === true &&
      !card.answer &&
      !(Number.isFinite(time(card.expiresAt)) && time(card.expiresAt) <= now.getTime()),
  );
}

/** Aliases that apply the user's answer at a gate: a lease naming one means the step waits for the user. */
export const GATE_ALIASES = ["film:approve", "campaign:approve"];

/** What waits for the user in a project: cards, a gate of the leased step, a pause. */
export function waitingFor(root, project, now = new Date()) {
  const dir = projectDirOf(root, project);
  const loaded = readLease(dir);
  const lease = loaded && "lease" in loaded ? loaded.lease : undefined;
  const control = readControl(dir);
  return {
    cards: waitingCards(dir, now).length,
    gate: Boolean(lease && lease.allow.some((alias) => GATE_ALIASES.includes(alias))),
    paused: control && control.state !== "running" ? control.state : undefined,
  };
}

/** The running console's URL from `out/console/server.json`, when its process is alive. */
export function consoleUrl(root) {
  const lock = readJson(path.join(root, SERVER_LOCK_FILE));
  if (!isObject(lock) || lock.v !== 1 || !Number.isInteger(lock.pid) || !Number.isInteger(lock.port)) return undefined;
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return undefined;
  }
  const url = str(lock.url);
  return url && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?/.test(url) ? url : `http://127.0.0.1:${lock.port}/`;
}
