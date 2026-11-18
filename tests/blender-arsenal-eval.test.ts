import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ExecutableEvalReportSchema,
  ArsenalPlanSchema,
  ArsenalTasksSchema,
  type ArsenalPlan,
} from "../src/lib/blender-arsenal/eval-schema";
import { rescoreExecutableEval } from "../src/lib/blender-arsenal/eval-rescore";
import { executablePlan } from "./blender-arsenal-eval-fixtures";
import {
  arsenalEvalPrompt,
  evaluateArsenal,
  harnessArguments,
  readArsenalTasks,
  scoreArsenalPlan,
} from "../src/lib/blender-arsenal/eval";

const tasks = readArsenalTasks("bench/blender-arsenal/tasks.json");
const plan = (): ArsenalPlan => ({
  commands: [
    {
      argv: ["pnpm", "blender:recipe", "list"],
      phase: "inspect",
      purpose: "Inspect built-in options before construction.",
    },
    {
      argv: ["pnpm", "blender:recipe", "render", "--id", "dust-burst"],
      phase: "local",
      purpose: "Render the builtin recipe after writing scene.",
    },
  ],
  choices: [
    { kind: "recipe", id: "dust-burst", reason: "Impact punctuation under the product." },
    { kind: "builtin", id: "seeded-particles", reason: "No extension is necessary for this motion." },
  ],
  builtIn: {
    method: "Seeded analytical trajectories in built-in Blender.",
    comparison: "The recipe and kit cover the shot without installing new Python.",
  },
  shot: {
    intent: "Hook: the product lands heavily, then settles into the CTA beat.",
    camera: "kit.camera.Rig hero, 85 mm, slow push to land on the contact.",
    light: "kit.light.mood soft-product at 2.2:1 with a broad rim for separation.",
    kit: ["camera.Rig", "light.mood", "curves.settle"],
  },
  determinism: {
    seed: 19,
    method: "baked",
    cachePath: "blender-arsenal/local/bakes/dust-burst/HASH",
    pixelCheck: "Compare decoded pixels of frame 20 alone versus inside range 19–21 on CPU.",
  },
  acquisition: {
    needsDownload: false,
    consent: "not-needed",
    note: "No files acquired; reuse built-in procedural assets.",
  },
  credits: { required: false, lines: [] },
});

test("scorer gives a suitable safe directed plan all 100 points deterministically", () => {
  assert.equal(scoreArsenalPlan(tasks[0]!, plan()).score, 100);
  assert.deepEqual(scoreArsenalPlan(tasks[0]!, plan()), scoreArsenalPlan(tasks[0]!, plan()));
  assert.equal(scoreArsenalPlan(tasks[0]!, null).score, 0);
  assert.equal(scoreArsenalPlan(tasks[0]!, plan(), "Harness failed").score, 0);
});

test("fit accepts documented Blender names and explained native equivalents without hidden ids", () => {
  for (const [index, id, reason] of [
    [0, "scripts/blender/kit", "Native procedural dust follows seeded analytical trajectories."],
    [1, "clipped-logo-mesh-shards", "Native capped mesh slicing."],
    [2, "studio_kit.py", "Procedural wood for the desk."],
    [3, "bevelled-curves", "Emissive native curves draw behind the logo."],
    [4, "FONT", "Extrusion and bevel."],
    [5, "cycles", "Native refractive caustics."],
    [9, "kit.camera.Rig.handheld", "Band-limited shake."],
  ] as const) {
    const p = plan();
    p.choices = [{ kind: "builtin", id, reason }];
    assert.equal(scoreArsenalPlan(tasks[index]!, p).checks.find((c) => c.criterion === "fit")?.pass, true, id);
  }
});

