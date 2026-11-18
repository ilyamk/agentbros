import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FILM_CHAIN, ProductTruthSchema, chainProblems } from "../src/lib/film/chain";
import { buildBrief, materialLines } from "../src/lib/film/brief";
import {
  DONE_CHECKS,
  approveStep,
  proofClaimProblems,
  baseTokens,
  deriveChain,
  nextAction,
  openFilmProject,
  sealStep,
  type FilmProject,
} from "../src/lib/film/state";
import {
  buildPool,
  computeReview,
  laneFile,
  projectRubricVersion,
  rubricRecordFile,
  pickIdeas,
  pickScript,
  poolFile,
  rankLatest,
  readingOverruns,
  reviewFile,
  StudioRefusal,
} from "../src/lib/film/studio";
import {
  CategoryScanSchema,
  CreativePoolSchema,
  CreativeReviewSchema,
  PoolKeySchema,
  StrategySchema,
} from "../src/types/studio";
import { TEAM_METHODS, methodFor } from "../src/lib/film/studio";
import { SCRIPT_VARIANTS, TEAM_STANCES } from "../src/types/studio";
import { IDEA_AXES, SCRIPT_AXES } from "../src/lib/film/creative-rubric";
import {
  categoryScanFixture,
  skipDiscovery,
  strategyFixture,
  toConceptApproved,
  writeCategoryScan,
  toScriptPicked,
  writeBoards,
  writeReview,
  writeStrategy,
  writeTeams,
  writeVariants,
} from "./helpers/film-studio";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const ID = "studio";

function cli(root: string, script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const line = result.stdout.trim().split("\n").at(-1) ?? "{}";
  return {
    status: result.status,
    json: JSON.parse(line) as {
      ok: boolean;
      error?: string;
      message?: string;
      outputs: string[];
      metadata: Record<string, any>;
    },
  };
}

