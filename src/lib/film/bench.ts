/**
 * Creative benchmark: round 1 of two runs merged into one blind pool, judged by fresh directors outside the chain,
 * then compared per run. Protocol in docs/creative-benchmark.md.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CreativePoolSchema, StrategySchema, type CreativePool } from "../../types/studio";
import { IDEA_AXES, passes } from "./creative-rubric";
import { poolFile, roundDir, seededShuffle } from "./studio";

const pipelineDir = (projectDir: string) => path.join(projectDir, "pipeline");

export class BenchRefusal extends Error {}

/** Keys that tell a judge how an idea was made, or that carry the newer run's own tests. */
export const STRIPPED_KEYS = [
  "stimulus",
  "subverts",
  "killedObvious",
  "proofFrame",
  "method",
  "benchmark",
  "trizResolution",
  "swapTest",
  "lifeWithout",
] as const;
export const METHOD_WORDS =
  /\b(zwicky|scamper|triz|synectics?|random[- ]entry|kill[- ]first(?:[- ]?(?:10|ten))?|stimul(?:us|i)|clich[eé]s?|white[- ]?space)\b/gi;
const CLICHE = /clich[eé]/i;
const SWAP_TAIL = /\s*Swap test:[\s\S]*$/;

export const BenchKeySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("ideas"),
  seed: z.string(),
  runs: z.array(z.string()).length(2),
  entries: z.array(z.object({ id: z.string(), run: z.string(), sourceId: z.string() })),
  stripped: z.object({ keys: z.array(z.string()), oneRunKeys: z.array(z.string()) }),
});
export type BenchKey = z.infer<typeof BenchKeySchema>;

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

/** A run's round-1 pool: the archived round if there is one, else the current pool, which must be round 1. */
export function roundOnePool(projectDir: string): { file: string; pool: CreativePool } {
  const archived = path.join(roundDir(projectDir, "ideas", 1), "pool.json");
  const file = existsSync(archived) ? archived : poolFile(projectDir, "ideas");
  if (!existsSync(file))
    throw new BenchRefusal(
      `No ideas pool in ${path.basename(projectDir)}: neither ${path.relative(projectDir, archived)} nor pipeline/pools/ideas.json.`,
    );
  const pool = CreativePoolSchema.parse(readJson(file));
  if (pool.round !== 1)
    throw new BenchRefusal(
      `${path.relative(projectDir, file)} is round ${pool.round}; a benchmark compares round 1 with round 1, and that round was not archived.`,
    );
  return { file, pool };
}

function clean(value: unknown, drop: ReadonlySet<string>): unknown {
  if (Array.isArray(value))
    return value
      .filter((entry) => !(typeof entry === "string" && (/^\s*swap:/i.test(entry) || CLICHE.test(entry))))
      .map((entry) => clean(entry, drop));
  if (typeof value === "string") {
    const sentences = value.replace(SWAP_TAIL, "").split(/(?<=[.!?])\s+/);
    return sentences.filter((sentence) => !CLICHE.test(sentence)).join(" ");
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !drop.has(key))
        .map(([key, entry]) => [key, clean(entry, drop)]),
    );
  return value;
}

/** A merged pool: a creative pool whose ids are M1…Mn, so no id can be confused with a run's own. */
export const BenchPoolSchema = CreativePoolSchema.extend({
  items: z.array(z.object({ id: z.string().regex(/^M\d+$/), content: z.record(z.string(), z.unknown()) })).min(1),
});
export type BenchPool = z.infer<typeof BenchPoolSchema>;

export type MergeResult = { pool: BenchPool; key: BenchKey; residual: { id: string; run: string; word: string }[] };

/** Strips what would tell the judges which run or method an idea came from, shuffles both runs together and keys the ids apart. */
export function mergePools(runs: { run: string; pool: CreativePool }[], seed: string): MergeResult {
  if (runs.length !== 2) throw new BenchRefusal(`A benchmark merges exactly two runs, not ${runs.length}.`);
  const keysOf = (pool: CreativePool) => new Set(pool.items.flatMap((item) => Object.keys(item.content)));
  const [first, second] = runs.map((entry) => keysOf(entry.pool)) as [Set<string>, Set<string>];
  const oneRunKeys = [...new Set([...first, ...second])]
    .filter((key) => first.has(key) !== second.has(key) && !(STRIPPED_KEYS as readonly string[]).includes(key))
    .sort();
  const drop = new Set<string>([...STRIPPED_KEYS, ...oneRunKeys]);
  const items = runs.flatMap(({ run, pool }) =>
    pool.items.map((item) => ({
      run,
      sourceId: item.id,
      content: clean(item.content, drop) as Record<string, unknown>,
    })),
  );
  const shuffled = seededShuffle(items, seed).map((item, index) => ({ ...item, id: `M${index + 1}` }));
  const residual = shuffled.flatMap((item) =>
    [...JSON.stringify(item.content).matchAll(METHOD_WORDS)].map((match) => ({
      id: item.id,
      run: item.run,
      word: match[0],
    })),
  );
  const pool = BenchPoolSchema.parse({
    schemaVersion: 1,
    kind: "ideas",
    round: 1,
    seed,
    rubricVersion: runs[0]!.pool.rubricVersion,
    items: shuffled.map((item) => ({ id: item.id, content: item.content })),
  });
  const key = BenchKeySchema.parse({
    schemaVersion: 1,
    kind: "ideas",
    seed,
    runs: runs.map((entry) => entry.run),
    entries: shuffled.map((item) => ({ id: item.id, run: item.run, sourceId: item.sourceId })),
    stripped: { keys: [...STRIPPED_KEYS], oneRunKeys },
  });
  return { pool, key, residual };
}

