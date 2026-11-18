import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkCrossFilmRepetition, checkPlan, checkSignature } from "../src/lib/film/plan-check";
import {
  canonicalJson,
  listUsage,
  noteUsage,
  propsHash,
  recentOtherFilms,
  recordUsage,
  usageBlocks,
  usageDir,
} from "../src/lib/library/usage";
import { MotionPlanSchema, type MotionPlan } from "../src/types/creative";
import { FilmTargetsSchema } from "../src/types/film";
import type { LibraryUsage } from "../src/types/tournament";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const FIXTURES = path.join(REPO, "tests/fixtures/film");

const shot = (id: string, startFrame: number, durationFrames: number, extra: Record<string, unknown> = {}) => ({
  id,
  startFrame,
  durationFrames,
  intent: "i",
  subject: "s",
  framing: "f",
  camera: "push in",
  composition: "c",
  entrance: "e",
  exit: "e",
  curve: "expoOut",
  route: "remotion",
  ...extra,
});
const PLAN: MotionPlan = MotionPlanSchema.parse({
  schemaVersion: 1,
  projectId: "film",
  fps: 30,
  shots: [
    shot("open", 0, 30, { blocks: ["grain-overlay"] }),
    shot("reveal", 30, 45, { weight: "hero", function: "reveal", blocks: ["mask-reveal", "custom: torn paper"] }),
    shot("end", 75, 30, { weight: "support", blocks: ["end-card"] }),
  ],
});
const PLACEMENTS = {
  fps: 30,
  durationInFrames: 105,
  blocks: [
    { id: "mask-reveal", startFrame: 30, props: { colour: "#fff", text: "Hi" } },
    { id: "end-card", startFrame: 80 },
  ],
};

/** A temporary root whose memory/ is this test's memory root, whatever AGENTBROS_MEMORY_ROOT the runner set. */
function temp(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "library-usage-"));
  const previous = process.env.AGENTBROS_MEMORY_ROOT;
  process.env.AGENTBROS_MEMORY_ROOT = path.join(root, "memory");
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTBROS_MEMORY_ROOT;
    else process.env.AGENTBROS_MEMORY_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const usage = (projectId: string, date: string, blocks: LibraryUsage["blocks"]): LibraryUsage => ({
  schemaVersion: 1,
  projectId,
  date,
  blocks,
});
const hero = (id: string, props?: unknown) => ({ id, propsHash: propsHash(props), weight: "hero" as const });

// --- propsHash and blocks ---

