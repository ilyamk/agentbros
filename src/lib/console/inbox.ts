/**
 * Decided decisions on disk (RFC 0004 D9, FR5): `public/projects/<id>/pipeline/inbox/<decisionId>.json`, one
 * InboxDecisionFile per decision, written atomically. A refused attempt that the user then retries with other words is
 * kept beside it as `<decisionId>.refused-<n>.json`, so the history shows every attempt. Pending decisions are never
 * written: they are computed (FR2).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  INBOX_DIR,
  InboxDecisionFileSchema,
  PROJECTS_DIR,
  type ConsoleEvent,
  type InboxDecisionFile,
} from "../../types/console";
import { MAX_EVENTS_LIMIT, readEvents } from "./events-reader";

export const inboxDirOf = (rootDir: string, project: string) => path.join(rootDir, PROJECTS_DIR, project, INBOX_DIR);
const fileOf = (rootDir: string, project: string, name: string) => path.join(inboxDirOf(rootDir, project), name);

/** The decided decision with this id, or undefined (missing or invalid). */
export function readInbox(rootDir: string, project: string, decisionId: string): InboxDecisionFile | undefined {
  const file = fileOf(rootDir, project, `${decisionId}.json`);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = InboxDecisionFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeAtomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

/** Validates and writes the decided decision (atomic rename). */
export function writeInbox(rootDir: string, decision: InboxDecisionFile): string {
  const parsed = InboxDecisionFileSchema.parse(decision);
  const file = fileOf(rootDir, parsed.project, `${parsed.id}.json`);
  writeAtomic(file, parsed);
  return file;
}

/** Refused attempts kept per decision; one more retry is refused before anything runs. */
export const MAX_REFUSED_ATTEMPTS = 20;

const counterOf = (rootDir: string, project: string, decisionId: string) =>
  fileOf(rootDir, project, `${decisionId}.attempts`);

/** How many refused attempts of this decision are archived (a counter file beside it, not a directory scan). */
export function refusedAttempts(rootDir: string, project: string, decisionId: string): number {
  try {
    const value = Number(readFileSync(counterOf(rootDir, project, decisionId), "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Moves a refused decision aside before a retry: `<id>.refused-<n>.json`, n from the counter. */
export function archiveRefused(rootDir: string, project: string, decisionId: string): void {
  const dir = inboxDirOf(rootDir, project);
  const from = path.join(dir, `${decisionId}.json`);
  if (!existsSync(from)) return;
  const n = refusedAttempts(rootDir, project, decisionId) + 1;
  renameSync(from, path.join(dir, `${decisionId}.refused-${n}.json`));
  writeAtomic(counterOf(rootDir, project, decisionId), n);
}

export interface DecisionHistory {
  /** Every decided decision and archived refusal, newest first by decidedAt. */
  decisions: InboxDecisionFile[];
  /** The journal's `decision.applied` and `decision.refused` events, oldest first. */
  events: ConsoleEvent[];
}

/** FR5: what the user decided, with their words, the argv and the envelope (inbox files plus journal events). */
export function listDecisions(rootDir: string, project: string): DecisionHistory {
  const dir = inboxDirOf(rootDir, project);
  const decisions: InboxDecisionFile[] = [];
  if (existsSync(dir))
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = InboxDecisionFileSchema.safeParse(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
        if (parsed.success) decisions.push(parsed.data);
      } catch {
        // an unreadable file is not history
      }
    }
  decisions.sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "") || a.id.localeCompare(b.id));
  const events: ConsoleEvent[] = [];
  let since: string | undefined;
  do {
    const page = readEvents(rootDir, project, { since, limit: MAX_EVENTS_LIMIT });
    events.push(
      ...page.events.filter((event) => event.kind === "decision.applied" || event.kind === "decision.refused"),
    );
    since = page.next ?? undefined;
  } while (since);
  return { decisions, events };
}
