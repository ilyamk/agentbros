import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BenchKeySchema,
  DEFAULT_SWAP_TARGET,
  agreement,
  analyseJudge,
  judgeBriefs,
  mergePools,
  roundOnePool,
} from "../src/lib/film/bench";
import { IDEA_AXES } from "../src/lib/film/creative-rubric";
import { CreativePoolSchema, type CreativePool } from "../src/types/studio";
import { strategyFixture } from "./helpers/film-studio";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");

const idea = (run: string, n: number, extra: Record<string, unknown> = {}) => ({
  title: `${run} idea ${n}`,
  premise: `A ${run} premise. Swap test: a stand-in could not do it.`,
  coreImage: `A plain picture. It turns the usual cliché around. It ends on the product.`,
  risks: ["swap: survives in the stand-in", "a cliché nobody needs", "too slow"],
  ...extra,
});

const poolOf = (run: string, round: number, items: Record<string, unknown>[]): CreativePool =>
  CreativePoolSchema.parse({
    schemaVersion: 1,
    kind: "ideas",
    round,
    seed: run,
    rubricVersion: 1,
    items: items.map((content, index) => ({ id: `I${index + 1}`, content })),
  });

function root(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "creative-bench-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

test("merge strips method keys, one-run keys, swap and cliché text; shuffles by seed and keys the ids apart", () => {
  const older = poolOf("old", 1, [idea("old", 1), idea("old", 2, { stimulus: { method: "zwicky" } })]);
  const newer = poolOf("new", 1, [
    idea("new", 1, { proofFrame: { proof: "p", where: "hook" }, lifeWithout: "x", onlyNew: "a newer field" }),
    idea("new", 2, { method: "triz", onlyNew: "b" }),
  ]);
  const result = mergePools(
    [
      { run: "old", pool: older },
      { run: "new", pool: newer },
    ],
    "s1",
  );
  const text = JSON.stringify(result.pool);
  assert.doesNotMatch(text, /stimulus|proofFrame|lifeWithout|"method"|onlyNew|Swap test|swap:|clich/i);
  assert.match(text, /too slow/, "an ordinary risk stays");
  assert.match(text, /A plain picture\. It ends on the product\./, "only the sentence with the cliché goes");
  assert.deepEqual(
    result.pool.items.map((item) => item.id),
    ["M1", "M2", "M3", "M4"],
  );
  assert.deepEqual(result.key.stripped.oneRunKeys, ["onlyNew"]);
  assert.deepEqual(result.key.runs, ["old", "new"]);
  assert.deepEqual(
    new Set(result.key.entries.map((entry) => `${entry.run}/${entry.sourceId}`)),
    new Set(["old/I1", "old/I2", "new/I1", "new/I2"]),
  );
  assert.deepEqual(
    mergePools(
      [
        { run: "old", pool: older },
        { run: "new", pool: newer },
      ],
      "s1",
    ).key,
    result.key,
    "the same seed, the same order",
  );
  assert.notDeepEqual(
    mergePools(
      [
        { run: "old", pool: older },
        { run: "new", pool: newer },
      ],
      "another",
    ).key.entries.map((entry) => entry.sourceId + entry.run),
    result.key.entries.map((entry) => entry.sourceId + entry.run),
  );

  const leaky = mergePools(
    [
      {
        run: "old",
        pool: poolOf("old", 1, [idea("old", 1, { premise: "We used SCAMPER here, then the white space." })]),
      },
      { run: "new", pool: newer },
    ],
    "s1",
  );
  assert.deepEqual(
    leaky.residual.map((hit) => hit.word.toLowerCase()).sort(),
    ["scamper", "white space"],
    "residual method words are reported, not hidden",
  );
  assert.throws(() => mergePools([{ run: "old", pool: older }], "s"), /exactly two runs/);
});

test("the round-1 pool comes from the archived round, else the current pool, which must be round 1", (t) => {
  const project = path.join(root(t), "p");
  writeJson(path.join(project, "pipeline/pools/ideas.json"), poolOf("p", 2, [idea("p", 1)]));
  assert.throws(() => roundOnePool(project), /round 2; a benchmark compares round 1/);
  writeJson(path.join(project, "pipeline/rounds/ideas-1/pool.json"), poolOf("p", 1, [idea("p", 1)]));
  assert.equal(roundOnePool(project).pool.round, 1);
});

test("judge briefs keep the older run's issued brief, swap the pool in, and add the benchmark's exceptions", (t) => {
  const repo = root(t);
  const project = path.join(repo, "public/projects/old");
  const ownPool = "public/projects/old/pipeline/pools/ideas.json";
  const issued = `# Film chain: creative director, ideas round 1 (step idea-review, project old)\n\n## Inputs, and nothing else\n\n- ${ownPool}: what you judge\n\n## Outputs\n\n- review, targetSha256 the SHA-256 of ${ownPool}\n`;
  mkdirSync(path.join(project, "pipeline/briefs"), { recursive: true });
  writeFileSync(path.join(project, "pipeline/briefs/idea-review-critic.md"), issued);
  const briefs = judgeBriefs({ rootDir: repo, projectDir: project, poolPath: "bench/m/pool.json", judges: 3 });
  assert.deepEqual(
    briefs.map((brief) => path.relative(repo, brief.file)),
    ["bench/m/judge-1.md", "bench/m/judge-2.md", "bench/m/judge-3.md"],
  );
  const [first] = briefs;
  assert.ok(
    first!.text.startsWith(issued.replaceAll(ownPool, "bench/m/pool.json").trimEnd()),
    "the issued brief, unchanged but for the pool",
  );
  assert.ok(!first!.text.includes(ownPool));
  for (const needed of [
    "Write only bench/m/judge-1.json",
    "Write nothing under public/projects/",
    "Do not run creative:rank, film:done",
    "pipeline/category-scan.json",
    "bench/m/key.json",
    '"swapPasses"',
    `true only if ${DEFAULT_SWAP_TARGET} could NOT produce the film's key frames`,
  ])
    assert.ok(first!.text.includes(needed), needed);

  writeJson(path.join(project, "pipeline/strategy.json"), {
    ...strategyFixture(),
    strongestAlternative: { name: "a paper diary", whyConsidered: "free" },
  });
  assert.match(
    judgeBriefs({ rootDir: repo, projectDir: project, poolPath: "bench/m/pool.json", judges: 1 })[0]!.text,
    /true only if a paper diary could NOT produce/,
  );

  writeFileSync(
    path.join(project, "pipeline/briefs/idea-review-critic.md"),
    issued.replace("ideas round 1", "ideas round 2"),
  );
  assert.throws(
    () => judgeBriefs({ rootDir: repo, projectDir: project, poolPath: "bench/m/pool.json", judges: 3 }),
    /not the round-1 brief/,
  );
});

const judge = (
  scores: Record<string, { all: number; distinctiveness?: number; swap?: boolean }>,
  sameImage: string[][] = [],
) => ({
  scores: Object.entries(scores).map(([id, item]) => ({
    id,
    axes: Object.fromEntries(
      IDEA_AXES.map((axis) => [
        axis,
        { score: axis === "distinctiveness" ? (item.distinctiveness ?? item.all) : item.all, note: "n" },
      ]),
    ),
    swapPasses: item.swap ?? false,
    swapNote: "n",
  })),
  sameImage,
});

test("analysis: per-run means and delta, swap and threshold passes, top-6 share, twins split by run, and agreement across judges", () => {
  const key = BenchKeySchema.parse({
    schemaVersion: 1,
    kind: "ideas",
    seed: "s",
    runs: ["old", "new"],
    entries: ["M1", "M2", "M3", "M4"].map((id, index) => ({
      id,
      run: index < 2 ? "old" : "new",
      sourceId: `I${index}`,
    })),
    stripped: { keys: [], oneRunKeys: [] },
  });
  const first = analyseJudge(
    "judge-1",
    judge(
      {
        M1: { all: 3 },
        M2: { all: 4, distinctiveness: 2 },
        M3: { all: 4, swap: true },
        M4: { all: 4, distinctiveness: 5, swap: true },
      },
      [
        ["M1", "M2"],
        ["M2", "M3"],
      ],
    ),
    key,
  );
  assert.equal(first.runs["old"]!.axes["distinctiveness"], 2.5);
  assert.equal(first.runs["new"]!.axes["distinctiveness"], 4.5);
  assert.equal(first.delta["distinctiveness"], 2);
  assert.deepEqual([first.runs["old"]!.swapPasses, first.runs["new"]!.swapPasses], [0, 2]);
  assert.deepEqual(
    [first.runs["old"]!.thresholdPasses, first.runs["new"]!.thresholdPasses],
    [0, 2],
    "v1 rule: every axis 3 or more, truth 4 or more, mean 3.6",
  );
  assert.deepEqual([first.runs["old"]!.top6, first.runs["new"]!.top6], [2, 2]);
  assert.deepEqual(first.sameImage, { withinRun: [["M1", "M2"]], crossRun: [["M2", "M3"]] });

  const second = analyseJudge(
    "judge-2",
    judge({ M1: { all: 4 }, M2: { all: 4 }, M3: { all: 4 }, M4: { all: 3 } }),
    key,
  );
  const rows = Object.fromEntries(agreement([first, second]).map((row) => [row.measure, row]));
  assert.deepEqual(
    [rows["distinctiveness"]!.sign, rows["distinctiveness"]!.min, rows["distinctiveness"]!.max],
    ["mixed", -0.5, 2],
  );
  assert.equal(rows["truth"]!.sign, "mixed");
  assert.throws(() => analyseJudge("judge-3", judge({ M9: { all: 3 } }), key), /M9, which the key does not hold/);
});

test("creative:bench walks merge, brief and analyse through the CLI on synthetic runs", (t) => {
  const repo = root(t);
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/creative-bench.ts"), ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
    });
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "one JSON line");
    return {
      status: result.status,
      json: JSON.parse(lines[0]!) as { ok: boolean; error?: string; outputs: string[]; metadata: Record<string, any> },
    };
  };
  for (const run of ["old", "new"]) {
    const dir = path.join(repo, "public/projects", run, "pipeline");
    writeJson(path.join(dir, "brief.json"), { renderMode: "bespoke" });
    writeJson(path.join(dir, "pools/ideas.json"), poolOf(run, 1, [idea(run, 1), idea(run, 2)]));
  }
  mkdirSync(path.join(repo, "public/projects/old/pipeline/briefs"), { recursive: true });
  writeFileSync(
    path.join(repo, "public/projects/old/pipeline/briefs/idea-review-critic.md"),
    "# Film chain: creative director, ideas round 1\n\n- public/projects/old/pipeline/pools/ideas.json: what you judge\n",
  );
  const merged = cli("--action", "merge", "--runs", "old,new", "--seed", "s", "--out", "bench/m");
  assert.equal(merged.status, 0, JSON.stringify(merged.json));
  assert.deepEqual(merged.json.metadata["perRun"], { old: 2, new: 2 });
  assert.equal(
    cli("--action", "merge", "--runs", "old,new", "--seed", "s", "--out", "bench/m").json.error,
    "VALIDATION",
    "a merged pool is never replaced",
  );
  const briefs = cli("--action", "brief", "--project", "old", "--pool", "bench/m/pool.json", "--judges", "2");
  assert.deepEqual(briefs.json.outputs, ["bench/m/judge-1.md", "bench/m/judge-2.md"]);
  const key = BenchKeySchema.parse(JSON.parse(readFileSync(path.join(repo, "bench/m/key.json"), "utf8")));
  const scores = Object.fromEntries(key.entries.map((entry) => [entry.id, { all: entry.run === "new" ? 4 : 3 }]));
  for (const n of [1, 2]) writeJson(path.join(repo, `bench/m/judge-${n}.json`), judge(scores));
  const analysed = cli("--action", "analyse", "--dir", "bench/m");
  assert.equal(analysed.status, 0, JSON.stringify(analysed.json));
  assert.equal(
    analysed.json.metadata["agreement"].find((row: { measure: string }) => row.measure === "itemMean").sign,
    "up",
  );
  assert.equal(cli("--action", "merge", "--runs", "old", "--seed", "s", "--out", "bench/x").json.error, "VALIDATION");
});
