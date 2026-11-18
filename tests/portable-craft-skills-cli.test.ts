/** CLI half of portable-craft-skills.test.ts: documented flags against installed --help and the workflow plans. Slow (one child per script), so in SLOW. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { documentedCommands, checkDocumentedFlags } from "./helpers/skill-contract";
import { productAdFixture } from "./workflow-product-ad-fixtures";
import { educationFixture } from "./workflow-education-fixture";
import { recordingFixture } from "./workflow-recording-edit-fixtures";
import { shortsFixture } from "./workflow-shorts-series.fixture";

const root = process.cwd();
const skills = [
  "creative-studio",
  "creative-strategy",
  "script-and-education",
  "recording-recut",
  "video-recipes",
  "editorial-storytelling",
  "motion-and-typography",
  "captions-and-localization",
  "harness-asset-import",
  "resource-discovery",
  "qa-and-delivery",
  "sound-design-and-mix",
  "model-and-asset-production",
  "blender-3d",
  "engine-selection",
  "reference-analysis",
  "reference-replica",
  "edit-research",
  "reference-preparation",
];
function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? markdownFiles(path.join(directory, e.name))
      : e.name.endsWith(".md")
        ? [path.join(directory, e.name)]
        : [],
  );
}
const runner = path.join(root, "node_modules/tsx/dist/cli.mjs");
function cli(script: string, args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [runner, path.join(root, script), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: process.env.HOME },
  });
  assert.ifError(result.error);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, script);
  return { ...result, envelope: JSON.parse(lines[0]!) };
}

test("every documented CLI flag resolves against actual installed help", () => {
  const files = [
    ...markdownFiles(".agents/agents"),
    ...skills.flatMap((skill) => markdownFiles(`.agents/skills/${skill}`)),
  ];
  const commands = files.flatMap((file) => documentedCommands(readFileSync(file, "utf8"), root));
  assert.ok(commands.length >= 35, "Ensure command examples were actually inspected");
  const temporary = mkdtempSync(path.join(tmpdir(), "skill-help-"));
  try {
    for (const script of new Set(commands.map((c) => c.script))) {
      const help = cli(script, ["--help"], temporary);
      assert.equal(help.status, 0, script);
      assert.equal(help.envelope.metadata.help, true, script);
      for (const command of commands.filter((c) => c.script === script)) checkDocumentedFlags(command, help.stderr);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("an unsupported command flag fails as INVALID_INPUT instead of executing instruction text", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "skill-invalid-"));
  try {
    const result = cli("scripts/video-workflow.ts", ["--invent-review"], cwd);
    assert.equal(result.status, 1);
    assert.equal(result.envelope.error, "INVALID_INPUT");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const scenario of ["product-ad", "education", "recording-edit", "shorts-series"] as const) {
  test(`documented ${scenario} route plans supplied synthetic inputs through actual CLI without project writes or generation`, (t) => {
    let cwd: string, request: unknown;
    if (scenario === "education") {
      const f = educationFixture();
      cwd = f.root;
      request = f.request;
      t.after(f.cleanup);
    } else if (scenario === "shorts-series") {
      const f = shortsFixture(t);
      cwd = f.root;
      request = f.request;
    } else {
      cwd = mkdtempSync(path.join(tmpdir(), "skill-plan-"));
      t.after(() => rmSync(cwd, { recursive: true, force: true }));
      request = scenario === "product-ad" ? productAdFixture(cwd) : recordingFixture(cwd);
    }
    writeFileSync(path.join(cwd, "request.json"), JSON.stringify(request));
    const before = readdirSync(cwd);
    const result = cli(
      "scripts/video-workflow.ts",
      ["--scenario", scenario, "--request", "request.json", "--scope-root", cwd],
      cwd,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.metadata.action, "plan");
    assert.equal(result.envelope.metadata.dryRun, true);
    assert.equal(result.envelope.metadata.apiCalls, 0);
    assert.equal(result.envelope.metadata.apiSpendUsd, 0);
    assert.deepEqual(result.envelope.outputs, []);
    assert.deepEqual(readdirSync(cwd), before);
  });
}
