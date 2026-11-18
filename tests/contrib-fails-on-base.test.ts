import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { failsOnBase, proofBlocks } from "../src/lib/contrib/fails-on-base";
import type { GateRunner } from "../src/lib/contrib/check";
import { contributionGates } from "../src/lib/contrib/gates";
import { categoryPlan } from "../scripts/github/gh-category-gates";
import { changeText, temporaryRepository } from "./contrib-tools-helpers";

const regression = `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { value } from '../src/value.ts';
import { expected } from './support.ts';
test('regression', () => {
  assert.deepEqual(readFileSync(new URL('./fixtures/value.bin', import.meta.url)), Buffer.from([0, 255, 128]));
  assert.ok(statSync(new URL('./executable.sh', import.meta.url)).mode & 0o111);
  assert.equal(value, expected);
});\n`;

function fixture(category = "fix", baseValue = 0, headValue = 1, addTest = true) {
  const repo = temporaryRepository();
  repo.git("rm", ".changes/repair.md");
  repo.write(".gitignore", "node_modules\n");
  repo.write("src/value.ts", `export const value = ${baseValue};\n`);
  repo.write("tests/helpers/memory-root.ts", "export {};\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "proof base");
  const base = repo.git("rev-parse", "HEAD");
  symlinkSync(path.resolve("node_modules"), path.join(repo.root, "node_modules"), "dir");
  repo.write(".changes/repair.md", changeText(category));
  repo.write("src/value.ts", `export const value = ${headValue};\n`);
  if (addTest) {
    repo.write("tests/regression.test.ts", regression);
    repo.write("tests/support.ts", "export const expected = 1;\n");
    repo.write("tests/fixtures/value.bin", Buffer.from([0, 255, 128]));
    repo.write("tests/executable.sh", "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(repo.root, "tests/executable.sh"), 0o755);
  }
  repo.git("add", ".");
  repo.git("commit", "-m", "proof head");
  return { ...repo, base };
}

const run: GateRunner = (command, root, timeoutMs) => {
  assert.equal(timeoutMs, 600000);
  assert.deepEqual(command.slice(1), [
    "--import",
    "tsx",
    "--test",
    "--import",
    "./tests/helpers/memory-root.ts",
    "--test-reporter=tap",
    "tests/regression.test.ts",
  ]);
  assert.equal(realpathSync(path.join(root, "node_modules")), realpathSync("node_modules"));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(command[0]!, command.slice(1), { cwd: root, env, encoding: "utf8", timeout: timeoutMs });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};

for (const scenario of [
  { category: "fix", base: 0, head: 1, test: true, outcome: "proved" },
  { category: "docs", base: 0, head: 1, test: true, outcome: "not-applicable" },
  { category: "docs", base: 0, head: 1, test: false, outcome: "not-applicable" },
  { category: "fix", base: 0, head: 1, test: false, outcome: "no-test" },
  { category: "fix", base: 1, head: 1, test: true, outcome: "passes-on-base" },
  { category: "fix", base: 0, head: 0, test: true, outcome: "fails-on-head" },
])
  test(`base proof: ${scenario.outcome} (${scenario.category}, tests=${scenario.test})`, async () => {
    const repo = fixture(scenario.category, scenario.base, scenario.head, scenario.test);
    const trees: string[] = [];
    try {
      // Dirty source must not influence either committed revision's result.
      repo.write("src/value.ts", "export const value = 999;\n");
      const proof = await failsOnBase({ root: repo.root, base: repo.base }, (...args) => {
        trees.push(args[1]);
        return run(...args);
      });
      assert.equal(proof.outcome, scenario.outcome);
      assert.equal(proofBlocks(proof), !["proved", "not-applicable"].includes(scenario.outcome));
      for (const tree of trees) assert.equal(existsSync(tree), false, "temporary worktree removed");
      assert.equal(repo.git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
    } finally {
      repo.dispose();
    }
  });

test("force, explicit head and CLI JSON success/failure/help", async () => {
  const repo = fixture("docs");
  try {
    const head = repo.git("rev-parse", "HEAD");
    assert.equal((await failsOnBase({ root: repo.root, base: repo.base, head, force: true }, run)).outcome, "proved");
    const result = repo.cli("contrib-fails-on-base", "--base", repo.base, "--force", "--head", head);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(result.stdout).metadata.proof.outcome, "proved");
    const failed = repo.cli("contrib-fails-on-base", "--base", head, "--force");
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).metadata.proof.outcome, "no-test");
    for (const flags of [[], ["--base", "missing"], ["--unknown"]]) {
      const invalid = repo.cli("contrib-fails-on-base", ...flags);
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout.trim().split("\n").length, 1);
    }
    assert.equal(JSON.parse(repo.cli("contrib-fails-on-base", "--help").stdout).metadata.help, true);
  } finally {
    repo.dispose();
  }
});