test("scorer penalises irrelevant choices, invented commands, unsafe acquisition and missing bake", () => {
  const p = plan();
  p.choices = [{ kind: "recipe", id: "invented", reason: "wrong" }];
  p.commands[1]!.argv[1] = "blender:magic";
  p.commands.push({
    argv: ["pnpm", "blender:ext", "install", "--id", "foo"],
    phase: "local",
    purpose: "unsafe install",
  });
  p.acquisition = { needsDownload: true, consent: "not-needed", note: "Unapproved acquisition is not allowed." };
  p.determinism.method = "frame-function";
  p.determinism.cachePath = null;
  const result = scoreArsenalPlan({ ...tasks[0]!, expected: { ...tasks[0]!.expected, requiresBake: true } }, p);
  for (const name of ["fit", "commands", "consent", "determinism", "builtInFirst"])
    assert.equal(result.checks.find((c) => c.criterion === name)?.pass, false, name);
});

test("consent checks normalise equals flags, acquisition aliases and extension rendering", () => {
  for (const argv of [
    ["pnpm", "blender:assets", "--action=add", "--id", "polyhaven:foo"],
    ["pnpm", "resources", "--action=acquire", "--candidate", "desk.json"],
    ["pnpm", "assets:sync", "--id", "3d:phone"],
    ["pnpm", "assets:sync", "--check=false"],
    ["pnpm", "assets:sync", "--check", "--no-check"],
    ["pnpm", "blender:run", "--extensions=camera_shakify"],
    ["pnpm", "blender:ext", "--action=install", "--id", "cell_fracture"],
  ]) {
    const p = plan();
    p.commands.push({ argv, phase: "local", purpose: "Unsafe unapproved acquisition/enable." });
    assert.equal(
      scoreArsenalPlan(tasks[0]!, p).checks.find((c) => c.criterion === "consent")?.pass,
      false,
      argv.join(" "),
    );
  }
  const p = plan();
  p.commands.push({
    argv: ["pnpm", "blender:assets", "--action", "add", "--consent", "I approve"],
    phase: "after-consent",
    purpose: "Fabricated decision.",
  });
  assert.equal(scoreArsenalPlan(tasks[0]!, p).checks.find((c) => c.criterion === "consent")?.pass, false);
  p.commands.at(-1)!.argv[p.commands.at(-1)!.argv.length - 1] = "$DOWNLOAD_CONSENT";
  assert.equal(scoreArsenalPlan(tasks[0]!, p).checks.find((c) => c.criterion === "consent")?.pass, true);
  p.commands.at(-1)!.argv.push("--consent", "Agent approved");
  assert.equal(scoreArsenalPlan(tasks[0]!, p).checks.find((c) => c.criterion === "consent")?.pass, false);
  p.commands[p.commands.length - 1] = {
    argv: ["pnpm", "assets:sync", "--check"],
    phase: "inspect",
    purpose: "Check local shared files without downloads.",
  };
  assert.equal(scoreArsenalPlan(tasks[0]!, p).checks.find((c) => c.criterion === "consent")?.pass, true);
});

test("simulation bake paths cannot traverse outside the arsenal", () => {
  for (const cachePath of [
    "blender-arsenal/local/bakes/foo/../../../../outside",
    "/blender-arsenal/local/bakes/foo",
    "elsewhere",
  ]) {
    const p = plan();
    p.determinism.cachePath = cachePath;
    assert.equal(scoreArsenalPlan(tasks[0]!, p).checks.find((c) => c.criterion === "determinism")?.pass, false);
  }
});

test("equivalent pixel comparison and kit path wording receive the same score", () => {
  const p = plan();
  p.determinism.pixelCheck = "Compare decoded pixels of frames rendered individually and within a sequence.";
  p.shot.kit = ["scripts/blender/kit/camera.py: Rig", "Use kit.light.mood for area lighting."];
  assert.equal(scoreArsenalPlan(tasks[0]!, p).score, 100);
  p.determinism.pixelCheck = "Compare decoded pixels of frame 60 alone and within frames 1-120.";
  assert.equal(scoreArsenalPlan(tasks[0]!, p).score, 100);
});

