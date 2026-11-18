import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { budgetDelta, budgetFor, budgetMarkdown, measureBudget, measureText } from "../src/lib/context/budget";
import { descriptionOf, repositoryText } from "../src/lib/context/repository";
import { listPlaybookIds } from "../src/lib/playbooks/project";

const root = path.resolve(import.meta.dirname, "..");
const loader = createRequire(import.meta.url).resolve("tsx");

test("real tree has positive boot/agent measurements and a step row for every playbook", () => {
  const budget = budgetFor(root);
  assert.deepEqual(
    budget.boot.map((row) => row.id),
    ["claude-code", "codex"],
  );
  for (const row of [...budget.boot, ...budget.subagents]) {
    assert.ok(row.bytes > 0);
    assert.ok(row.estimatedTokens > 0);
  }
  assert.equal(budget.mcp.status, "unknown");
  for (const id of listPlaybookIds(root)) {
    const steps = budget.steps.filter((row) => row.id.startsWith(`${id}/`));
    assert.ok(steps.length > 0, id);
    for (const row of steps) assert.ok(row.files.includes(`playbooks/${id}/AGENTS.md`));
    assert.ok(budget.playbooks.find((row) => row.id === id)!.bytes > 0);
  }
  const build = budget.steps.find((row) => row.id === "motion-design/build")!;
  assert.ok(build.files.includes("src/motion/AGENTS.md"));
  assert.ok(build.files.includes(".agents/skills/blender-3d/SKILL.md"));
  assert.match(budgetMarkdown(budget), /Estimated tokens/);
});

/**
 * What the first step of a route reads, held at its 2026-11-16 size rounded up to a KiB (before step-scoped reads:
 * product-promo/intake 91,277 bytes, explainer/intake 105,114, shorts-from-long/setup 41,463). Lower a ceiling when a
 * row shrinks; raising one needs the context-growth review in docs/context-budget.md.
 */
const FIRST_STEP_CEILINGS: Record<string, number> = {
  "product-promo/intake": 28 * 1024,
  "explainer/intake": 25 * 1024,
  "shorts-from-long/setup": 29 * 1024,
};
const ANY_FILM_INTAKE = 34 * 1024;
const ANY_FOOTAGE_SETUP = 42 * 1024;
/** Root AGENTS.md plus skill and agent descriptions (29,765 bytes on 2026-11-16). */
const BOOT_CEILING = 30 * 1024;

test("first-step reads stay step-scoped and within their ceilings", () => {
  const budget = budgetFor(root);
  for (const row of budget.boot)
    assert.ok(row.bytes <= BOOT_CEILING, `boot/${row.id} is ${row.bytes} bytes, ceiling ${BOOT_CEILING}`);
  for (const [id, ceiling] of Object.entries(FIRST_STEP_CEILINGS)) {
    const row = budget.steps.find((step) => step.id === id)!;
    assert.ok(row.bytes <= ceiling, `${id} reads ${row.bytes} bytes, ceiling ${ceiling}`);
  }
  for (const row of budget.steps) {
    if (row.id.endsWith("/intake"))
      assert.ok(row.bytes <= ANY_FILM_INTAKE, `${row.id} reads ${row.bytes} bytes, ceiling ${ANY_FILM_INTAKE}`);
    if (row.id.endsWith("/setup"))
      assert.ok(row.bytes <= ANY_FOOTAGE_SETUP, `${row.id} reads ${row.bytes} bytes, ceiling ${ANY_FOOTAGE_SETUP}`);
    // The chain's sections are read at their steps; intake reads the index and a type page, never every type.
    if (row.id.endsWith("/intake"))
      assert.ok(
        !row.files.includes("docs/production-chain/reference.md") && !row.files.includes("docs/film-types.md"),
        row.id,
      );
  }
  assert.ok(
    Buffer.byteLength(readFileSync(path.join(root, "docs/production-chain.md"), "utf8")) <= 10 * 1024,
    "docs/production-chain.md stays an index; detail goes in docs/production-chain/",
  );
});

test("estimate is deterministic for UTF-8, with folded and quoted descriptions", () => {
  assert.deepEqual(measureText("abcdé🌟"), { bytes: 10, estimatedTokens: 3 });
  assert.equal(descriptionOf("---\ndescription: >\n  Use this\n  for films.\n---\n"), "Use this for films.");
  assert.equal(descriptionOf(`---\ndescription: ${JSON.stringify('Use "quotes".')}\n---\n`), 'Use "quotes".');
  const description = "---\ndescription: Short\n  continued description.\n---\n";
  const texts: Record<string, string> = { "AGENTS.md": "root", ".agents/skills/test/SKILL.md": description };
  const budget = measureBudget({
    files: Object.keys(texts),
    read: (file) => texts[file],
    exists: (file) => file in texts,
  });
  assert.equal(budget.boot[0]!.bytes, Buffer.byteLength("rootShort continued description."));
});

test("ref delta uses git objects, handles removals and measures contributor largest card", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "budget-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  git("init", "-q");
  put("AGENTS.md", "abcd");
  put(".agents/agents/helper.md", "---\ndescription: A helper\n---\nDefinition.");
  put("contrib/categories/small.md", "x");
  put("contrib/categories/large.md", "123456789");
  put(
    "playbooks/product-promo/playbook.json",
    readFileSync(path.join(root, "playbooks/product-promo/playbook.json"), "utf8"),
  );
  put("playbooks/product-promo/AGENTS.md", "The playbook");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base");
  const before = budgetFor(dir, "HEAD");
  put("AGENTS.md", "abcdefgh");
  rmSync(path.join(dir, ".agents/agents/helper.md"));
  const after = budgetFor(dir);
  const delta = budgetDelta(after, before);
  assert.equal(delta.find((row) => row.id === "boot/codex")!.bytes, -4);
  // Deleted tracked definitions contribute zero, with their path reported missing.
  assert.equal(after.subagents[0]!.bytes, 0);
  assert.equal(after.contributor.bytes, 9);
  assert.equal(before.boot[0]!.bytes, 12);
  assert.match(budgetMarkdown(after, delta), /Δ bytes/);
  assert.throws(() => budgetFor(dir, "--bad-ref"));
  const repo = repositoryText(dir, "HEAD");
  assert.equal(repo.read(".env"), undefined);
  assert.equal(repo.read("../AGENTS.md"), undefined);
  assert.equal(measureBudget(repo).steps.length, before.steps.length);
});

test("budget CLI follows JSON contract, writes reports and rejects unknown arguments", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "budget-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const markdown = path.join(dir, "comment.md");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(path.join(dir, "AGENTS.md"), "Root instructions");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base");
  const script = path.join(root, "scripts/context-budget.ts");
  const run = spawnSync(
    process.execPath,
    ["--import", loader, script, "--base", "HEAD", "--write", "--markdown", markdown],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(run.stdout).ok, true);
  assert.match(readFileSync(markdown, "utf8"), /boot\/codex/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "out/context/budget.json"), "utf8")).version, 1);
  const invalid = spawnSync(process.execPath, ["--import", "tsx", "scripts/context-budget.ts", "--unknown"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(JSON.parse(invalid.stdout).ok, false);
  const help = spawnSync(process.execPath, ["--import", loader, script, "--help"], { cwd: dir, encoding: "utf8" });
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.equal(help.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(help.stdout).ok, true);
});
