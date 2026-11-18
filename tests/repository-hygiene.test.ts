import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { auditRepositoryHygiene } from "../src/lib/workspace/hygiene";

const homePath = path.posix.join("/", "Users", "private-maintainer", "old-checkout", "file.json");
const audit = (files: Record<string, string>) =>
  auditRepositoryHygiene({ files: Object.keys(files), exists: (file) => file in files, read: (file) => files[file] });

test("all source formats are checked for local machine paths and source-controlled maintenance output", () => {
  const windowsPath = ["C:", "Users", "private-maintainer", "old-checkout"].join("\\");
  const report = audit({
    "docs/current.md": `# Guide\n${homePath}`,
    "tests/helpers/snapshot.json": JSON.stringify({ root: homePath }),
    "scripts/example.py": `ROOT = ${JSON.stringify(homePath)}`,
    "src/example.ts": `const root = ${JSON.stringify(windowsPath)};`,
    "docs/verification/receipt.md": "# One-run result",
    "logs/run.log": "done",
    "tests/fixtures/portable.json": '{"path":"projects/demo/input.wav"}',
  });
  assert.equal(report.summary.localPaths, 4);
  assert.equal(report.summary.maintenanceOutputs, 2);
  assert.ok(report.findings.some((finding) => finding.file === "tests/helpers/snapshot.json" && finding.line === 1));
  assert.equal(JSON.stringify(report).includes(homePath), false, "The report must not copy the private source path");
  assert.equal(
    report.findings.some((finding) => finding.file === "tests/fixtures/portable.json"),
    false,
  );
});

test("media binaries outside inventory row (c) are findings", () => {
  const report = audit({
    "public/shared/music/bed.mp3": "",
    "src/assets/hero.PNG": "",
    "docs/readme/hero.png": "",
    "docs/readme/contributing-map.gif": "",
    "tests/fixtures/film-chain/track.wav": "",
    "docs/assets.md": "# Assets",
  });
  assert.deepEqual(
    report.findings.filter((finding) => finding.rule === "media-binary").map((finding) => finding.file),
    ["public/shared/music/bed.mp3", "src/assets/hero.PNG"],
  );
  assert.equal(report.summary.mediaBinaries, 2);
});

test("portable versioned product inputs and relative paths are not rejected as test-run data", () => {
  const report = audit({
    "src/lib/models/prices.json":
      '{"schemaVersion":2,"source":"https://example.test/users/person/prices","observedAsOf":"2026-11-16"}',
    "credits/source.json": '{"pinnedCommit":"0123456789","licence":"MIT"}',
    "bench/workflows/v4/suite.json": '{"version":4,"tasks":[]}',
    ".agents/skills/test/SKILL.md": "Read `src/lib/AGENTS.md`; save diagnostics under ignored `out/qa/`.",
  });
  assert.deepEqual(report.findings, []);
  const leakedQuery = audit({
    "config.json": JSON.stringify({ url: `https://example.test/submit?source=${encodeURIComponent(homePath)}` }),
  });
  assert.equal(leakedQuery.summary.localPaths, 1, "URL query data must not hide a private source path");
});

function workspace(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "repository-hygiene-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  put(".gitignore", "out/\nnode_modules/\nmemory/\n.env\n");
  put("AGENTS.md", "# Portable instructions");
  const script = path.resolve(import.meta.dirname, "../scripts/repo-hygiene.ts");
  const loader = createRequire(import.meta.url).resolve("tsx");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", loader, script, ...args], { cwd: root, encoding: "utf8" });
  return { root, put, run };
}

test("CLI detects non-ignored untracked files and ignored-but-tracked logs, preserving source and private ignored data", (t) => {
  const f = workspace(t);
  f.put("out/qa/ignored.log", homePath);
  f.put("memory/decision.md", homePath);
  f.put(".env", homePath);
  assert.equal(f.run("--check").status, 0);
  f.put("notes.json", JSON.stringify({ root: homePath }));
  const rejected = f.run("--check", "--write");
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(rejected.stdout).error, "VALIDATION");
  const report = readFileSync(path.join(f.root, "out/qa/repository-hygiene/report.json"), "utf8");
  assert.equal(report.includes(homePath), false);
  assert.ok(readFileSync(path.join(f.root, "notes.json"), "utf8").includes(homePath));
  rmSync(path.join(f.root, "notes.json"));
  f.put("out/qa/tracked.log", "temporary");
  execFileSync("git", ["add", "-f", "out/qa/tracked.log"], { cwd: f.root });
  assert.notEqual(f.run("--check").status, 0);
  assert.equal(f.run("--help").status, 0);
  assert.notEqual(f.run("--yes").status, 0);
  assert.notEqual(f.run("--check", "--clean").status, 0);
});

