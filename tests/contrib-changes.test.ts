import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseChangeEntry } from "../src/lib/contrib/changes";
const source = `---
category: fix
bump: patch # comment
breaking: false
pr: 0
authors: [person, "other"]
harness: codex
deps: Needed for local parsing
---
Fix local parsing.\n`;
test("validates change metadata, arrays, comments and summary", () => {
  assert.deepEqual(parseChangeEntry(source).authors, ["person", "other"]);
  assert.equal(parseChangeEntry(source).deps, "Needed for local parsing");
  for (const input of [
    source.replace('authors: [person, "other"]', "authors: []"),
    source.replace("breaking: false", "breaking: no"),
    source.replace("pr: 0", "pr: -1"),
    source.replace("bump: patch", "bump: tiny"),
    source.replace("Fix local parsing.", ""),
    source.replace("deps: Needed for local parsing", "deps: # empty"),
    source.replace("pr: 0", "pr: 0\npr: 1"),
    source.replace("category: fix", "category:\n  nested: fix"),
  ])
    assert.throws(() => parseChangeEntry(input));
  assert.throws(() => parseChangeEntry(source, ".changes/../bad.md"));
  assert.throws(() => parseChangeEntry(source.replace("pr: 0", "pr: 0\nbody: ignored")));
  assert.equal(
    parseChangeEntry(source.replace("Needed for local parsing", "Needed for the owner's parser")).deps,
    "Needed for the owner's parser",
  );
});
test("change:add writes validated entry, refuses overwrite and obeys CLI contract", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "contrib-add-"));
  const cli = path.resolve("scripts/change-add.ts");
  const tsx = path.resolve("node_modules/tsx/dist/loader.mjs");
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", tsx, cli, ...args], {
      cwd,
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
    });
  try {
    writeFileSync(path.join(cwd, ".env"), "THIS IS NOT A VALID ENV FILE\n");
    const args = [
      "--category",
      "fix",
      "--bump",
      "patch",
      "--summary",
      "Repair parsing",
      "--author",
      "person",
      "--harness",
      "codex",
    ];
    const first = run(args);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.equal(first.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(first.stdout).ok, true);
    assert.equal(
      parseChangeEntry(readFileSync(path.join(cwd, ".changes/repair-parsing.md"), "utf8")).body,
      "Repair parsing",
    );
    const again = run(args);
    assert.equal(again.status, 1);
    assert.equal(JSON.parse(again.stdout).error, "FILE_EXISTS");
    const novelty = run([...args, "--slug", "novel-fold", "--novelty", "fold adds adjustable perspective and creases"]);
    assert.equal(novelty.status, 0, novelty.stdout);
    assert.equal(
      parseChangeEntry(readFileSync(path.join(cwd, ".changes/novel-fold.md"), "utf8")).novelty,
      "fold adds adjustable perspective and creases",
    );
    assert.equal(run([...args, "--novelty", "fold\npr: 42"]).status, 1);
    for (const invalid of [
      ["--category", "unknown", "--bump", "patch", "--summary", "Bad"],
      [...args, "--slug", "../escape"],
      [...args, "--unknown"],
    ]) {
      const result = run(invalid);
      assert.equal(result.status, 1);
      assert.equal(result.stdout.trim().split("\n").length, 1);
      assert.equal(JSON.parse(result.stdout).ok, false);
    }
    assert.equal(JSON.parse(run(["--help"]).stdout).metadata.help, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
