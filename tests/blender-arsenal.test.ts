import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { arsenalCandidates, arsenalStatus, auditArsenal } from "../src/lib/blender-arsenal/overview";
import { arsenalPaths, ensureArsenalLayout } from "../src/lib/blender-arsenal/paths";
import { readArsenalTasks } from "../src/lib/blender-arsenal/eval";
import { listRecipes } from "../src/lib/blender-arsenal/recipes";
import { SourceSchema } from "../src/lib/blender-arsenal/libraries/schemas";

const root = process.cwd();
const json = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "arsenal-audit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(path.join(root, "blender-arsenal"), path.join(directory, "blender-arsenal"), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}local`),
  });
  mkdirSync(path.join(directory, "scripts/blender"), { recursive: true });
  cpSync("scripts/blender/recipes", path.join(directory, "scripts/blender/recipes"), { recursive: true });
  cpSync("scripts/blender/materials", path.join(directory, "scripts/blender/materials"), { recursive: true });
  mkdirSync(path.join(directory, "docs"), { recursive: true });
  cpSync("docs/blender-arsenal", path.join(directory, "docs/blender-arsenal"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: directory }).status, 0);
  return directory;
}

test("tracked repository manifests meet the offline contribution gate", () => {
  const result = auditArsenal();
  assert.deepEqual(result.problems, []);
  assert.equal(result.pass, true);
  assert.ok(result.counts.extensions > 30 && result.counts.sources >= 10);
});

test("audit aggregates invalid manifests, unknown collection sources and malformed META", (t) => {
  const directory = fixture(t),
    p = arsenalPaths(directory);
  save(p.extensionsManifest, { unknown: true });
  save(path.join(p.collections, "bad.json"), {
    version: 1,
    name: "bad",
    status: "proposed",
    verified: false,
    items: ["unknown:thing"],
    notes: "",
  });
  writeFileSync(path.join(p.recipes, "broken.py"), 'META = {"unknown": True}\n');
  const result = auditArsenal(directory);
  assert.equal(result.pass, false);
  for (const pattern of [/extensions.json/, /Unknown collection source/, /recipe|META/i])
    assert.ok(
      result.problems.some((p) => pattern.test(p.file + p.problem)),
      String(pattern),
    );
  assert.ok(result.problems.every((p) => p.fix.length > 10));
});

test("approved sources need actual consent, evaluation, Verdict and measured numbers", (t) => {
  const directory = fixture(t),
    p = arsenalPaths(directory),
    data = json(p.librariesManifest);
  const source = (data.sources as Record<string, unknown>[])[0]!;
  source.status = "approved";
  delete source.consent;
  delete source.evaluation;
  save(p.librariesManifest, data);
  assert.ok(auditArsenal(directory).problems.some((p) => p.problem.includes("no consent")));
  assert.ok(auditArsenal(directory).problems.some((p) => p.problem.includes("no evaluation")));
  source.consent = { by: "fixture owner", date: "2026-11-15", note: "test approval" };
  source.evaluation = "docs/blender-arsenal/test-eval.md";
  save(p.librariesManifest, data);
  const file = path.join(directory, String(source.evaluation));
  assert.ok(auditArsenal(directory).problems.some((p) => p.problem.includes("Cannot read evaluation")));
  writeFileSync(file, "## Verdict\n\n## Trial results\n\n3 ms\n");
  assert.ok(auditArsenal(directory).problems.some((p) => p.problem.includes("completed Verdict")));
  writeFileSync(file, "## Verdict\n\nPending\n\n## Trial results\n\nPending\n");
  assert.ok(auditArsenal(directory).problems.some((p) => p.problem.includes("completed Verdict")));
  assert.ok(auditArsenal(directory).problems.some((p) => p.problem.includes("no trial numbers")));
  writeFileSync(
    file,
    "## Verdict\n\nApproved for fixture use.\n\n## Trial results\n\n| Measurement | Result |\n|---|---:|\n| Synthetic test | 23 ms |\n",
  );
  assert.equal(
    auditArsenal(directory).problems.some((p) => p.file.endsWith(`#${source.id}`)),
    false,
  );
});

test("rejected sources need a reason; proposed evaluation links must exist", (t) => {
  const directory = fixture(t),
    p = arsenalPaths(directory),
    data = json(p.librariesManifest);
  const source = (data.sources as Record<string, unknown>[])[0]!;
  source.status = "rejected";
  delete source.reason;
  source.evaluation = "docs/blender-arsenal/missing.md";
  save(p.librariesManifest, data);
  const result = auditArsenal(directory);
  assert.ok(result.problems.some((p) => p.problem.includes("no reason")));
  assert.ok(result.problems.some((p) => p.problem.includes("Cannot read evaluation")));
});

test("audit rejects tracked local payloads, retaining files and the git index", (t) => {
  const directory = fixture(t),
    p = ensureArsenalLayout(directory),
    file = path.join(p.local, "download.txt");
  writeFileSync(file, "tiny synthetic payload");
  assert.equal(spawnSync("git", ["add", "-f", "--", file], { cwd: directory }).status, 0);
  assert.ok(auditArsenal(directory).problems.some((p) => p.problem === "Local payload is tracked"));
  assert.equal(readFileSync(file, "utf8"), "tiny synthetic payload");
});