function setup(t: TestContext, extra: { brief?: Record<string, unknown>; truth?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "film-studio-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(cli(root, "scripts/film-init.ts", "--project", ID).status, 0);
  const dir = path.join(root, "public/projects", ID);
  const pipeline = path.join(dir, "pipeline");
  const project = (): FilmProject => openFilmProject(dir, { rootDir: root });
  const place = (...files: string[]) =>
    files.forEach((file) => copyFileSync(path.join(FIXTURES, file), path.join(pipeline, file)));
  const seal = (id: string) => sealStep(project(), id);
  const approve = (id: string) => approveStep(project(), id, `yes to ${id}`);
  const status = (id: string) => deriveChain(project()).steps.find((step) => step.id === id)!;
  const merge = (file: string, fields?: Record<string, unknown>) =>
    fields &&
    writeFileSync(
      path.join(pipeline, file),
      JSON.stringify({ ...JSON.parse(readFileSync(path.join(pipeline, file), "utf8")), ...fields }),
    );
  place("brief.json");
  merge("brief.json", extra.brief);
  seal("intake");
  approve("intake");
  place("product-truth.json");
  merge("product-truth.json", extra.truth);
  seal("truth");
  place("film-targets.json");
  seal("reference");
  return { root, dir, pipeline, project, place, seal, approve, status };
}

type Film = ReturnType<typeof setup>;

function toStrategyApproved(film: Film, strategy: Record<string, unknown> = {}) {
  writeStrategy(film.dir, strategy);
  film.seal("strategy");
  film.approve("strategy");
  skipDiscovery(film.dir);
}

function toIdeasPooled(
  film: Film,
  strategy: Record<string, unknown> = {},
  teams: Parameters<typeof writeTeams>[3] = {},
) {
  toStrategyApproved(film, strategy);
  writeTeams(film.dir, 1, 4, teams);
  film.seal("ideas");
  buildPool(film.dir, ID, "ideas");
  film.seal("idea-review");
}

function toMusicApproved(film: Film) {
  toConceptApproved(film, ID);
  mkdirSync(path.join(film.dir, "music"), { recursive: true });
  copyFileSync(path.join(FIXTURES, "track.wav"), path.join(film.dir, "music/track.wav"));
  film.place("music-shortlist.json", "music-decision.json");
  film.seal("music");
  film.approve("music");
  film.place("audio-map.json");
  film.seal("audio-map");
}

// --- The chain as data ---

test("the creative front: strategy before the teams, the blind review gates the concept, variants before the script", () => {
  const ids = FILM_CHAIN.map((step) => step.id);
  const at = (id: string) => ids.indexOf(id);
  assert.ok(
    at("reference") < at("strategy") &&
      at("strategy") < at("ideas") &&
      at("ideas") < at("idea-review") &&
      at("idea-review") < at("concept"),
  );
  assert.ok(
    at("audio-map") < at("script-variants") &&
      at("script-variants") < at("script-review") &&
      at("script-review") < at("script"),
  );
  for (const id of ["idea-review", "script-review"]) {
    const step = FILM_CHAIN[at(id)]!;
    assert.equal(step.gate, "critic", "a review reuses the critic gate");
    assert.equal(step.critic!.agent, "creative-director");
    assert.equal(step.critic!.pack, false);
  }
  assert.deepEqual(chainProblems(), []);
  const broken = FILM_CHAIN.map((step) =>
    step.id === "idea-review" ? { ...step, critic: { ...step.critic!, fixBy: "music" } } : step,
  );
  assert.ok(chainProblems(broken).some((problem) => /fixBy names no fan-out step/.test(problem)));
});

test("the stances and variants in code are the ones the references file describes", () => {
  const text = readFileSync(path.join(REPO, ".agents/skills/creative-studio/references/creative-teams.md"), "utf8");
  const headings = [...text.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, [...TEAM_STANCES, ...SCRIPT_VARIANTS]);
});

test("agent definitions stay under 6 KiB", () => {
  const agents = readdirSync(path.join(REPO, ".agents/agents")).filter(
    (name) => name.endsWith(".md") && name !== "README.md",
  );
  assert.ok(agents.includes("creative-director.md"));
  for (const agent of agents) {
    const size = readFileSync(path.join(REPO, ".agents/agents", agent)).byteLength;
    assert.ok(size <= 6 * 1024, `${agent}: ${size} B`);
  }
});

test("product truth's sourceNotes are typed: a wrong shape fails validation", () => {
  const truth = JSON.parse(readFileSync(path.join(FIXTURES, "product-truth.json"), "utf8"));
  assert.ok(
    ProductTruthSchema.safeParse({
      ...truth,
      sourceNotes: [{ path: "locales/ru/start.ftl", role: "start screen", readToEnd: true }],
    }).success,
  );
  assert.equal(
    ProductTruthSchema.safeParse({
      ...truth,
      sourceNotes: [{ path: "locales/ru/start.ftl", role: "start screen", readToEnd: "yes" }],
    }).success,
    false,
  );
});

test("a strategy may waive a secondary type's QA line, with the brief limit that wins", () => {
  const strategy = { ...strategyFixture() };
  assert.deepEqual(StrategySchema.parse(strategy).waivers, []);
  const waived = StrategySchema.parse({
    ...strategy,
    waivers: [{ rule: "Real captures, not mock-ups", reason: "The brief allows a synthetic interface only" }],
  });
  assert.equal(waived.waivers[0]!.rule, "Real captures, not mock-ups");
  assert.equal(
    StrategySchema.safeParse({ ...strategy, waivers: [{ rule: "x" }] }).success,
    false,
    "a waiver needs its reason",
  );
});

test("every lesson names the rubric axes it bears on, so the creative director can use it", () => {
  const text = readFileSync(path.join(REPO, "design-reference/creative-lessons.md"), "utf8");
  const lessons = text.split("## Lessons")[1]!.split(/^### /m).slice(1);
  assert.ok(lessons.length >= 1);
  const known = new Set([...IDEA_AXES, ...SCRIPT_AXES, "none"]);
  for (const lesson of lessons) {
    const axes = /^- \*\*Rubric axis:\*\* (.+)\.$/m.exec(lesson)?.[1]?.split(/,\s*/);
    assert.ok(axes?.length, `${lesson.split("\n")[0]}: no rubric axis`);
    for (const axis of axes!) assert.ok(known.has(axis), `${axis} is not a rubric axis`);
  }
});

// --- Strategy ---

test("the strategy must repeat the brief's film type and is a user gate", (t) => {
  const film = setup(t);
  writeStrategy(film.dir, { filmType: "footage" });
  assert.throws(() => film.seal("strategy"), /strategy.filmType is footage/);
  writeStrategy(film.dir);
  film.seal("strategy");
  const next = nextAction(film.project());
  assert.deepEqual([next.action, next.step], ["ask", "strategy"]);
  assert.ok(next.show!.some((file) => file.endsWith("strategy.md")));
});

// --- Pool ---

test("the pool is blind and deterministic: no author, shuffled by a seed, the key kept apart", (t) => {
  const film = setup(t);
  toStrategyApproved(film);
  writeTeams(film.dir, 1, 5);
  film.seal("ideas");
  const first = buildPool(film.dir, ID, "ideas", { write: false });
  const again = buildPool(film.dir, ID, "ideas", { write: false });
  assert.equal(JSON.stringify(first.pool), JSON.stringify(again.pool), "the same seed gives the same bytes");
  assert.equal(first.pool.items.length, 15);
  assert.deepEqual(
    first.pool.items.map((item) => item.id),
    Array.from({ length: 15 }, (_, index) => `I${index + 1}`),
  );
  const text = JSON.stringify(first.pool);
  assert.doesNotMatch(text, /"team"|"author"|"sourceId"|concepts\//, "authorship is stripped");
  const order = first.pool.items.map((item) => item.content["title"]);
  assert.notDeepEqual(order, [...order].sort(), "shuffled, not in team order");
  const other = buildPool(film.dir, ID, "ideas", { write: false, seed: "another" });
  assert.notDeepEqual(
    other.pool.items.map((item) => item.content["title"]),
    order,
  );
  for (const entry of first.key.entries)
    assert.equal(
      first.pool.items.find((item) => item.id === entry.id)!.content["title"],
      `${entry.author} ${entry.sourceId}`,
      "the key maps every id back",
    );
  writeFileSync(
    laneFile(film.dir, "ideas", "provocation"),
    JSON.stringify({ schemaVersion: 1, team: "provocation", round: 1, ideas: [] }),
  );
  assert.throws(() => buildPool(film.dir, ID, "ideas"), StudioRefusal, "a team with too few ideas holds the round");
});

// --- Review, threshold and loop-back ---

test("a review is ranked by code, both orders must agree, and a hand-written verdict is refused", (t) => {
  const film = setup(t);
  toIdeasPooled(film);
  const pool = JSON.parse(readFileSync(poolFile(film.dir, "ideas"), "utf8")) as { items: { id: string }[] };
  const [a, b] = [pool.items[0]!.id, pool.items[1]!.id];
  // b wins only when shown first: position bias, dropped. a beats everyone else in both orders.
  writeReview(film.dir, "ideas", 1, () => 4, {
    pairWinner: (first, second) => (first === b && second === a ? b : first === a || second === a ? a : "tie"),
  });
  const brokenLater = JSON.parse(readFileSync(reviewFile(film.dir, "ideas", 1), "utf8"));
  assert.equal(nextAction(film.project()).commands?.[0], `pnpm creative:rank --project ${ID} --kind ideas`);
  const { computed } = rankLatest(film.dir, "ideas");
  assert.equal(computed.ranking[0], a);
  assert.equal(computed.verdict, "pass");
  assert.equal(film.status("idea-review").status, "done");
  writeFileSync(
    reviewFile(film.dir, "ideas", 1),
    JSON.stringify({
      ...brokenLater,
      ranking: [...computed.ranking].reverse(),
      passing: computed.passing,
      top: [...computed.ranking].reverse().slice(0, 3),
      verdict: "pass",
    }),
  );
  assert.equal(film.status("idea-review").status, "invalid", "a ranking that code would not write is refused");
  const missing = { ...brokenLater, pairs: brokenLater.pairs.slice(1) };
  writeFileSync(reviewFile(film.dir, "ideas", 1), JSON.stringify(missing));
  assert.throws(
    () => rankLatest(film.dir, "ideas"),
    /is not judged/,
    "every ordered pair among the top must be judged",
  );
  const fewArguments = { ...brokenLater, against: [] };
  writeFileSync(reviewFile(film.dir, "ideas", 1), JSON.stringify(fewArguments));
  assert.throws(
    () => rankLatest(film.dir, "ideas"),
    /add an argument against .*Nothing was written/,
    "the director learns the computed top before anything is written",
  );
  assert.equal(JSON.parse(readFileSync(reviewFile(film.dir, "ideas", 1), "utf8")).verdict, undefined);
  assert.equal(
    nextAction(film.project()).commands?.[0],
    `pnpm creative:rank --project ${ID} --kind ideas`,
    "an incomplete review goes back to rank and its director, never to creative:pool",
  );
});

test("below the threshold the round goes back to the teams with the notes, at most twice, then to the user", (t) => {
  const film = setup(t);
  toIdeasPooled(film);
  writeReview(film.dir, "ideas", 1, () => 3, { notes: ["no idea shows the product working before second 6"] });
  rankLatest(film.dir, "ideas");
  let next = nextAction(film.project());
  assert.deepEqual([next.action, next.step], ["dispatch", "ideas"], "back to the teams, not to the user");
  assert.equal(next.dispatches!.length, 3);
  const brief = buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt;
  assert.match(brief, /Write round 2/);
  assert.match(brief, /creative-review\/ideas-round-1\.json/, "the team brief carries the director's notes");
  assert.throws(() => buildBrief(film.project(), "ideas", { lane: "human-moment" }), /not one of this film's teams/);

  const round1 = path.join(film.pipeline, "rounds/ideas-1");
  const kept = JSON.parse(readFileSync(path.join(round1, "round.json"), "utf8"));
  assert.deepEqual(
    [kept.round, kept.review, kept.judged],
    [1, "pipeline/creative-review/ideas-round-1.json", "pipeline/creative-review/judged/ideas-round-1.json"],
    "the round's files line up with its review and judged record",
  );
  assert.ok(existsSync(path.join(film.dir, kept.judged)));
  assert.ok(kept.authors.every((author: { kept: boolean }) => author.kept));
  const metaphorRound1 = readFileSync(path.join(film.pipeline, "concepts/metaphor.json"), "utf8");
  assert.equal(readFileSync(path.join(round1, "authors/metaphor.json"), "utf8"), metaphorRound1);
  assert.equal(readFileSync(path.join(round1, "pool.json"), "utf8"), readFileSync(poolFile(film.dir, "ideas"), "utf8"));

  writeTeams(film.dir, 2);
  assert.equal(film.status("ideas").status, "unsealed");
  film.seal("ideas");
  buildPool(film.dir, ID, "ideas");
  assert.equal(
    readFileSync(path.join(round1, "authors/metaphor.json"), "utf8"),
    metaphorRound1,
    "round 2 overwrote the team file; round 1's copy stands",
  );
  assert.equal(JSON.parse(readFileSync(path.join(round1, "pool.json"), "utf8")).round, 1);
  assert.throws(
    () => buildBrief(film.project(), "idea-review", { role: "critic" }),
    /nothing for a critic yet\. Run `pnpm film:done --project studio --step idea-review` first/,
    "a pool built without its receipt names the command",
  );
  film.seal("idea-review");
  next = nextAction(film.project());
  assert.deepEqual([next.agent, next.fresh], ["creative-director", true], "a new director judges round 2");
  assert.match(buildBrief(film.project(), "idea-review", { role: "critic" }).prompt, /ideas-round-2\.json/);
  writeReview(film.dir, "ideas", 2, (index) => (index === 0 ? 4 : 3), { notes: ["closer; the hook still waits"] });
  rankLatest(film.dir, "ideas");
  assert.equal(film.status("idea-review").status, "done", "one idea passes: the round passes");
  assert.ok(existsSync(path.join(film.pipeline, "rounds/ideas-2/authors/provocation.json")));

  writeReview(film.dir, "ideas", 2, () => 3, { notes: ["no progress"] });
  assert.throws(
    () => rankLatest(film.dir, "ideas"),
    /--rescore-reason/,
    "a second judgement of a ranked round is a rescore",
  );
  rankLatest(film.dir, "ideas", { rescoreReason: "the round judged again" });
  next = nextAction(film.project());
  assert.deepEqual(
    [next.action, next.step],
    ["ask", "idea-review"],
    "no higher best mean than round 1: the user decides",
  );
  assert.match(next.question!, /No progress/);
  assert.match(next.benchmarkProxy!, /film:approve --project studio --step idea-review --proxy benchmark/);
});

test("a rescore after the verdict is refused without a reason, recorded with its diff, and shown to the user", (t) => {
  const film = setup(t);
  toIdeasPooled(film);
  writeReview(film.dir, "ideas", 1, () => 4);
  rankLatest(film.dir, "ideas");
  const file = reviewFile(film.dir, "ideas", 1);
  const ranked = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(ranked.judged.verdict, "pass");
  const id = ranked.scores[0].id as string;
  ranked.scores[0].axes[IDEA_AXES[0]].score = 5;
  writeFileSync(file, JSON.stringify(ranked));
  assert.equal(film.status("idea-review").status, "invalid", "changed scores no longer stand as ranked");
  assert.throws(
    () => rankLatest(film.dir, "ideas"),
    new RegExp(`${id} ${IDEA_AXES[0]} 4→5.*--rescore-reason.*Nothing was written`),
  );
  assert.equal(JSON.parse(readFileSync(file, "utf8")).rescoredAfterVerdict, undefined);

  const rescored = cli(
    film.root,
    "scripts/creative-rank.ts",
    "--project",
    ID,
    "--kind",
    "ideas",
    "--rescore-reason",
    "misread the hook",
  );
  assert.equal(rescored.json.ok, true, JSON.stringify(rescored.json));
  assert.equal(rescored.json.metadata["rescoredAfterVerdict"], true);
  const entry = JSON.parse(readFileSync(file, "utf8")).rescoredAfterVerdict;
  assert.equal(entry.length, 1);
  assert.deepEqual(entry[0].changes, [{ id, axis: IDEA_AXES[0], from: 4, to: 5 }]);
  assert.equal(entry[0].reason, "misread the hook");
  assert.equal(entry[0].pairsOrSameImageChanged, false);
  assert.equal(film.status("idea-review").status, "done");
  rankLatest(film.dir, "ideas");
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).rescoredAfterVerdict.length,
    1,
    "an unchanged rerun records nothing",
  );

  const rewritten = { ...JSON.parse(readFileSync(file, "utf8")) };
  for (const key of ["ranking", "passing", "top", "verdict", "judged", "rescoredAfterVerdict"]) delete rewritten[key];
  rewritten.scores[0].axes[IDEA_AXES[1]].score = 5;
  writeFileSync(file, JSON.stringify(rewritten));
  assert.equal(film.status("idea-review").status, "invalid");
  assert.throws(
    () => rankLatest(film.dir, "ideas"),
    /--rescore-reason/,
    "a review rewritten without its ranking is still checked against rank's own record",
  );
  rewritten.scores[0].axes[IDEA_AXES[1]].score = 4;
  writeFileSync(file, JSON.stringify(rewritten));
  rankLatest(film.dir, "ideas");
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).rescoredAfterVerdict.length,
    1,
    "the record survives the rewrite",
  );

  const status = cli(film.root, "scripts/film-status.ts", "--project", ID);
  assert.match(
    status.json.metadata["rescoredAfterVerdict"][0],
    /ideas round 1 was rescored after its verdict.*Reason: misread the hook/,
  );
  pickIdeas(film.dir);
  writeBoards(film.dir);
  film.seal("concept");
  const next = nextAction(film.project());
  assert.deepEqual([next.action, next.step], ["ask", "concept"]);
  assert.match(next.question!, /Tell the user: ideas round 1 was rescored after its verdict/);
});