export const benchFiles = (dir: string) => ({
  pool: path.join(dir, "pool.json"),
  key: path.join(dir, "key.json"),
  analysis: path.join(dir, "analysis.json"),
  judgeBrief: (n: number) => path.join(dir, `judge-${n}.md`),
  judgeReview: (n: number) => path.join(dir, `judge-${n}.json`),
});

export function writeMerge(dir: string, result: MergeResult): string[] {
  const files = benchFiles(dir);
  if (existsSync(files.pool) || existsSync(files.key))
    throw new BenchRefusal(`${dir} already holds a merged pool; choose another --out so no judged pool is replaced.`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(files.pool, `${JSON.stringify(result.pool, null, 2)}\n`);
  writeFileSync(files.key, `${JSON.stringify(result.key, null, 2)}\n`);
  return [files.pool, files.key];
}

export const DEFAULT_SWAP_TARGET = "a hired human doing the job in the owner's account";

/**
 * A judge's brief: the older run's idea-review brief exactly as it was issued for round 1, with the merged pool in
 * place of its own, and the benchmark's exceptions appended. The judges read the older run's strategy, so the newer
 * run's strategy fields stay out of sight.
 */
export function judgeBriefs(options: {
  rootDir: string;
  projectDir: string;
  poolPath: string;
  judges: number;
}): { file: string; text: string }[] {
  const { rootDir, projectDir, poolPath, judges } = options;
  if (!Number.isInteger(judges) || judges < 1)
    throw new BenchRefusal(`--judges must be a whole number of 1 or more, not ${judges}.`);
  const issued = path.join(pipelineDir(projectDir), "briefs", "idea-review-critic.md");
  if (!existsSync(issued))
    throw new BenchRefusal(
      `${path.relative(rootDir, issued)} is missing: the older run's director brief must be the one it issued.`,
    );
  const original = readFileSync(issued, "utf8");
  const header = original.split("\n", 1)[0] ?? "";
  if (!/\bideas round 1\b/.test(header))
    throw new BenchRefusal(
      `${path.relative(rootDir, issued)} is not the round-1 brief (${header.trim()}); a benchmark judges round 1.`,
    );
  const ownPool = path.relative(rootDir, poolFile(projectDir, "ideas"));
  if (!original.includes(ownPool))
    throw new BenchRefusal(
      `${path.relative(rootDir, issued)} does not name ${ownPool}, so the pool cannot be swapped in.`,
    );
  const pool = path.relative(rootDir, path.resolve(rootDir, poolPath));
  const dir = path.dirname(path.resolve(rootDir, poolPath));
  const strategy = StrategySchema.safeParse(
    existsSync(path.join(pipelineDir(projectDir), "strategy.json"))
      ? readJson(path.join(pipelineDir(projectDir), "strategy.json"))
      : undefined,
  );
  const target = (strategy.success && strategy.data.strongestAlternative?.name) || DEFAULT_SWAP_TARGET;
  const swapped = original.split(ownPool).join(pool);
  return Array.from({ length: judges }, (_, index) => {
    const n = index + 1;
    const output = path.relative(rootDir, benchFiles(dir).judgeReview(n));
    const exceptions = [
      "",
      `## Benchmark exceptions, judge ${n} (these override everything above)`,
      "",
      "This is a benchmark, not the chain: you are one of several fresh judges of one merged pool.",
      `- Write only ${output}, in the review's shape, with ids exactly as in the pool (M1, M2, ...). Write nothing under public/projects/.`,
      "- Do not run creative:rank, film:done or any other chain command. Judge every ordered pair among the six items with the highest mean of your scores.",
      `- Do not open pipeline/concepts/, pipeline/pools/, pipeline/rounds/, pipeline/stimuli/, pipeline/category-scan.json, ${path.relative(rootDir, benchFiles(dir).key)} or another judge's file.`,
      `- For every item add "swapPasses" (true or false) and "swapNote" (one line) beside its axes: true only if ${target} could NOT produce the film's key frames.`,
      `- Done when ${output} scores every item on every axis with a note, judges those pairs in both orders, lists sameImage, and has swapPasses and swapNote for every item.`,
    ];
    return { file: benchFiles(dir).judgeBrief(n), text: `${swapped.replace(/\n+$/, "")}\n${exceptions.join("\n")}\n` };
  });
}

const JudgeSchema = z.object({
  scores: z
    .array(
      z.object({
        id: z.string(),
        axes: z.record(z.string(), z.union([z.number(), z.object({ score: z.number() })])),
        swapPasses: z.boolean().optional(),
      }),
    )
    .min(1),
  sameImage: z.array(z.array(z.string())).optional(),
});

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
const round2 = (value: number) => Math.round(value * 100) / 100;

export type RunStats = {
  items: number;
  axes: Record<string, number>;
  itemMean: number;
  swapPasses: number;
  thresholdPasses: number;
  top6: number;
};
export type JudgeAnalysis = {
  judge: string;
  runs: Record<string, RunStats>;
  delta: Record<string, number>;
  sameImage: { withinRun: string[][]; crossRun: string[][] };
};
export type Agreement = {
  measure: string;
  deltas: number[];
  sign: "up" | "down" | "flat" | "mixed";
  min: number;
  max: number;
};

/** One judge against the key: per-run axis means, item means, swap and threshold passes, top-6 share and twins. Delta is the second run minus the first. */
export function analyseJudge(judge: string, raw: unknown, key: BenchKey): JudgeAnalysis {
  const review = JudgeSchema.parse(raw);
  const runOf = new Map(key.entries.map((entry) => [entry.id, entry.run]));
  const unknown = review.scores.filter((score) => !runOf.has(score.id)).map((score) => score.id);
  if (unknown.length) throw new BenchRefusal(`${judge} scores ${unknown.join(", ")}, which the key does not hold.`);
  const rows = review.scores.map((score, order) => {
    const axes = Object.fromEntries(
      Object.entries(score.axes).map(([axis, value]) => [axis, typeof value === "number" ? value : value.score]),
    );
    return {
      id: score.id,
      run: runOf.get(score.id)!,
      axes,
      mean: mean(Object.values(axes)),
      swap: score.swapPasses === true,
      order,
    };
  });
  const top = [...rows].sort((a, b) => b.mean - a.mean || a.order - b.order).slice(0, 6);
  const runs = Object.fromEntries(
    key.runs.map((run) => {
      const own = rows.filter((row) => row.run === run);
      const stats: RunStats = {
        items: own.length,
        axes: Object.fromEntries(IDEA_AXES.map((axis) => [axis, round2(mean(own.map((row) => row.axes[axis] ?? 0)))])),
        itemMean: round2(mean(own.map((row) => row.mean))),
        swapPasses: own.filter((row) => row.swap).length,
        thresholdPasses: own.filter((row) => passes(row.axes)).length,
        top6: top.filter((row) => row.run === run).length,
      };
      return [run, stats];
    }),
  );
  const [a, b] = key.runs.map((run) => runs[run]!) as [RunStats, RunStats];
  const delta = {
    ...Object.fromEntries(IDEA_AXES.map((axis) => [axis, round2(b.axes[axis]! - a.axes[axis]!)])),
    itemMean: round2(b.itemMean - a.itemMean),
  };
  const groups = review.sameImage ?? [];
  const crossRun = groups.filter((group) => new Set(group.map((id) => runOf.get(id))).size > 1);
  return {
    judge,
    runs,
    delta,
    sameImage: { withinRun: groups.filter((group) => !crossRun.includes(group)), crossRun },
  };
}

/** Whether the judges agree on the direction of each delta, with its spread. */
export function agreement(judges: JudgeAnalysis[]): Agreement[] {
  const measures = [...IDEA_AXES, "itemMean"];
  return measures.map((measure) => {
    const deltas = judges.map((judge) => judge.delta[measure]!);
    const signs = new Set(deltas.map((value) => Math.sign(value)));
    const sign = signs.size > 1 ? "mixed" : signs.has(1) ? "up" : signs.has(-1) ? "down" : "flat";
    return { measure, deltas, sign, min: Math.min(...deltas), max: Math.max(...deltas) };
  });
}

export function analyseDir(dir: string): { runs: string[]; judges: JudgeAnalysis[]; agreement: Agreement[] } {
  const files = benchFiles(dir);
  if (!existsSync(files.key)) throw new BenchRefusal(`${files.key} is missing: run --action merge first.`);
  const key = BenchKeySchema.parse(readJson(files.key));
  const judgeFiles = readdirSync(dir)
    .filter((name) => /^judge-\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (!judgeFiles.length) throw new BenchRefusal(`No judge-<n>.json in ${dir}: dispatch the judges first.`);
  const judges = judgeFiles.map((name) =>
    analyseJudge(name.replace(/\.json$/, ""), readJson(path.join(dir, name)), key),
  );
  const result = { runs: key.runs, judges, agreement: agreement(judges) };
  writeFileSync(files.analysis, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