test("propsHash is stable: key order does not matter, no props hash as {}, a changed value changes it", () => {
  assert.equal(propsHash({ a: 1, b: { c: [1, 2], d: "x" } }), propsHash({ b: { d: "x", c: [1, 2] }, a: 1 }));
  assert.equal(propsHash(undefined), propsHash({}));
  assert.equal(propsHash({ a: 1, skip: undefined }), propsHash({ a: 1 }));
  assert.notEqual(propsHash({ a: 1 }), propsHash({ a: 2 }));
  assert.notEqual(propsHash({ list: [1, 2] }), propsHash({ list: [2, 1] }), "array order is content");
  assert.match(propsHash({ a: 1 }), /^[a-f0-9]{16}$/);
  assert.equal(canonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
});

test("usageBlocks weighs each placement by the shot that holds its start, adds unplaced plan blocks, skips custom ones", () => {
  const blocks = usageBlocks(PLAN, PLACEMENTS);
  assert.deepEqual(blocks, [
    { id: "end-card", propsHash: propsHash(undefined), weight: "support" },
    { id: "grain-overlay", propsHash: propsHash(undefined), weight: "support" },
    { id: "mask-reveal", propsHash: propsHash({ text: "Hi", colour: "#fff" }), weight: "hero" },
  ]);
  assert.deepEqual(
    usageBlocks(PLAN).find((block) => block.id === "mask-reveal"),
    { id: "mask-reveal", propsHash: propsHash({}), weight: "hero" },
    "without placements a plan block has no props",
  );
  const sixty = usageBlocks(
    {
      ...PLAN,
      fps: 60,
      shots: PLAN.shots.map((item) => ({
        ...item,
        startFrame: item.startFrame * 2,
        durationFrames: item.durationFrames * 2,
      })),
    },
    PLACEMENTS,
  );
  assert.equal(
    sixty.find((block) => block.id === "mask-reveal")?.weight,
    "hero",
    "placement frames scale to the plan's fps",
  );
});

// --- Record and list ---

test("recordUsage writes memory/usage/<project>.json under the root; listUsage reads newest first, skipping bad files", (t) => {
  const root = temp(t);
  const first = recordUsage("film-a", PLAN, PLACEMENTS, { root, date: new Date(2026, 10, 1) });
  assert.equal(first.file, path.join(root, "memory/usage/film-a.json"));
  assert.equal(first.usage.date, "2026-11-01");
  recordUsage("film-b", PLAN, undefined, { root, date: new Date(2026, 10, 3) });
  recordUsage("film-a", PLAN, PLACEMENTS, { root, date: new Date(2026, 10, 2) });
  writeFileSync(path.join(usageDir(root), "broken.json"), "{");
  const { records, warnings } = listUsage(root);
  assert.deepEqual(
    records.map((record) => `${record.projectId}@${record.date}`),
    ["film-b@2026-11-03", "film-a@2026-11-02"],
    "a re-record replaces the project's earlier one",
  );
  assert.equal(warnings.length, 1);
  assert.deepEqual(
    recentOtherFilms(records, "film-b").map((record) => record.projectId),
    ["film-a"],
  );
  process.env.AGENTBROS_MEMORY_ROOT = path.join(root, "nowhere");
  assert.deepEqual(listUsage(), { records: [], warnings: [] });
});

test("recentOtherFilms leaves this film out and keeps the last two, newest first", () => {
  const records = [
    usage("a", "2026-11-01", []),
    usage("b", "2026-11-04", []),
    usage("c", "2026-11-03", []),
    usage("me", "2026-11-05", []),
  ];
  assert.deepEqual(
    recentOtherFilms(records, "me").map((record) => record.projectId),
    ["b", "c"],
  );
  assert.deepEqual(
    recentOtherFilms(records, "me", 2, (id) => id !== "b").map((record) => record.projectId),
    ["c", "a"],
    "a deleted project's usage does not count",
  );
});

test("a transition placed in the shot before the one that names it is recorded once, with its props and the heavier weight", () => {
  const plan = MotionPlanSchema.parse({
    ...PLAN,
    shots: [
      shot("hook", 0, 30, { weight: "support", blocks: ["giant-word-pull-out"] }),
      shot("cut", 30, 45, { weight: "hero", blocks: ["accelerate-into-cut"] }),
      shot("end", 75, 30, { blocks: ["end-card"] }),
    ],
  });
  const placements = {
    fps: 30,
    blocks: [
      { id: "giant-word-pull-out", startFrame: 0, props: { word: "Meet" } },
      { id: "accelerate-into-cut", startFrame: 18, props: { seamFrame: 12 } },
    ],
  };
  const blocks = usageBlocks(plan, placements);
  assert.deepEqual(
    blocks.filter((block) => block.id === "accelerate-into-cut"),
    [{ id: "accelerate-into-cut", propsHash: propsHash({ seamFrame: 12 }), weight: "hero" }],
    "no second row with an empty-props hash",
  );
  assert.deepEqual(
    blocks.map((block) => block.id),
    ["accelerate-into-cut", "end-card", "giant-word-pull-out"],
  );
  const unplaced = usageBlocks(plan, {
    fps: 30,
    blocks: [{ id: "accelerate-into-cut", startFrame: 80, props: { seamFrame: 3 } }],
  });
  assert.equal(
    unplaced.filter((block) => block.id === "accelerate-into-cut").length,
    2,
    "a placement two shots away is another use",
  );
});

test("library:usage --record and --list, and film:done's hook records with a warning instead of failing", (t) => {
  const root = temp(t);
  const dir = path.join(root, "public/projects/film/pipeline");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "brief.json"), JSON.stringify({ renderMode: "bespoke" }));
  writeFileSync(path.join(dir, "motion-plan.json"), JSON.stringify(PLAN));
  writeFileSync(path.join(dir, "cue-placements.json"), JSON.stringify(PLACEMENTS));
  const run = (...args: string[]) =>
    JSON.parse(
      spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/library-usage.ts"), ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, AGENTBROS_MEMORY_ROOT: path.join(root, "memory") },
      })
        .stdout.trim()
        .split("\n")
        .at(-1)!,
    ) as { ok: boolean; error?: string; metadata: Record<string, any> };
  const recorded = run("--record", "--project", "film");
  assert.equal(recorded.ok, true);
  assert.deepEqual(
    recorded.metadata["blocks"]
      .filter((block: { weight: string }) => block.weight === "hero")
      .map((block: { id: string }) => block.id),
    ["mask-reveal"],
  );
  assert.equal(run("--list").metadata["films"], 1);
  assert.equal(run("--record").error, "INVALID_INPUT");
  assert.equal(run().error, "INVALID_INPUT");
  assert.equal(noteUsage(path.join(root, "public/projects/film"), "film", root), undefined);
  assert.ok(existsSync(path.join(root, "memory/usage/film.json")));
  assert.match(
    noteUsage(path.join(root, "public/projects/missing"), "missing", root)!,
    /library usage was not recorded/,
  );
});

