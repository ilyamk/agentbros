import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  summarizeVisionResults,
  visionAcceptancePassed,
  visionHarnessArguments,
  VisionJudgementSchema,
  type VisionEvalResult,
} from "../src/lib/vision/evaluation";

function result(expected: "clear" | "defect" | "insufficient", variant = "candidate"): VisionEvalResult {
  return {
    harness: "codex",
    model: "configured",
    caseId: "case",
    category: "ui",
    variant,
    expected,
    judgement: { status: expected, evidenceIds: ["image"], note: "Observed frame", nextAction: "Concrete next action" },
    imagesDelivered: 1,
    citationsValid: true,
    elapsedMs: 10,
  };
}
function successful() {
  const rows = [
    ...Array.from({ length: 12 }, () => result("defect")),
    ...Array.from({ length: 6 }, () => result("clear")),
    ...Array.from({ length: 6 }, () => result("insufficient")),
  ];
  return [...rows, ...rows.map((row) => ({ ...row, variant: "baseline" }))];
}
test("acceptance refuses empty/smoke, failed calls, invalid citations and false assurance", () => {
  assert.equal(visionAcceptancePassed([]), false);
  assert.equal(visionAcceptancePassed(summarizeVisionResults([result("defect")])), false);
  assert.equal(visionAcceptancePassed(summarizeVisionResults(successful())), true);
  for (const change of [
    (r: VisionEvalResult) => {
      r.error = "timeout";
    },
    (r: VisionEvalResult) => {
      r.citationsValid = false;
    },
  ]) {
    const rows = successful();
    change(rows[0]!);
    assert.equal(visionAcceptancePassed(summarizeVisionResults(rows)), false);
  }
  const rows = successful();
  rows[18]!.judgement!.status = "clear";
  assert.equal(visionAcceptancePassed(summarizeVisionResults(rows)), false, "missing evidence cannot become a pass");
});
test("new format must preserve recall and improve a deficient baseline by the frozen margin", () => {
  const rows = successful();
  for (const i of [0, 1]) rows[i]!.judgement = { ...rows[i]!.judgement!, status: "clear" };
  assert.equal(visionAcceptancePassed(summarizeVisionResults(rows)), false);
  const improved = successful();
  for (const i of [24, 25, 26]) improved[i]!.judgement = { ...improved[i]!.judgement!, status: "clear" };
  assert.equal(visionAcceptancePassed(summarizeVisionResults(improved)), true);
});
test("harnesses use configured models, fresh sessions and only the confined image reader", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "vision-eval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "mcp.json"),
    schema = path.join(root, "schema.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { vision_review: { args: ["reader", "packet", "log"] } } }));
  writeFileSync(schema, "{}");
  const codex = visionHarnessArguments(
    "codex",
    "configured-model",
    root,
    config,
    schema,
    path.join(root, "result.json"),
  );
  assert.ok(codex.includes("configured-model"));
  assert.ok(codex.includes("read-only"));
  assert.ok(codex.includes("--ephemeral"));
  assert.ok(codex.includes("view_image"));
  assert.ok(codex.some((arg) => arg.startsWith("mcp_servers.vision_review.args=")));
  const claude = visionHarnessArguments(
    "claude",
    "configured-model",
    root,
    config,
    schema,
    path.join(root, "result.json"),
  );
  assert.ok(claude.includes("--restricted"));
  assert.ok(claude.includes("--strict-mcp-config"));
  assert.equal(claude[claude.indexOf("--tools") + 1], "");
  assert.ok(![...claude, ...codex].some((arg) => arg.includes("bypass-permission")));
  assert.throws(() =>
    VisionJudgementSchema.parse({ status: "clear", evidenceIds: [], note: "Did not look", nextAction: "none" }),
  );
});