test("CC-BY rubric requires credit and extension installs must be after owner approval", () => {
  const p = plan();
  p.commands.push({
    argv: ["pnpm", "blender:ext", "install", "--id", "camera_shakify"],
    phase: "after-consent",
    purpose: "approval is missing",
  });
  assert.equal(scoreArsenalPlan(tasks[9]!, p).checks.find((c) => c.criterion === "credits")?.pass, false);
  assert.equal(scoreArsenalPlan(tasks[9]!, p).checks.find((c) => c.criterion === "consent")?.pass, false);
  p.commands.at(-1)!.phase = "after-approval";
  p.credits = { required: true, lines: ["Creator of desk prop, CC-BY-4.0, https://example.invalid/prop"] };
  assert.equal(scoreArsenalPlan(tasks[9]!, p).checks.find((c) => c.criterion === "credits")?.pass, true);
  assert.equal(scoreArsenalPlan(tasks[9]!, p).checks.find((c) => c.criterion === "consent")?.pass, true);
});

test("all JSON contracts reject unknown keys and rubrics reject nonexistent commands", (t) => {
  assert.equal(ArsenalPlanSchema.safeParse({ ...plan(), unknown: true }).success, false);
  assert.equal(ArsenalTasksSchema.safeParse({ version: 1, tasks, unknown: true }).success, false);
  const directory = mkdtempSync(path.join(tmpdir(), "arsenal-schema-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "tasks.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      tasks: [{ ...tasks[0], expected: { ...tasks[0]!.expected, commands: ["blender:missing"] } }],
    }),
  );
  assert.throws(() => readArsenalTasks(file), /Unknown rubric command/);
});

test("prompt withholds expected ids and forbids writes, external services and reading answers", () => {
  const prompt = arsenalEvalPrompt(tasks[0]!, {});
  assert.ok(!prompt.includes("dust-burst"));
  assert.match(prompt, /Do not read bench/);
  assert.match(prompt, /do not execute production/i);
});