test("ideas the director marks sameImage never share the top: the next one takes the place", (t) => {
  const film = setup(t);
  toIdeasPooled(film);
  writeReview(film.dir, "ideas", 1, (index) => (index < 2 ? 5 : 4));
  const file = reviewFile(film.dir, "ideas", 1);
  const pool = CreativePoolSchema.parse(JSON.parse(readFileSync(poolFile(film.dir, "ideas"), "utf8")));
  const review = JSON.parse(readFileSync(file, "utf8"));
  const { ranking } = computeReview(CreativeReviewSchema.parse(review), pool);
  const [first, second, third, fourth] = ranking as [string, string, string, string];
  writeFileSync(file, JSON.stringify({ ...review, sameImage: [["I99", first]] }));
  assert.throws(() => rankLatest(film.dir, "ideas"), /sameImage names I99/);
  writeFileSync(file, JSON.stringify({ ...review, sameImage: [[second, first]] }));
  const { computed } = rankLatest(film.dir, "ideas");
  assert.deepEqual(computed.top, [first, third, fourth], "the twin is skipped, the next idea enters");
  assert.deepEqual(computed.ranking, ranking, "the frozen rubric's ranking is untouched");
  const { concept } = pickIdeas(film.dir);
  assert.deepEqual(
    concept.candidates.map((candidate) => candidate.id),
    [first, third, fourth],
  );
  assert.match(
    concept.rejected.find((item) => item.id === second)!.reason,
    new RegExp(`Rank 2 .*the same image as ${first}`),
  );

  const context = { project: film.project(), tokens: baseTokens(film.project()), silence: false };
  assert.deepEqual(DONE_CHECKS["ideas-differ"](context), []);
  const conceptFile = path.join(film.pipeline, "concept.json");
  const picked = JSON.parse(readFileSync(conceptFile, "utf8"));
  picked.candidates[1].id = second;
  writeFileSync(conceptFile, JSON.stringify(picked));
  assert.match(
    DONE_CHECKS["ideas-differ"](context).join(" "),
    new RegExp(`${second} and ${first} are one image`),
    "different words, one picture: still twins",
  );
});

