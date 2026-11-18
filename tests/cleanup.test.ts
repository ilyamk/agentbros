import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { memoryGuard } from "../src/lib/workspace/cleanup";

const repo = path.resolve(import.meta.dirname, "..");
const runner = path.join(repo, "node_modules/.bin/tsx");

function workspace(t: TestContext, files: string[]): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "cleanup spaces "));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), "data");
  }
  return cwd;
}
function invoke(script: string, args: string[], cwd: string) {
  const result = spawnSync(runner, [path.join(repo, "scripts", script), ...args], { cwd, encoding: "utf8" });
  const envelope = JSON.parse(result.stdout);
  assert.equal(result.status, envelope.ok ? 0 : 1);
  return envelope;
}
const git = (cwd: string, ...args: string[]) => assert.equal(spawnSync("git", args, { cwd }).status, 0);
const exists = (cwd: string, file: string) => existsSync(path.join(cwd, file));

const FULL_PROJECT = [
  "public/projects/a/project.json",
  "src/projects/a/index.tsx",
  "out/a/vertical.mp4",
  ".cache/paid-responses/a/response.bin",
  ".cache/realtime/a/journal.json",
  ".cache/realtime-channels/a/journal.json",
  ".cache/realtime-editors/a/journal.json",
  ".cache/rhythm-evidence/a/evidence.json",
];

const OLD_QA_RUNTIME_FILES = [
  "out/qa/old-local-run/runtime.js",
  "out/qa/old-local-run/fixture/runtime.js",
  "out/qa/old-local-run/gsap.js",
];

test("project removal shows the plan by default and deletes the whole footprint only with --yes", (t) => {
  const cwd = workspace(t, [
    ...FULL_PROJECT,
    "public/projects/ab/project.json",
    "out/ab/vertical.mp4",
    ".cache/realtime/ab/journal.json",
  ]);
  const plan = invoke("project-remove.ts", ["--", "a"], cwd);
  assert.equal(plan.metadata.dryRun, true);
  assert.equal(plan.metadata.targets.length, FULL_PROJECT.length);
  assert.deepEqual(plan.outputs, []);
  for (const file of FULL_PROJECT) assert.ok(exists(cwd, file), file);

  const removed = invoke("project-remove.ts", ["a", "--yes"], cwd);
  assert.equal(removed.metadata.dryRun, false);
  for (const file of FULL_PROJECT) assert.ok(!exists(cwd, file), file);
  assert.ok(
    exists(cwd, "public/projects/ab/project.json") &&
      exists(cwd, "out/ab/vertical.mp4") &&
      exists(cwd, ".cache/realtime/ab/journal.json"),
  );
});

test("project removal rejects unknown and unsafe ids", (t) => {
  const cwd = workspace(t, ["public/projects/a/project.json"]);
  assert.equal(invoke("project-remove.ts", ["missing", "--yes"], cwd).error, "PROJECT_NOT_FOUND");
  for (const id of ["..", "../a", "a/b", "."])
    assert.equal(invoke("project-remove.ts", ["--project", id, "--yes"], cwd).error, "INVALID_INPUT", id);
  assert.ok(exists(cwd, "public/projects/a/project.json"));
});

test("a symlink escaping the workspace is refused and its target stays intact", (t) => {
  const cwd = workspace(t, ["public/projects/a/project.json"]);
  const outside = workspace(t, ["keep.txt"]);
  mkdirSync(path.join(cwd, "out"));
  symlinkSync(outside, path.join(cwd, "out", "a"));
  assert.equal(invoke("project-remove.ts", ["a", "--yes"], cwd).error, "VALIDATION");
  assert.ok(exists(outside, "keep.txt") && exists(cwd, "public/projects/a/project.json"));
});

test("nested symlinks are unlinked without touching their targets", (t) => {
  const cwd = workspace(t, ["public/projects/a/project.json"]);
  const outside = workspace(t, ["keep.txt"]);
  symlinkSync(outside, path.join(cwd, "public/projects/a/link"));
  assert.equal(invoke("project-remove.ts", ["a", "--yes"], cwd).ok, true);
  assert.ok(exists(outside, "keep.txt") && !exists(cwd, "public/projects/a"));
});

test("unsettled or unreadable paid operations block removal of the whole request", (t) => {
  const cwd = workspace(t, ["public/projects/a/project.json", "out/a/vertical.mp4"]);
  const ledger = path.join(cwd, "public/projects/a/pipeline/operations.json");
  mkdirSync(path.dirname(ledger));
  for (const content of [
    { jobs: { op: { state: "unknown", reservedMicros: 0 } } },
    { jobs: { op: { state: "failed", reservedMicros: 5 } } },
  ]) {
    writeFileSync(ledger, JSON.stringify(content));
    const plan = invoke("project-remove.ts", ["a"], cwd);
    assert.equal(plan.ok, true);
    assert.equal(plan.metadata.blocked.length, 1);
    assert.equal(invoke("project-remove.ts", ["a", "--yes"], cwd).error, "VALIDATION");
    assert.ok(exists(cwd, "out/a/vertical.mp4"), "nothing is removed when any target is blocked");
  }
  writeFileSync(ledger, "{broken");
  assert.equal(invoke("project-remove.ts", ["a", "--yes"], cwd).error, "VALIDATION");
  writeFileSync(ledger, JSON.stringify({ jobs: { op: { state: "published", reservedMicros: 0 } } }));
  assert.equal(invoke("project-remove.ts", ["a", "--yes"], cwd).ok, true);
  assert.ok(!exists(cwd, "out/a"));
});

