import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PIPELINE_STAGES } from "../src/types/pipeline";

const repo = path.resolve(import.meta.dirname, "..");
const declared = () => ({
  kind: "chart",
  data: [{ value: 35, label: "2019", domain: { kind: "year-v1", year: 2019 } }],
  annotations: [
    {
      dataIndex: 0,
      text: "2019",
      binding: { version: 1, kind: "domain-label-v1", expectedDomain: { kind: "year-v1", year: 2019 } },
    },
  ],
});

function probe(projectPanel: unknown, storyboardPanel: unknown = projectPanel, strict = false) {
  const root = mkdtempSync(path.join(tmpdir(), "chart-probe-"));
  try {
    const directory = path.join(root, "public/projects/test");
    mkdirSync(path.join(directory, "pipeline"), { recursive: true });
    const config = {
      name: "Chart probe",
      productName: "Fixture",
      formats: ["landscape"],
      tagline: "",
      colors: { accent: "#ffffff", background: "#000000", text: "#ffffff" },
      voice: "rachel",
      musicPrompt: "",
      musicVolume: 0,
      scenes: [
        { id: "proof", text: "", visualType: "title", headline: "", durationInFrames: 30, leftPanel: projectPanel },
      ],
    };
    const files = {
      "project.json": config,
      "pipeline/storyboard.json": {
        scenes: [
          {
            id: "proof",
            beatId: "proof",
            voiceoverText: "",
            durationSec: 1,
            musicIntensity: "none",
            leftPanel: storyboardPanel,
          },
        ],
      },
      // A present validated storyboard must be marked done to avoid the independent
      // STAGE_HAS_OUTPUT_BUT_PENDING warning in strict-mode chart assertions.
      "pipeline/pipeline-state.json": {
        projectId: "test",
        currentStage: "brief",
        stages: Object.fromEntries(
          PIPELINE_STAGES.map((stage) => [
            stage,
            { status: stage === "storyboard" ? "done" : "pending", attempts: stage === "storyboard" ? 1 : 0 },
          ]),
        ),
        history: [],
        createdAt: "2026-10-12T00:00:00Z",
        updatedAt: "2026-10-12T00:00:00Z",
      },
    };
    for (const [name, value] of Object.entries(files)) writeFileSync(path.join(directory, name), JSON.stringify(value));
    const originals = Object.keys(files).map((name) => readFileSync(path.join(directory, name)));
    const result = spawnSync(
      process.execPath,
      [
        path.join(repo, "node_modules/tsx/dist/cli.mjs"),
        path.join(repo, "scripts/pipeline-check.ts"),
        "--project",
        "test",
        "--json-only",
        ...(strict ? ["--strict"] : []),
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20000,
        env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.stdout.trim().split("\n").length, 1, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(result.status, envelope.ok ? 0 : 1, result.stderr);
    Object.keys(files).forEach((name, index) =>
      assert.deepEqual(readFileSync(path.join(directory, name)), originals[index]),
    );
    return envelope;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("strict probe accepts explicit consistent chart declarations in storyboard and composed project", () => {
  const envelope = probe(declared(), undefined, true);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.metadata.summary.readyToProceed, true);
  assert.equal(envelope.metadata.summary.errorCount, 0);
  assert.ok(
    !envelope.metadata.findings.some((f: { code: string }) =>
      ["CHART_ANNOTATION_TARGET_INVALID", "CHART_DOMAIN_BINDING_MISMATCH", "CHART_SEMANTICS_REVIEW_REQUIRED"].includes(
        f.code,
      ),
    ),
  );
  assert.ok(
    envelope.metadata.findings.some(
      (f: { code: string; severity: string }) => f.code === "CHART_QUANTITY_REVIEW_REQUIRED" && f.severity === "info",
    ),
  );
});

test("probe locates a storyboard year contradiction even when canonical project is consistent", () => {
  const bad = declared();
  bad.annotations[0]!.binding.expectedDomain.year = 2020;
  bad.annotations[0]!.text = "2020";
  const envelope = probe(declared(), bad);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.metadata.summary.readyToProceed, false);
  const findings = envelope.metadata.findings.filter(
    (f: { code: string }) => f.code === "CHART_DOMAIN_BINDING_MISMATCH",
  );
  assert.ok(findings.length > 0);
  assert.ok(
    findings.every(
      (f: { severity: string; stage: string; ref: { file: string; jsonPath: string } }) =>
        f.severity === "error" &&
        f.stage === "storyboard" &&
        f.ref.file.endsWith("storyboard.json") &&
        f.ref.jsonPath.startsWith("scenes[0].leftPanel.annotations[0]"),
    ),
  );
});

test("strict probe refuses an invalid actual composed annotation target with precise project ref", () => {
  const bad = declared();
  bad.annotations[0]!.dataIndex = 4;
  const envelope = probe(bad, declared(), true);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, "VALIDATION");
  assert.equal(envelope.details.summary.readyToProceed, false);
  const finding = envelope.details.findings.find((f: { code: string }) => f.code === "CHART_ANNOTATION_TARGET_INVALID");
  assert.equal(finding.stage, "compose");
  assert.equal(finding.ref.jsonPath, "scenes[0].leftPanel.annotations[0]");
  assert.ok(finding.ref.file.endsWith("project.json"));
});

test("untyped legacy charts without annotations remain nonblocking informational review in strict mode", () => {
  const envelope = probe({ kind: "chart", data: [{ label: "Launch 2020", value: 35 }] }, undefined, true);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.metadata.summary.readyToProceed, true);
  const findings = envelope.metadata.findings.filter(
    (f: { code: string }) => f.code === "CHART_SEMANTICS_REVIEW_REQUIRED",
  );
  assert.equal(findings.length, 2);
  assert.ok(
    findings.every(
      (f: { severity: string; ref: { jsonPath: string } }) =>
        f.severity === "info" && f.ref.jsonPath === "scenes[0].leftPanel",
    ),
  );
});
