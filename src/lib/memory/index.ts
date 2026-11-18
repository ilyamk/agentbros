/** A user's local memory: one Markdown file per entry under memory/<dir>/, a generated index, append-only metrics. Rules: memory/AGENTS.md. */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
  MEMORY_DIRS,
  MEMORY_TYPES,
  MemoryEntrySchema,
  MemoryMetricSchema,
  USER_CONFIRMED_TYPES,
  type MemoryEntry,
  type MemoryMetric,
  type MemoryProposal,
  type MemoryRef,
  type MemoryType,
} from "../../types/memory";
import { CliErrorObject } from "../cli";
import { parseFrontMatter, serialiseFrontMatter } from "./frontmatter";

export { parseFrontMatter, serialiseFrontMatter } from "./frontmatter";

export const INDEX_FILE = "index.json";
export const LOCK_FILE = ".lock";
/** A lock older than this is a crashed writer's and is broken; a writer waits at most LOCK_WAIT_MS for a live one. */
export const LOCK_STALE_MS = 30_000;
export const LOCK_WAIT_MS = 15_000;
export const METRICS_FILE = "metrics.jsonl";
/** Token-set Jaccard similarity at or above which two active summaries of one type count as the same entry. */
export const NEAR_DUPLICATE = 0.8;
export const STALE_DAYS = 180;
export const QUERY_LIMIT = 7;
export const QUERY_MAX_CHARS = 1200;
/** Query rank by type, first to last; the user's own types (decision, preference, lesson) always rank above the rest. */
export const TYPE_PRIORITY: readonly MemoryType[] = ["decision", "preference", "lesson", "gap", "observation", "episode", "proposal"];
/** House rule: an applied proposal whose causes are not seen again for this many days is a candidate for verified. */
export const VERIFY_DAYS = 30;
/** Types a proposal may answer. */
export const PROPOSAL_CAUSE_TYPES: readonly MemoryType[] = ["observation", "gap", "lesson"];

export type ProposalState = MemoryProposal["state"];
/** The legal next states of a proposal; rejected and retired close it. */
export const PROPOSAL_NEXT: Record<ProposalState, readonly ProposalState[]> = {
  proposed: ["approved", "rejected"],
  approved: ["applied", "rejected"],
  applied: ["verified", "ineffective", "retired"],
  verified: ["retired"],
  ineffective: ["retired"],
  rejected: [],
  retired: [],
};
/** Proposals whose causes count as answered: consolidate does not suggest them again. */
const OPEN_OR_HELD: ReadonlySet<ProposalState> = new Set(["proposed", "approved", "applied", "verified"]);

export type StoredEntry = MemoryEntry & { file: string; body: string };
/** An entry as index.json holds it: no body, a relative file. Queries accept these to rank without reading every file. */
export type PreloadedEntry = MemoryEntry & { body?: string; file?: string };
export type MemoryInput = Omit<z.input<typeof MemoryEntrySchema>, "version" | "status" | "occurrences" | "createdAt" | "id"> & {
  id?: string;
  body?: string;
  createdAt?: string;
};
export type MemoryQuery = {
  playbook?: string;
  step?: string;
  platform?: string;
  types?: MemoryType[];
  text?: string;
  project?: string;
  includeInactive?: boolean;
  limit?: number;
  maxChars?: number;
};

/** AGENTBROS_MEMORY_ROOT, else <root or cwd>/memory. */
export function memoryDir(root?: string): string {
  const fromEnv = process.env.AGENTBROS_MEMORY_ROOT;
  return path.resolve(fromEnv ? fromEnv : path.join(root ?? process.cwd(), "memory"));
}

/** The local calendar date, yyyy-mm-dd: a note added in the user's morning carries their day, not UTC's. */
const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const today = () => localDate(new Date());
const ref = (entry: MemoryEntry): MemoryRef => ({ id: entry.id, type: entry.type, summary: entry.summary });
const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

function similarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (!left.size && !right.size) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");
}

