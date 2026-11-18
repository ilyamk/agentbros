import { writeBudgetBrief } from "./ceiling-grant";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { importAsset } from "../../src/lib/assets/registry";
import { approveEntityVersion, saveEntityVersion } from "../../src/lib/entities/service";
import { ModelPreparationSpecSchema, type GenjutsuMode } from "../../src/types/model-preparation";
import { loadHiggsfieldRestylePresets } from "../../src/lib/models/hf-restyle-presets";
import { approvePreparation, writePreparationRights } from "../../src/lib/model-preparation/approval";
import type { prepareModel } from "../../src/lib/model-preparation/prepare";

export function genjutsuFixture(t: TestContext, bespoke = false) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "genjutsu-preparation-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const project = path.join(rootDir, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(
    path.join(project, bespoke ? "pipeline/brief.json" : "project.json"),
    bespoke ? JSON.stringify({ renderMode: "bespoke", budgetUsd: 10 }) : "{}",
  );
  if (!bespoke) writeBudgetBrief(project);
  const video = path.join(rootDir, "source.mp4"),
    image = path.join(rootDir, "front.png");
  for (const args of [
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=960x540:r=10:d=6",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6",
      "-shortest",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      video,
    ],
    ["-f", "lavfi", "-i", "color=c=blue:s=640x640", "-frames:v", "1", "-threads", "1", image],
  ]) {
    const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const source = importAsset({
    rootDir,
    projectId: "demo",
    sourceFile: video,
    provenance: { origin: "manual", tool: "offline-fixture" },
  }).asset;
  const reference = importAsset({
    rootDir,
    projectId: "demo",
    sourceFile: image,
    provenance: { origin: "manual", tool: "offline-fixture" },
  }).asset;
  saveEntityVersion(
    "demo",
    {
      id: "hero",
      name: "Hero",
      kind: "character",
      description: "Invented synthetic fixture",
      appearance: { physical: "Illustrated face" },
      persona: { role: "Performer" },
      createdBy: "fixture",
      references: [{ assetId: reference.id, role: "front" }],
      likenessConsent: { status: "not-applicable" },
    },
    { rootDir },
  );
  approveEntityVersion(
    "demo",
    "character",
    "hero",
    1,
    { id: "fixture-user", kind: "human", authorizationEvidence: "Fixture approval, not a real human decision" },
    { rootDir, expectedRevision: 1 },
  );
  const spec = (mode: GenjutsuMode = "object-swap", id = `${mode}-v1`) =>
    ModelPreparationSpecSchema.parse({
      schemaVersion: 1,
      id,
      mode,
      sourceAssetId: source.id,
      segment: { startSec: 1, durationSec: 4 },
      references: [{ kind: "character", entityId: "hero", revision: 1, role: "front" }],
      target: {
        description: "the performer on the left",
        change: "Use the approved hero identity.",
        preserve: ["camera and motion", "background"],
        otherSubjects: ["the performer on the right"],
      },
      ...(mode === "restyle" ? { presetId: loadHiggsfieldRestylePresets().presets[0]!.id } : {}),
      audioPolicy: "mute",
    });
  return { rootDir, project, source, reference, video, image, spec };
}
export function approveFixture(
  data: ReturnType<typeof prepareModel>,
  rootDir: string,
  status: "owned" | "licensed" | "study-only" = "owned",
) {
  const id = data.receipt.id;
  writePreparationRights(
    "demo",
    id,
    {
      status,
      userStatement: "Fixture source-use authorisation, no actual person or external clip",
      evidence: "Locally synthesised fixture",
      processingAllowed: true,
      commercialAllowed: status !== "study-only",
      placements: ["tiktok"],
      audioRights: "muted",
      usage: { advertising: false, endorsement: false, standaloneResale: false },
    },
    rootDir,
  );
  return approvePreparation(
    "demo",
    id,
    "Fixture approval of the exact inputs",
    {
      preparationSha256: data.sha256,
      reviewer: "fixture-reviewer",
      evidence: "Synthetic fixture observations, not creative acceptance",
      sourceMotionReadable: true,
      targetUnambiguous: true,
      references: data.receipt.references.map((ref) => ({
        sha256: ref.media.sha256,
        identityConsistent: true,
        detailReadable: true,
        angleSuitable: true,
        evidence: "Fixture only",
      })),
    },
    rootDir,
  );
}
