import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { chartRoutesFixture, projectPins, population } from "./helpers/chart-quantity-routes";
import { COMMANDS } from "../src/mcp/catalog";
import { invokeCommand, prepareCommand } from "../src/mcp/bridge";
import { planProjectRender } from "../src/lib/render-plan";
const repo = path.resolve(import.meta.dirname, "..");
function cli(
  f: ReturnType<typeof chartRoutesFixture>,
  script: string,
  flags: string[] = [],
  env: Record<string, string | undefined> = {},
) {
  const before = projectPins(f.project);
  const run = spawnSync(
    process.execPath,
    [
      path.join(repo, "node_modules/tsx/dist/cli.mjs"),
      path.join(repo, "scripts", script),
      "--project",
      "test",
      ...flags,
    ],
    {
      cwd: f.root,
      encoding: "utf8",
      timeout: 20000,
      env: {
        AGENTBROS_NO_DOTENV: "1",
        AGENTBROS_EVENTS: "off",
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        ...env,
      },
    },
  );
  assert.ifError(run.error);
  assert.equal(run.stdout.trim().split("\n").length, 1, run.stderr);
  const envelope = JSON.parse(run.stdout);
  assert.equal(run.status, envelope.ok ? 0 : 1, run.stderr);
  assert.deepEqual(projectPins(f.project), before);
  assert.equal(existsSync(path.join(f.root, "out")), false);
  return envelope;
}
test("actual chart CLI and render dry-run emit one JSON with exact source pins and no inferred approval", (t) => {
  const f = chartRoutesFixture(t),
    report = cli(f, "chart-inspect.ts");
  assert.equal(report.ok, true);
  assert.deepEqual(report.outputs, []);
  assert.equal(report.metadata.status, "declared-correspondence");
  assert.equal(report.metadata.factualTruth, "unverified");
  assert.equal(report.metadata.humanApproval, "not-inferred");
  assert.equal(report.metadata.apiSpendUsd, 0);
  const plan = cli(f, "render-project.ts", ["--dry-run"]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.outputs, []);
  assert.equal(plan.metadata.chartQuantities.status, "declared-correspondence");
  assert.equal(
    plan.metadata.chartQuantities.inputs.find((p: { path: string }) => p.path.endsWith("/source.json")).sha256,
    f.bridge.bindings[0].source.sha256,
  );
  const unknown = cli(f, "chart-inspect.ts", ["--output", "invented.json"]);
  assert.equal(unknown.ok, false);
  assert.equal(existsSync(path.join(f.root, "invented.json")), false);
});
test("return-vs-population and stale bridge fail CLI/dry-run before child; blocked metadata retains current findings", (t) => {
  const f = chartRoutesFixture(t);
  f.bridge.bindings[0].quantity = population;
  f.saveBridge();
  for (const [script, flags] of [
    ["chart-inspect.ts", []],
    ["render-project.ts", ["--dry-run"]],
  ] as const) {
    const result = cli(f, script, [...flags]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "VALIDATION");
    const report = result.details.chartQuantities ?? result.details;
    assert.equal(report.status, "blocked");
    assert.ok(report.findings.some((finding: { code: string }) => finding.code === "CHART_SOURCE_MISMATCH"));
  }
  const bin = path.join(f.root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "pnpm"), "#!/bin/sh\ntouch child-was-called\nexit 1\n", { mode: 0o755 });
  assert.equal(cli(f, "render-project.ts", [], { PATH: `${bin}${path.delimiter}${process.env.PATH}` }).ok, false);
  assert.equal(existsSync(path.join(f.root, "child-was-called")), false);
  f.bridge.bindings[0].chartHash = "0".repeat(64);
  f.saveBridge();
  assert.equal(cli(f, "chart-inspect.ts").error, "VALIDATION");
});
test("exact numeric callout errors have precise canonical and storyboard pipeline refs; non-strict reports errors, strict refuses", (t) => {
  const f = chartRoutesFixture(t);
  f.config.scenes[0].leftPanel = { ...f.panel, callout: { ...f.panel.callout!, value: "+94%" } };
  f.write("project.json", f.config);
  const nonstrict = cli(f, "pipeline-check.ts", ["--json-only"]);
  assert.equal(nonstrict.ok, true);
  assert.equal(nonstrict.metadata.summary.readyToProceed, false);
  const finding = nonstrict.metadata.findings.find(
    (finding: { code: string }) => finding.code === "CHART_QUANTITY_MISMATCH",
  );
  assert.equal(finding.ref.jsonPath, "scenes[0].leftPanel.callout.value");
  assert.equal(finding.stage, "compose");
  assert.equal(cli(f, "render-project.ts", ["--dry-run"]).error, "VALIDATION");
  f.config.scenes[0].leftPanel = f.panel;
  f.write("project.json", f.config);
  f.storyboard.scenes[0].leftPanel = { ...f.panel, callout: { ...f.panel.callout!, value: "+94%" } };
  f.write("pipeline/storyboard.json", f.storyboard);
  const strict = cli(f, "pipeline-check.ts", ["--json-only", "--strict"]);
  assert.equal(strict.ok, false);
  assert.equal(strict.error, "VALIDATION");
  assert.ok(
    strict.details.findings.some(
      (f: { code: string; stage: string; ref: { jsonPath: string } }) =>
        f.code === "CHART_QUANTITY_MISMATCH" &&
        f.stage === "storyboard" &&
        f.ref.jsonPath === "scenes[0].leftPanel.callout.value",
    ),
  );
});
test("pipeline source refs are precise; missing bridge and legacy quantity remain visible/nonblocking even strict", (t) => {
  const f = chartRoutesFixture(t);
  f.bridge.bindings[0].source.recordId = "missing";
  f.saveBridge();
  const blocked = cli(f, "pipeline-check.ts", ["--json-only", "--strict"]);
  assert.equal(blocked.ok, false);
  assert.ok(
    blocked.details.findings.some(
      (finding: { code: string; ref: { file: string; jsonPath: string } }) =>
        finding.code === "CHART_SOURCE_MISMATCH" &&
        finding.ref.file.endsWith("chart-quantity-bindings.json") &&
        finding.ref.jsonPath === "bindings[0]",
    ),
  );
  unlinkSync(path.join(f.project, "pipeline/evidence/chart-quantity-bindings.json"));
  const pending = cli(f, "pipeline-check.ts", ["--json-only", "--strict"]);
  assert.equal(pending.ok, true);
  assert.equal(pending.metadata.summary.readyToProceed, true);
  assert.ok(
    pending.metadata.findings.some(
      (finding: { code: string; severity: string; ref: { jsonPath: string } }) =>
        finding.code === "CHART_SOURCE_REVIEW_REQUIRED" &&
        finding.severity === "info" &&
        finding.ref.jsonPath === "scenes[0].leftPanel.data[0]",
    ),
  );
  assert.equal(cli(f, "render-project.ts", ["--dry-run"]).metadata.chartQuantities.status, "unverified");
  const legacy = { ...f.panel, quantity: undefined, callout: { value: "+95%" } };
  f.config.scenes[0].leftPanel = legacy;
  f.storyboard.scenes[0].leftPanel = legacy;
  f.write("project.json", f.config);
  f.write("pipeline/storyboard.json", f.storyboard);
  const legacyResult = cli(f, "pipeline-check.ts", ["--json-only", "--strict"]);
  assert.equal(legacyResult.ok, true);
  assert.ok(
    legacyResult.metadata.findings.some(
      (finding: { code: string; severity: string }) =>
        finding.code === "CHART_QUANTITY_REVIEW_REQUIRED" && finding.severity === "info",
    ),
  );
  assert.equal(cli(f, "chart-inspect.ts").metadata.status, "unverified");
});
test("active TimelineIR checks current chart instead of borrowing canonical payload and preserves literal timeline CLI", (t) => {
  const f = chartRoutesFixture(t);
  const initial = f.initializeTimeline();
  const activeValid = cli(f, "render-project.ts", ["--timeline", "--dry-run"]);
  assert.equal(activeValid.ok, true);
  assert.equal(cli(f, "chart-inspect.ts", ["--timeline"]).metadata.status, "declared-correspondence");
  const changed = structuredClone(initial);
  changed.timeline.tracks[0].clips[0].payload!.scene = {
    ...f.scene,
    leftPanel: { ...f.panel, data: [{ value: 96 }], callout: { ...f.panel.callout!, value: "+96%" } },
  };
  f.write("pipeline/timeline-edit.json", changed);
  assert.equal(cli(f, "render-project.ts", ["--timeline", "--dry-run"]).error, "VALIDATION");
  assert.equal(cli(f, "chart-inspect.ts", ["--timeline"]).error, "VALIDATION");
  assert.equal(cli(f, "render-project.ts", ["--dry-run"]).ok, true);
  f.write("pipeline/timeline-edit.json", initial);
  f.config.scenes[0].leftPanel = { ...f.panel, callout: { ...f.panel.callout!, value: "+96%" } };
  f.write("project.json", f.config);
  assert.equal(cli(f, "render-project.ts", ["--dry-run"]).error, "VALIDATION");
  assert.equal(cli(f, "render-project.ts", ["--timeline", "--dry-run"]).ok, true);
  assert.equal(
    planProjectRender("test", "landscape", f.root, { timeline: true }).chartQuantities.activeCharts[0].chartHash,
    f.bridge.bindings[0].chartHash,
  );
});
test("MCP chart route is strict readonly local/scoped, invokes same actual CLI, and refuses injection/provider flags", async (t) => {
  const f = chartRoutesFixture(t),
    command = COMMANDS.find((c) => c.name === "chart_inspect")!;
  assert.equal(command.readOnly, true);
  assert.equal(command.paid, "local");
  assert.deepEqual(command.paths, []);
  const options = { root: f.root, codeRoot: repo, allowPaid: false, projectScope: "test", stderr: () => {} },
    before = projectPins(f.project);
  assert.throws(() => prepareCommand(command, { project: "other" }, options), /scope/);
  for (const extra of [{ "scope-root": "/" }, { execute: true }, { output: "outside" }, { "allow-paid": true }])
    assert.throws(() => prepareCommand(command, { project: "test", ...extra }, options));
  const result = await invokeCommand(command, { project: "test" }, options);
  assert.equal(result.ok, true);
  const metadata = result.metadata as Record<string, unknown>;
  assert.equal(metadata.status, "declared-correspondence");
  assert.equal(metadata.apiCalls, 0);
  assert.deepEqual(projectPins(f.project), before);
  f.bridge.bindings[0].value = 96;
  f.saveBridge();
  const failed = await invokeCommand(command, { project: "test" }, options);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "VALIDATION");
});