function writeAtomic(file: string, text: string, check?: (written: string) => void): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, text);
  try {
    check?.(readFileSync(temporary, "utf8"));
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  renameSync(temporary, file);
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** This checkout's own memory/, which tests may never write. */
const CHECKOUT_MEMORY = path.resolve(import.meta.dirname, "..", "..", "..", "memory");

/**
 * Runs `fn` holding memory/.lock (O_EXCL); breaks a lock older than LOCK_STALE_MS; TIMEOUT after LOCK_WAIT_MS. Under a test
 * runner (NODE_TEST_CONTEXT) every write refuses the checkout's memory/ unless AGENTBROS_MEMORY_ROOT names it explicitly.
 */
function withLock<T>(root: string | undefined, fn: () => T): T {
  if (process.env.NODE_TEST_CONTEXT && !process.env.AGENTBROS_MEMORY_ROOT && memoryDir(root) === CHECKOUT_MEMORY) {
    throw new CliErrorObject({ code: "VALIDATION", message: "A test may not write this checkout's memory/: set AGENTBROS_MEMORY_ROOT or pass a temporary root." });
  }
  const dir = memoryDir(root);
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        // released or broken by another writer meanwhile
      }
      if (Date.now() > deadline) throw new CliErrorObject({ code: "TIMEOUT", message: `memory/${LOCK_FILE} is held by another writer; retry, or remove it if no writer is running.` });
      sleep(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

function entryFile(entry: Pick<MemoryEntry, "id" | "type">, root?: string): string {
  return path.join(memoryDir(root), MEMORY_DIRS[entry.type], `${entry.id}.md`);
}

function frontMatterOf(entry: MemoryEntry): Record<string, unknown> {
  const { version, id, type, summary, scope, source, status, supersedes, occurrences, sightings, createdAt, reviewedAt, proposal } = entry;
  return { version, id, type, summary, scope, source, status, supersedes, occurrences, sightings, createdAt, reviewedAt, proposal };
}

/** Writes an entry only after its serialised text parses back to the same entry. */
function save(entry: MemoryEntry, body: string, root?: string): void {
  const valid = MemoryEntrySchema.parse(entry);
  writeAtomic(entryFile(valid, root), serialiseFrontMatter(frontMatterOf(valid), body), (written) => {
    const back = MemoryEntrySchema.safeParse(parseFrontMatter(written).data);
    if (!back.success || JSON.stringify(frontMatterOf(back.data)) !== JSON.stringify(frontMatterOf(valid))) {
      throw new CliErrorObject({ code: "VALIDATION", message: `${valid.id} would not read back as written; nothing was saved.` });
    }
  });
}

/** Each entry file's name, mtime and size, keyed by its path under memory/: what index.json was built from. */
function fingerprint(dir: string): Record<string, { mtimeMs: number; size: number }> {
  const files: Record<string, { mtimeMs: number; size: number }> = {};
  for (const type of MEMORY_TYPES) {
    const folder = path.join(dir, MEMORY_DIRS[type]);
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names.filter((file) => file.endsWith(".md")).sort()) {
      try {
        const { mtimeMs, size } = statSync(path.join(folder, name));
        files[`${MEMORY_DIRS[type]}/${name}`] = { mtimeMs, size };
      } catch {
        // removed meanwhile: the index will not match it
      }
    }
  }
  return files;
}

/** Every valid entry; an unreadable, invalid or misplaced file becomes a warning, never an exception. */
export function loadMemory(root?: string): { entries: StoredEntry[]; warnings: string[] } {
  const dir = memoryDir(root);
  const entries: StoredEntry[] = [];
  const warnings: string[] = [];
  for (const type of MEMORY_TYPES) {
    const folder = path.join(dir, MEMORY_DIRS[type]);
    if (!existsSync(folder)) continue;
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch (error) {
      warnings.push(`${MEMORY_DIRS[type]}: ${(error as NodeJS.ErrnoException).code === "ENOTDIR" ? "not a folder" : error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const name of names.filter((file) => file.endsWith(".md")).sort()) {
      const relative = `${MEMORY_DIRS[type]}/${name}`;
      try {
        const { data, body } = parseFrontMatter(readFileSync(path.join(folder, name), "utf8"));
        const parsed = MemoryEntrySchema.safeParse(data);
        if (!parsed.success) {
          warnings.push(`${relative}: ${issues(parsed.error)}`);
          continue;
        }
        if (parsed.data.type !== type) warnings.push(`${relative}: a ${parsed.data.type} belongs in ${MEMORY_DIRS[parsed.data.type]}/`);
        else if (name !== `${parsed.data.id}.md`) warnings.push(`${relative}: the file name must be ${parsed.data.id}.md`);
        else entries.push({ ...parsed.data, file: path.join(folder, name), body });
      } catch (error) {
        warnings.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { entries, warnings };
}

function find(id: string, root?: string): StoredEntry {
  const entry = loadMemory(root).entries.find((item) => item.id === id);
  if (!entry) throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `No memory entry ${id}.` });
  return entry;
}

/** The full entry with its body. */
export function getMemory(id: string, root?: string): StoredEntry {
  return find(id, root);
}

function writeIndexLocked(root?: string): void {
  const dir = memoryDir(root);
  const files = fingerprint(dir);
  const { entries, warnings } = loadMemory(root);
  const index = {
    generated: "by pnpm memory; never edit by hand",
    files,
    entries: entries.map(({ file, body: _body, ...entry }) => ({ ...entry, file: path.relative(dir, file).split(path.sep).join("/") })),
    warnings,
  };
  writeAtomic(path.join(dir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);
}

/** Regenerates memory/index.json from the entry files, with each file's fingerprint. */
export function writeIndex(root?: string): void {
  withLock(root, () => writeIndexLocked(root));
}

/** index.json's rows when every entry file still matches its fingerprint (same names, mtimes and sizes); else undefined. Reads only. */
export function readFreshIndex(root?: string): { entries: PreloadedEntry[]; warnings: string[] } | undefined {
  const dir = memoryDir(root);
  try {
    const index = JSON.parse(readFileSync(path.join(dir, INDEX_FILE), "utf8")) as { files?: unknown; entries?: unknown; warnings?: unknown };
    if (!index.files || typeof index.files !== "object" || !Array.isArray(index.entries) || !Array.isArray(index.warnings)) return undefined;
    const recorded = index.files as Record<string, { mtimeMs?: unknown; size?: unknown }>;
    const current = fingerprint(dir);
    const names = Object.keys(current);
    if (names.length !== Object.keys(recorded).length) return undefined;
    for (const name of names) {
      const was = recorded[name];
      if (!was || was.mtimeMs !== current[name]!.mtimeMs || was.size !== current[name]!.size) return undefined;
    }
    return { entries: index.entries as PreloadedEntry[], warnings: index.warnings as string[] };
  } catch {
    return undefined;
  }
}

/** Near-duplicates must also share scope: the same project (or none on both), and overlapping playbooks when both name some. */
function sameScope(a: MemoryEntry, b: MemoryEntry): boolean {
  if ((a.scope.project ?? null) !== (b.scope.project ?? null)) return false;
  if (a.scope.playbooks.length && b.scope.playbooks.length && !a.scope.playbooks.some((id) => b.scope.playbooks.includes(id))) return false;
  return true;
}

/** Proposals of different changes (a sensor and its retirement) are never near-duplicates. */
const isNear = (a: MemoryEntry, b: MemoryEntry) =>
  a.type === b.type && a.proposal?.change === b.proposal?.change && sameScope(a, b) && similarity(a.summary, b.summary) >= NEAR_DUPLICATE;

function slug(summary: string, room: number): string {
  const text = summary.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  let result = "";
  for (const word of text.split(/[^a-z0-9]+/).filter(Boolean).slice(0, 8)) {
    const next = result ? `${result}-${word}` : word;
    if (next.length > room) break;
    result = next;
  }
  return result || createHash("sha1").update(summary).digest("hex").slice(0, 8);
}

/** Validates and writes a new entry, marks what it supersedes, regenerates the index. Refuses duplicates and near-duplicates. */
export function addMemory(input: MemoryInput, root?: string): MemoryEntry {
  return withLock(root, () => addLocked(input, root));
}

function addLocked(input: MemoryInput, root?: string): MemoryEntry {
  const { body = "", id: givenId, createdAt = today(), ...fields } = input;
  const { entries } = loadMemory(root);
  const type = fields.type;
  let id = givenId;
  if (!id) {
    const prefix = `${type}-${createdAt.replaceAll("-", "")}-`;
    const base = `${prefix}${slug(fields.summary ?? "", 96 - prefix.length - 3)}`;
    id = base;
    for (let n = 2; entries.some((entry) => entry.id === id) || existsSync(entryFile({ id, type }, root)); n++) id = `${base}-${n}`;
  }
  const parsed = MemoryEntrySchema.safeParse({ ...fields, version: 1, id, createdAt, status: "active", occurrences: 1 });
  if (!parsed.success) throw new CliErrorObject({ code: "VALIDATION", message: issues(parsed.error), details: { issues: parsed.error.issues } });
  const entry = parsed.data;
  if (entry.proposal) {
    checkNewProposal(entry.proposal, entries);
    entry.scope = proposalScope(entry.scope, entry.proposal.causes.map((cause) => entries.find((item) => item.id === cause)!));
  }
  if (entries.some((item) => item.id === entry.id) || existsSync(entryFile(entry, root))) {
    throw new CliErrorObject({ code: "FILE_EXISTS", message: `Memory entry ${entry.id} already exists.` });
  }
  const near = entries.find((item) => item.status === "active" && !entry.supersedes.includes(item.id) && isNear(item, entry));
  if (near) {
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: `An active ${entry.type} already says this: ${near.id} ("${near.summary}"). ${near.type === "observation" || near.type === "gap" ? `Record a repeat with pnpm memory --seen ${near.id}, or replace it` : "If the user's words change it, replace it"} with --supersedes ${near.id}.`,
      details: { existing: near.id },
    });
  }
  const targets = entry.supersedes.map((target) => {
    const found = entries.find((item) => item.id === target);
    if (!found) throw new CliErrorObject({ code: "VALIDATION", message: `supersedes: no memory entry ${target}.` });
    if (found.type === "proposal") throw new CliErrorObject({ code: "VALIDATION", message: `supersedes: ${target} is a proposal; close it with --reject or --verdict ${target} --state retired.` });
    if (USER_CONFIRMED_TYPES.includes(found.type) && entry.source.kind !== "user") {
      throw new CliErrorObject({ code: "VALIDATION", message: `supersedes: ${target} is a ${found.type}, the user's own words; only an entry from the user's words (--quote) can replace it.` });
    }
    return found;
  });
  save(entry, body, root);
  for (const { file: _file, body: targetBody, ...target } of targets) save({ ...target, status: "superseded", reviewedAt: createdAt }, targetBody, root);
  writeIndexLocked(root);
  return entry;
}

const union = <T>(...lists: (readonly T[])[]): T[] => [...new Set(lists.flat())];

/** A proposal's scope: its own plus the union of its causes' playbooks, steps and platforms; a project only when every cause shares one. */
function proposalScope(own: MemoryEntry["scope"], causes: readonly MemoryEntry[]): MemoryEntry["scope"] {
  const projects = new Set(causes.map((cause) => cause.scope.project ?? null));
  const shared = projects.size === 1 ? [...projects][0] : null;
  const project = own.project ?? shared ?? undefined;
  return {
    ...own,
    playbooks: union(own.playbooks, ...causes.map((cause) => cause.scope.playbooks)),
    steps: union(own.steps, ...causes.map((cause) => cause.scope.steps)),
    platforms: union(own.platforms, ...causes.map((cause) => cause.scope.platforms)),
    ...(project ? { project } : {}),
  };
}

/** A new proposal starts proposed, with no approval or commits, and answers active observations, gaps or lessons. */
function checkNewProposal(proposal: MemoryProposal, entries: readonly MemoryEntry[]): void {
  if (proposal.state !== "proposed" || proposal.approval || proposal.commits.length || proposal.appliedAt || proposal.verdict || proposal.confirmation) {
    throw new CliErrorObject({ code: "VALIDATION", message: "A new proposal starts proposed, without approval, commits or verdict; the user approves it with --approve." });
  }
  for (const cause of proposal.causes) {
    const found = entries.find((item) => item.id === cause);
    if (!found) throw new CliErrorObject({ code: "VALIDATION", message: `causes: no memory entry ${cause}.` });
    if (!PROPOSAL_CAUSE_TYPES.includes(found.type)) throw new CliErrorObject({ code: "VALIDATION", message: `causes: ${cause} is a ${found.type}; a proposal answers ${PROPOSAL_CAUSE_TYPES.join(", ")}.` });
    if (found.status !== "active") throw new CliErrorObject({ code: "VALIDATION", message: `causes: ${cause} is ${found.status}; a proposal answers active entries.` });
  }
}

export type ProposalMove =
  | { to: "approved"; quote: string }
  | { to: "applied"; commits: string[] }
  | { to: "rejected"; verdict?: string; quote?: string }
  | { to: "verified" | "ineffective"; verdict: string; quote: string }
  | { to: "retired"; verdict: string };

/**
 * Moves a proposal along its lifecycle (PROPOSAL_NEXT); an illegal move is VALIDATION naming the legal next states.
 * approved carries the user's words and today's date; applied its commits (checked by the caller) and today's date;
 * rejected and retired also retire the entry. Verified, ineffective and the rejection of an approved proposal carry the
 * user's words as `confirmation` with today's date; retired may be an agent's.
 */
export function moveProposal(id: string, move: ProposalMove, root?: string): MemoryEntry {
  return withLock(root, () => {
    const { file: _file, body, ...entry } = find(id, root);
    if (!entry.proposal) throw new CliErrorObject({ code: "VALIDATION", message: `${id} is a ${entry.type}, not a proposal.` });
    const from = entry.proposal.state;
    const legal = PROPOSAL_NEXT[from];
    if (!legal.includes(move.to)) {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `${id} is ${from}; it cannot become ${move.to}. ${legal.length ? `Legal next states: ${legal.join(", ")}.` : "It is closed."}`,
        details: { state: from, legal },
      });
    }
    const date = today();
    const proposal: MemoryProposal = { ...entry.proposal, state: move.to };
    if (move.to === "approved") proposal.approval = { quote: move.quote, at: date };
    else if (move.to === "applied") {
      if (!move.commits.length) throw new CliErrorObject({ code: "VALIDATION", message: "applied needs at least one commit." });
      proposal.commits = [...new Set(move.commits)];
      proposal.appliedAt = date;
    } else {
      if (move.verdict !== undefined) proposal.verdict = move.verdict;
      const quote = "quote" in move ? move.quote : undefined;
      const needsWords = move.to === "verified" || move.to === "ineffective" || (move.to === "rejected" && entry.proposal.approval);
      if (needsWords && !quote?.trim()) {
        throw new CliErrorObject({ code: "VALIDATION", message: `${id}: ${move.to === "rejected" ? "rejecting an approved proposal" : `a ${move.to} verdict`} needs the user's own words (--quote).` });
      }
      if (quote?.trim()) proposal.confirmation = { quote, at: date };
    }
    const closed = move.to === "rejected" || move.to === "retired";
    const updated = { ...entry, proposal, reviewedAt: date, ...(closed ? { status: "retired" as const } : {}) };
    const parsed = MemoryEntrySchema.safeParse(updated);
    if (!parsed.success) throw new CliErrorObject({ code: "VALIDATION", message: issues(parsed.error) });
    save(parsed.data, body, root);
    writeIndexLocked(root);
    return parsed.data;
  });
}