test("idea briefs carry the existing material, the library catalogue and, with no budget, the rule that nothing new is made", (t) => {
  const film = setup(t, {
    brief: { budgetUsd: 0, bespoke: { realData: [{ what: "Five role names", mayShow: true }] } },
    truth: {
      material: [
        { what: "Bot replies in Russian", where: "start.ftl", state: "exists" },
        { what: "Real chat screens", state: "missing" },
      ],
    },
  });
  toStrategyApproved(film);
  const briefFile = path.join(film.pipeline, "brief.json");
  const team = buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt;
  for (const needed of [
    "## Existing material and budget",
    "- exists: Bot replies in Russian (start.ftl)",
    "- missing: Real chat screens",
    "- real data from the brief: Five role names",
    "docs/library/catalogue.json",
    "Budget 0: the picture is built only from the motion library",
  ])
    assert.ok(team.includes(needed), needed);

  const catalogue = path.join(film.root, "docs/library/catalogue.json");
  mkdirSync(path.dirname(catalogue), { recursive: true });
  writeFileSync(catalogue, "[]");
  writeTeams(film.dir, 1);
  film.seal("ideas");
  writeFileSync(catalogue, "[1]");
  assert.equal(
    film.status("ideas").status,
    "done",
    "the catalogue is read, not tracked: another agent's library work never stales the ideas",
  );

  buildPool(film.dir, ID, "ideas");
  film.seal("idea-review");
  const director = buildBrief(film.project(), "idea-review", { role: "critic" }).prompt;
  for (const needed of [
    "score feasibility against this",
    "- missing: Real chat screens",
    "- docs/library/catalogue.json: the motion library catalogue",
    "Budget 0",
    '"sameImage", e.g. [["I5", "I7"]]',
    "--rescore-reason",
  ])
    assert.ok(director.includes(needed), needed);

  writeFileSync(briefFile, JSON.stringify({ ...JSON.parse(readFileSync(briefFile, "utf8")), budgetUsd: 40 }));
  assert.match(
    materialLines(film.project(), baseTokens(film.project())).join("\n"),
    /Budget 40 USD: .*needs the user's yes at the material step/,
  );
});

