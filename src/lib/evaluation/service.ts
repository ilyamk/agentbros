import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { assertPathWithin } from "../cli";
import { runWorkflow } from "../workflows/dispatch";
import {
  CraftDecisionSchema,
  CraftEvaluationRequestSchema,
  CraftHumanReviewSchema,
  type CraftEvaluationRequest,
  type EvaluationPin,
} from "../../types/craft-evaluation";
import { DeliveryManifestSchema } from "../../types/delivery";
import { CRAFT_RUBRICS, CRAFT_RUBRIC_VERSION } from "./rubrics";
export type CriterionStatus = "pass" | "fail" | "pending" | "accepted" | "changes-requested" | "uncertain";
export interface CraftCriterionResult {
  criterion: string;
  status: CriterionStatus;
  note: string;
  evidenceIds: string[];
}
export interface CraftVariantResult {
  id: string;
  fingerprint: string;
  technical: "pass" | "fail";
  creative: "pending" | "changes-requested" | "human-declared-accepted";
  criteria: CraftCriterionResult[];
  deliveryEvidence: Record<string, unknown>;
  workflowMetadata?: Record<string, unknown>;
  reviewOrigin?: "human-declared" | "synthetic-fixture";
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function readPin(pin: EvaluationPin, root: string, json = false, maximum = 32 * 1024 ** 3) {
  const file = path.resolve(root, pin.path);
  assertPathWithin(root, realpathSync(file));
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > maximum)
      throw new Error(`Pin ${pin.id} must be a nonempty regular file within its size bound`);
    if (json && before.size > 8 * 1024 ** 2) throw new Error(`JSON pin ${pin.id} exceeds 8 MiB`);
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(1024 * 1024);
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!count) throw new Error(`Pin ${pin.id} changed during read`);
      hash.update(buffer.subarray(0, count));
      if (json) chunks.push(Buffer.from(buffer.subarray(0, count)));
      offset += count;
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error(`Pin ${pin.id} changed during read`);
    if (hash.digest("hex") !== pin.sha256) throw new Error(`Stale pin ${pin.id}: SHA-256 mismatch`);
    return { file, value: json ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown) : undefined };
  } finally {
    closeSync(fd);
  }
}
function pinFile(pin: EvaluationPin, root: string, maximum?: number) {
  return readPin(pin, root, false, maximum).file;
}
export function readPinnedEvaluationJson(pin: EvaluationPin, root: string): unknown {
  return readPin(pin, realpathSync(root), true).value;
}
export function craftVariantFingerprint(request: CraftEvaluationRequest, variant: CraftEvaluationRequest["baseline"]) {
  // Human review is excluded to avoid a circular pin, while all evaluated bytes remain bound.
  const { review: _review, ...pinned } = variant;
  return digest({
    rubricVersion: CRAFT_RUBRIC_VERSION,
    scenario: request.scenario,
    material: request.material,
    inputs: request.inputs,
    variant: pinned,
  });
}
function sourceDeclaration(scenario: CraftEvaluationRequest["scenario"], raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Workflow request must be an object");
  const r = raw as Record<string, unknown>;
  switch (scenario) {
    case "product-ad":
      return {
        media: r.media,
        claims: Array.isArray(r.claims)
          ? r.claims.map((c) => {
              const claim = c as Record<string, unknown>;
              return { id: claim.id, evidence: claim.evidence };
            })
          : r.claims,
      };
    case "education":
      return { media: r.media, sources: r.sources };
    case "recording-edit":
      return { source: r.source, transcript: r.transcript, protectedSpans: r.protectedSpans };
    case "shorts-series":
      return r.source;
  }
}
function checkInputCoverage(value: unknown, inputs: EvaluationPin[], root: string) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) checkInputCoverage(item, inputs, root);
    return;
  }
  const record = value as Record<string, unknown>;
  const file =
    typeof record.file === "string" ? record.file : typeof record.path === "string" ? record.path : undefined;
  if (
    file &&
    typeof record.sha256 === "string" &&
    !inputs.some(
      (p) =>
        realpathSync(path.resolve(root, p.path)) === realpathSync(path.resolve(root, file)) &&
        p.sha256 === record.sha256,
    )
  )
    throw new Error("Workflow source is not covered by shared input pins");
  for (const item of Object.values(record)) checkInputCoverage(item, inputs, root);
}
export async function evaluateCraft(raw: unknown, rootDirectory = process.cwd()) {
  const request = CraftEvaluationRequestSchema.parse(raw),
    root = realpathSync(rootDirectory);
  const rubric = CRAFT_RUBRICS[request.scenario];
  const variants = [request.baseline, ...(request.candidate ? [request.candidate] : [])];
  if (new Set(variants.map((v) => v.id)).size !== variants.length)
    throw new Error("Baseline and candidate IDs must differ");
  if (new Set(request.repairs.map((r) => r.criterion)).size !== request.repairs.length)
    throw new Error("Duplicate repair criterion");
  if (new Set(request.inputs.map((p) => p.id)).size !== request.inputs.length)
    throw new Error("Duplicate shared input IDs");
  for (const pin of request.inputs) pinFile(pin, root);
  const sources: unknown[] = [],
    results: CraftVariantResult[] = [];
  for (const variant of variants) {
    const pins = [
      variant.request,
      ...variant.skills,
      variant.configuration,
      variant.decisions,
      ...variant.evidence,
      ...(variant.delivery ? [variant.delivery] : []),
    ];
    if (
      new Set([...request.inputs, ...pins, ...(variant.review ? [variant.review] : [])].map((p) => p.id)).size !==
      request.inputs.length + pins.length + (variant.review ? 1 : 0)
    )
      throw new Error("Pin IDs must be unique within a variant and shared inputs");
    for (const pin of pins) pinFile(pin, root, variant.evidence.includes(pin) ? undefined : 8 * 1024 ** 2);
    const workflowRequest = readPinnedEvaluationJson(variant.request, root);
    const declaration = sourceDeclaration(request.scenario, workflowRequest);
    checkInputCoverage(declaration, request.inputs, root);
    sources.push(declaration);
    const decisions = CraftDecisionSchema.parse(readPinnedEvaluationJson(variant.decisions, root));
    const knownEvidence = new Set([...request.inputs, ...pins].map((p) => p.id));
    const creativeIds = rubric.filter((c) => c.kind === "creative").map((c) => c.id);
    if (new Set(decisions.decisions.map((d) => d.criterion)).size !== decisions.decisions.length)
      throw new Error("Duplicate decision criterion");
    for (const decision of decisions.decisions) {
      if (!creativeIds.includes(decision.criterion)) throw new Error(`Unknown creative decision ${decision.criterion}`);
      if (decision.evidenceIds.some((id) => !knownEvidence.has(id)))
        throw new Error("Decision cites unpinned evidence");
    }
    const fingerprint = craftVariantFingerprint(request, variant);
    const criteria: CraftCriterionResult[] = [];
    let workflowMetadata: Record<string, unknown> | undefined;
    try {
      const planned = await runWorkflow(request.scenario, workflowRequest, {
        action: "plan",
        rootDir: root,
        scopeRoot: root,
      });
      workflowMetadata = planned.metadata;
      criteria.push({
        criterion: "workflow-contract",
        status: "pass",
        note: "Existing workflow plan accepted supplied inputs; this does not inspect rendered output.",
        evidenceIds: [variant.request.id, ...request.inputs.map((p) => p.id)],
      });
    } catch (error) {
      criteria.push({
        criterion: "workflow-contract",
        status: "fail",
        note: error instanceof Error ? error.message : String(error),
        evidenceIds: [variant.request.id],
      });
    }
    const missing = creativeIds.filter((id) => !decisions.decisions.some((d) => d.criterion === id));
    criteria.push({
      criterion: "decision-evidence",
      status: missing.length ? "fail" : "pass",
      note: missing.length
        ? `Missing decisions: ${missing.join(", ")}`
        : "Every creative criterion has a recorded decision with pinned evidence; artistic quality remains unmeasured.",
      evidenceIds: [variant.decisions.id],
    });
    for (const id of creativeIds)
      criteria.push({
        criterion: id,
        status: "pending",
        note: "Human creative observation required for this exact variant.",
        evidenceIds: [],
      });
    let reviewOrigin: CraftVariantResult["reviewOrigin"];
    if (variant.review) {
      const review = CraftHumanReviewSchema.parse(readPinnedEvaluationJson(variant.review, root));
      if (review.variantFingerprint !== fingerprint) throw new Error("Stale review: variant fingerprint mismatch");
      if (request.material === "synthetic-fixture" && review.origin !== "synthetic-fixture")
        throw new Error("Synthetic fixture cannot carry human pilot acceptance");
      if (new Set(review.observations.map((o) => o.criterion)).size !== review.observations.length)
        throw new Error("Duplicate reviewer criterion");
      for (const observation of review.observations) {
        if (!creativeIds.includes(observation.criterion)) throw new Error("Review cannot override technical criteria");
        if (observation.evidenceIds.some((id) => !knownEvidence.has(id)))
          throw new Error("Review cites unpinned evidence");
        const result = criteria.find((c) => c.criterion === observation.criterion)!;
        result.note = observation.note;
        result.evidenceIds = observation.evidenceIds;
        // Fixture judgements are recorded but can never stand for human creative acceptance.
        result.status = review.origin === "synthetic-fixture" ? "pending" : observation.judgement;
      }
      reviewOrigin = review.origin;
    }
    let deliveryEvidence: Record<string, unknown> = {
      status: "pending",
      note: "No existing delivery manifest/output bytes supplied; render, audio and visual QA are not inferred.",
    };
    if (variant.delivery) {
      const delivery = DeliveryManifestSchema.parse(readPinnedEvaluationJson(variant.delivery, root));
      const projectId = (workflowRequest as Record<string, unknown>).projectId;
      if (projectId && delivery.projectId !== projectId)
        throw new Error("Delivery evidence belongs to another workflow project");
      if (
        !delivery.sourceIdentities.length ||
        !delivery.sourceIdentities.every((identity) =>
          identity.sources.some((source) => source.role === "config" && source.sha256 === variant.configuration.sha256),
        )
      )
        throw new Error("Delivery evidence is not bound to the pinned project configuration");
      const outputKeys = new Set<string>();
      for (const output of delivery.outputs) {
        if (
          !variant.evidence.some(
            (pin) =>
              pin.sha256 === output.sha256 &&
              realpathSync(path.resolve(root, pin.path)) === realpathSync(path.resolve(root, output.path)),
          )
        )
          throw new Error("Delivery output must have an exact pinned evidence file");
        if (
          !delivery.sourceIdentities.some(
            (identity) =>
              identity.format === output.format &&
              identity.captions === (output.variant === "clean" ? "off" : "on") &&
              identity.sourceSnapshotHash === output.sourceSnapshotHash &&
              identity.propsHash === output.propsHash,
          )
        )
          throw new Error("Delivery output has no matching source identity");
        const key = `${output.format}:${output.variant}`;
        if (outputKeys.has(key)) throw new Error("Duplicate delivery output");
        outputKeys.add(key);
      }
      const expected = delivery.request.formats.flatMap((format) =>
        delivery.request.variants.map((variant) => `${format}:${variant}`),
      );
      if ([...outputKeys].some((key) => !expected.includes(key)))
        throw new Error("Delivery output is outside requested formats/variants");
      const incomplete = expected.some((key) => !outputKeys.has(key));
      deliveryEvidence = {
        status:
          delivery.findings.some((f) => f.severity === "error") || delivery.state === "blocked"
            ? "imported-blocked"
            : incomplete
              ? "imported-incomplete"
              : "imported-checks",
        declaredState: delivery.state,
        findings: delivery.findings,
        outputs: delivery.outputs,
        note: "Parsed existing delivery evidence and checked output/config hashes; measurements and reviewer identity are imported declarations, not independently repeated QA.",
      };
    }
    criteria.push({
      criterion: "delivery-evidence",
      status:
        deliveryEvidence.status === "pending"
          ? "pending"
          : deliveryEvidence.status === "imported-checks"
            ? "pass"
            : "fail",
      note: String(deliveryEvidence.note),
      evidenceIds: variant.delivery ? [variant.delivery.id, ...variant.evidence.map((pin) => pin.id)] : [],
    });
    const technical = criteria.some((c) => c.status === "fail") ? "fail" : "pass";
    const creative = criteria.some((c) => c.status === "changes-requested")
      ? "changes-requested"
      : criteria.filter((c) => creativeIds.includes(c.criterion)).every((c) => c.status === "accepted")
        ? "human-declared-accepted"
        : "pending";
    for (const pin of [...request.inputs, ...pins, ...(variant.review ? [variant.review] : [])])
      pinFile(pin, root, request.inputs.includes(pin) || variant.evidence.includes(pin) ? undefined : 8 * 1024 ** 2);
    results.push({
      id: variant.id,
      fingerprint,
      technical,
      creative,
      criteria,
      deliveryEvidence,
      ...(workflowMetadata ? { workflowMetadata } : {}),
      ...(reviewOrigin ? { reviewOrigin } : {}),
    });
  }
  if (sources.length === 2 && digest(sources[0]) !== digest(sources[1]))
    throw new Error(
      "Baseline/candidate source, transcript or protected context differs; compare the same supplied inputs",
    );
  const repairs = request.repairs.map((repair) => {
    if (
      results.length !== 2 ||
      repair.baselineFingerprint !== results[0].fingerprint ||
      repair.candidateFingerprint !== results[1].fingerprint
    )
      throw new Error("Repair requires current baseline/candidate fingerprints");
    if (repair.decisionId !== request.candidate!.decisions.id)
      throw new Error("Repair must cite candidate decision artifact");
    const before = results[0].criteria.find((c) => c.criterion === repair.criterion),
      after = results[1].criteria.find((c) => c.criterion === repair.criterion);
    if (!before || !after) throw new Error("Unknown repair criterion");
    const resolved =
      (before.status === "fail" && after.status === "pass") ||
      (before.status === "changes-requested" && after.status === "accepted");
    return {
      ...repair,
      before: before.status,
      after: after.status,
      status: resolved ? "evidence-resolved" : "unverified",
    };
  });
  const artifactComparison: { id: string; beforeSha256: string | null; afterSha256: string | null; status: string }[] =
    [];
  if (request.candidate) {
    for (const before of request.baseline.evidence) {
      const after = request.candidate.evidence.find((pin) => pin.id === before.id);
      artifactComparison.push({
        id: before.id,
        beforeSha256: before.sha256,
        afterSha256: after?.sha256 ?? null,
        status: !after ? "removed" : before.sha256 === after.sha256 ? "unchanged" : "changed",
      });
    }
    for (const after of request.candidate.evidence.filter(
      (pin) => !request.baseline.evidence.some((before) => before.id === pin.id),
    ))
      artifactComparison.push({ id: after.id, beforeSha256: null, afterSha256: after.sha256, status: "added" });
  }
  return {
    version: 1,
    evaluationId: request.id,
    scenario: request.scenario,
    material: request.material,
    rubricVersion: CRAFT_RUBRIC_VERSION,
    rubric,
    inputFingerprint: digest(request.inputs),
    variants: results,
    repairs,
    artifactComparison,
    limits: [
      "Workflow plan acceptance is not rendered video/audio QA.",
      "Reviewer identity is self-declared and unauthenticated; no release approval is created.",
      "No audience outcomes, virality, scores, provider quality or billing are inferred.",
    ],
    apiCalls: 0,
    apiSpendUsd: 0,
  };
}
