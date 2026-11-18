import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { hashFile } from "../src/lib/assets/registry";
import { workflowClaims } from "../src/lib/workflows/claims";
import { reviewClaims, type Finding } from "../src/lib/delivery/reviews";
import { DeliveryRequestSchema, type DeliverySnapshot } from "../src/types/delivery";

function fixture(t: test.TestContext, mode: "product" | "education" | "inherited") {
  const root = mkdtempSync(path.join(tmpdir(), "workflow claim review ")),
    project = path.join(root, "public/projects/demo");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(project, "pipeline/evidence"), { recursive: true });
  mkdirSync(path.join(project, "assets/evidence"), { recursive: true });
  const statement = "One supplied interaction changes the visible state.";
  writeFileSync(path.join(project, "project.json"), JSON.stringify({ scenes: [{ id: "proof", text: statement }] }));
  const file = path.join(project, mode === "product" ? "assets/evidence/source.txt" : "pipeline/evidence/source.txt");
  writeFileSync(file, statement);
  const sha256 = hashFile(file);
  if (mode === "product")
    writeFileSync(
      path.join(project, "pipeline/product-ad-evidence.json"),
      JSON.stringify({
        claimEvidence: [
          {
            id: "claim",
            statement,
            evidence: { path: "projects/demo/assets/evidence/source.txt", sha256, excerpt: statement },
          },
        ],
        beats: [{ id: "proof", claimIds: ["claim"] }],
      }),
    );
  if (mode === "education")
    writeFileSync(
      path.join(project, "pipeline/education.json"),
      JSON.stringify({
        request: {
          sources: [{ id: "source", sha256, url: "https://example.invalid/supplied-source" }],
          claims: [{ id: "claim", evidence: [{ sourceId: "source", excerpt: statement }] }],
          chapters: [{ beats: [{ id: "proof", spokenText: statement, claimIds: ["claim"] }] }],
        },
        evidenceFiles: [{ id: "source", sha256, file: "pipeline/evidence/source.txt" }],
      }),
    );
  if (mode === "inherited")
    writeFileSync(
      path.join(project, "pipeline/workflow-claims.json"),
      JSON.stringify({
        version: 1,
        projectId: "demo",
        claims: [
          {
            id: "claim:proof",
            text: statement,
            sceneId: "proof",
            sourceUrls: ["https://example.invalid/supplied-source"],
            evidence: [{ path: "projects/demo/pipeline/evidence/source.txt", sha256, excerpt: statement }],
          },
        ],
      }),
    );
  const request = DeliveryRequestSchema.parse({
    version: 1,
    projectId: "demo",
    formats: ["landscape"],
    variants: ["captioned"],
    placements: ["local-review"],
    loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: true },
  });
  const snapshot = { identities: [{ storyHash: "a".repeat(64) }] } as unknown as DeliverySnapshot;
  const review = () => {
    const findings: Finding[] = [];
    reviewClaims(root, request, snapshot, findings);
    return findings;
  };
  return { root, project, file, statement, request, snapshot, review };
}
for (const mode of ["product", "education", "inherited"] as const)
  test(`${mode} assertions cannot bypass claim review with an empty caller map`, (t) => {
    const f = fixture(t, mode);
    assert.ok(f.review().some((finding) => finding.code === "CLAIMS_REVIEW_REQUIRED"));
    f.request.claimsReview = {
      reviewedBy: "Synthetic fixture declaration",
      reviewedAt: new Date().toISOString(),
      evidence: "Local test only, no independent claim verification",
      storyHash: "a".repeat(64),
      claims: [],
    };
    assert.ok(f.review().some((finding) => finding.severity === "error"));
    const claims = workflowClaims(f.root, "demo");
    f.request.declaredClaims = claims.map(({ id, text, sceneId }) => ({ id, text, sceneId }));
    f.request.claimsReview.claims = claims.map((claim) => ({
      id: claim.id,
      sourceUrl: claim.sourceUrls[0] ?? "https://example.invalid/fixture-evidence",
      supported: true,
      note: "Synthetic technical declaration only",
    }));
    assert.equal(f.review().filter((finding) => finding.severity === "error").length, 0);
    f.request.declaredClaims[0].text = "Altered unsupported assertion";
    assert.ok(f.review().some((finding) => finding.severity === "error"));
  });
test("lesson source review must use its pinned source and intact original evidence", (t) => {
  const f = fixture(t, "education"),
    claims = workflowClaims(f.root, "demo");
  f.request.declaredClaims = claims.map(({ id, text, sceneId }) => ({ id, text, sceneId }));
  f.request.claimsReview = {
    reviewedBy: "Fixture",
    reviewedAt: new Date().toISOString(),
    evidence: "Test declaration only",
    storyHash: "a".repeat(64),
    claims: [
      {
        id: claims[0].id,
        sourceUrl: "https://example.invalid/unrelated",
        supported: true,
        note: "Unrelated source negative",
      },
    ],
  };
  assert.ok(f.review().some((finding) => finding.message.includes("pinned source")));
  writeFileSync(f.file, "Changed original evidence");
  assert.throws(f.review, /source changed/);
});
test("caller support declarations cannot authorize a lesson with no frozen supporting evidence", (t) => {
  const f = fixture(t, "education");
  writeFileSync(
    path.join(f.project, "pipeline/education.json"),
    JSON.stringify({
      request: {
        sources: [],
        claims: [{ id: "claim", evidence: [] }],
        chapters: [{ beats: [{ id: "proof", spokenText: f.statement, claimIds: ["claim"] }] }],
      },
      evidenceFiles: [],
    }),
  );
  f.request.declaredClaims = [{ id: "claim:proof", text: f.statement, sceneId: "proof" }];
  f.request.claimsReview = {
    reviewedBy: "Synthetic negative declaration",
    reviewedAt: new Date().toISOString(),
    evidence: "Cannot replace a source",
    storyHash: "a".repeat(64),
    claims: [
      {
        id: "claim:proof",
        sourceUrl: "https://example.invalid/missing-proof",
        supported: true,
        note: "Negative fixture",
      },
    ],
  };
  assert.throws(f.review, /Too small/);
});