test("tracked files need --allow-tracked and uncommitted edits are always refused", (t) => {
  const cwd = workspace(t, ["public/projects/a/project.json"]);
  git(cwd, "init", "-q");
  git(cwd, "add", ".");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  assert.equal(invoke("project-remove.ts", ["a", "--yes"], cwd).error, "VALIDATION");
  assert.equal(invoke("project-remove.ts", ["a"], cwd).metadata.targets[0].trackedFiles, 1);

  writeFileSync(path.join(cwd, "public/projects/a/project.json"), "edited");
  assert.equal(invoke("project-remove.ts", ["a", "--yes", "--allow-tracked"], cwd).error, "VALIDATION");
  assert.ok(exists(cwd, "public/projects/a/project.json"));

  git(cwd, "checkout", "--", ".");
  assert.equal(invoke("project-remove.ts", ["a", "--yes", "--allow-tracked"], cwd).ok, true);
  assert.ok(!exists(cwd, "public/projects/a"));
});

test("workspace clean honours scopes, --keep and the protected runtime and project state", (t) => {
  const keptFiles = ["public/projects/keep/project.json", "src/projects/keep/index.tsx", "out/keep/vertical.mp4"];
  const cwd = workspace(t, [
    ...FULL_PROJECT,
    ...keptFiles,
    "public/shared/sfx/click.mp3",
    ".env",
    "node_modules/pkg/index.js",
    "out/keep/bundle/bundle.js",
    "out/variants/a.mp4",
    "out/qa/phase0/report.json",
    "out/qa/offline-inference/evidence/report.json",
    "out/qa/offline-inference/runtime/model.bin",
    ".cache/font-contexts/context.json",
    "out/.gitkeep",
    ...OLD_QA_RUNTIME_FILES,
    "out/qa/hyperframes-native/report.json",
    "out/qa/native-composition-instances/other/report.json",
  ]);
  const before = invoke("workspace-clean.ts", ["--scope", "all", "--keep", "keep"], cwd);
  assert.equal(before.metadata.dryRun, true);
  assert.ok(exists(cwd, "out/variants/a.mp4"));

  invoke("workspace-clean.ts", ["--scope", "cache", "--yes"], cwd);
  assert.ok(
    !exists(cwd, ".cache/font-contexts") && exists(cwd, ".cache/paid-responses/a/response.bin"),
    "project state is not a disposable cache",
  );

  invoke("workspace-clean.ts", ["--scope", "bundles", "--keep", "keep", "--yes"], cwd);
  assert.ok(!exists(cwd, "out/keep/bundle") && exists(cwd, "out/keep/vertical.mp4"));

  invoke("workspace-clean.ts", ["--scope", "qa", "--yes"], cwd);
  assert.ok(
    !exists(cwd, "out/qa/phase0") &&
      !exists(cwd, "out/qa/offline-inference/evidence") &&
      exists(cwd, "out/qa/offline-inference/runtime/model.bin"),
  );

  invoke("workspace-clean.ts", ["--scope", "projects,renders", "--keep", "keep", "--yes"], cwd);
  for (const file of FULL_PROJECT) assert.ok(!exists(cwd, file), file);
  assert.ok(!exists(cwd, "out/variants"));
  for (const file of [
    ...keptFiles,
    "public/shared/sfx/click.mp3",
    ".env",
    "node_modules/pkg/index.js",
    "out/qa/offline-inference/runtime/model.bin",
    "out/.gitkeep",
  ])
    assert.ok(exists(cwd, file), file);

  invoke("workspace-clean.ts", ["--scope", "qa", "--include-runtime", "--yes"], cwd);
  assert.ok(!exists(cwd, "out/qa/offline-inference"));
  for (const file of OLD_QA_RUNTIME_FILES) assert.ok(!exists(cwd, file), file);
  assert.ok(
    !exists(cwd, "out/qa/hyperframes-native/report.json") && !exists(cwd, "out/qa/native-composition-instances/other"),
  );
});

test("workspace clean validates scopes and --keep before planning", (t) => {
  const cwd = workspace(t, ["public/projects/a/project.json"]);
  assert.equal(invoke("workspace-clean.ts", ["--yes"], cwd).error, "INVALID_INPUT");
  assert.equal(invoke("workspace-clean.ts", ["--scope", "everything", "--yes"], cwd).error, "INVALID_INPUT");
  assert.equal(
    invoke("workspace-clean.ts", ["--scope", "projects", "--keep", "typo", "--yes"], cwd).error,
    "INVALID_INPUT",
  );
  assert.ok(exists(cwd, "public/projects/a/project.json"));
});

