import test from "node:test";
import assert from "node:assert/strict";
import { draftContributionPr, prMarkdown } from "../src/lib/contrib/pr";
import { parsePrBlock } from "../src/lib/contrib/pr-block";
import { checkContribution } from "../src/lib/contrib/check";
import { temporaryRepository } from "./contrib-tools-helpers";

test("PR Markdown contains a valid opening block and all requested sections", () => {
  const block = {
    category: "docs",
    size: "S" as const,
    autonomy: "assisted" as const,
    harness: "codex" as const,
    model: "test model",
    owner: "@tester",
    change: ".changes/repair.md",
  };
  const body = prMarkdown(block, "Repair the guide.", "The command was wrong.", "Docs only.", {
    version: 1,
    base: "base",
    head: "head",
    categories: ["docs"],
    gates: [{ name: "lint", command: ["pnpm", "lint"], exitCode: 1, durationMs: 3, summary: "Failure\nnext" }],
    notVerified: ["typecheck"],
  });
  assert.deepEqual(parsePrBlock(body), block);
  assert.equal(
    body,
    `<!-- agentbros:pr\ncategory: "docs"\nsize: "S"\nautonomy: "assisted"\nharness: "codex"\nmodel: "test model"\nowner: "@tester"\nchange: ".changes/repair.md"\n-->\n\n## What\n\nRepair the guide.\n\n## Why\n\nThe command was wrong.\n\n## Evidence\n\n- FAIL: pnpm lint (exit 1, 3 ms) — Failure next\n\n## Not verified\n\n- typecheck\n- lint did not pass\n\n## Risks\n\nDocs only.\n`,
  );
});
test("PR draft uses committed entry, validates flags and suppresses stale passing evidence", async () => {
  const repo = temporaryRepository();
  try {
    const options = {
      root: repo.root,
      model: "test-model",
      owner: "tester",
      why: "A concrete reason",
      risks: "A stated risk",
    };
    const body = draftContributionPr(options);
    assert.equal(parsePrBlock(body).harness, "codex");
    assert.match(body, /Repair a concrete problem/);
    assert.throws(() => draftContributionPr({ ...options, category: "library" }), /disagrees/);
    await checkContribution({ root: repo.root, only: ["typecheck"] }, () => ({
      exitCode: 0,
      stdout: '{"ok":true}',
      stderr: "",
    }));
    assert.match(draftContributionPr(options), /PASS: pnpm typecheck/);
    repo.write("docs/guide.md", "Changed again\n");
    repo.git("add", "docs");
    repo.git("commit", "-m", "follow-up");
    const stale = draftContributionPr(options);
    assert.match(stale, /evidence is stale/);
    assert.doesNotMatch(stale, /PASS: pnpm typecheck/);
    repo.write(".changes/other.md", "invalid");
    repo.git("add", ".changes");
    repo.git("commit", "-m", "extra entry");
    assert.throws(() => draftContributionPr(options), /Exactly one/);
  } finally {
    repo.dispose();
  }
});
test("PR CLI prints the body inside its single JSON envelope and optionally writes it, without gh", () => {
  const repo = temporaryRepository();
  try {
    repo.write(".env", "INVALID ENV CONTENT\n");
    const result = repo.cli(
      "contrib-pr",
      "--model",
      "test-model",
      "--owner",
      "tester",
      "--out",
      "draft/pr.md",
      "--why",
      "A reason",
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(parsePrBlock(json.metadata.body).change, ".changes/repair.md");
    assert.deepEqual(json.outputs, ["draft/pr.md"]);
    assert.equal(repo.cli("contrib-pr", "--model", "model").status, 1);
    assert.equal(JSON.parse(repo.cli("contrib-pr", "--help").stdout).metadata.help, true);
  } finally {
    repo.dispose();
  }
});

test("PR scalar encoding round-trips quoted model names and refuses unsupported multiline fields", () => {
  const block = {
    category: "docs",
    size: "S" as const,
    autonomy: "human" as const,
    harness: "other" as const,
    model: 'Model "quoted"',
    owner: "tester",
    change: ".changes/repair.md",
  };
  assert.equal(parsePrBlock(prMarkdown(block, "What", "Why", "Risks")).model, block.model);
  assert.throws(() => prMarkdown({ ...block, model: "two\nlines" }, "What", "Why", "Risks"), /newlines/);
});
test("PR draft does not present dirty checkout evidence as proof for committed HEAD", async () => {
  const repo = temporaryRepository();
  const runner = () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: "" });
  const options = { root: repo.root, model: "model", owner: "tester" };
  try {
    repo.write("docs/guide.md", "Uncommitted fix\n");
    const evidence = await checkContribution({ root: repo.root, only: ["typecheck"] }, runner);
    assert.ok(evidence.dirtyPaths?.includes("docs/guide.md"));
    assert.doesNotMatch(draftContributionPr(options), /PASS: pnpm typecheck/);
    repo.git("restore", "docs/guide.md");
    repo.write("src/untracked.ts", "export const value = 1;\n");
    await checkContribution({ root: repo.root, only: ["typecheck"] }, runner);
    assert.match(draftContributionPr(options), /Uncommitted changes/);
    assert.doesNotMatch(draftContributionPr(options), /PASS: pnpm typecheck/);
  } finally {
    repo.dispose();
  }
});