test("evaluation documents cannot escape through a symlink", (t) => {
  const directory = fixture(t),
    file = path.join(directory, "docs/blender-arsenal/cell_fracture.md");
  rmSync(file);
  symlinkSync(path.join(root, "package.json"), file);
  assert.ok(auditArsenal(directory).problems.some((p) => p.problem.includes("symlink")));
});

test("source schema is strict and supports optional evaluation/rejection evidence", () => {
  const source = (json("blender-arsenal/libraries.json").sources as unknown[])[0];
  assert.equal(SourceSchema.safeParse({ ...(source as object), unknown: true }).success, false);
  assert.equal(SourceSchema.safeParse({ ...(source as object), evaluation: "../escape.md" }).success, false);
});

test("status reports empty local state, exact collection commands and unmeasured recipes without creating directories", (t) => {
  const directory = fixture(t),
    result = arsenalStatus(directory);
  assert.equal(result.library.total, 0);
  assert.deepEqual(result.bakeCache, { bytes: 0, files: 0 });
  assert.ok(
    result.collections.every(
      (c) => c.missing === c.items.length && c.items.every((i) => i.command.startsWith("pnpm blender:assets")),
    ),
  );
  assert.equal(result.recipes.length, listRecipes(directory).length);
  assert.ok(result.recipes.every((r) => r.status === "unmeasured" && r.measuredCost === null));
  const p = ensureArsenalLayout(directory);
  writeFileSync(path.join(p.bakes, "synthetic.txt"), "1234567");
  assert.deepEqual(arsenalStatus(directory).bakeCache, { bytes: 7, files: 1 });
});

test("status reads measured recipe proof rather than treating null hints as zero", (t) => {
  const directory = fixture(t),
    file = path.join(directory, "proof.json");
  save(file, {
    schemaVersion: 1,
    generatedAt: "2026-11-15",
    settings: { samples: 4, resolution: [160, 90], frames: [1, 3], engine: "cycles" },
    pass: false,
    recipes: [{ id: "dust-burst", status: "failed", secondsPerFrame: 2.25, renderSecondsPerFrame: 1.5 }],
    sheet: null,
  });
  const recipe = arsenalStatus(directory, file).recipes.find((r) => r.id === "dust-burst")!;
  assert.equal(recipe.status, "failed");
  assert.equal(recipe.measuredCost?.secondsPerFrame, 2.25);
});

test("candidates merge source/extension rejections and proposals without approved entries", (t) => {
  const directory = fixture(t),
    p = arsenalPaths(directory),
    data = json(p.librariesManifest);
  const source = (data.sources as Record<string, unknown>[])[0]!;
  source.status = "rejected";
  source.reason = "Synthetic rejection";
  save(p.librariesManifest, data);
  const candidates = arsenalCandidates(directory);
  assert.ok(candidates.some((c) => c.kind === "source" && c.reason === "Synthetic rejection"));
  assert.ok(candidates.some((c) => c.kind === "extension" && c.status === "rejected"));
  assert.ok(candidates.every((c) => c.status !== "approved"));
});

test("ten benchmark rubrics resolve existing recipe, collection, extension and command ids", () => {
  const recipes = listRecipes().map((r) => r.id),
    p = arsenalPaths();
  const extensions = (json(p.extensionsManifest).extensions as { id: string }[]).map((e) => e.id);
  const tasks = readArsenalTasks("bench/blender-arsenal/tasks.json");
  assert.equal(tasks.length, 10);
  for (const task of tasks) {
    for (const id of task.expected.recipes) assert.ok(recipes.includes(id), id);
    for (const id of task.expected.extensions) assert.ok(extensions.includes(id), id);
    for (const id of task.expected.collections) assert.equal(json(path.join(p.collections, `${id}.json`)).name, id);
  }
});

test("CLI refuses layout symlinks before writing outside the worktree and rejects unknown flags", (t) => {
  const directory = fixture(t),
    outside = mkdtempSync(path.join(tmpdir(), "arsenal-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, arsenalPaths(directory).local);
  const loader = createRequire(import.meta.url).resolve("tsx");
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", loader, path.join(root, "scripts/blender-arsenal.ts"), ...args], {
      cwd: directory,
      encoding: "utf8",
    });
  const result = run(["init"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.match((JSON.parse(result.stdout) as { message: string }).message, /symlink/);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(run(["--unknown", "true"]).status, 1);
  for (const args of [
    ["audit", "--action=init"],
    ["--action", "audit", "--action=init"],
  ]) {
    const conflict = run(args);
    assert.equal(conflict.status, 1);
    assert.equal(JSON.parse(conflict.stdout).error, "INVALID_INPUT");
  }
});

test("gate passes a fixture with unsupported approvals explicitly corrected to proposed", (t) => {
  const directory = fixture(t),
    p = arsenalPaths(directory),
    data = json(p.librariesManifest);
  for (const source of data.sources as Record<string, unknown>[])
    if (source.status === "approved" && !source.consent) source.status = "proposed";
  save(p.librariesManifest, data);
  assert.deepEqual(auditArsenal(directory).problems, []);
});

test("live MCP asset kinds mirror the arsenal kinds", async () => {
  const { LIVE_ASSET_KINDS } = await import("../src/lib/backends/blender-live-schema");
  const { ASSET_KINDS } = await import("../src/lib/blender-arsenal/paths");
  assert.deepEqual([...LIVE_ASSET_KINDS], [...ASSET_KINDS]);
});