test("creative:pool keeps the previous round's pool and key when no rank archived it", (t) => {
  const film = setup(t);
  toIdeasPooled(film);
  writeReview(film.dir, "ideas", 1, () => 3, { notes: ["again"] });
  rankLatest(film.dir, "ideas");
  rmSync(path.join(film.pipeline, "rounds"), { recursive: true });
  writeTeams(film.dir, 2);
  film.seal("ideas");
  buildPool(film.dir, ID, "ideas");
  const kept = JSON.parse(readFileSync(path.join(film.pipeline, "rounds/ideas-1/round.json"), "utf8"));
  assert.equal(JSON.parse(readFileSync(path.join(film.pipeline, "rounds/ideas-1/pool.json"), "utf8")).round, 1);
  assert.ok(
    kept.authors.every((author: { kept: boolean }) => !author.kept),
    "the authors had already rewritten their files: recorded as not kept, never copied wrong",
  );
});

// --- Discovery and creativity methods ---

test("a category scan needs at least eight examples and eight clichés, each example read or inferred", () => {
  assert.ok(CategoryScanSchema.safeParse(categoryScanFixture()).success);
  const fixture = categoryScanFixture();
  assert.equal(CategoryScanSchema.safeParse({ ...fixture, examples: fixture.examples.slice(0, 7) }).success, false);
  assert.equal(CategoryScanSchema.safeParse({ ...fixture, cliches: fixture.cliches.slice(0, 7) }).success, false);
  assert.equal(
    CategoryScanSchema.safeParse({
      ...fixture,
      examples: fixture.examples.map((example) => ({ ...example, evidence: "guessed" })),
    }).success,
    false,
  );
});

test("each team gets its own method, the same every time; another stance falls back to random entry", () => {
  assert.deepEqual(TEAM_METHODS, {
    metaphor: "zwicky",
    "product-in-use": "scamper",
    provocation: "triz",
    "human-moment": "synectics",
  });
  assert.equal(new Set(TEAM_STANCES.map(methodFor)).size, TEAM_STANCES.length);
  assert.equal(methodFor("another-stance"), "random-entry");
});