// --- plan:check dimensions ---

test("cross-film-repetition: a repeated hero block warns, the whole hero set repeated fails, props or weight that differ pass", () => {
  const mine = [
    hero("mask-reveal", { text: "Hi" }),
    hero("odometer"),
    { id: "grain-overlay", propsHash: propsHash({}), weight: "support" as const },
  ];
  assert.equal(checkCrossFilmRepetition(mine, []).status, "pass");
  const partly = checkCrossFilmRepetition(mine, [usage("last", "2026-11-01", [hero("mask-reveal", { text: "Hi" })])]);
  assert.equal(partly.status, "warn");
  assert.match(partly.message, /1 of 2 hero block/);
  const whole = checkCrossFilmRepetition(mine, [
    usage("last", "2026-11-01", [hero("odometer")]),
    usage("before", "2026-10-30", [hero("odometer"), hero("mask-reveal", { text: "Hi" })]),
  ]);
  assert.equal(whole.status, "fail");
  assert.match(whole.message, /before \(2026-10-30\)/);
  assert.ok(whole.fix);
  assert.equal(
    checkCrossFilmRepetition(mine, [
      usage("last", "2026-11-01", [hero("mask-reveal", { text: "Bye" }), hero("odometer", { size: 2 })]),
    ]).status,
    "pass",
    "other props are another use",
  );
  assert.equal(
    checkCrossFilmRepetition(mine, [
      usage("last", "2026-11-01", [
        { ...hero("odometer"), weight: "support" },
        { ...hero("mask-reveal", { text: "Hi" }), weight: "support" },
      ]),
    ]).status,
    "warn",
    "the same block and props in a support role warn; only a hero set repeated as heroes fails",
  );
  assert.equal(checkCrossFilmRepetition([], [usage("last", "2026-11-01", [hero("odometer")])]).status, "pass");
});

test("signature-element: a bespoke film names one element from its idea in shots it has", () => {
  assert.equal(checkSignature(PLAN).status, "fail");
  assert.equal(
    checkSignature({
      ...PLAN,
      signature: {
        description: "Torn paper reveals",
        shotIds: ["ghost"],
        whyFromIdea: "the product tears through noise",
      },
    }).status,
    "fail",
  );
  const named = checkSignature({
    ...PLAN,
    signature: {
      description: "Torn paper reveals",
      shotIds: ["reveal"],
      whyFromIdea: "the product tears through noise",
    },
  });
  assert.equal(named.status, "pass");
  assert.deepEqual(named.shotIds, ["reveal"]);
});

