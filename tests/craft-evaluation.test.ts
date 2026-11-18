import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  ftruncateSync,
  openSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runWorkflow } from "../src/lib/workflows/dispatch";
import { readPinnedEvaluationJson } from "../src/lib/evaluation/service";
import { hashFile } from "../src/lib/assets/registry";
import { evaluateCraft, craftVariantFingerprint } from "../src/lib/evaluation/service";
import { CRAFT_RUBRICS } from "../src/lib/evaluation/rubrics";
import {
  CraftEvaluationRequestSchema,
  type CraftEvaluationRequest,
  type EvaluationPin,
} from "../src/types/craft-evaluation";
import { productAdFixture } from "./workflow-product-ad-fixtures";
import { educationFixture } from "./workflow-education-fixture";
import { reviewedRequest } from "./workflow-recording-edit-fixtures";
import { shortsFixture } from "./workflow-shorts-series.fixture";
const repo = path.resolve(import.meta.dirname, "..");
function temp(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "craft evaluation "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function pin(root: string, id: string, file: string): EvaluationPin {
  return { id, path: path.relative(realpathSync(root), realpathSync(file)), sha256: hashFile(file) };
}
function put(root: string, id: string, content: unknown): EvaluationPin {
  const file = path.join(root, `${id}.json`);
  writeFileSync(file, JSON.stringify(content));
  return pin(root, id, file);
}
function directoryHashes(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(root, file), hashFile(file)];
      }),
  );
}
function inputFiles(raw: unknown): { file: string; sha256: string }[] {
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw)) return raw.flatMap(inputFiles);
  const r = raw as Record<string, unknown>;
  const file = typeof r.file === "string" ? r.file : typeof r.path === "string" ? r.path : undefined;
  return [
    ...(file && typeof r.sha256 === "string" ? [{ file, sha256: r.sha256 }] : []),
    ...Object.values(r).flatMap(inputFiles),
  ];
}
function manifest(root: string, scenario: CraftEvaluationRequest["scenario"], raw: unknown): CraftEvaluationRequest {
  const all = inputFiles(raw),
    unique = [...new Map(all.map((v) => [v.file, v])).values()];
  // Shorts originals are transitively checked by their source dependency/context pins.
  const inputs = unique.length
    ? unique.map((v, i) => ({
        id: `input-${i}`,
        path: path.relative(root, path.resolve(root, v.file)),
        sha256: v.sha256,
      }))
    : [pin(root, "source-project", path.join(root, "public/projects/source/project.json"))];
  const skillFile = path.join(root, "skill-version.md");
  writeFileSync(skillFile, readFileSync(path.join(repo, ".agents/skills/qa-and-delivery/SKILL.md")));
  const skill = pin(root, "skill-version", skillFile);
  const config = put(root, "configuration", { version: 1, scenario });
  const decisions = put(root, "decisions", {
    version: 1,
    decisions: CRAFT_RUBRICS[scenario]
      .filter((c) => c.kind === "creative")
      .map((c) => ({
        criterion: c.id,
        observation: "Synthetic supplied marker only; speech labels are not authentic human narration.",
        choice: "Preserve the declared original evidence and context.",
        rationale: "Technical reproducibility; artistic intent still needs human review.",
        evidenceIds: [inputs[0].id],
        unresolved: ["Production creative acceptance remains pending."],
      })),
  });
  return CraftEvaluationRequestSchema.parse({
    version: 1,
    id: "pilot",
    material: "synthetic-fixture",
    scenario,
    inputs,
    baseline: {
      id: "baseline",
      request: put(root, "workflow-request", raw),
      skills: [skill],
      configuration: config,
      decisions,
    },
  });
}
test("all four actual supplied-media fixture plans evaluate with human creative review pending", async (t) => {
  const productRoot = temp(t);
  const education = educationFixture();
  t.after(() => education.cleanup());
  const recordingRoot = temp(t),
    recording = await reviewedRequest(recordingRoot);
  const shorts = shortsFixture(t);
  const cases = [
    ["product-ad", productRoot, productAdFixture(productRoot)],
    ["education", education.root, education.request],
    ["recording-edit", recordingRoot, recording],
    ["shorts-series", shorts.root, shorts.request],
  ] as const;
  for (const [scenario, root, raw] of cases) {
    const evaluated = manifest(root, scenario, raw);
    const created = await runWorkflow(scenario, raw, { action: "create", rootDir: root, scopeRoot: root });
    evaluated.baseline.evidence = created.outputs
      .filter((file) => file.endsWith(".json"))
      .slice(0, 16)
      .map((file, i) => pin(root, `artifact-${i}`, file));
    assert.ok(evaluated.baseline.evidence.length > 0, "Actual workflow artifacts should be pinned");
    const originalProjectHashes = directoryHashes(path.join(root, "public"));
    const report = await evaluateCraft(evaluated, root);
    assert.deepEqual(
      directoryHashes(path.join(root, "public")),
      originalProjectHashes,
      "Evaluation must not change existing project bytes",
    );
    if (scenario === "product-ad" || scenario === "recording-edit")
      await assert.rejects(
        () => runWorkflow(scenario, raw, { action: "create", rootDir: root, scopeRoot: root }),
        /exists|overwrites/,
      );
    assert.equal(report.variants[0].technical, "pass", JSON.stringify(report));
    assert.equal(report.variants[0].creative, "pending");
    assert.ok(
      report.variants[0].criteria
        .filter((c) => !["workflow-contract", "decision-evidence"].includes(c.criterion))
        .every((c) => c.status === "pending"),
    );
    assert.equal(report.apiCalls, 0);
    assert.equal(report.apiSpendUsd, 0);
    assert.ok(report.variants[0].workflowMetadata);
  }
});
test("known defective product proof/CTA is caught and pinned targeted repair resolves technical contract", async (t) => {
  const root = temp(t),
    raw = productAdFixture(root);
  const defective = structuredClone(raw);
  defective.beats[4].headline = "Wrong destination action";
  const request = manifest(root, "product-ad", defective);
  request.candidate = {
    ...request.baseline,
    id: "candidate",
    request: put(root, "fixed-request", raw),
    decisions: put(root, "fixed-decisions", {
      version: 1,
      decisions: CRAFT_RUBRICS["product-ad"]
        .filter((c) => c.kind === "creative")
        .map((c) => ({
          criterion: c.id,
          observation: "CTA label was mismatched.",
          choice: "Restore exact declared action.",
          rationale: "One truthful destination.",
          evidenceIds: [request.inputs[0].id],
        })),
    }),
  };
  request.repairs = [
    {
      criterion: "workflow-contract",
      baselineFingerprint: craftVariantFingerprint(request, request.baseline),
      candidateFingerprint: craftVariantFingerprint(request, request.candidate),
      decisionId: request.candidate.decisions.id,
      rationale: "Exact declared CTA restored.",
    },
  ];
  const report = await evaluateCraft(request, root);
  assert.equal(report.variants[0].technical, "fail");
  assert.equal(report.variants[1].technical, "pass");
  assert.equal(report.repairs[0].status, "evidence-resolved");
  assert.equal(report.variants[1].creative, "pending");
  request.repairs[0].candidateFingerprint = "a".repeat(64);
  await assert.rejects(() => evaluateCraft(request, root), /current baseline\/candidate/);
});
test("decision coverage fails independently; review cannot override technical failures or manufacture production approval", async (t) => {
  const root = temp(t),
    request = manifest(root, "product-ad", productAdFixture(root));
  request.baseline.decisions = put(root, "incomplete", {
    version: 1,
    decisions: [
      {
        criterion: "promise-payoff",
        observation: "Only one decision.",
        choice: "No complete rubric review.",
        rationale: "Known defective fixture.",
        evidenceIds: [request.inputs[0].id],
      },
    ],
  });
  assert.equal((await evaluateCraft(request, root)).variants[0].technical, "fail");
  const review = {
    version: 1,
    origin: "synthetic-fixture",
    reviewer: "Synthetic fixture only",
    reviewedAt: "2026-10-11T00:00:00Z",
    variantFingerprint: craftVariantFingerprint(request, request.baseline),
    observations: [
      {
        criterion: "promise-payoff",
        judgement: "accepted",
        note: "Synthetic judgement only.",
        evidenceIds: [request.inputs[0].id],
      },
    ],
  };
  request.baseline.review = put(root, "review", review);
  assert.equal((await evaluateCraft(request, root)).variants[0].creative, "pending");
  request.baseline.review = put(root, "fake-review", { ...review, productionReady: true });
  await assert.rejects(() => evaluateCraft(request, root), /productionReady|Unrecognized/);
  request.baseline.review = put(root, "agent-review", { ...review, origin: "agent" });
  await assert.rejects(() => evaluateCraft(request, root));
  request.baseline.review = put(root, "false-human", { ...review, origin: "human-declared" });
  await assert.rejects(() => evaluateCraft(request, root), /Synthetic fixture/);
  request.baseline.review = put(root, "technical-override", {
    ...review,
    observations: [{ ...review.observations[0], criterion: "workflow-contract" }],
  });
  await assert.rejects(() => evaluateCraft(request, root), /override technical/);
});
test("stale source/skill/review pins, changed baseline inputs and unpinned evidence are rejected", async (t) => {
  const root = temp(t),
    raw = productAdFixture(root),
    request = manifest(root, "product-ad", raw);
  const changed = structuredClone(request);
  changed.baseline.skills[0].sha256 = "a".repeat(64);
  await assert.rejects(() => evaluateCraft(changed, root), /Stale pin/);
  request.baseline.review = put(root, "stale-review", {
    version: 1,
    origin: "synthetic-fixture",
    reviewer: "Fixture",
    reviewedAt: "2026-10-11T00:00:00Z",
    variantFingerprint: "b".repeat(64),
    observations: [
      {
        criterion: "promise-payoff",
        judgement: "accepted",
        note: "Stale fixture.",
        evidenceIds: [request.inputs[0].id],
      },
    ],
  });
  await assert.rejects(() => evaluateCraft(request, root), /Stale review/);
  delete request.baseline.review;
  const changedRaw = structuredClone(raw);
  changedRaw.media[0].provenance.model = "different-source-declaration";
  request.candidate = {
    ...request.baseline,
    id: "candidate",
    request: put(root, "changed-source-request", changedRaw),
  };
  await assert.rejects(() => evaluateCraft(request, root), /same supplied inputs/);
  delete request.candidate;
  request.baseline.decisions = put(root, "unpinned-decision", {
    version: 1,
    decisions: [
      {
        criterion: "promise-payoff",
        observation: "Invented report.",
        choice: "Bad",
        rationale: "Bad",
        evidenceIds: ["imaginary-evidence"],
      },
    ],
  });
  await assert.rejects(() => evaluateCraft(request, root), /unpinned evidence/);
});
test("scope, symlink and sparse bounds enforced before reading; runner executes no caller-provided code", async (t) => {
  const root = temp(t),
    outside = temp(t),
    request = manifest(root, "product-ad", productAdFixture(root));
  writeFileSync(path.join(outside, "external.txt"), "private fixture");
  request.baseline.skills = [pin(outside, "outside-skill", path.join(outside, "external.txt"))];
  request.baseline.skills[0].path = path.join(outside, "external.txt");
  await assert.rejects(() => evaluateCraft(request, root), /escapes|outside/);
  symlinkSync(path.join(root, "configuration.json"), path.join(root, "symlink.json"));
  request.baseline.skills = [{ ...request.baseline.configuration, id: "linked-skill", path: "symlink.json" }];
  await assert.rejects(() => evaluateCraft(request, root), /ELOOP|symbolic/i);
  const fd = openSync(path.join(root, "sparse.bin"), "wx");
  try {
    ftruncateSync(fd, 33 * 1024 ** 3);
  } finally {
    closeSync(fd);
  }
  request.baseline.skills = [{ id: "sparse", path: "sparse.bin", sha256: "a".repeat(64) }];
  await assert.rejects(() => evaluateCraft(request, root), /size bound/);
});
test("CLI rubric/evaluation use one JSON envelope, reject invalid manifests and create no projects", (t) => {
  const root = temp(t),
    cli = (args: string[]) =>
      spawnSync(
        process.execPath,
        [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "scripts/craft-evaluation.ts"), ...args],
        { cwd: root, encoding: "utf8" },
      );
  const listed = cli(["--action=rubric"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim().split("\n").length, 1);
  assert.equal(Object.keys(JSON.parse(listed.stdout).metadata.rubrics).length, 4);
  const invalid = cli(["--action=evaluate"]);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error, "VALIDATION");
  const request = manifest(root, "product-ad", productAdFixture(root));
  const manifestPin = put(root, "manifest", request);
  const evaluated = cli([`--request=${path.join(root, manifestPin.path)}`, `--scope-root=${root}`]);
  assert.equal(evaluated.status, 0, evaluated.stderr + evaluated.stdout);
  assert.equal(JSON.parse(evaluated.stdout).metadata.report.variants[0].creative, "pending");
});