/** One more sighting of an observation or a gap: occurrences + 1, today's date appended to sightings; `evidence` adds a dated line to the body. */
export function markSeen(id: string, root?: string, evidence?: string): MemoryEntry {
  return withLock(root, () => {
    const { file: _file, body, ...entry } = find(id, root);
    if (entry.type !== "observation" && entry.type !== "gap") {
      throw new CliErrorObject({ code: "VALIDATION", message: `Only observations and gaps count sightings; ${id} is a ${entry.type}.` });
    }
    const date = today();
    const updated = { ...entry, occurrences: entry.occurrences + 1, sightings: [...entry.sightings, date], reviewedAt: date };
    const line = evidence?.trim() ? `- Seen ${date}: ${evidence.trim().replace(/\s+/g, " ")}` : "";
    save(updated, line ? `${body.trimEnd()}${body.trim() ? "\n" : ""}${line}` : body, root);
    writeIndexLocked(root);
    return updated;
  });
}

/** Sets an entry's status; a proposal closes only through moveProposal (rejected or retired). */
export function setStatus(id: string, status: MemoryEntry["status"], root?: string): MemoryEntry {
  return withLock(root, () => {
    const { file: _file, body, ...entry } = find(id, root);
    if (entry.type === "proposal") throw new CliErrorObject({ code: "VALIDATION", message: `${id} is a proposal: close it with --reject or --verdict ${id} --state retired.` });
    const updated = { ...entry, status, reviewedAt: today() };
    save(updated, body, root);
    writeIndexLocked(root);
    return updated;
  });
}

