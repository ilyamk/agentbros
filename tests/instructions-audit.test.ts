import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TriageConfigSchema } from "../src/types/triage";
import { auditPlan, runAudit, splitSections } from "../src/lib/triage/audit";
import { readLedger } from "../src/lib/triage/ledger";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = TriageConfigSchema.parse({
  version: 2,
  enabled: true,
  judges: [
    { label: "anthropic", provider: "anthropic", model: "test-claude" },
    { label: "openai", provider: "openai", model: "test-openai" },
  ],
  perPrCapUsd: 0.5,
  monthlyCapUsd: 10,
  maxDiffBytes: 61440,
  pricing: {
    "test-claude": { inputUsdPerMtok: 1, outputUsdPerMtok: 2 },
    "test-openai": { inputUsdPerMtok: 1, outputUsdPerMtok: 2 },
  },
});
function temporary(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "instruction-audit-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function planFor(texts: Record<string, string>) {
  return auditPlan({ files: Object.keys(texts), read: (file) => texts[file], exists: (file) => file in texts });
}
function recordings(dir: string, count: number): void {
  for (let index = 1; index <= count; index++)
    for (const vendor of ["anthropic", "openai"])
      copyFileSync(
        path.join(root, "tests/fixtures/triage", `audit-${vendor === "anthropic" ? 0 : 1}-${vendor}.json`),
        path.join(dir, `${vendor === "anthropic" ? 0 : 1}-${vendor}-${index}.json`),
      );
}

