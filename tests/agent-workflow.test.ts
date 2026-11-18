import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowObserver } from "../src/lib/bench/workflow-observer";
import { workflowScenarios } from "../src/lib/bench/workflow-scenarios";
import { checkWorkflowEvidence, runWorkflowEvaluation } from "../src/lib/bench/workflow-run";
import { observedHandoff } from "../src/lib/bench/workflow-assertions";
import { workflowReport } from "../src/lib/bench/workflow-report";
import { digest } from "../src/lib/bench/io";
import { WorkflowReportSchema } from "../src/types/workflow-evaluation";

const root = process.cwd();
function fixture(t: test.TestContext) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-workflow-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace"),
    evidence = path.join(directory, "evidence");
  mkdirSync(workspace);
  const entry = workflowScenarios(root)[0]!;
  return {
    directory,
    workspace,
    evidence,
    entry,
    observer: new WorkflowObserver(root, workspace, evidence, entry.scenario),
  };
}

test("v2 workflow suite independently freezes all material and leaves registered v1 unchanged", () => {
  const entries = workflowScenarios(root);
  assert.equal(entries.length, 14);
  assert.equal(new Set(entries.map((e) => e.scenario.id)).size, 14);
  for (const { scenario } of entries) {
    assert.ok(scenario.material.every((m) => m.path.startsWith("bench/workflows/v2/material/")));
    assert.equal(scenario.limits.mediaSpendUsd, 0);
    assert.equal(scenario.limits.downloadBytes, 0);
  }
  const legacy = JSON.parse(readFileSync("bench/tasks/explainer/task.json", "utf8"));
  assert.equal(legacy.material[0].sha256, "7320b9ed4748e2fdf5869eabf5ddccbfeb720c8cbad41e128edf20f632a459fa");
});
test("observations prove exact producer-consumer bytes while allowing unrelated work and equivalent routes", async (t) => {
  const { workspace, observer } = fixture(t);
  writeFileSync(path.join(workspace, "source.json"), '{"value":1}');
  await observer.operation("producer-a", [], ["source.json"], () => undefined, { kind: "command" });
  await observer.operation("independent-task", [], [], () => undefined, { kind: "discovery" });
  const consumer = await observer.operation("any-valid-consumer", ["source.json"], [], () =>
    JSON.parse(observer.read("source.json").toString()),
  );
  assert.equal(observedHandoff(observer.events, consumer.event, "source.json").command, "producer-a");
  const forged = { ...consumer.event, inputs: [{ ...consumer.event.inputs[0]!, sha256: digest("different bytes") }] };
  assert.throws(
    () => observedHandoff([...observer.events.slice(0, -1), forged], forged, "source.json"),
    /exact consumed/,
  );
  assert.throws(() => observedHandoff([consumer.event], consumer.event, "source.json"), /producer/);
});
test("mutation during consumption, symlinks and forged actors cannot produce accepted evidence", async (t) => {
  const { workspace, observer } = fixture(t);
  const file = path.join(workspace, "input.json");
  writeFileSync(file, "{}");
  await assert.rejects(
    observer.operation("consumer", ["input.json"], [], () => writeFileSync(file, '{"changed":true}')),
    /changed/,
  );
  assert.equal(observer.events.at(-1)?.passed, false);
  symlinkSync(file, path.join(workspace, "link.json"));
  assert.throws(() => observer.pin("link.json"), /Symlink/);
  assert.throws(() => observer.pin("../escape.json"));
  assert.throws(() => observer.record({ ...observer.events[0]!, actor: "invented-leaf" }), /actor identity/);
});
test("self-reported success and absent leaf traces remain inconclusive", (t) => {
  const { observer, entry } = fixture(t);
  const report = workflowReport(observer, { mode: "agent", commit: "a".repeat(40), scenarioSha256: entry.sha256 });
  assert.equal(report.status, "inconclusive");
  assert.equal(report.metrics.tokens, null);
  const leaf = workflowScenarios(root).find((e) => e.scenario.requiresLeaf)!;
  const missing = new WorkflowObserver(root, observer.workspace, path.join(observer.evidence, "leaf"), leaf.scenario);
  const leafReport = workflowReport(missing, {
    mode: "agent",
    commit: "a".repeat(40),
    scenarioSha256: leaf.sha256,
    outcome: "handoff",
  });
  assert.equal(leafReport.status, "inconclusive");
});
test("scenario command authority refuses paid work, unknown tools and unauthorised effects before launch", async (t) => {
  const { observer } = fixture(t);
  for (const [alias, argv] of [
    ["generate:model", []],
    ["imaginary-tool", []],
    ["transcribe", ["--force"]],
    ["commands", ["--write-doc"]],
    ["commands", ["--allow-download=true"]],
  ] as [string, string[]][])
    await assert.rejects(observer.execute(alias, argv), /authority/);
  assert.ok(observer.events.every((e) => e.exitCode === null));
  assert.equal(observer.activeProcesses, 0);
});
test("dry runs validate the frozen scenario without commands, agents or workspaces", async () => {
  const result = await runWorkflowEvaluation({ root, scenario: "recording-shorts", dryRun: true });
  assert.ok("dryRun" in result.metadata);
  assert.equal(result.metadata.dryRun, true);
  assert.deepEqual(result.outputs, []);
  await assert.rejects(
    runWorkflowEvaluation({ root, mode: "agent", scenario: "recording-shorts", dryRun: true }),
    /explicit/,
  );
});
test("model-specific budget calibration uses a new suite and refuses mismatched harness cells", async () => {
  const suite = "bench/workflows/v3/suite.json",
    entries = workflowScenarios(root, suite);
  assert.equal(entries.length, 3);
  assert.ok(entries.every((e) => e.suiteVersion === 3 && e.profile?.model === "gpt-6.1-sol"));
  assert.equal(entries.find((e) => e.scenario.id === "recording-shorts")!.scenario.limits.tokens, 500000);
  assert.equal(
    workflowScenarios(root).find((e) => e.scenario.id === "recording-shorts")!.scenario.limits.tokens,
    150000,
    "registered v2 allowance remains unchanged",
  );
  await assert.rejects(
    runWorkflowEvaluation({
      root,
      suite,
      scenario: "recording-shorts",
      mode: "agent",
      dryRun: true,
      agent: { harness: "codex", model: "unregistered-model", allowAgent: true },
    }),
    /differs from.*profile/,
  );
});
test("all deterministic contracts execute producers, real consumers and immutable evidence", async (t) => {
  const result = await runWorkflowEvaluation({ root });
  t.after(() => rmSync(path.join(root, path.dirname(result.outputs.at(-1)!)), { recursive: true, force: true }));
  assert.ok("counts" in result.metadata);
  assert.deepEqual(result.metadata.counts, { passed: 14, failed: 0, skipped: 0, inconclusive: 0 });
  assert.equal(result.metadata.accepted, true);
  for (const file of result.outputs.filter((f) => f.endsWith("/report.json"))) {
    const report = WorkflowReportSchema.parse(JSON.parse(readFileSync(path.join(root, file), "utf8")));
    assert.equal(report.mode, "contract");
    assert.ok(report.limitations.some((s) => s.includes("Fixture")));
    assert.equal(report.metrics.pendingOwnedCommands, 0);
    assert.equal(checkWorkflowEvidence(path.join(root, path.dirname(file))).metadata.integrity, true);
  }
  const recording = JSON.parse(
    readFileSync(
      path.join(
        root,
        result.outputs.find((f) => f.endsWith("/recording-shorts/report.json"))!,
      ),
      "utf8",
    ),
  );
  assert.ok(recording.events.some((e: { command: string }) => e.command === "shorts:prepare"));
  const directory = path.join(root, path.dirname(result.outputs[0]!));
  const report = WorkflowReportSchema.parse(JSON.parse(readFileSync(path.join(directory, "report.json"), "utf8")));
  const pin = report.events.flatMap((e) => e.outputs)[0]!;
  writeFileSync(path.join(directory, "blobs", pin.sha256), "corrupted");
  assert.throws(() => checkWorkflowEvidence(directory), /bytes changed/);
  assert.equal(existsSync(path.join(root, "public/projects/workflow-e2e")), false);
});