const contains = (list: readonly string[], value: string | undefined): "any" | "specific" | false =>
  !value || !list.length ? "any" : list.includes(value) ? "specific" : false;

/** Ranked refs within hard caps: active only by default; proposals only when `types` names them; scope must admit each asked value; text with terms keeps only entries with at least one hit (none without terms filters nothing); the user's types first, then specific matches, text hits, type, newest. */
export function queryMemory(query: MemoryQuery, root?: string, entries?: readonly PreloadedEntry[]): MemoryRef[] {
  const limit = Math.max(0, Math.floor(query.limit ?? QUERY_LIMIT));
  const maxChars = Math.max(0, query.maxChars ?? QUERY_MAX_CHARS);
  const terms = [...words(query.text ?? "")];
  const ranked = (entries ?? loadMemory(root).entries)
    .filter((entry) => query.includeInactive || entry.status === "active")
    .filter((entry) => (query.types?.length ? query.types.includes(entry.type) : entry.type !== "proposal"))
    .filter((entry) => !query.project || !entry.scope.project || entry.scope.project === query.project)
    .flatMap((entry) => {
      const matches = [contains(entry.scope.playbooks, query.playbook), contains(entry.scope.steps, query.step), contains(entry.scope.platforms, query.platform)];
      if (matches.includes(false)) return [];
      const specific = matches.filter((match) => match === "specific").length + (query.project && entry.scope.project === query.project ? 1 : 0);
      const haystack = words(`${entry.summary} ${entry.body ?? ""}`);
      const hits = terms.filter((term) => haystack.has(term)).length;
      if (terms.length && !hits) return [];
      return [{ entry, specific, hits }];
    })
    .sort((a, b) =>
      Number(USER_CONFIRMED_TYPES.includes(b.entry.type)) - Number(USER_CONFIRMED_TYPES.includes(a.entry.type)) ||
      b.specific - a.specific ||
      b.hits - a.hits ||
      TYPE_PRIORITY.indexOf(a.entry.type) - TYPE_PRIORITY.indexOf(b.entry.type) ||
      (b.entry.reviewedAt ?? b.entry.createdAt).localeCompare(a.entry.reviewedAt ?? a.entry.createdAt) ||
      a.entry.id.localeCompare(b.entry.id));
  const result: MemoryRef[] = [];
  let chars = 0;
  for (const { entry } of ranked) {
    if (result.length >= limit || chars + entry.summary.length > maxChars) break;
    chars += entry.summary.length;
    result.push(ref(entry));
  }
  return result;
}