test("split by headings with source lines; fenced headings remain section material", () => {
  const sections = splitSections("AGENTS.md", "Preamble\n# Root\nRule\n```md\n## Quoted\n```\n## Other\nLast\n");
  assert.deepEqual(
    sections.map(({ heading, line }) => ({ heading, line })),
    [
      { heading: "Preamble", line: 1 },
      { heading: "Root", line: 2 },
      { heading: "Other", line: 7 },
    ],
  );
  assert.match(sections[1]!.text, /## Quoted/);
});

test("audit maps tasks through the existing step-context resolver and includes other instruction levels", () => {
  const plan = planFor({
    "AGENTS.md": "# Root\nThe root rule.",
    "playbooks/product-promo/playbook.json": readFileSync(
      path.join(root, "playbooks/product-promo/playbook.json"),
      "utf8",
    ),
    "playbooks/product-promo/AGENTS.md": "# Playbook\nA repeated rule.",
    ".agents/skills/helper/SKILL.md": "---\ndescription: Use for a helper task.\n---\n# Body\nA skill body.",
    "not-instructions.md": "# Excluded",
  });
  assert.equal(plan.sections.length, 4);
  const body = plan.sections.find((section) => section.heading === "Body")!;
  assert.equal(
    body.tasks.some((task) => task.startsWith("boot/")),
    false,
  );
  const playbook = plan.sections.find((section) => section.file.startsWith("playbooks/"))!;
  assert.ok(playbook.tasks.includes("product-promo/build"));
  const prompt = plan.prompts[plan.sections.indexOf(playbook)]!;
  assert.match(prompt.user, /product-promo\/build/);
  assert.match(prompt.user, /The root rule/);
  for (const question of [
    /relevant to each task/,
    /filler, a restatement, outdated/,
    /conflict with another level/,
    /one level lower/,
  ])
    assert.match(prompt.system, question);
  assert.ok(plan.limitations.length > 0);
});

test("recorded audit ranks findings, reports agreement and never edits source instructions", async (t) => {
  const dir = temporary(t);
  const texts = { "AGENTS.md": "# Root\nRender with the CLI.\n## Other\nRepeat it." };
  const before = JSON.stringify(texts);
  const plan = planFor(texts);
  recordings(dir, plan.sections.length);
  const result = await runAudit(plan, {
    config,
    ledger: path.join(dir, "ledger.jsonl"),
    runId: "audit-1",
    env: { TRIAGE_RECORDINGS: dir },
  });
  assert.equal(result.report.sections.length, 2);
  assert.equal(result.report.findings.length, 4);
  assert.deepEqual(result.report.labels, []);
  assert.match(result.markdown, /AGENTS\.md:1/);
  assert.equal(JSON.stringify(texts), before);
  assert.equal(readLedger(path.join(dir, "ledger.jsonl")).length, 8);
});

for (const scenario of ["missing canary", "schema failure", "disagreement", "abstention"])
  test(`recorded audit requires human review on ${scenario}`, async (t) => {
    const dir = temporary(t);
    const plan = planFor({ "AGENTS.md": "# Root\nRender with the CLI." });
    recordings(dir, 1);
    const file = path.join(dir, "1-openai-1.json");
    const recording = JSON.parse(readFileSync(file, "utf8"));
    const judgement = JSON.parse(recording.output[0].content[0].text);
    if (scenario === "missing canary") delete judgement.canary;
    if (scenario === "schema failure") judgement.findings = "invalid";
    if (scenario === "disagreement") judgement.findings = [];
    recording.output[0].content[0].text = JSON.stringify(judgement);
    if (scenario === "abstention") recording.status = "incomplete";
    writeFileSync(file, JSON.stringify(recording));
    const result = await runAudit(plan, {
      config,
      ledger: path.join(dir, "ledger.jsonl"),
      runId: "audit-1",
      env: { TRIAGE_RECORDINGS: dir },
    });
    assert.deepEqual(result.report.labels, ["triage:needs-human"]);
  });

test("audit refuses unknown prices, null monthly caps and an unaffordable full plan before calls", async (t) => {
  const dir = temporary(t);
  const plan = planFor({ "AGENTS.md": "# Root\nRule.\n## Other\nMore rules." });
  const ledger = path.join(dir, "ledger.jsonl");
  for (const [changed, pattern] of [
    [{ ...config, monthlyCapUsd: null }, /undecided/],
    [{ ...config, pricing: {} }, /Unknown triage price/],
    [{ ...config, perPrCapUsd: 0.00001 }, /spend cap/],
  ] as const)
    await assert.rejects(
      runAudit(plan, { config: changed, ledger, runId: "audit-1", env: { TRIAGE_RECORDINGS: dir } }),
      pattern,
    );
  assert.equal(existsSync(ledger), false);
});

test("audit CLI plans offline, writes JSON/Markdown reports with recordings and emits one JSON line", (t) => {
  const dir = temporary(t);
  mkdirSync(path.join(dir, "contrib"));
  writeFileSync(path.join(dir, "contrib/triage.json"), JSON.stringify(config));
  writeFileSync(path.join(dir, "AGENTS.md"), "# Root\nRender with the CLI.");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "AGENTS.md", "contrib/triage.json");
  recordings(dir, 1);
  const loader = path.join(root, "node_modules/tsx/dist/loader.mjs");
  const script = path.join(root, "scripts/instructions-audit.ts");
  const env = { PATH: process.env.PATH, TRIAGE_RECORDINGS: dir, TRIAGE_LEDGER: path.join(dir, "ledger.jsonl") };
  for (const flag of ["--help", "--unknown"]) {
    const result = spawnSync(process.execPath, ["--import", loader, script, flag], { cwd: dir, env, encoding: "utf8" });
    assert.equal(result.status, flag === "--help" ? 0 : 1);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(result.stdout).ok, flag === "--help");
  }
  for (const dryRun of [true, false]) {
    const result = spawnSync(process.execPath, ["--import", loader, script, ...(dryRun ? ["--dry-run"] : [])], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    if (dryRun) {
      assert.equal(envelope.metadata.sectionCount, 1);
      assert.equal(existsSync(path.join(dir, "out/context")), false);
      assert.equal(existsSync(env.TRIAGE_LEDGER), false);
    } else {
      assert.equal(JSON.parse(readFileSync(path.join(dir, "out/context/audit.json"), "utf8")).findings.length, 2);
      assert.match(readFileSync(path.join(dir, "out/context/audit.md"), "utf8"), /Instruction audit/);
    }
  }
});
