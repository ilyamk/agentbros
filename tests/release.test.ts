import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyRelease,
  bumpVersion,
  newShowcases,
  planRelease,
  readEntries,
  releaseDecision,
  releaseNotes,
  type ReleaseEntry,
} from "../src/lib/release";
import { parseChangeEntry } from "../src/lib/contrib/changes";
import { notesFor } from "../src/lib/release/notes";
import type { ApiSurface } from "../src/lib/api-surface";

const fixture = path.resolve("tests/fixtures/release");
const loader = path.resolve("node_modules/tsx/dist/loader.mjs");
const entry = (changes: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  category: "fix",
  bump: "patch",
  breaking: false,
  pr: 0,
  authors: ["alex"],
  body: "Repair.",
  file: ".changes/repair.md",
  ...changes,
});
const surface = (playbooks: string[] = []): ApiSurface => ({
  version: 1,
  commands: [],
  cliContract: {},
  schemas: [],
  blocks: [],
  mcpTools: [],
  playbooks,
  environmentVariables: [],
  unknown: [],
});
function temporary(t: test.TestContext): string {
  const root = mkdtempSync(path.join(tmpdir(), "release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "package.json"), '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n');
  cpSync(path.join(fixture, "entries"), path.join(root, ".changes"), { recursive: true });
  writeFileSync(path.join(root, ".changes/README.md"), "Keep this guide.\n");
  return root;
}
const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function initialise(root: string) {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "Fixture"]);
}
function cli(root: string, script: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", loader, path.resolve(`scripts/${script}.ts`), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
  });
}

test("bump matrix keeps minor declarations and maps 0.x breaking/major to minor", () => {
  for (const [version, bump, expected] of [
    ["0.1.2", "patch", "0.1.3"],
    ["0.1.2", "minor", "0.2.0"],
    ["0.1.2", "major", "0.2.0"],
    ["1.2.3", "patch", "1.2.4"],
    ["1.2.3", "minor", "1.3.0"],
    ["1.2.3", "major", "2.0.0"],
  ] as const)
    assert.equal(bumpVersion(version, bump), expected);
  assert.equal(releaseDecision("0.1.0", [entry({ breaking: true })]).version, "0.2.0");
  for (const version of ["v0.1.0", "01.2.3", "1.2", "1.2.3-beta", "../outside"])
    assert.throws(() => bumpVersion(version, "patch"));
});

test("ready criteria cover thresholds, breaking, security and the exact fourteen-day boundary", () => {
  const date = "2026-01-01T12:00:00Z";
  const decide = (entries: ReleaseEntry[], now = "2026-01-15T12:00:00Z") =>
    releaseDecision("0.1.0", entries, undefined, date, new Date(now));
  assert.equal(decide([]).ready, false);
  assert.equal(decide([entry()], "2026-01-15T11:59:59Z").ready, false);
  assert.deepEqual(decide([entry()]).reasons, ["time"]);
  assert.equal(
    releaseDecision(
      "0.1.0",
      Array.from({ length: 14 }, () => entry()),
    ).ready,
    false,
  );
  assert.deepEqual(
    releaseDecision(
      "0.1.0",
      Array.from({ length: 15 }, () => entry()),
    ).reasons,
    ["entries"],
  );
  assert.deepEqual(releaseDecision("0.1.0", [entry({ breaking: true })]).reasons, ["breaking"]);
  assert.deepEqual(releaseDecision("0.1.0", [entry({ category: "security" })]).reasons, ["security"]);
  assert.throws(() => decide([entry()], "bad"));
});

test("surface raises the declared bump and reports under-declarations before the 0.x mapping", () => {
  const result = releaseDecision(
    "0.1.0",
    [entry(), entry({ file: ".changes/add.md", bump: "minor" }), entry({ file: ".changes/break.md", breaking: true })],
    { classification: "breaking", breaking: ["removed flag"], added: [] },
  );
  assert.equal(result.version, "0.2.0");
  assert.equal(result.bump, "minor");
  assert.deepEqual(result.underDeclared, [".changes/repair.md", ".changes/add.md"]);
  assert.equal(
    releaseDecision("1.0.0", [entry()], { classification: "minor", breaking: [], added: ["flag"] }).version,
    "1.1.0",
  );
});