/** What a next-step answer carries for this playbook, step and platform: queryMemory with its defaults. */
export function memoryFor(ctx: { playbook?: string; step?: string; platform?: string }, root?: string, entries?: readonly PreloadedEntry[]): MemoryRef[] {
  return queryMemory(ctx, root, entries);
}

export type ProposalReview = MemoryRef & {
  appliedAt: string;
  candidate: "ineffective" | "verified" | "watching";
  /** Cause sightings dated after appliedAt (strictly later days). */
  recurred: { id: string; dates: string[] }[];
  daysSinceApplied: number;
  /** Days until the verified window closes, while watching. */
  daysLeft?: number;
};

/** Whole days from one yyyy-mm-dd to another, through UTC midnights so a DST change cannot shift it. */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Read-only hygiene report: near-duplicate groups, repeats (occurrences >= 2), stale entries (> 180 days unreviewed), broken
 * files and references; `suggest`, repeats no open or held proposal answers; `review`, applied proposals with a candidate
 * verdict (a cause seen after appliedAt: ineffective; none for VERIFY_DAYS: verified; else watching).
 */
export function consolidate(
  root?: string,
  now: Date = new Date(),
): { duplicates: string[][]; repeats: MemoryRef[]; stale: MemoryRef[]; broken: string[]; suggest: MemoryRef[]; review: ProposalReview[] } {
  const { entries, warnings } = loadMemory(root);
  const active = entries.filter((entry) => entry.status === "active");
  const grouped = new Set<string>();
  const duplicates: string[][] = [];
  for (const [index, entry] of active.entries()) {
    if (grouped.has(entry.id)) continue;
    const group = [entry.id, ...active.slice(index + 1).filter((other) => !grouped.has(other.id) && isNear(entry, other)).map((other) => other.id)];
    if (group.length > 1) {
      group.forEach((id) => grouped.add(id));
      duplicates.push(group);
    }
  }
  const cutoff = localDate(new Date(now.getTime() - STALE_DAYS * 86_400_000));
  const ids = new Set(entries.map((entry) => entry.id));
  const broken = [
    ...warnings,
    ...entries.flatMap((entry) => entry.supersedes.filter((target) => !ids.has(target)).map((target) => `${entry.id}: supersedes a missing entry ${target}`)),
    ...entries.flatMap((entry) => (entry.proposal?.causes ?? []).filter((cause) => !ids.has(cause)).map((cause) => `${entry.id}: names a missing cause ${cause}`)),
  ];
  const repeats = active.filter((entry) => (entry.type === "observation" || entry.type === "gap") && entry.occurrences >= 2).sort((a, b) => b.occurrences - a.occurrences);
  const proposals = entries.filter((entry) => entry.proposal);
  /** A cause and every entry that supersedes it, transitively: a merged cause keeps counting through its successor. */
  const chain = (id: string): string[] => {
    const seen = new Set<string>();
    const queue = [id];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const entry of entries) if (entry.supersedes.includes(next)) queue.push(entry.id);
    }
    return [...seen];
  };
  const answered = new Set(proposals.filter((entry) => OPEN_OR_HELD.has(entry.proposal!.state)).flatMap((entry) => entry.proposal!.causes.flatMap(chain)));
  const day = localDate(now);
  const review = proposals
    .filter((entry) => entry.status === "active" && entry.proposal!.state === "applied" && entry.proposal!.appliedAt)
    .map((entry): ProposalReview => {
      const appliedAt = entry.proposal!.appliedAt!;
      const recurred = [...new Set(entry.proposal!.causes.flatMap(chain))].flatMap((cause) => {
        const dates = (entries.find((item) => item.id === cause)?.sightings ?? []).filter((date) => date > appliedAt);
        return dates.length ? [{ id: cause, dates }] : [];
      });
      const daysSinceApplied = daysBetween(appliedAt, day);
      const candidate = recurred.length ? "ineffective" : daysSinceApplied >= VERIFY_DAYS ? "verified" : "watching";
      return { ...ref(entry), appliedAt, candidate, recurred, daysSinceApplied, ...(candidate === "watching" ? { daysLeft: VERIFY_DAYS - daysSinceApplied } : {}) };
    });
  return {
    duplicates,
    repeats: repeats.map(ref),
    stale: active.filter((entry) => (entry.reviewedAt ?? entry.createdAt) < cutoff).map(ref),
    broken,
    suggest: repeats.filter((entry) => !answered.has(entry.id)).map(ref),
    review,
  };
}

/** Appends one validated line to memory/metrics.jsonl; with `once`, writes nothing when an existing valid line matches it (checked under the lock). Returns whether it wrote. */
export function recordMetric(metric: MemoryMetric, root?: string, options: { once?: (existing: MemoryMetric) => boolean } = {}): boolean {
  const parsed = MemoryMetricSchema.safeParse(metric);
  if (!parsed.success) throw new CliErrorObject({ code: "VALIDATION", message: issues(parsed.error) });
  return withLock(root, () => {
    const file = path.join(memoryDir(root), METRICS_FILE);
    const { once } = options;
    if (once && existsSync(file)) {
      const matches = readFileSync(file, "utf8").split("\n").some((line) => {
        if (!line.trim()) return false;
        try {
          const row = MemoryMetricSchema.safeParse(JSON.parse(line));
          return row.success && once(row.data);
        } catch {
          return false;
        }
      });
      if (matches) return false;
    }
    appendFileSync(file, `${JSON.stringify(parsed.data)}\n`);
    return true;
  });
}