const MEMORY = [
  "memory/AGENTS.md",
  "memory/preferences/preference-20261114-calm-voice.md",
  "memory/observations/observation-20261114-slow-hook.md",
  "memory/index.json",
  "memory/metrics.jsonl",
];

test("no scope but memory, and no project removal, ever touches the user's memory", (t) => {
  const cwd = workspace(t, [
    ...FULL_PROJECT,
    ...MEMORY,
    "out/variants/a.mp4",
    ".cache/font-contexts/context.json",
    "out/qa/phase0/report.json",
  ]);
  const planned = invoke("workspace-clean.ts", ["--scope", "all"], cwd);
  assert.ok(
    planned.metadata.targets.every((target: { path: string }) => !target.path.startsWith("memory")),
    "all excludes memory",
  );
  assert.equal(invoke("project-remove.ts", ["a", "--yes"], cwd).ok, true);
  for (const scope of ["projects", "renders", "bundles", "qa", "cache", "all"])
    assert.equal(invoke("workspace-clean.ts", ["--scope", scope, "--yes"], cwd).ok, true, scope);
  for (const file of MEMORY) assert.ok(exists(cwd, file), file);
  assert.ok(!exists(cwd, "out/variants") && !exists(cwd, ".cache/font-contexts"));
});

test("the memory scope lists entries, index and metrics, removes them only with --yes and keeps memory/AGENTS.md", (t) => {
  const cwd = workspace(t, MEMORY);
  const plan = invoke("workspace-clean.ts", ["--scope", "memory"], cwd);
  assert.equal(plan.metadata.dryRun, true);
  assert.deepEqual(plan.metadata.targets.map((target: { path: string }) => target.path).sort(), [
    "memory/index.json",
    "memory/metrics.jsonl",
    "memory/observations",
    "memory/preferences",
  ]);
  for (const file of MEMORY) assert.ok(exists(cwd, file), file);

  assert.equal(invoke("workspace-clean.ts", ["--scope", "memory", "--yes"], cwd).ok, true);
  assert.ok(exists(cwd, "memory/AGENTS.md"));
  for (const file of MEMORY.slice(1)) assert.ok(!exists(cwd, file), file);
});

test("a project's memory/usage record is project footprint: removed with the project, a tombstone keeps its metrics from a reused id", (t) => {
  const cwd = workspace(t, [
    ...FULL_PROJECT,
    ...MEMORY,
    "memory/usage/a.json",
    "memory/usage/ab.json",
    "memory/usage/gone.json",
    "public/projects/ab/project.json",
  ]);
  writeFileSync(path.join(cwd, "memory/metrics.jsonl"), "");
  const env = { ...process.env, AGENTBROS_MEMORY_ROOT: path.join(cwd, "memory") };
  const run = (script: string, args: string[]) =>
    JSON.parse(spawnSync(runner, [path.join(repo, "scripts", script), ...args], { cwd, encoding: "utf8", env }).stdout);
  const plan = run("project-remove.ts", ["a"]);
  assert.ok(
    plan.metadata.targets.some((target: { path: string }) => target.path === "memory/usage/a.json"),
    JSON.stringify(plan.metadata.targets),
  );
  assert.deepEqual(plan.metadata.blocked, []);
  assert.equal(run("project-remove.ts", ["a", "--yes"]).ok, true);
  assert.ok(!exists(cwd, "memory/usage/a.json") && exists(cwd, "memory/usage/ab.json"));
  for (const file of MEMORY) assert.ok(exists(cwd, file), `${file}: the user's memory stays`);
  const metrics = readFileSync(path.join(cwd, "memory/metrics.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    metrics.map((line: { project: string; event: string }) => [line.project, line.event]),
    [["a", "removed"]],
  );
  // A usage record whose project is already gone goes with --scope projects; a kept project's stays.
  const clean = run("workspace-clean.ts", ["--scope", "projects", "--keep", "ab"]);
  assert.deepEqual(
    clean.metadata.targets.map((target: { path: string }) => target.path),
    ["memory/usage/gone.json"],
  );
  assert.deepEqual(memoryGuard("memory/usage/a.json", "projects"), []);
  assert.equal(memoryGuard("memory/usage/a.json", "renders").length, 1);
  assert.equal(memoryGuard("memory/usage", "projects").length, 1, "the folder itself is the user's");
});

test("the memory guard refuses memory/AGENTS.md and its folder for every scope, and entries for any scope but memory", () => {
  for (const entry of ["memory", "memory/", "memory/AGENTS.md"])
    assert.equal(memoryGuard(entry, "memory").length, 1, entry);
  for (const scope of ["projects", "renders", "bundles", "qa", "cache"] as const)
    assert.equal(memoryGuard("memory/lessons", scope).length, 1, scope);
  assert.deepEqual(memoryGuard("memory/lessons", "memory"), []);
  assert.deepEqual(memoryGuard("out/memory", "renders"), []);
});
