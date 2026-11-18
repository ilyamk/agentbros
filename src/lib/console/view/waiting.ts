/**
 * Decisions waiting for the user (RFC 0004 FR2), derived from chain or footage state and agent cards, never only from
 * the journal. WP5 looks a pending decision up here by id before it applies it, and re-derives its argv; it never
 * trusts the client's copy.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { ProjectIdSchema, type Card, type Decision } from "../../../types/console";
import { bindFiles, pendingDecision } from "./decision";
import { projectPaths, type ProjectPaths } from "./files";
import { filmWaiting, readFilm, type QuoteContext } from "./film";
import { footageWaiting, readFootage } from "./footage";
import { readMoneyContext } from "./money-context";
import { projectRoute } from "./route";
import { readCards } from "./sections";

/** A pending `card-answer` decision for each card that expects an answer and has none. */
export function cardDecisions(paths: ProjectPaths, cards: readonly Card[], files: Map<string, string>): Decision[] {
  return cards.flatMap((card): Decision[] => {
    if (!card.expectsAnswer || card.answer) return [];
    const file = files.get(card.id);
    const media = "media" in card && card.media ? card.media : [];
    const bindTo = bindFiles(paths, [
      ...(file ? [path.join(paths.projectDir, file)] : []),
      ...media.map((ref) => path.join(ref.root === "out" ? paths.outDir : paths.projectDir, ref.path)),
    ]);
    const decision = pendingDecision(paths, {
      project: paths.id,
      kind: "card-answer",
      step: card.step ?? "card",
      title: card.title,
      ...(card.body ? { summary: card.body.slice(0, 2000) } : {}),
      bindTo,
      cardId: card.id,
      media,
      createdAt: card.createdAt,
    });
    return decision ? [decision] : [];
  });
}

/** Newest first (cards and gates alike), at most 64. */
export const sortWaiting = (decisions: Decision[]): Decision[] =>
  [...decisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 64);

/** The project's waiting decisions plus what could not be derived, as advisory lines. */
export function waitingWithAdvisories(
  paths: ProjectPaths,
  options: { now?: number; money?: QuoteContext } = {},
): { decisions: Decision[]; advisories: string[] } {
  const now = options.now ?? Date.now();
  const advisories: string[] = [];
  const decisions: Decision[] = [];
  const money = options.money ?? readMoneyContext(paths).quote;
  const { chain } = projectRoute(paths.projectDir);
  try {
    if (chain === "film") {
      const found = filmWaiting(readFilm(paths), paths, money);
      decisions.push(...found.decisions);
      advisories.push(...found.advisories);
    } else if (chain === "footage") {
      const found = footageWaiting(readFootage(paths), paths, money);
      decisions.push(...found.decisions);
      advisories.push(...found.advisories);
    }
  } catch (error) {
    advisories.push(`waiting: the ${chain} state cannot be derived (${(error as Error).message ?? error}).`);
  }
  const cards = readCards(paths, paths.id, now);
  advisories.push(...cards.advisories);
  decisions.push(...cardDecisions(paths, cards.value.cards, cards.value.files));
  return { decisions: sortWaiting(decisions), advisories };
}

/**
 * The decisions project `projectId` under `rootDir` waits on now: film gates and choices (with paid quotes and the
 * final verdict), footage approvals and quotes, and agent cards awaiting an answer. Ids are deterministic over the
 * project, kind, step and the sha256 of every bound file, so a decision found here is the one the user saw only while
 * those files are unchanged. Never throws for a missing or corrupt file; an unknown project yields [].
 */
export async function deriveWaiting(rootDir: string, projectId: string): Promise<Decision[]> {
  if (!ProjectIdSchema.safeParse(projectId).success) return [];
  const paths = projectPaths(path.resolve(rootDir), projectId);
  if (!existsSync(paths.projectDir)) return [];
  try {
    return waitingWithAdvisories(paths).decisions;
  } catch {
    return [];
  }
}
