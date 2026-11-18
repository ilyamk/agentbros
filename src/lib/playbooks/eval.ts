import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Playbook } from "../../types/playbook";
import { matchAgainst, type MatchStrength } from "./match";

/** The repository's labelled corpus, relative to the checkout. */
export const MATCH_CORPUS = "tests/fixtures/playbooks/match-corpus.json";

/** Labelled first requests: `expect` lists every acceptable playbook; empty means vague, never to be matched clearly. */
export const MatchCorpusSchema = z
  .object({
    version: z.literal(1),
    note: z.string().optional(),
    cases: z.array(
      z
        .object({ lang: z.enum(["en", "ru", "zh"]), request: z.string().min(3), expect: z.array(z.string().min(2)) })
        .strict(),
    ),
  })
  .strict();
export type MatchCorpus = z.infer<typeof MatchCorpusSchema>;

export type MatchOutcome =
  "right-clear" | "right-weak" | "wrong-clear" | "wrong-weak" | "none" | "vague-ok" | "vague-clear";

export type MatchCaseResult = {
  lang: string;
  request: string;
  expect: string[];
  outcome: MatchOutcome;
  top: string | null;
  strength: MatchStrength;
  score: number;
  runnerUp: string | null;
};

export type MatchEvalReport = {
  cases: number;
  /** Specific requests (non-empty `expect`) whose top candidate is acceptable, as a share. */
  top1: number;
  /** Specific requests bound without a question, correctly, as a share. */
  clear: number;
  counts: Record<MatchOutcome, number>;
  byLanguage: Record<string, { cases: number; top1: number; clear: number }>;
  /** Every case that is not right-clear or vague-ok, worst first. */
  misses: MatchCaseResult[];
};

const SEVERITY: MatchOutcome[] = ["wrong-clear", "vague-clear", "wrong-weak", "none", "right-weak"];

export function loadMatchCorpus(file: string): MatchCorpus {
  return MatchCorpusSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Scores the matcher on a labelled corpus. Pure: the tests and `pnpm playbook --eval` share it. */
export function evaluateMatching(corpus: MatchCorpus, playbooks: Playbook[]): MatchEvalReport {
  const known = new Set(playbooks.map((playbook) => playbook.id));
  const results = corpus.cases.map((item): MatchCaseResult => {
    for (const id of item.expect) if (!known.has(id)) throw new Error(`Corpus names unknown playbook ${id}`);
    const match = matchAgainst(item.request, playbooks);
    const top = match.candidates[0]?.id ?? null;
    const outcome: MatchOutcome = !item.expect.length
      ? match.strength === "clear"
        ? "vague-clear"
        : "vague-ok"
      : !top
        ? "none"
        : item.expect.includes(top)
          ? match.strength === "clear"
            ? "right-clear"
            : "right-weak"
          : match.strength === "clear"
            ? "wrong-clear"
            : "wrong-weak";
    return {
      lang: item.lang,
      request: item.request,
      expect: item.expect,
      outcome,
      top,
      strength: match.strength,
      score: match.candidates[0]?.score ?? 0,
      runnerUp: match.candidates[1]?.id ?? null,
    };
  });
  const share = (rows: MatchCaseResult[], test: (row: MatchCaseResult) => boolean) =>
    rows.length ? Math.round((rows.filter(test).length / rows.length) * 1000) / 1000 : 0;
  const specific = results.filter((row) => row.expect.length);
  const isTop = (row: MatchCaseResult) => row.outcome === "right-clear" || row.outcome === "right-weak";
  const counts = Object.fromEntries(
    (["right-clear", "right-weak", "wrong-clear", "wrong-weak", "none", "vague-ok", "vague-clear"] as const).map(
      (outcome) => [outcome, results.filter((row) => row.outcome === outcome).length],
    ),
  ) as Record<MatchOutcome, number>;
  const byLanguage = Object.fromEntries(
    [...new Set(specific.map((row) => row.lang))].sort().map((lang) => {
      const rows = specific.filter((row) => row.lang === lang);
      return [
        lang,
        { cases: rows.length, top1: share(rows, isTop), clear: share(rows, (row) => row.outcome === "right-clear") },
      ];
    }),
  );
  return {
    cases: results.length,
    top1: share(specific, isTop),
    clear: share(specific, (row) => row.outcome === "right-clear"),
    counts,
    byLanguage,
    misses: results
      .filter((row) => SEVERITY.includes(row.outcome))
      .sort((a, b) => SEVERITY.indexOf(a.outcome) - SEVERITY.indexOf(b.outcome)),
  };
}