test("breaking change validation requires a separate non-empty Migration paragraph", () => {
  const source = readFileSync(path.join(fixture, "entries/rename.md"), "utf8");
  assert.equal(parseChangeEntry(source).breaking, true);
  for (const value of [
    source.replace(/\n\nMigration:[\s\S]*/, ""),
    source.replace("Migration: Replace --old with --new.", "Migration:  "),
    source.replace("Migration: Replace --old with --new.", "Migration:\n\nUnrelated paragraph."),
    source.replace("\n\nMigration:", "\nMigration:"),
  ])
    assert.throws(() => parseChangeEntry(value), /Migration:/);
});

test("change:add requires migration instructions for breaking entries and writes them when supplied", (t) => {
  const root = temporary(t);
  const args = [
    "--category",
    "command",
    "--bump",
    "major",
    "--breaking",
    "--summary",
    "Rename a flag",
    "--author",
    "alex",
  ];
  const invalid = cli(root, "change-add", args);
  assert.equal(invalid.status, 1);
  assert.match(JSON.parse(invalid.stdout).message, /Migration:/);
  assert.equal(existsSync(path.join(root, ".changes/rename-a-flag.md")), false);
  const valid = cli(root, "change-add", [...args, "--migration", "Replace --old with --new."]);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  assert.match(
    parseChangeEntry(readFileSync(path.join(root, ".changes/rename-a-flag.md"), "utf8")).body,
    /\n\nMigration: Replace --old with --new\./,
  );
});

test("notes match the golden category, migration, contributor and delta document", (t) => {
  const root = temporary(t);
  const notes = releaseNotes("0.2.0", readEntries(root), {
    metrics: { "raw.blocks.total": 1 },
    context: [{ id: "boot/codex", bytes: -20, estimatedTokens: -5 }],
    showcases: ["showcases/demo/showcase.json"],
  });
  assert.equal(notes, readFileSync(path.join(fixture, "notes.md"), "utf8"));
});

test("notes credit people only and omit sections without data", () => {
  const notes = releaseNotes(
    "0.2.0",
    [
      entry({ authors: ["unknown", "agentbros-release[bot]", "dependabot[bot]", "@Unknown"] }),
      entry({ category: "library", authors: ["alex", "agentbros-release"], file: ".changes/block.md" }),
    ],
    { metrics: {}, context: [{ id: "boot/codex", bytes: 0, estimatedTokens: 0 }], showcases: [] },
  );
  assert.match(notes, /### Contributors\n\n- Motion library: \[@alex\]\(https:\/\/github\.com\/alex\)\n$/);
  assert.doesNotMatch(notes, /unknown|\[bot\]|agentbros-release|Bug fixes: /i);
  for (const absent of [
    "Metrics delta",
    "Context delta",
    "New showcases",
    "Not supplied",
    "None.",
    "Benchmark campaign",
    "No numeric changes",
    "No context changes",
  ])
    assert.ok(!notes.includes(absent), absent);
  const bare = releaseNotes("0.2.0", [entry({ authors: ["unknown"] })], { botLogins: ["someone-else[bot]"] });
  assert.equal(bare, "## 0.2.0\n\n### Bug fixes\n\n- Repair.\n");
  assert.doesNotMatch(
    releaseNotes("0.2.0", [entry({ authors: ["someone-else"] })], { botLogins: ["someone-else[bot]"] }),
    /Contributors/,
  );
});

test("plan compares the last tag surface, handles initial releases and discovers added showcases", async (t) => {
  const root = temporary(t);
  initialise(root);
  assert.equal((await planRelease(root)).version, "0.1.0");
  assert.equal((await planRelease(root)).initial, true);
  mkdirSync(path.join(root, "docs/api"), { recursive: true });
  writeFileSync(path.join(root, "docs/api/surface.json"), JSON.stringify(surface(["old"])));
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "Snapshot"]);
  git(root, ["tag", "v0.1.0"]);
  mkdirSync(path.join(root, "showcases/demo"), { recursive: true });
  writeFileSync(path.join(root, "showcases/demo/showcase.json"), "{}");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "Showcase"]);
  const plan = await planRelease(root, { surface: surface(), now: new Date("2026-12-01") });
  assert.equal(plan.comparison?.classification, "breaking");
  assert.equal(plan.version, "0.2.0");
  assert.equal(plan.initial, false);
  assert.equal(plan.lastRelease?.tag, "v0.1.0");
  assert.deepEqual(plan.underDeclared, [".changes/block.md", ".changes/repair.md"]);
  assert.deepEqual(newShowcases(root), ["showcases/demo/showcase.json"]);
  await assert.rejects(planRelease(root, { since: "missing" }));
});