test("plan:check adds the two gates only with context, and keeps them out of the risk mean", () => {
  const plan = MotionPlanSchema.parse(JSON.parse(readFileSync(path.join(FIXTURES, "plan-showcase-like.json"), "utf8")));
  const targets = FilmTargetsSchema.parse(
    JSON.parse(readFileSync(path.join(FIXTURES, "polymarket-targets.json"), "utf8")),
  );
  const bare = checkPlan(plan, targets);
  assert.ok(
    !bare.findings.some(
      (finding) => finding.dimension === "signature-element" || finding.dimension === "cross-film-repetition",
    ),
    "old callers see no new dimension",
  );
  const blocks = [hero("mask-reveal")];
  const gated = checkPlan(plan, targets, undefined, undefined, {
    bespoke: true,
    blocks,
    recent: [usage("last", "2026-11-01", blocks)],
  });
  assert.equal(gated.findings.find((finding) => finding.dimension === "signature-element")?.status, "fail");
  assert.equal(gated.findings.find((finding) => finding.dimension === "cross-film-repetition")?.status, "fail");
  assert.equal(gated.verdict, "fail");
  assert.equal(gated.riskScore, bare.riskScore, "film-level gates block by failing and never move the risk mean");
  const signed = checkPlan(
    { ...plan, signature: { description: "x", shotIds: [plan.shots[0]!.id], whyFromIdea: "y" } },
    targets,
    undefined,
    undefined,
    { bespoke: true, blocks, recent: [] },
  );
  assert.equal(signed.verdict, bare.verdict);
});

test("plan:check --project asks a bespoke film for its signature, never a replica, and reads the last films' usage", (t) => {
  const root = temp(t);
  const dir = path.join(root, "public/projects/film/pipeline");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "motion-plan.json"), JSON.stringify(PLAN));
  writeFileSync(path.join(dir, "cue-placements.json"), JSON.stringify(PLACEMENTS));
  writeFileSync(path.join(dir, "film-targets.json"), readFileSync(path.join(FIXTURES, "polymarket-targets.json")));
  recordUsage("last", PLAN, PLACEMENTS, { date: new Date(2026, 10, 1) });
  recordUsage("deleted", PLAN, PLACEMENTS, { date: new Date(2026, 10, 2) });
  // Only films whose project is still on disk count: "deleted" has no public/projects folder.
  mkdirSync(path.join(root, "public/projects/last"), { recursive: true });
  const run = (filmType?: string) => {
    writeFileSync(
      path.join(dir, "brief.json"),
      JSON.stringify({ renderMode: "bespoke", ...(filmType ? { filmType } : {}) }),
    );
    const result = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/plan-check.ts"), "--project", "film"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, AGENTBROS_MEMORY_ROOT: path.join(root, "memory") },
    });
    const json = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
      metadata: { findings: { dimension: string; status: string }[] };
    };
    return (dimension: string) => json.metadata.findings.find((row) => row.dimension === dimension)?.status;
  };
  const bespoke = run("motion-graphics");
  assert.equal(bespoke("signature-element"), "fail");
  assert.equal(bespoke("cross-film-repetition"), "fail", "the last film had the same hero with the same props");
  rmSync(path.join(root, "public/projects/last"), { recursive: true });
  assert.equal(
    run("motion-graphics")("cross-film-repetition"),
    "pass",
    "neither recorded film's project exists any more",
  );
  assert.equal(run("replica")("signature-element"), undefined);
});

test("an old plan without function, weight or signature still parses", () => {
  const old = JSON.parse(readFileSync(path.join(FIXTURES, "plan-sloppy.json"), "utf8"));
  const parsed = MotionPlanSchema.parse(old);
  assert.equal(parsed.signature, undefined);
  assert.ok(parsed.shots.every((item) => item.weight === undefined && item.function === undefined));
  assert.throws(() => MotionPlanSchema.parse({ ...old, shots: [{ ...old.shots[0], weight: "lead" }] }));
  assert.throws(() => MotionPlanSchema.parse({ ...old, shots: [{ ...old.shots[0], function: "intro" }] }));
});