test("cleanup previews then clears QA run outputs while preserving functional runtime, projects, memory and credentials", (t) => {
  const f = workspace(t);
  for (const file of [
    "out/qa/run/report.json",
    "out/qa/old-runtime/runtime.js",
    "out/qa/offline-inference/runtime/model.bin",
    "public/projects/demo/project.json",
    "memory/decision.md",
    ".env",
    "node_modules/package/index.js",
  ])
    f.put(file, "keep unless QA output");
  const preview = f.run("--clean");
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(JSON.parse(preview.stdout).metadata.dryRun, true);
  assert.ok(existsSync(path.join(f.root, "out/qa/run/report.json")));
  const clean = f.run("--clean", "--yes");
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.equal(existsSync(path.join(f.root, "out/qa/run")), false);
  assert.equal(existsSync(path.join(f.root, "out/qa/old-runtime")), false);
  for (const file of [
    "out/qa/offline-inference/runtime/model.bin",
    "public/projects/demo/project.json",
    "memory/decision.md",
    ".env",
    "node_modules/package/index.js",
  ])
    assert.ok(existsSync(path.join(f.root, file)), file);
});

test("report writing and QA cleanup refuse an output root escaping the repository", (t) => {
  const f = workspace(t);
  const external = mkdtempSync(path.join(tmpdir(), "hygiene-external-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  mkdirSync(path.join(external, "qa/run"), { recursive: true });
  writeFileSync(path.join(external, "qa/run/keep.txt"), "outside");
  symlinkSync(external, path.join(f.root, "out"));
  assert.notEqual(f.run("--write").status, 0);
  const clean = f.run("--clean", "--yes");
  assert.notEqual(clean.status, 0);
  assert.equal(readFileSync(path.join(external, "qa/run/keep.txt"), "utf8"), "outside");
});

test("dangling private symlinks are inspected without following; canonical relative agent links remain portable", (t) => {
  const f = workspace(t);
  f.put(".agents/agents/helper.md", "# Portable agent");
  mkdirSync(path.join(f.root, ".claude"), { recursive: true });
  symlinkSync("../.agents/agents", path.join(f.root, ".claude/agents"));
  assert.equal(f.run("--check").status, 0);
  symlinkSync(homePath, path.join(f.root, "runtime.js"));
  const rejected = f.run("--check");
  assert.notEqual(rejected.status, 0);
  const finding = JSON.parse(rejected.stdout).details.findings.find(
    (row: { file: string }) => row.file === "runtime.js",
  );
  assert.equal(finding.rule, "local-path");
  assert.equal(rejected.stdout.includes(homePath), false);
});

test("public environment examples are scanned; forced tracked private configuration is refused without reading its values", (t) => {
  const f = workspace(t);
  f.put(".env.example", `ASSET_ROOT=${homePath}\n`);
  const example = f.run("--check");
  assert.notEqual(example.status, 0);
  assert.ok(
    JSON.parse(example.stdout).details.findings.some(
      (row: { file: string; rule: string }) => row.file === ".env.example" && row.rule === "local-path",
    ),
  );
  rmSync(path.join(f.root, ".env.example"));
  f.put(".env", `PRIVATE_ROOT=${homePath}\n`);
  execFileSync("git", ["add", "-f", ".env"], { cwd: f.root });
  const privateFile = f.run("--check");
  assert.notEqual(privateFile.status, 0);
  assert.ok(
    JSON.parse(privateFile.stdout).details.findings.some(
      (row: { file: string; rule: string }) => row.file === ".env" && row.rule === "maintenance-output",
    ),
  );
  assert.equal(privateFile.stdout.includes(homePath), false);
});

test("harness links must point at .agents/ and generated harness files must stay ignored", () => {
  const links: Record<string, string> = { ".claude/skills": "../.agents/skills", ".claude/agents": "../elsewhere" };
  const files: Record<string, string> = {
    ".claude/skills": "",
    ".claude/agents": "",
    ".cursor/mcp.json": "{}",
    ".codex/agents/critic.toml": "",
    "docs/guide.md": "# ok",
  };
  const report = auditRepositoryHygiene({
    files: Object.keys(files),
    exists: (file) => file in files,
    read: (file) => files[file],
    linkTarget: (file) => links[file],
  });
  const flagged = report.findings.filter((finding) => finding.rule === "harness-link").map((finding) => finding.file);
  assert.deepEqual(flagged.sort(), [".claude/agents", ".codex/agents/critic.toml", ".cursor/mcp.json"]);
  assert.equal(report.summary.harnessLinks, 3);
  const copy = auditRepositoryHygiene({
    files: [".claude/skills"],
    exists: () => true,
    read: () => "a real file, not a link",
  });
  assert.equal(copy.summary.harnessLinks, 1, "a copied folder instead of the link is refused");
});
