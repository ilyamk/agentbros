import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditMarkdown, markdownAuditTsv, markdownFoldersTsv } from "../src/lib/context/markdown-audit";

const audit = (texts: Record<string, string>) =>
  auditMarkdown({ files: Object.keys(texts), read: (file) => texts[file], exists: (file) => file in texts });

test("folder and content audit distinguishes current consumers, agent inputs and disconnected histories", () => {
  const report = audit({
    "AGENTS.md": "# Instructions\nRead [guide](docs/current.md).",
    "src/worker.ts": 'const instructions = "docs/runtime.md";',
    "docs/current.md": "# Current guide\n[Evidence](verification/current.md)",
    "docs/runtime.md": "# Runtime input",
    "docs/verification/current.md": "# Measured acceptance",
    "docs/verification/old.md": "# Old trial\nOnly a dated report.",
    "docs/archive/index.md": "# Archive\n[old](../verification/old.md)",
    "docs/verification/helpers/runtime-pins.json": '{"path":"docs/verification/old.md","sha256":"abc"}',
    "docs/pending-plan.md": "# Product plan\nStatus: in progress.\nCurrent integration work.",
    "docs/finished-plan.md": "# Completed plan\nStatus: historical plan.\n[old](verification/old.md)",
    "docs/rollout-plan.md": "# Rollout\nStatus: evaluator implemented; remaining live work is pending.",
    "docs/partial-plan.md":
      "# Partial implementation\nStatus: implemented foundations; remaining integration is in progress.",
    ".agents/skills/film/SKILL.md": "# Agent prompt",
    "tests/fixtures/provider/docs.md": "# Fake provider documentation",
    "design-reference/techniques/move.md": "# Working movement reference",
    ".changes/change.md": "# Release input",
    "NOTICE.md": "# Attribution",
    "abandoned/notes.md": "# Unconnected notes",
  });
  const file = (name: string) => report.files.find((row) => row.path === name)!;
  for (const name of [
    "docs/current.md",
    "docs/runtime.md",
    "docs/pending-plan.md",
    "docs/rollout-plan.md",
    "docs/partial-plan.md",
    ".agents/skills/film/SKILL.md",
    "tests/fixtures/provider/docs.md",
    "design-reference/techniques/move.md",
    ".changes/change.md",
    "NOTICE.md",
  ])
    assert.equal(file(name).decision, "keep", name);
  assert.equal(file("docs/verification/current.md").decision, "review");
  assert.equal(file("docs/verification/current.md").connected, true);
  assert.match(file("docs/verification/current.md").reason, /References do not override/);
  for (const name of [
    "docs/verification/old.md",
    "docs/archive/index.md",
    "docs/finished-plan.md",
    "abandoned/notes.md",
  ])
    assert.equal(file(name).decision, "review", name);
  assert.equal(file("docs/verification/old.md").connected, false);
  assert.ok(file("docs/verification/old.md").references.every((ref) => ref.kind === "historical"));
  assert.deepEqual(file("docs/runtime.md").references, [{ file: "src/worker.ts", line: 1, kind: "code-or-config" }]);
  assert.ok(report.reviewOnlyDirectories.includes("abandoned"));
  const folder = report.directories.find((row) => row.path === "docs/verification")!;
  assert.equal(folder.markdown, 2);
  assert.equal(folder.keep, 0);
  assert.equal(folder.review, 2);
  assert.equal(folder.otherFiles, 1);
  assert.equal(folder.disposition, "review-only");
  assert.deepEqual(folder.roles, { evidence: 2 });
  assert.match(markdownFoldersTsv(report), /abandoned\treview-only\t/);
  assert.equal(report.summary.keep + report.summary.review, report.summary.markdown);
  assert.equal(report.brokenLinks.length, 0);
});

test("relative links, reference definitions and literal paths do not confuse equal basenames or external URLs", () => {
  const report = audit({
    "README.md":
      "# Root\n[guide](docs/nested/guide.md#start)\n[missing](missing.md)\n[external](https://example.test/docs/orphan.md)\n[encoded](docs/a%20b.md)\n[ref]: docs/reference.md\n[angle](<docs/my guide.md>)",
    "docs/nested/guide.md": "# Guide\n[local](README.md)\n[up](../../README.md)",
    "docs/nested/README.md": "# Nested guide",
    "docs/reference.md": "# Reference definition target",
    "docs/a b.md": "# Encoded link target",
    "docs/my guide.md": "# Angle link target",
    "docs/code guide.md": "# Quoted code target",
    "docs/orphan.md": "# Unknown guide",
    "src/test.ts": 'const unrelated = "https://example.test/docs/orphan.md";',
    "src/paths.ts": 'const guide = "docs/code guide.md";',
  });
  assert.equal(report.files.find((file) => file.path === "docs/orphan.md")!.connected, false);
  assert.equal(report.files.find((file) => file.path === "docs/nested/README.md")!.decision, "keep");
  assert.equal(report.files.find((file) => file.path === "docs/reference.md")!.connected, true);
  assert.equal(report.files.find((file) => file.path === "docs/a b.md")!.connected, true);
  assert.equal(report.files.find((file) => file.path === "docs/my guide.md")!.connected, true);
  assert.equal(report.files.find((file) => file.path === "docs/code guide.md")!.connected, true);
  assert.deepEqual(report.brokenLinks, [{ file: "README.md", line: 3, target: "missing.md" }]);
});

