import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { STIMULUS_METHODS, buildStimuli } from "../src/lib/film/stimuli";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const ID = "stimuli";

function cli(root: string, script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], { cwd: root, encoding: "utf8" });
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, result.stdout);
  return {
    status: result.status,
    json: JSON.parse(lines[0]!) as { ok: boolean; error?: string; outputs?: string[]; metadata: Record<string, any> },
  };
}

function setup(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "film-stimuli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(cli(root, "scripts/film-init.ts", "--project", ID).status, 0);
  return root;
}

test("stimuli are a pure function of method and seed, and differ between seeds", () => {
  for (const method of STIMULUS_METHODS) {
    const a = buildStimuli(method, "run-3");
    assert.deepEqual(buildStimuli(method, "run-3"), a, method);
    assert.notDeepEqual(buildStimuli(method, "run-4").stimuli, a.stimuli, method);
    assert.ok(a.stimuli.length > 0);
    for (const stimulus of a.stimuli) {
      assert.equal(stimulus.method, method);
      assert.equal(stimulus.seed, "run-3");
      assert.ok(stimulus.prompt.length > 20);
    }
  }
  assert.equal(buildStimuli("kill-first-10", "x").stimuli.length, 10);
  assert.equal(new Set(buildStimuli("kill-first-10", "x").stimuli.map((s) => s.prompt)).size, 10);
  assert.equal(buildStimuli("synectics", "x", 5).stimuli.length, 5);
  assert.deepEqual(Object.keys(buildStimuli("zwicky", "x").stimuli[0]!.detail), [
    "picture",
    "conflict",
    "pointOfView",
    "timeStructure",
    "productRole",
  ]);
});

test("creative:stimuli writes one sheet per method with the strategy's proposition, the same for the same seed", (t) => {
  const root = setup(t);
  const dir = path.join(root, "public/projects", ID);
  writeFileSync(
    path.join(dir, "pipeline/strategy.json"),
    JSON.stringify({ proposition: "A test proposition.", audience: { who: "someone", moment: "at a bus stop" } }),
  );
  const first = cli(root, "scripts/creative-stimuli.ts", "--project", ID, "--method", "all", "--seed", "s1");
  assert.equal(first.status, 0, JSON.stringify(first.json));
  assert.equal(first.json.outputs!.length, STIMULUS_METHODS.length);
  const zwicky = path.join(dir, "pipeline/stimuli/zwicky-s1.json");
  const sheet = JSON.parse(readFileSync(zwicky, "utf8"));
  assert.equal(sheet.context.proposition, "A test proposition.");
  assert.match(sheet.stimuli[0].prompt, /A test proposition\./);
  const again = cli(root, "scripts/creative-stimuli.ts", "--project", ID, "--method", "zwicky", "--seed", "s1");
  assert.equal(again.status, 0);
  assert.deepEqual(JSON.parse(readFileSync(zwicky, "utf8")), sheet);
  const other = cli(root, "scripts/creative-stimuli.ts", "--project", ID, "--method", "zwicky", "--seed", "s2");
  assert.notDeepEqual(
    JSON.parse(readFileSync(path.join(dir, "pipeline/stimuli/zwicky-s2.json"), "utf8")).stimuli,
    sheet.stimuli,
  );
  assert.equal(other.status, 0);
});

test("creative:stimuli refuses an unknown method or a bad count as INVALID_INPUT", (t) => {
  const root = setup(t);
  const unknown = cli(root, "scripts/creative-stimuli.ts", "--project", ID, "--method", "brainstorm", "--seed", "s1");
  assert.equal(unknown.status, 1);
  assert.equal(unknown.json.error, "INVALID_INPUT");
  const count = cli(
    root,
    "scripts/creative-stimuli.ts",
    "--project",
    ID,
    "--method",
    "triz",
    "--seed",
    "s1",
    "--count",
    "0",
  );
  assert.equal(count.json.error, "INVALID_INPUT");
});
