/**
 * Creative rubrics, each frozen: axes, threshold and the both-orders ranking that creative:rank applies.
 * v2 keeps v1's axes, threshold and ranking; only its distinctiveness anchor differs (the swap target is the strategy's strongestAlternative).
 * Anchors are in RUBRIC_FILES; tests/creative-rubric.test.ts pins each file's hash. A change is a new version, never an edit.
 */

export const RUBRIC_VERSIONS = [1, 2] as const;
export type RubricVersion = (typeof RUBRIC_VERSIONS)[number];
/** What film:init records for a new project; a project without a record predates v2 and is scored with v1. */
export const DEFAULT_RUBRIC_VERSION: RubricVersion = 2;
export const LEGACY_RUBRIC_VERSION: RubricVersion = 1;
export const RUBRIC_FILES: Record<RubricVersion, string> = {
  1: ".agents/skills/creative-studio/references/creative-rubric.md",
  2: ".agents/skills/creative-studio/references/creative-rubric-v2.md",
};
export const isRubricVersion = (value: unknown): value is RubricVersion =>
  RUBRIC_VERSIONS.includes(value as RubricVersion);

export const IDEA_AXES = ["picture", "hook", "distinctiveness", "truth", "feasibility", "ambition", "native"] as const;
export const SCRIPT_AXES = ["hookLine", "truth", "reading", "musicFit", "oneMessage"] as const;
export type ReviewKind = "ideas" | "scripts";
export const AXES: Record<ReviewKind, readonly string[]> = { ideas: IDEA_AXES, scripts: SCRIPT_AXES };

export const THRESHOLD = { minAxis: 3, minTruth: 4, minMean: 3.6 } as const;
/** How many items the pairwise comparison covers. */
export const PAIRWISE_TOP = 6;
/** Rounds back to the authors after the first; the round after the last goes to the user. */
export const MAX_LOOPBACKS = 2;
/** A measured reading overrun caps the script's reading axis. */
export const READING_OVERRUN_CAP = 2;

export type AxisScores = Record<string, number>;
export type PairJudgement = { first: string; second: string; winner: string };
export type ScoredItem = { id: string; axes: AxisScores; order: number };

const round2 = (value: number) => Math.round(value * 100) / 100;

export const meanOf = (axes: AxisScores): number => {
  const values = Object.values(axes);
  return values.length ? round2(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
};

export function passes(axes: AxisScores): boolean {
  const values = Object.values(axes);
  return (
    values.length > 0 &&
    values.every((value) => value >= THRESHOLD.minAxis) &&
    (axes["truth"] ?? 0) >= THRESHOLD.minTruth &&
    meanOf(axes) >= THRESHOLD.minMean
  );
}

export type PairOutcome = { a: string; b: string; ab?: string; ba?: string; agreed: boolean; winner?: string };

/** Groups judgements by unordered pair. A pair counts only when both orders exist and name the same winner, not a tie. */
export function agreedPairs(judgements: PairJudgement[]): PairOutcome[] {
  const pairs = new Map<string, PairOutcome>();
  for (const judgement of judgements) {
    const [a, b] = [judgement.first, judgement.second].sort() as [string, string];
    const key = `${a}|${b}`;
    const pair = pairs.get(key) ?? { a, b, agreed: false };
    if (judgement.first === a) pair.ab = judgement.winner;
    else pair.ba = judgement.winner;
    pairs.set(key, pair);
  }
  return [...pairs.values()].map((pair) => {
    const agreed = pair.ab !== undefined && pair.ab === pair.ba && pair.ab !== "tie";
    return { ...pair, agreed, ...(agreed ? { winner: pair.ab } : {}) };
  });
}

const byMean = (a: ScoredItem, b: ScoredItem) =>
  meanOf(b.axes) - meanOf(a.axes) ||
  Math.min(...Object.values(b.axes)) - Math.min(...Object.values(a.axes)) ||
  a.order - b.order;

/** The ids the pairwise comparison must cover, in mean order. */
export const pairwiseIds = (items: ScoredItem[]): string[] =>
  [...items]
    .sort(byMean)
    .slice(0, PAIRWISE_TOP)
    .map((item) => item.id);

/** Every ordered pair the director must judge among the pairwise ids. */
export function requiredOrders(ids: string[]): Array<[string, string]> {
  return ids.flatMap((a, i) => ids.flatMap((b, j) => (i === j ? [] : [[a, b] as [string, string]])));
}

export type Ranking = {
  ranking: string[];
  pairs: PairOutcome[];
  net: Record<string, number>;
  passing: string[];
  verdict: "pass" | "below-threshold";
};

export function rank(items: ScoredItem[], judgements: PairJudgement[]): Ranking {
  const byMeanOrder = [...items].sort(byMean);
  const top = byMeanOrder.slice(0, PAIRWISE_TOP);
  const topIds = new Set(top.map((item) => item.id));
  const pairs = agreedPairs(
    judgements.filter((judgement) => topIds.has(judgement.first) && topIds.has(judgement.second)),
  );
  const net: Record<string, number> = Object.fromEntries(top.map((item) => [item.id, 0]));
  for (const pair of pairs.filter((outcome) => outcome.agreed)) {
    const loser = pair.winner === pair.a ? pair.b : pair.a;
    net[pair.winner!]! += 1;
    net[loser]! -= 1;
  }
  const ordered = [...top].sort((a, b) => net[b.id]! - net[a.id]! || byMean(a, b));
  const preference = [...ordered, ...byMeanOrder.slice(PAIRWISE_TOP)].map((item) => item.id);
  const passing = preference.filter((id) => passes(items.find((item) => item.id === id)!.axes));
  const ranking = [...passing, ...preference.filter((id) => !passing.includes(id))];
  return { ranking, pairs, net, passing, verdict: passing.length ? "pass" : "below-threshold" };
}
