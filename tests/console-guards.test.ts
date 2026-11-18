/**
 * Guards so the studio console's files (RFC 0004) change no existing behaviour: out/console is not a render folder,
 * `console` is not a project id, the console's pipeline entries (inbox/, session/, cards/, ratings.json) are not route
 * markers, and step:violations without --project lists only projects with a lease or a violation log.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateProjectId } from "../src/lib/cli";
import { walkJson } from "../src/lib/footage/next";
import { isConsolePipelineEntry, projectFootprint } from "../src/lib/pipeline/paths";
import { detectRoute } from "../src/lib/pipeline/route";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");

function workspace(t: TestContext, files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "console-guards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}

function cli(root: string, script: string, args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, result.stdout + result.stderr);
  return JSON.parse(lines[0]!) as Record<string, any>;
}

test("workspace:clean --scope renders and bundles never touch out/console", (t) => {
  const root = workspace(t, {
    "out/a/vertical.mp4": "v",
    "out/a/bundle/bundle.js": "b",
    "out/console/events.jsonl": "{}\n",
    "out/console/bundle/x.js": "x",
  });
  const plan = cli(root, "workspace-clean.ts", ["--scope", "renders,bundles"]);
  assert.equal(plan.ok, true, plan.message);
  const paths = plan.metadata.targets.map((target: { path: string }) => target.path);
  assert.ok(paths.includes(path.join("out", "a")));
  assert.ok(!paths.some((entry: string) => entry.startsWith(path.join("out", "console"))), paths.join(", "));
  cli(root, "workspace-clean.ts", ["--scope", "renders", "--yes"]);
  assert.ok(existsSync(path.join(root, "out/console/events.jsonl")));
  assert.ok(!existsSync(path.join(root, "out/a")));
});

test("the project id console is reserved: not creatable, not removable, skipped by workspace:clean", (t) => {
  assert.throws(() => validateProjectId("console"), /reserved/);
  assert.doesNotThrow(() => validateProjectId("console-demo"));
  assert.throws(() => projectFootprint("console"), /reserved/);
  assert.throws(() => projectFootprint("Console"), /reserved/, "case-insensitive, as on APFS");
  const root = workspace(t, {
    "out/console/events.jsonl": "{}\n",
    "public/projects/console/project.json": "{}",
    "public/projects/a/project.json": "{}",
  });
  assert.equal(cli(root, "project-remove.ts", ["--project", "console", "--yes"]).error, "INVALID_INPUT");
  assert.equal(cli(root, "project-remove.ts", ["console", "--yes"]).error, "INVALID_INPUT");
  assert.ok(existsSync(path.join(root, "out/console/events.jsonl")));
  assert.equal(cli(root, "create-project.ts", ["--project", "console"]).error, "INVALID_INPUT");
  const plan = cli(root, "workspace-clean.ts", ["--scope", "projects"]);
  assert.equal(plan.ok, true, plan.message);
  const paths = plan.metadata.targets.map((target: { path: string }) => target.path);
  assert.ok(paths.includes(path.join("public", "projects", "a")));
  assert.ok(!paths.some((entry: string) => entry.includes("console")), paths.join(", "));
  assert.deepEqual(
    plan.metadata.skipped.map((entry: { path: string }) => entry.path),
    [path.join("public", "projects", "console")],
  );
  assert.match(plan.metadata.skipped[0].reason, /reserved: out\/console\/ belongs to the studio console/);
});

test("reserved ids compare case-insensitively: Console is skipped and out/Console is not a render", (t) => {
  const root = workspace(t, {
    "out/Console/events.jsonl": "{}\n",
    "public/projects/Console/project.json": "{}",
  });
  const plan = cli(root, "workspace-clean.ts", ["--scope", "projects,renders"]);
  assert.equal(plan.ok, true, plan.message);
  const paths = plan.metadata.targets.map((target: { path: string }) => target.path);
  assert.ok(!paths.some((entry: string) => entry.toLowerCase().includes("console")), paths.join(", "));
  assert.equal(plan.metadata.skipped[0].path, path.join("public", "projects", "Console"));
  const removal = cli(root, "project-remove.ts", ["Console", "--yes"]);
  assert.equal(removal.error, "INVALID_INPUT");
  assert.match(removal.message, /reserved/);
});

const RECORDING_REQUEST = JSON.stringify({ workflow: "recording-edit", source: { sha256: "a".repeat(64) } });

test("route detection and the footage scan skip the console's pipeline entries", (t) => {
  for (const entry of ["inbox/d1.json", "session/control.json", "cards/c1.json", "ratings.json", "./inbox"])
    assert.equal(isConsolePipelineEntry(entry), true, entry);
  for (const entry of ["footage/talk/recut-request.json", "inboxes/x.json", "brief.json", "evidence/ratings.json"])
    assert.equal(isConsolePipelineEntry(entry), false, entry);

  const root = workspace(t, {
    "public/projects/p/pipeline/inbox/recut-request.json": RECORDING_REQUEST,
    "public/projects/p/pipeline/cards/request-card.json": RECORDING_REQUEST,
    "public/projects/p/pipeline/session/request.json": RECORDING_REQUEST,
    "public/projects/p/pipeline/ratings.json": "{}",
    "public/projects/p/pipeline/footage/talk/notes.json": "{}",
  });
  const projectDir = path.join(root, "public/projects/p");
  assert.notEqual(detectRoute(projectDir).route, "footage", "console files are not a recording request");
  const pipeline = path.join(projectDir, "pipeline");
  assert.deepEqual(
    walkJson(pipeline).map((file) => path.relative(pipeline, file).split(path.sep).join("/")),
    ["footage/talk/notes.json"],
  );
  writeFileSync(path.join(pipeline, "footage/talk/recut-request.json"), RECORDING_REQUEST);
  assert.equal(detectRoute(projectDir).route, "footage", "a real request still counts");
});

test("step:violations without --project lists projects with a lease or a violation log, not a bare session folder", (t) => {
  const root = workspace(t, {
    "public/projects/control-only/pipeline/session/control.json": "{}",
    "public/projects/with-log/pipeline/session/violations.jsonl": "",
    "public/projects/plain/project.json": "{}",
  });
  const report = cli(root, "step-violations.ts", []);
  assert.equal(report.ok, true, report.message);
  assert.deepEqual(
    report.metadata.projects.map((project: { projectId: string }) => project.projectId),
    ["with-log"],
  );
});