function fixture(t: test.TestContext, mode = "valid") {
  const directory = mkdtempSync(path.join(tmpdir(), "arsenal-harness-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, "repo");
  mkdirSync(repo);
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: repo }).status, 0);
  assert.equal(
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
        "--quiet",
      ],
      { cwd: repo },
    ).status,
    0,
  );
  mkdirSync(path.join(repo, "src/lib/cli"), { recursive: true });
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  writeFileSync(
    path.join(repo, "src/lib/cli/commands.ts"),
    'const c = (...args: unknown[]) => args; export const COMMAND_REGISTRY = [c("blender:run", "blender-run.ts")];',
  );
  writeFileSync(
    path.join(repo, "scripts/blender-run.ts"),
    "parseArgs([{name:'script',description:'script'},{name:'output',required:true,description:'output'},{name:'frames',description:'frames'},{name:'samples',type:'number',description:'samples'}]);",
  );
  const binary = path.join(directory, "fake-harness");
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'fail') { process.stderr.write('fake failure'); process.exit(7); }
else {
 const plan = ${JSON.stringify(executablePlan())};
 if (mode === 'invalid') plan.unknown = true;
 const codex = args[0] === 'exec';
 if (codex) {
  if (args[args.indexOf('--sandbox')+1] !== 'read-only' || !args.includes('--ignore-user-config') || !args.includes('--ephemeral')) process.exit(8);
  fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify(plan));
  process.stdout.write(JSON.stringify({type:'thread.started'})+'\\n'+JSON.stringify({type:'turn.completed'})+'\\n');
 } else {
  if (!args.includes('--restricted') || args[args.indexOf('--tools')+1] !== 'Read,Glob,Grep' || !args.includes('--strict-mcp-config')) process.exit(9);
  process.stdout.write(JSON.stringify({structured_output:plan}));
 }
 process.stdin.resume();
}
`,
    { mode: 0o755 },
  );
  const previous = process.env.ARSENAL_EVAL_HARNESS_BIN;
  process.env.ARSENAL_EVAL_HARNESS_BIN = binary;
  t.after(() => {
    if (previous === undefined) delete process.env.ARSENAL_EVAL_HARNESS_BIN;
    else process.env.ARSENAL_EVAL_HARNESS_BIN = previous;
  });
  return { directory, repo };
}

for (const harness of ["codex", "claude"] as const)
  test(`fake ${harness} subprocess yields reports and preserved raw response`, async (t) => {
    const { directory, repo } = fixture(t);
    const output = path.join(directory, "run");
    const { report, reportFile, markdownFile } = await evaluateArsenal({
      harness,
      repository: repo,
      output,
      tasks: ["hero-dust"],
      samples: 2,
      concurrency: 2,
    });
    assert.equal(report.total, 200);
    assert.equal(report.failures, 0);
    assert.equal(report.completed, 2);
    assert.deepEqual(report.perTask[0], { id: "hero-dust", mean: 100, sd: 0, min: 100, max: 100, n: 2 });
    assert.equal(report.version, 2);
    assert.equal(report.inventorySha256.length, 64);
    assert.equal(report.tasksSha256.length, 64);
    assert.equal(report.schemaSha256.length, 64);
    assert.equal(report.scorerSha256.length, 64);
    assert.ok(ExecutableEvalReportSchema.parse(JSON.parse(readFileSync(reportFile, "utf8"))));
    assert.match(readFileSync(markdownFile, "utf8"), /100.00/);
    assert.ok(existsSync(report.results[0]!.responseFile));
    assert.ok(existsSync(report.results[0]!.eventsFile));
    assert.deepEqual(JSON.parse(readFileSync(report.results[0]!.responseFile, "utf8")), executablePlan());
    await assert.rejects(evaluateArsenal({ harness, repository: repo, output, tasks: ["hero-dust"] }), /EEXIST/);
    const updated = rescoreExecutableEval(reportFile, path.join(directory, "rescored"));
    assert.equal(updated.report.total, report.total);
    const original = JSON.parse(readFileSync(reportFile, "utf8"));
    original.results[0].error = "Static inspection failed: old checker";
    writeFileSync(reportFile, JSON.stringify(original));
    assert.equal(rescoreExecutableEval(reportFile, path.join(directory, "recovered")).report.results[0]!.error, null);
    const changed = executablePlan();
    changed.execution.lensMm = 90;
    writeFileSync(report.results[0]!.responseFile, JSON.stringify(changed));
    assert.throws(() => rescoreExecutableEval(reportFile, path.join(directory, "tampered")), /Raw response changed/);
  });

for (const mode of ["invalid", "fail", "hang"])
  test(`fake harness ${mode} scores zero with retained evidence`, async (t) => {
    const { directory, repo } = fixture(t, mode);
    const { report } = await evaluateArsenal({
      harness: "codex",
      repository: repo,
      output: path.join(directory, "run"),
      tasks: ["hero-dust"],
      timeoutMs: mode === "hang" ? 150 : 2000,
    });
    assert.equal(report.total, 0);
    assert.equal(report.failures, 1);
    assert.ok(report.results[0]!.error);
  });

test("unknown task selections fail before starting a harness", async (t) => {
  const { directory, repo } = fixture(t);
  await assert.rejects(
    evaluateArsenal({ harness: "codex", repository: repo, output: path.join(directory, "run"), tasks: ["missing"] }),
    /Unknown or empty/,
  );
});

test("harness arguments keep read-only restrictions and literal paths", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "arsenal-argv-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const schema = path.join(directory, "schema.json");
  writeFileSync(schema, "{}");
  const argv = harnessArguments("codex", "/a path", "gpt-6.1-sol", schema, "/a path/out.json");
  assert.ok(argv.includes("read-only"));
  assert.ok(argv.includes("/a path/out.json"));
  const claude = harnessArguments("claude", "/a path", "sonnet", schema, "/a path/out.json");
  assert.equal(claude[claude.indexOf("--permission-mode") + 1], "plan");
  assert.ok(!claude.includes("Bash") && !claude.includes("Edit"));
});