test("historical records remain reviewable when mentioned by current code; fixture and release mentions are not current consumers", () => {
  const report = audit({
    "src/worker.ts": 'const formerContract = "docs/finished-plan.md";',
    "docs/finished-plan.md": "# Plan\nStatus: implemented (2026-10-11).\n[report](verification/report.md)",
    "tests/fixtures/pins.json": '{"file":"docs/verification/report.md"}',
    ".changes/entry.md": "[old report](../docs/verification/report.md)",
    "docs/verification/report.md": "# Report",
  });
  const historical = report.files.find((file) => file.path === "docs/finished-plan.md")!;
  assert.equal(historical.decision, "review");
  assert.equal(historical.connected, true);
  assert.match(historical.reason, /resolve current references/);
  assert.equal(report.files.find((file) => file.path === "docs/verification/report.md")!.connected, false);
  assert.match(markdownAuditTsv(report), /src\/worker.ts:1 \(code-or-config\)/);
  assert.deepEqual(audit({ "one.md": "same", "two.md": "same" }).duplicates, [["one.md", "two.md"]]);
});

test("declared directory-loaded roles are retained and fenced link examples are not reported as broken links", () => {
  const report = audit({
    "contrib/categories/audio.md": "# Contribution instruction card",
    "bench/workflows/v3/README.md": "# Pinned evaluation protocol",
    "examples/workflows/README.md": "# Runnable example",
    "vendor/adapter/README.md": "# Source provenance",
    "tests/one-off-plan.md": "An unconnected implementation note.",
    "docs/one-off-plan.md": "# An unconnected note without declared active scope",
    "README.md":
      "# Root\n```md\n[example](does-not-exist.md)\n```\n[real](also-missing.md)\nInline example: `[example](not-a-real-link.md)`.",
  });
  assert.equal(report.files.filter((file) => file.decision === "keep").length, 5);
  assert.equal(report.files.find((file) => file.path === "tests/one-off-plan.md")!.decision, "review");
  assert.equal(report.files.find((file) => file.path === "docs/one-off-plan.md")!.decision, "review");
  assert.deepEqual(report.brokenLinks, [{ file: "README.md", line: 5, target: "also-missing.md" }]);
});

test("CLI includes untracked repository material, excludes ignored/private files, writes only optional reports and rejects output escapes", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "docs-audit-"));
  const external = mkdtempSync(path.join(tmpdir(), "docs-audit-external-"));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), text);
  };
  execFileSync("git", ["init", "-q"], { cwd: directory });
  put(".gitignore", "node_modules/\nmemory/\nout/\n.env\n");
  put("AGENTS.md", "# Instructions\n[guide](docs/current.md)");
  put("docs/current.md", "# Current guide");
  put("notes/old.md", "# Untracked notes");
  put("node_modules/package/README.md", "Dependency docs");
  put("memory/decision.md", "Private memory");
  put(".env", "docs/current.md");
  writeFileSync(path.join(external, "private.md"), "Private material");
  symlinkSync(path.join(external, "private.md"), path.join(directory, "outside.md"));
  const script = path.resolve(import.meta.dirname, "../scripts/docs-audit.ts");
  const loader = createRequire(import.meta.url).resolve("tsx");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", loader, script, ...args], { cwd: directory, encoding: "utf8" });
  const dry = run();
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.equal(JSON.parse(dry.stdout).metadata.markdown, 3);
  assert.equal(existsSync(path.join(directory, "out")), false);
  const written = run("--write");
  assert.equal(written.status, 0, written.stdout + written.stderr);
  assert.equal(written.stdout.trim().split("\n").length, 1);
  const report = JSON.parse(readFileSync(path.join(directory, "out/qa/docs-audit/report.json"), "utf8"));
  assert.equal(report.files.length, 3);
  assert.match(readFileSync(path.join(directory, "out/qa/docs-audit/directories.tsv"), "utf8"), /notes\treview-only/);
  assert.ok(report.skipped.includes("outside.md"));
  assert.equal(readFileSync(path.join(directory, "notes/old.md"), "utf8"), "# Untracked notes");
  assert.equal(run("--help").status, 0);
  assert.notEqual(run("--delete").status, 0);
  rmSync(path.join(directory, "out"), { recursive: true });
  symlinkSync(external, path.join(directory, "out"));
  const escaped = run("--write");
  assert.notEqual(escaped.status, 0);
  assert.equal(existsSync(path.join(external, "qa")), false);
});