test("exceptions and timeouts remove temporary Git worktrees without establishing proof", async () => {
  const repo = fixture();
  let tree = "";
  try {
    await assert.rejects(
      failsOnBase({ root: repo.root, base: repo.base }, (_, cwd) => {
        tree = cwd;
        throw new Error("runner failed");
      }),
      /runner failed/,
    );
    assert.equal(existsSync(tree), false);
    await assert.rejects(
      failsOnBase({ root: repo.root, base: repo.base }, () => ({
        exitCode: 124,
        stdout: "# fail 1",
        stderr: "timeout",
      })),
      /timed out/,
    );
    await assert.rejects(
      failsOnBase({ root: repo.root, base: repo.base }, () => ({
        exitCode: 130,
        interrupted: true,
        stdout: "",
        stderr: "interrupted",
      })),
      /interrupted/,
    );
    await assert.rejects(
      failsOnBase({ root: repo.root, base: repo.base }, () => ({ exitCode: 0, stdout: "", stderr: "" })),
      /did not report executing tests/,
    );
    assert.equal(repo.git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
  } finally {
    repo.dispose();
  }
});

test("G3 commands use the shared local/CI category plan and trusted base", () => {
  for (const [category, alias] of [
    ["fix", "contrib:fails-on-base"],
    ["library", "contrib:novelty"],
    ["playbook", "contrib:novelty"],
  ]) {
    const local = contributionGates([category!], "base-commit");
    const ci = categoryPlan([], "base-commit", contributionGates, [category!]);
    const expected = { name: `category:${alias}`, command: ["pnpm", alias, "--base", "base-commit"] };
    assert.deepEqual(
      local.find((gate) => gate.name === expected.name),
      expected,
    );
    assert.deepEqual(
      ci.find((gate) => gate.name === expected.name),
      expected,
    );
  }
});

test("a dangling base symlink cannot redirect the head test overlay outside its worktree", async () => {
  const repo = fixture();
  try {
    const head = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "--detach", repo.base);
    const outside = path.join(repo.root, "dangling-target.ts");
    symlinkSync(outside, path.join(repo.root, "tests/support.ts"));
    repo.git("add", ".");
    repo.git("commit", "-m", "dangling base symlink");
    const base = repo.git("rev-parse", "HEAD");
    unlinkSync(path.join(repo.root, "tests/support.ts"));
    repo.git("checkout", head, "--", "tests", "src/value.ts", ".changes/repair.md");
    repo.git("add", ".");
    repo.git("commit", "-m", "replace symlink with test support");
    await assert.rejects(failsOnBase({ root: repo.root, base }, run), /symlink/);
    assert.equal(existsSync(outside), false);
    assert.equal(repo.git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
  } finally {
    repo.dispose();
  }
});

test("a test that cannot load on base (it imports a module only the head adds) is not regression proof", async () => {
  const repo = temporaryRepository();
  try {
    repo.git("rm", ".changes/repair.md");
    repo.write(".gitignore", "node_modules\n");
    repo.write("src/value.ts", "export const value = 1;\n");
    repo.write("tests/helpers/memory-root.ts", "export {};\n");
    repo.git("add", ".");
    repo.git("commit", "-m", "proof base");
    const base = repo.git("rev-parse", "HEAD");
    symlinkSync(path.resolve("node_modules"), path.join(repo.root, "node_modules"), "dir");
    repo.write(".changes/repair.md", changeText("fix"));
    repo.write("src/added.ts", "export const added = 2;\n");
    repo.write(
      "tests/regression.test.ts",
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { added } from '../src/added.ts';\ntest('new feature', () => { assert.equal(added, 2); });\n",
    );
    repo.git("add", ".");
    repo.git("commit", "-m", "feature dressed as fix");
    const proof = await failsOnBase({ root: repo.root, base }, run);
    assert.equal(proof.outcome, "passes-on-base", JSON.stringify(proof));
    assert.match(proof.reason ?? "", /file level/);
    assert.equal(proofBlocks(proof), true);
  } finally {
    repo.dispose();
  }
});
