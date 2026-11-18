import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const repo = path.resolve(import.meta.dirname, "..");
const script = path.join(repo, "scripts/export-public.ts");
const ENTRY = "memory/preferences/preference-20261114-short-hook.md";
const HIT = "memory-entry preference-20261114-short-hook";
const SUMMARY = "Keep the hook under two seconds for this user";
const QUOTE_LINES = [
  String.raw`Крючок должен "сработать" до второй доли`,
  String.raw`и без пути C:\temp в кадре, никогда`,
];
const CODE = "`pnpm next --project a`";

test("export denies memory entries, keeps memory/AGENTS.md and reports decoded memory content anywhere else as a leak", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "export-memory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const front = [
    "---",
    "version: 1",
    'id: "preference-20261114-short-hook"',
    "type: preference",
    `summary: ${JSON.stringify(SUMMARY)}`,
    "source:",
    "  kind: user",
    `  quote: ${JSON.stringify(QUOTE_LINES.join("\n"))}`,
    "---",
  ].join("\n");
  const files: Record<string, string> = {
    "memory/AGENTS.md": "# Memory\n\nRules for the local memory folder.\n",
    [ENTRY]: `${front}\n\n| Rule | Why |\n|---|---|\n- ${CODE}\n`,
    "memory/index.json": "{}\n",
    "memory/metrics.jsonl": "{}\n",
    "README.md": "# Fixture\n",
    "docs/notes.md": `Notes\n${SUMMARY}.\n`,
    "docs/quote.md": `Said once:\n> ${QUOTE_LINES[1]}\n`,
    "docs/table.md": `| Column one | Column two |\n|---|---|\n| a | b |\n${CODE}\n`,
    "export.json": JSON.stringify({
      deny: [{ glob: "memory/**", except: ["memory/AGENTS.md"], reason: "local memory" }],
      denyByContent: [],
      leakPatterns: [],
      allowedHits: [],
    }),
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      script,
      "--dry-run",
      "--config",
      path.join(root, "export.json"),
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, AGENTBROS_MEMORY_ROOT: "" } },
  );
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.error, "VALIDATION", "a memory leak fails the export");
  const metadata = envelope.details;
  for (const file of [ENTRY, "memory/index.json", "memory/metrics.jsonl"])
    assert.ok(file in metadata.deniedFiles, file);
  assert.ok(!("memory/AGENTS.md" in metadata.deniedFiles));
  assert.deepEqual(metadata.unusedDenyRules, []);
  assert.deepEqual(
    metadata.hits.map((hit: { file: string; pattern: string }) => `${hit.file} ${hit.pattern}`),
    [`docs/notes.md ${HIT}`, `docs/quote.md ${HIT}`],
    "a decoded quote line with quotes and a backslash is found; separators, table rows and code lines are not needles",
  );
});

test("a proposal's approval quote and verdict are needles too", async (t) => {
  const { memoryContent } = await import("../src/lib/leak-scan");
  const root = mkdtempSync(path.join(tmpdir(), "leak-proposal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "proposals");
  mkdirSync(dir, { recursive: true });
  const approval = "Yes go ahead and add that caption sensor";
  const verdict = "Captions still covered the buttons twice after it";
  writeFileSync(
    path.join(dir, "proposal-20261114-caption-sensor.md"),
    [
      "---",
      "version: 1",
      'id: "proposal-20261114-caption-sensor"',
      "type: proposal",
      'summary: "Add a sensor for captions over buttons"',
      "proposal:",
      '  change: "sensor"',
      `  approval: ${JSON.stringify({ quote: approval, at: "2026-11-14" })}`,
      `  verdict: ${JSON.stringify(verdict)}`,
      "---",
      "",
    ].join("\n"),
  );
  const needles = memoryContent([root]).map(({ needle }) => needle);
  assert.ok(
    needles.some((needle) => approval.includes(needle) || needle.includes(approval)),
    "approval quote",
  );
  assert.ok(
    needles.some((needle) => verdict.includes(needle) || needle.includes(verdict)),
    "verdict",
  );
});