test("apply edits a temporary copy, preserves the guide and makes no commits or tags", (t) => {
  const root = temporary(t);
  initialise(root);
  const head = git(root, ["rev-parse", "HEAD"]);
  const result = cli(root, "release-apply", ["--version", "0.2.0"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(result.stdout).metadata.tag, "v0.2.0");
  assert.equal(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version, "0.2.0");
  assert.match(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), /^# Changelog\n\n## 0.2.0\n/);
  assert.equal(readEntries(root).length, 0);
  assert.equal(existsSync(path.join(root, ".changes/README.md")), true);
  assert.equal(git(root, ["rev-parse", "HEAD"]), head);
  assert.equal(git(root, ["tag"]), "");
  assert.throws(() => applyRelease(root, "0.3.0", "## 0.3.0\n"), /at least one/);
});

test("apply prepends existing history and refuses downgrades before consuming files", (t) => {
  const root = temporary(t);
  const entries = readEntries(root);
  writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.0.1\n\nOld notes.\n");
  assert.throws(() => applyRelease(root, "0.0.1", "## 0.0.1\n", entries), /backwards/);
  assert.equal(readEntries(root).length, 3);
  applyRelease(root, "0.2.0", releaseNotes("0.2.0", entries), entries);
  assert.match(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), /## 0.0.1\n\nOld notes\.\n$/);
});

test("apply works without git, including when a showcase folder exists, and accepts prepared notes", (t) => {
  const root = temporary(t);
  mkdirSync(path.join(root, "showcases"));
  const notes = releaseNotes("0.2.0", readEntries(root), { showcases: ["showcases/demo/showcase.json"] });
  const file = path.join(root, "notes.md");
  writeFileSync(file, notes);
  const result = cli(root, "release-apply", ["--version", "0.2.0", "--notes", file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), /\[demo\]/);
  const other = temporary(t);
  mkdirSync(path.join(other, "showcases"));
  assert.equal(cli(other, "release-apply", ["--version", "0.2.0"]).status, 0);
});

test("apply refuses a dangling changelog symlink before changing the version or entries", (t) => {
  const root = temporary(t);
  const target = path.join(root, "missing.md");
  symlinkSync(target, path.join(root, "CHANGELOG.md"));
  assert.throws(() => applyRelease(root, "0.2.0", releaseNotes("0.2.0", readEntries(root))), /regular file/);
  assert.equal(existsSync(target), false);
  assert.equal(readEntries(root).length, 3);
  assert.equal(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version, "0.1.0");
});

test("release CLIs use a single JSON envelope, accept paired snapshots and reject invalid input", (t) => {
  const root = temporary(t);
  initialise(root);
  for (const script of ["release-plan", "release-notes", "release-apply"]) {
    const result = cli(root, script, ["--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).metadata.help, true);
  }
  const result = cli(root, "release-plan", ["--now", "2026-11-15"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).metadata.initial, true);
  const notes = cli(root, "release-notes", ["--version", "0.2.0"]);
  assert.equal(notes.status, 0, notes.stdout + notes.stderr);
  assert.match(JSON.parse(notes.stdout).metadata.notes, /^## 0.2.0/);
  const invalid = cli(root, "release-notes", ["--version", "0.2.0", "--metrics-old", "missing"]);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error, "INVALID_INPUT");
  const before = path.join(root, "before.json");
  const after = path.join(root, "after.json");
  writeFileSync(before, '{"raw":{"blocks":2}}');
  writeFileSync(after, '{"raw":{"blocks":4}}');
  assert.match(
    notesFor(root, { version: "0.2.0", "metrics-old": before, "metrics-new": after }).notes,
    /raw.blocks: \+2/,
  );
  const context = {
    version: 1,
    boot: [{ id: "codex", bytes: 100, estimatedTokens: 25 }],
    steps: [],
    playbooks: [],
    subagents: [],
    contributor: { id: "contributor", bytes: 0, estimatedTokens: 0 },
  };
  writeFileSync(before, JSON.stringify(context));
  writeFileSync(after, JSON.stringify({ ...context, boot: [{ id: "codex", bytes: 80, estimatedTokens: 20 }] }));
  assert.match(
    notesFor(root, { version: "0.2.0", "context-old": before, "context-new": after }).notes,
    /boot\/codex: -20 bytes, -5 estimated tokens/,
  );
});