test("known-defective education qualifications, recording negation and shorts approval are caught", async (t) => {
  const education = educationFixture();
  t.after(() => education.cleanup());
  const educationBad = structuredClone(education.request);
  educationBad.claims[0].evidence[0].excerpt = "Invented claim that is absent from source.";
  const recordingRoot = temp(t),
    recording = await reviewedRequest(recordingRoot);
  recording.keepSpans[0].startFrame = 12;
  const shorts = shortsFixture(t);
  shorts.request.episodes[0].approvedSourceHash = "a".repeat(64);
  for (const [scenario, root, raw] of [
    ["education", education.root, educationBad],
    ["recording-edit", recordingRoot, recording],
    ["shorts-series", shorts.root, shorts.request],
  ] as const) {
    const report = await evaluateCraft(manifest(root, scenario, raw), root);
    assert.equal(
      report.variants[0].criteria.find((c) => c.criterion === "workflow-contract")!.status,
      "fail",
      scenario,
    );
  }
});
test("JSON is parsed from the hash-validated bytes, with strict JSON allocation bounds", (t) => {
  const root = temp(t),
    original = put(root, "pinned-json", { meaning: "original" });
  assert.deepEqual(readPinnedEvaluationJson(original, root), { meaning: "original" });
  writeFileSync(path.join(root, original.path), JSON.stringify({ meaning: "changed" }));
  assert.throws(() => readPinnedEvaluationJson(original, root), /Stale pin/);
  const fd = openSync(path.join(root, "large-json.json"), "wx");
  try {
    ftruncateSync(fd, 9 * 1024 ** 2);
  } finally {
    closeSync(fd);
  }
  assert.throws(
    () => readPinnedEvaluationJson({ id: "oversized-json", path: "large-json.json", sha256: "a".repeat(64) }, root),
    /8 MiB/,
  );
});
test("pinned artifact comparison records changed bytes without inventing quality improvements", async (t) => {
  const root = temp(t),
    request = manifest(root, "product-ad", productAdFixture(root));
  request.baseline.evidence = [put(root, "before-frame-evidence", { frame: 0, issue: "Declared label overlap." })];
  request.baseline.evidence[0].id = "frame-evidence";
  request.candidate = {
    ...request.baseline,
    id: "candidate",
    evidence: [put(root, "after-frame-evidence", { frame: 0, repair: "Declared layout adjustment." })],
  };
  request.candidate.evidence[0].id = "frame-evidence";
  const report = await evaluateCraft(request, root);
  assert.equal(report.artifactComparison[0].status, "changed");
  assert.equal(report.variants[1].creative, "pending");
  assert.equal(report.variants[1].deliveryEvidence.status, "pending");
});
test("existing delivery report import preserves blocked findings and validates exact configuration/output bindings", async (t) => {
  const root = temp(t),
    raw = productAdFixture(root);
  await runWorkflow("product-ad", raw, { action: "create", rootDir: root });
  const request = manifest(root, "product-ad", raw);
  const config = path.join(root, "public/projects", raw.projectId, "project.json");
  request.baseline.configuration = pin(root, "configuration", config);
  const { captureDeliverySnapshot } = await import("../src/lib/delivery/service");
  const { snapshot } = captureDeliverySnapshot(
    {
      version: 1,
      projectId: raw.projectId,
      mode: "draft",
      formats: ["landscape"],
      variants: ["clean"],
      timeline: true,
      placements: ["synthetic-test"],
      commercial: false,
      loudness: { targetLufs: -16, toleranceLu: 5, maxTruePeakDb: -1, audioRequired: true },
    },
    { rootDir: root },
  );
  const identity = snapshot.identities[0];
  // Deliberately blocked imported evidence, with no invented measured output or review approval.
  const report = {
    version: 1,
    projectId: raw.projectId,
    snapshotId: snapshot.id,
    createdAt: snapshot.createdAt,
    state: "blocked",
    request: {
      version: 1,
      projectId: raw.projectId,
      mode: "draft",
      formats: ["landscape"],
      variants: ["clean"],
      timeline: true,
      placements: ["synthetic-test"],
      commercial: false,
      loudness: { targetLufs: -16, toleranceLu: 5, maxTruePeakDb: -1, audioRequired: true },
    },
    sourceIdentities: [identity],
    findings: [{ code: "OUTPUT_MISSING", severity: "error", message: "Fixture intentionally has no rendered master." }],
    outputs: [],
    rights: [],
    costs: null,
    reviewEvidence: {},
    apiCalls: 0,
  };
  request.baseline.delivery = put(root, "delivery-report", report);
  const evaluated = await evaluateCraft(request, root);
  assert.equal(evaluated.variants[0].deliveryEvidence.status, "imported-blocked");
  assert.equal(evaluated.variants[0].technical, "fail");
  const manifestPin = put(root, "blocked-delivery-evaluation", request);
  const cli = spawnSync(
    process.execPath,
    [
      path.join(repo, "node_modules/tsx/dist/cli.mjs"),
      path.join(repo, "scripts/craft-evaluation.ts"),
      `--request=${path.join(root, manifestPin.path)}`,
      `--scope-root=${root}`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stdout).details.report.variants[0].technical, "fail");
  assert.equal((evaluated.variants[0].deliveryEvidence.findings as { code: string }[])[0].code, "OUTPUT_MISSING");
  assert.equal(evaluated.variants[0].creative, "pending");
  request.baseline.delivery = put(root, "delivery-incomplete", {
    ...report,
    state: "draft-needs-review",
    findings: [],
  });
  const incomplete = await evaluateCraft(request, root);
  assert.equal(incomplete.variants[0].deliveryEvidence.status, "imported-incomplete");
  assert.equal(incomplete.variants[0].technical, "fail");
  const outputFile = raw.media.find((media) => media.kind === "video")!.path;
  const outputPin = pin(root, "imported-output", outputFile);
  const withOutput = {
    ...report,
    outputs: [
      {
        path: outputFile,
        sha256: outputPin.sha256,
        format: "landscape",
        variant: "clean",
        sourceSnapshotHash: identity.sourceSnapshotHash,
        propsHash: identity.propsHash,
        durationSec: 5,
        fps: 30,
        width: 480,
        height: 480,
        integratedLufs: null,
        truePeakDb: null,
      },
    ],
  };
  request.baseline.delivery = put(root, "delivery-with-output", withOutput);
  await assert.rejects(() => evaluateCraft(request, root), /exact pinned evidence/);
  request.baseline.evidence.push(outputPin);
  assert.equal((await evaluateCraft(request, root)).variants[0].deliveryEvidence.status, "imported-blocked");
  request.baseline.delivery = put(root, "delivery-wrong-identity", {
    ...withOutput,
    outputs: [{ ...withOutput.outputs[0], sourceSnapshotHash: "a".repeat(64) }],
  });
  await assert.rejects(() => evaluateCraft(request, root), /matching source identity/);
  request.baseline.delivery = put(root, "delivery-valid-binding", withOutput);
  request.baseline.configuration = put(root, "wrong-configuration", { synthetic: "wrong snapshot" });
  await assert.rejects(() => evaluateCraft(request, root), /pinned project configuration/);
});
test("human observations are exact-variant declarations, not release authorization; a targeted creative repair remains explicit", async (t) => {
  const root = temp(t),
    request = manifest(root, "product-ad", productAdFixture(root));
  request.material = "supplied-pilot"; // Only exercise the declaration schema; this test creates no real pilot acceptance.
  request.candidate = {
    ...request.baseline,
    id: "candidate",
    decisions: put(root, "candidate-decisions", {
      version: 1,
      decisions: CRAFT_RUBRICS["product-ad"]
        .filter((c) => c.kind === "creative")
        .map((c) => ({
          criterion: c.id,
          observation: "Synthetic fixture demonstrates review-binding mechanics only.",
          choice: "Restore declared action label.",
          rationale: "Target one reported defect.",
          evidenceIds: [request.inputs[0].id],
        })),
    }),
  };
  const beforeFingerprint = craftVariantFingerprint(request, request.baseline),
    afterFingerprint = craftVariantFingerprint(request, request.candidate);
  const review = (fingerprint: string, changes: boolean) => ({
    version: 1,
    origin: "human-declared",
    reviewer: "SYNTHETIC SCHEMA TEST; not a real human approval",
    reviewedAt: "2026-10-11T00:00:00Z",
    variantFingerprint: fingerprint,
    observations: CRAFT_RUBRICS["product-ad"]
      .filter((c) => c.kind === "creative")
      .map((c) => ({
        criterion: c.id,
        judgement: changes && c.id === "cta-rhythm" ? "changes-requested" : "accepted",
        note: "Synthetic observation illustrating explicit review mechanics.",
        evidenceIds: [request.inputs[0].id],
      })),
  });
  request.baseline.review = put(root, "before-review", review(beforeFingerprint, true));
  request.candidate.review = put(root, "after-review", review(afterFingerprint, false));
  request.repairs = [
    {
      criterion: "cta-rhythm",
      baselineFingerprint: beforeFingerprint,
      candidateFingerprint: afterFingerprint,
      decisionId: request.candidate.decisions.id,
      rationale: "Illustrate exactly linked human-declared repair.",
    },
  ];
  const evaluated = await evaluateCraft(request, root);
  assert.equal(evaluated.variants[0].creative, "changes-requested");
  assert.equal(evaluated.variants[1].creative, "human-declared-accepted");
  assert.equal(evaluated.repairs[0].status, "evidence-resolved");
  assert.ok(!("productionReady" in evaluated));
  assert.ok(evaluated.limits.some((line) => line.includes("unauthenticated")));
});