for (const changedInput of ["project.json", "pipeline/timeline-edit.json"])
  test(`render refuses different consumed ${changedInput} bytes even when current chart declarations still correspond`, (t) => {
    const f = chartRoutesFixture(t),
      timeline = changedInput.includes("timeline");
    if (timeline) f.initializeTimeline();
    const file = path.join(f.project, changedInput),
      before = fs.readFileSync(file),
      originalRealpath = fs.realpathSync;
    let calls = 0,
      changed = false;
    const mock = t.mock.method(fs, "realpathSync", (input: fs.PathLike) => {
      if (String(input) === file && ++calls === 3) {
        const value = JSON.parse(before.toString("utf8"));
        if (timeline) value.revision += 1;
        else value.name = "Changed after plan consumed bytes";
        fs.writeFileSync(file, JSON.stringify(value));
        changed = true;
      }
      return originalRealpath(input);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => planProjectRender("test", "landscape", f.root, { timeline }),
        (error: unknown) => {
          const e = error as {
            code: string;
            message: string;
            details: { chartQuantities: { status: string; findings: { code: string }[] } };
          };
          return (
            e.code === "VALIDATION" &&
            /different project\/timeline bytes/.test(e.message) &&
            e.details.chartQuantities.status === "blocked" &&
            e.details.chartQuantities.findings.some((f) => f.code === "CHART_SOURCE_MISMATCH")
          );
        },
      );
      assert.equal(changed, true);
      assert.equal(existsSync(path.join(f.root, "out")), false);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
      fs.writeFileSync(file, before);
    }
  });