test("with a scan, the team brief lists the clichés, dontTake and white space, its method and stimuli file; without, none of it", (t) => {
  const film = setup(t);
  toStrategyApproved(film);
  const plain = buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt;
  assert.doesNotMatch(plain, /## Category conventions and clichés|## Your method|## Method /);
  assert.ok(!existsSync(path.join(film.pipeline, "stimuli")), "no stimuli without a scan");

  rmSync(path.join(film.pipeline, "skips"), { recursive: true });
  writeCategoryScan(film.dir);
  film.seal("discovery");
  const first = buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt;
  for (const needed of [
    "## Category conventions and clichés",
    "- CLICHE_0: obvious picture 0 (seen in Brand 0)",
    "- DONT_TAKE_robot mascot",
    "- WHITE_SPACE_the client's side of the chat",
    "## Your method, before you write ideas",
    "killedObvious",
    "Your method is zwicky",
    `pipeline/stimuli/zwicky-${ID}_metaphor.json`,
    `"seed": "${ID}:metaphor"`,
    'At least 2 of your ideas carry "stimulus"',
  ])
    assert.ok(first.includes(needed), needed);
  const sheet = JSON.parse(readFileSync(path.join(film.pipeline, `stimuli/zwicky-${ID}_metaphor.json`), "utf8"));
  assert.deepEqual([sheet.method, sheet.seed], ["zwicky", `${ID}:metaphor`]);
  assert.equal(
    buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt,
    first,
    "the same seed, the same stimuli, the same brief",
  );
  assert.match(buildBrief(film.project(), "ideas", { lane: "provocation" }).prompt, /Your method is triz/);
});

test("with a scan a team needs its ten killed ideas and two from its stimuli; the pool strips both, the key keeps them", (t) => {
  const film = setup(t);
  toStrategyApproved(film);
  rmSync(path.join(film.pipeline, "skips"), { recursive: true });
  writeCategoryScan(film.dir);
  film.seal("discovery");
  writeTeams(film.dir, 1, 4, { stimuli: 1, killed: 10 });
  assert.match(film.status("ideas").reasons.join(" "), /1 idea\(s\) carry a stimulus; at least 2 must/);
  writeTeams(film.dir, 1, 4, { stimuli: 2, killed: 9 });
  assert.match(film.status("ideas").reasons.join(" "), /killedObvious holds 9 of the 10/);
  writeTeams(film.dir, 1, 4, { stimuli: 2, killed: 10 });
  film.seal("ideas");
  buildPool(film.dir, ID, "ideas");
  const pool = readFileSync(poolFile(film.dir, "ideas"), "utf8");
  assert.doesNotMatch(
    pool,
    /STIMULUS_SECRET|KILLED_SECRET|CLICHE_SECRET|"stimulus"|"subverts"|killedObvious/,
    "the director judges what is written, not the category list",
  );
  const key = PoolKeySchema.parse(JSON.parse(readFileSync(path.join(film.pipeline, "pools/ideas-key.json"), "utf8")));
  assert.equal(key.entries.filter((entry) => entry.stimulus).length, 2 * 3);
  assert.equal(key.entries.filter((entry) => entry.subverts).length, 3);
  assert.equal(key.killedObvious!["metaphor"]!.length, 10);
});

const PROOF = {
  proof: "PROOF_SECRET the list re-sorts itself by date",
  claim: "Sorts tasks by date",
  looksLike: "a dated task jumps to the top as it is typed",
};
const ALTERNATIVE = { name: "a paper to-do list", whyConsidered: "it is free and already on the desk" };

test("each product-only proof must cite a working product-truth claim, by text or id, with a clear error otherwise", (t) => {
  const truth = {
    claims: [
      { text: "Sorts tasks by date", status: "working" },
      { id: "c2", text: "Syncs calendars", status: "working" },
      { text: "Plans your week", status: "horizon" },
    ],
  };
  assert.deepEqual(
    proofClaimProblems(
      [
        { proof: "a", claim: "Sorts tasks by date" },
        { proof: "b", claim: "c2" },
      ],
      truth,
    ),
    [],
  );
  assert.match(
    proofClaimProblems([{ proof: "c", claim: "Plans your week" }], truth).join(),
    /productOnlyProofs\[0\] "c" cites "Plans your week", whose status is horizon; a proof needs a working claim/,
  );
  assert.match(
    proofClaimProblems([{ proof: "d", claim: "Reads minds" }], truth).join(),
    /"Reads minds", which is not a claim in product-truth.json/,
  );
  assert.equal(
    StrategySchema.safeParse(strategyFixture({ productOnlyProofs: [{ proof: "p", claim: "c" }] })).success,
    false,
    "looksLike is required",
  );

  const film = setup(t, {
    truth: {
      claims: [
        { text: "Sorts tasks by date", status: "working" },
        { text: "Plans your week", status: "in-development" },
      ],
    },
  });
  writeStrategy(film.dir, {
    strongestAlternative: ALTERNATIVE,
    productOnlyProofs: [{ ...PROOF, claim: "Plans your week" }],
  });
  assert.throws(() => film.seal("strategy"), /whose status is in-development/);
  writeStrategy(film.dir, { strongestAlternative: ALTERNATIVE, productOnlyProofs: [PROOF] });
  film.seal("strategy");
});

test("the proof section is in a team's brief only when the strategy has proofs; the strategy brief names both fields", (t) => {
  const film = setup(t);
  const strategyBrief = buildBrief(film.project(), "strategy").prompt;
  for (const needed of [
    "## Product-only proofs (strategy.json fields)",
    '"strongestAlternative"',
    '"productOnlyProofs"',
  ])
    assert.ok(strategyBrief.includes(needed), needed);
  toStrategyApproved(film);
  assert.doesNotMatch(
    buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt,
    /## Proof only this product can show|"proofFrame": \{/,
  );
  toStrategyApproved(film, { strongestAlternative: ALTERNATIVE, productOnlyProofs: [PROOF] });
  const brief = buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt;
  for (const needed of [
    "## Proof only this product can show",
    `Strongest alternative: ${ALTERNATIVE.name} (${ALTERNATIVE.whyConsidered})`,
    `- ${PROOF.proof}: ${PROOF.looksLike}`,
    '"proofFrame"',
    "hook or its turn",
  ])
    assert.ok(brief.includes(needed), needed);
});

test("with proofs every idea needs a proofFrame naming one of them; the pool strips it, the key keeps it", (t) => {
  const film = setup(t);
  toStrategyApproved(film, { strongestAlternative: ALTERNATIVE, productOnlyProofs: [PROOF] });
  writeTeams(film.dir, 1, 4, { proof: PROOF.proof, proofFrames: 3 });
  assert.match(film.status("ideas").reasons.join(" "), /idea\(s\) 4 have no proofFrame/);
  writeTeams(film.dir, 1, 4, { proof: "a proof nobody listed" });
  assert.match(film.status("ideas").reasons.join(" "), /name a proof the strategy does not list/);
  writeTeams(film.dir, 1, 4, { proof: PROOF.proof });
  film.seal("ideas");
  buildPool(film.dir, ID, "ideas");
  const pool = readFileSync(poolFile(film.dir, "ideas"), "utf8");
  assert.doesNotMatch(pool, /PROOF_SECRET|proofFrame/, "the director judges what is written");
  const key = PoolKeySchema.parse(JSON.parse(readFileSync(path.join(film.pipeline, "pools/ideas-key.json"), "utf8")));
  assert.equal(key.entries.filter((entry) => entry.proofFrame?.proof === PROOF.proof).length, key.entries.length);
  assert.deepEqual(new Set(key.entries.map((entry) => entry.proofFrame!.where)), new Set(["hook", "turn"]));
});

test("a new project is scored with rubric v2; film:init --rubric 1 and a project from before v2 stay on v1", (t) => {
  const film = setup(t);
  assert.equal(projectRubricVersion(film.dir), 2);
  assert.deepEqual(JSON.parse(readFileSync(rubricRecordFile(film.dir), "utf8")), {
    schemaVersion: 1,
    rubricVersion: 2,
  });
  rmSync(rubricRecordFile(film.dir));
  assert.equal(projectRubricVersion(film.dir), 1, "no record: the project predates v2");
  const root = mkdtempSync(path.join(tmpdir(), "film-studio-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = cli(root, "scripts/film-init.ts", "--project", "bench", "--rubric", "1");
  assert.equal(init.json.metadata["rubricVersion"], 1);
  assert.equal(projectRubricVersion(path.join(root, "public/projects/bench")), 1);
  assert.equal(cli(root, "scripts/film-init.ts", "--project", "other", "--rubric", "3").json.error, "INVALID_INPUT");
});

test("creative:rank refuses a review on another rubric than the project's; a v1 project is ranked with v1", (t) => {
  const film = setup(t);
  writeFileSync(rubricRecordFile(film.dir), JSON.stringify({ schemaVersion: 1, rubricVersion: 1 }));
  toIdeasPooled(film);
  assert.equal(JSON.parse(readFileSync(poolFile(film.dir, "ideas"), "utf8")).rubricVersion, 1);
  writeReview(film.dir, "ideas", 1, () => 4, { rubricVersion: 2 });
  assert.throws(
    () => rankLatest(film.dir, "ideas"),
    /says rubricVersion 2, but this project is scored with rubric v1.*Nothing was written/,
  );
  writeReview(film.dir, "ideas", 1, () => 4);
  assert.equal(rankLatest(film.dir, "ideas").computed.verdict, "pass");
  assert.equal(film.status("idea-review").status, "done");
});

test("under v2 the director brief names the strongest alternative as the swap target and the v2 file; under v1 neither", (t) => {
  const film = setup(t);
  toIdeasPooled(film, { strongestAlternative: ALTERNATIVE, productOnlyProofs: [PROOF] }, { proof: PROOF.proof });
  const v2 = buildBrief(film.project(), "idea-review", { role: "critic" }).prompt;
  for (const needed of [
    "## Swap target",
    `Strongest alternative: ${ALTERNATIVE.name} (${ALTERNATIVE.whyConsidered})`,
    "## The frozen rubric v2 for ideas, quoted",
    "- .agents/skills/creative-studio/references/creative-rubric-v2.md\n",
    "rubricVersion 2",
  ])
    assert.ok(v2.includes(needed), needed);

  const legacy = setup(t);
  writeFileSync(rubricRecordFile(legacy.dir), JSON.stringify({ schemaVersion: 1, rubricVersion: 1 }));
  toIdeasPooled(legacy, { strongestAlternative: ALTERNATIVE, productOnlyProofs: [PROOF] }, { proof: PROOF.proof });
  const v1 = buildBrief(legacy.project(), "idea-review", { role: "critic" }).prompt;
  assert.doesNotMatch(v1, /Swap target|Strongest alternative|creative-rubric-v2/);
  for (const needed of [
    "## The frozen rubric v1 for ideas, quoted",
    "- .agents/skills/creative-studio/references/creative-rubric.md\n",
    "rubricVersion 1",
  ])
    assert.ok(v1.includes(needed), needed);
});

// --- Script variants ---

test("script variants: reading overruns are measured and cap the axis; the winner becomes script.json, the runner-up sits beside it", (t) => {
  const film = setup(t);
  toMusicApproved(film);
  const crowded = (script: Record<string, any>) =>
    (script["beats"][0]["onScreen"] = [
      {
        text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen",
        kind: "read",
      },
    ]);
  assert.equal(
    readingOverruns({
      beats: [
        {
          id: "x",
          durationSec: 1.2,
          onScreen: [
            { text: "two words", kind: "read" },
            { text: "flash", kind: "texture" },
          ],
        },
      ],
    }).length,
    0,
  );
  assert.equal(
    readingOverruns({ beats: [{ id: "x", durationSec: 1, onScreen: [{ text: "one two three four", kind: "read" }] }] })
      .length,
    1,
  );
  writeVariants(film.dir, 1, { a: crowded });
  film.seal("script-variants");
  const { pool, key } = buildPool(film.dir, ID, "scripts");
  film.seal("script-review");
  const crowdedId = key.entries.find((entry) => entry.author === "a")!.id;
  assert.equal(pool.items.find((item) => item.id === crowdedId)!.readingOverruns!.length, 1);
  writeReview(film.dir, "scripts", 1, () => 5);
  const { computed } = rankLatest(film.dir, "scripts");
  assert.notEqual(computed.ranking[0], crowdedId, "the capped reading axis costs the crowded variant the win");
  const result = pickScript(film.dir);
  const winner = key.entries.find((entry) => entry.id === result.winner)!;
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(film.pipeline, "script.json"), "utf8")),
    JSON.parse(readFileSync(path.join(film.dir, winner.file), "utf8")).script,
  );
  assert.ok(existsSync(path.join(film.pipeline, "script-alternative.md")));
  assert.equal(nextAction(film.project()).commands?.[0], `pnpm film:done --project ${ID} --step script`);
  film.seal("script");
  const next = nextAction(film.project());
  assert.deepEqual([next.action, next.step], ["ask", "script"]);
  assert.ok(
    next.show!.some((file) => file.endsWith("script-alternative.md")),
    "the user sees the runner-up",
  );
  writeFileSync(
    path.join(film.pipeline, "script.json"),
    JSON.stringify({ ...JSON.parse(readFileSync(path.join(film.pipeline, "script.json"), "utf8")), signOff: "edited" }),
  );
  assert.match(film.status("script").reasons.join(" "), /not the review's winning variant/);
});

// --- Proxy decisions ---

test("a benchmark proxy advances the chain but never counts as the user's approval, and never passes the human verdict or spending", (t) => {
  const film = setup(t);
  writeStrategy(film.dir);
  film.seal("strategy");
  const event = approveStep(film.project(), "strategy", "proxy", undefined, {
    kind: "benchmark",
    reason: "benchmark run 1",
  });
  skipDiscovery(film.dir);
  assert.equal(event.proxy, "orchestrator-benchmark");
  const state = film.status("strategy");
  assert.deepEqual([state.status, state.proxied], ["done", true]);
  assert.match(state.reasons.join(" "), /not by the user/);
  assert.match(
    buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt,
    /strategy: not the user's decision; a benchmark proxy went on/,
  );
  assert.throws(
    () => approveStep(film.project(), "human", "proxy", undefined, { kind: "benchmark", reason: "x" }),
    /the verdict on the film is the user's alone/,
  );
  assert.throws(
    () => approveStep(film.project(), "material", "proxy", undefined, { kind: "benchmark", reason: "x" }),
    (error: Error) => !/verdict on the film/.test(error.message),
    "a proxy may pass material; it never authorises spending",
  );
  assert.throws(
    () => approveStep(film.project(), "concept", "proxy", undefined, { kind: "benchmark", reason: " " }),
    /needs its reason/,
  );

  const viaCli = cli(
    film.root,
    "scripts/film-approve.ts",
    "--project",
    ID,
    "--step",
    "human",
    "--proxy",
    "benchmark",
    "--reason",
    "try",
  );
  assert.equal(viaCli.json.error, "STAGE_INCOMPLETE");
  assert.equal(
    cli(film.root, "scripts/film-approve.ts", "--project", ID, "--step", "strategy", "--proxy", "benchmark").json.error,
    "INVALID_INPUT",
    "a proxy needs a reason",
  );

  // A proxy event planted by hand on the human gate does not close it.
  mkdirSync(path.join(film.pipeline, "approvals"), { recursive: true });
  writeFileSync(
    path.join(film.pipeline, "approvals/human.json"),
    JSON.stringify({
      schemaVersion: 1,
      step: "human",
      events: [
        { answer: "proxy", at: "2026-11-12T00:00:00Z", artefacts: {}, proxy: "orchestrator-benchmark", reason: "x" },
      ],
    }),
  );
  assert.notEqual(film.status("human").status, "done");
  const status = cli(film.root, "scripts/film-status.ts", "--project", ID).json.metadata;
  assert.deepEqual(status["proxied"], ["strategy"]);
  assert.equal(status["acceptedByUser"], false);
});

// --- Boards ---

test("concept:boards validates library ids and roles before rendering, and plans one still per frame plus a contact sheet", (t) => {
  const film = setup(t);
  toConceptApproved(film, ID);
  const plan = cli(film.root, "scripts/concept-boards.ts", "--project", ID, "--plan-only");
  assert.equal(plan.status, 0, plan.json.message ?? "");
  const concept = JSON.parse(readFileSync(path.join(film.pipeline, "concept.json"), "utf8")) as {
    candidates: { id: string }[];
  };
  assert.equal(plan.json.metadata["frames"].length, concept.candidates.length * 2);
  assert.equal(plan.json.metadata["sheet"], `public/projects/${ID}/pipeline/boards/boards.jpg`);
  const boards = JSON.parse(readFileSync(path.join(film.pipeline, "concept-boards.json"), "utf8"));
  boards.candidates[0].frames[1].props = { word: "Clear" };
  boards.candidates[0].frames[0].itemId = "no-such-block";
  boards.candidates[1].frames = boards.candidates[1].frames.filter((frame: { role: string }) => frame.role !== "last");
  boards.candidates[1].frames.push({ role: "turn", itemId: "type-hero-word", caption: "turn" });
  writeFileSync(path.join(film.pipeline, "concept-boards.json"), JSON.stringify(boards));
  const bad = cli(film.root, "scripts/concept-boards.ts", "--project", ID, "--plan-only");
  assert.equal(bad.json.error, "VALIDATION");
  assert.match(bad.json.message!, /unknown library item "no-such-block"/);
  assert.match(bad.json.message!, /no last frame/);
  assert.match(
    bad.json.message!,
    /type-hero-word has no prop word; its props: text/,
    "a misnamed prop would silently render the block's demo copy",
  );
  const concept2 = film.status("concept");
  assert.equal(concept2.status, "failing");
  assert.match(concept2.reasons.join(" "), /has no last frame/);
});

test(
  "concept:boards renders real stills from a library block",
  { skip: process.env.RUN_RENDER_TESTS !== "1" ? "set RUN_RENDER_TESTS=1 to render" : false, timeout: 600_000 },
  (t) => {
    const film = setup(t);
    toConceptApproved(film, ID);
    rmSync(path.join(film.pipeline, "boards"), { recursive: true, force: true });
    const result = spawnSync(
      process.execPath,
      [TSX, path.join(REPO, "scripts/concept-boards.ts"), "--project", ID, "--public-dir", path.join(REPO, "public")],
      {
        cwd: film.root,
        encoding: "utf8",
        env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    const json = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    assert.equal(json.ok, true, json.message);
    assert.ok(existsSync(path.join(film.pipeline, "boards/boards.jpg")));
    assert.equal(film.status("concept").status, "unsealed");
  },
);

test("a benchmark records the music choice as a proxy, and film:next approves it only as a proxy", (t) => {
  const film = setup(t);
  toConceptApproved(film, ID);
  mkdirSync(path.join(film.dir, "music"), { recursive: true });
  copyFileSync(path.join(FIXTURES, "track.wav"), path.join(film.dir, "music/track.wav"));
  film.place("music-shortlist.json");
  const ask = nextAction(film.project());
  assert.deepEqual([ask.action, ask.step], ["ask", "music"]);
  assert.match(ask.benchmarkProxy!, /--answer "proxy \(benchmark\): <why>"/);
  film.place("music-decision.json");
  const decision = JSON.parse(readFileSync(path.join(film.pipeline, "music-decision.json"), "utf8"));
  decision.askedUser.answer = "proxy (benchmark): run 1";
  writeFileSync(path.join(film.pipeline, "music-decision.json"), JSON.stringify(decision));
  film.seal("music");
  const next = nextAction(film.project());
  assert.deepEqual(next.commands, [
    `pnpm film:approve --project ${ID} --step music --proxy benchmark --reason "run 1"`,
  ]);
  approveStep(film.project(), "music", "proxy (benchmark): run 1", undefined, { kind: "benchmark", reason: "run 1" });
  assert.equal(film.status("music").proxied, true);
  assert.notEqual(nextAction(film.project()).step, "music", "approved once, not asked again");
});
