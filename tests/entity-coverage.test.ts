import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { importAsset } from "../src/lib/assets/registry";
import { saveEntityVersion, getEntityVersion } from "../src/lib/entities/service";
import { createAssetBoard } from "../src/lib/entities/board";
import {
  computeCoverage,
  loadCoveragePolicy,
  CoveragePolicySchema,
  type CoverageReport,
} from "../src/lib/references/coverage";
import { EntityCardInputSchema, type EntityCard, type EntityCardInput } from "../src/types/entities";
import type { EntityReferenceFacts } from "../src/types/reference-view";

const id = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const neutral: EntityReferenceFacts = { background: "neutral", lighting: "even", outfitId: "suit", handsEmpty: true };
const character = (references: EntityCardInput["references"], extra: Partial<EntityCardInput> = {}): EntityCard =>
  EntityCardInputSchema.parse({
    id: "host",
    kind: "character",
    name: "Host",
    description: "Narrator",
    appearance: { physical: "Illustrated astronaut" },
    persona: { role: "Teacher" },
    createdBy: "agent",
    references,
    ...extra,
  });
const rules = (report: CoverageReport, severity: "warn" | "unknown") =>
  report.ruleFindings.filter((f) => f.severity === severity).map((f) => f.rule);

test("coverage policy validates and rejects unknown roles and rules", () => {
  const policy = loadCoveragePolicy();
  assert.deepEqual(policy.character.required, ["front"]);
  assert.ok(policy.character.rules.includes("minDistinctYawDeg:45"));
  assert.throws(() => CoveragePolicySchema.parse({ ...policy, object: { required: ["packshot"] } }));
  assert.throws(() => CoveragePolicySchema.parse({ ...policy, object: { rules: ["lighting:moody"] } }));
  assert.throws(() => CoveragePolicySchema.parse({ ...policy, object: { optional: ["mood:*"] } }));
});

test("front-only character misses recommended views and warns on yaw spread (AC4)", () => {
  const report = computeCoverage(character([{ assetId: id(1), role: "front", facts: { yawDeg: 0, ...neutral } }]));
  assert.equal(report.satisfied, false);
  assert.deepEqual(report.missingRequired, []);
  assert.deepEqual(report.missing, [
    "three-quarter-left|three-quarter-right",
    "profile-left|profile-right",
    "face-closeup",
  ]);
  assert.deepEqual(rules(report, "warn"), ["minDistinctYawDeg:45"]);
  assert.deepEqual(report.present, ["front"]);
  assert.equal(report.advisory, true);
});

test("turnaround with yaw 0/45/90/180, neutral background and even light is satisfied (AC4)", () => {
  const card = character([
    { assetId: id(1), role: "front", facts: { yawDeg: 0, ...neutral } },
    { assetId: id(2), role: "three-quarter-left", facts: { yawDeg: 45, ...neutral } },
    { assetId: id(3), role: "profile-left", facts: { yawDeg: 90, ...neutral } },
    { assetId: id(4), role: "back", facts: { yawDeg: 180, ...neutral } },
    { assetId: id(5), role: "face-closeup", facts: { background: "neutral", lighting: "even", outfitId: "suit" } },
  ]);
  const report = computeCoverage(card);
  assert.equal(report.satisfied, true, JSON.stringify(report));
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.ruleFindings, []);
  // Near-duplicate angles and a second costume warn.
  const close = computeCoverage(
    character([
      ...card.references,
      { assetId: id(6), role: "three-quarter-right", facts: { yawDeg: -30, ...neutral, outfitId: "coat" } },
    ]),
  );
  assert.equal(close.satisfied, false);
  assert.deepEqual(rules(close, "warn"), ["minDistinctYawDeg:45", "oneOutfitPerSheet"]);
  const holding = computeCoverage(
    character(
      card.references.map((r) => (r.role === "front" ? { ...r, facts: { ...r.facts, handsEmpty: false } } : r)),
    ),
  );
  assert.deepEqual(rules(holding, "warn"), ["handsEmptyOnTurnaround"]);
});

test("unknown facts are advisory 'unknown' findings; unrecognised roles are listed, not failed", () => {
  const report = computeCoverage(
    character(
      [
        { assetId: id(1), role: "front" },
        { assetId: id(2), role: "three-quarter-right" },
        { assetId: id(3), role: "profile-right" },
        { assetId: id(4), role: "face-closeup" },
        { assetId: id(5), role: "expression-happy" },
      ],
      {
        voice: {
          description: "warm",
          consent: { status: "not-applicable" },
          sampleAssetIds: [id(9)],
        },
      } as Partial<EntityCardInput>,
    ),
  );
  assert.equal(report.satisfied, true);
  assert.deepEqual(rules(report, "warn"), []);
  assert.deepEqual(rules(report, "unknown").sort(), [
    "background:neutral",
    "handsEmptyOnTurnaround",
    "lighting:even",
    "minDistinctYawDeg:45",
    "oneOutfitPerSheet",
  ]);
  assert.deepEqual(report.unrecognisedRoles, ["expression-happy"]);
  assert.ok(report.present.includes("voice-sample"));
});

test("location with other people warns; duplicate plate roles warn one plate per lighting", () => {
  const location = (references: EntityCardInput["references"]) =>
    EntityCardInputSchema.parse({
      id: "studio",
      kind: "location",
      name: "Studio",
      description: "Set",
      createdBy: "agent",
      geography: "interior",
      layout: "window left",
      lighting: "soft",
      references,
    });
  const report = computeCoverage(
    location([
      { assetId: id(1), role: "plate-wide", facts: { containsOtherPeople: true } },
      { assetId: id(2), role: "plate-wide", facts: { containsOtherPeople: false } },
      { assetId: id(3), role: "plate:night", facts: { containsOtherPeople: false } },
    ]),
  );
  assert.equal(report.satisfied, false);
  assert.deepEqual(report.missingRecommended, ["plate-reverse", "plate-medium"]);
  const people = report.ruleFindings.find((f) => f.rule === "noUnintendedPeople");
  assert.equal(people?.severity, "warn");
  assert.deepEqual(people?.references, [id(1)]);
  assert.ok(report.ruleFindings.some((f) => f.rule === "onePlatePerLighting" && f.severity === "warn"));
});

test("object packshot coverage and style without subject", () => {
  const object = EntityCardInputSchema.parse({
    id: "bottle",
    kind: "object",
    name: "Bottle",
    description: "Product",
    createdBy: "agent",
    physical: { shape: "round bottle" },
    references: [
      { assetId: id(1), role: "packshot-front", facts: { background: "neutral", lighting: "even" } },
      { assetId: id(2), role: "packshot-three-quarter", facts: { background: "scene", lighting: "even" } },
      { assetId: id(3), role: "label-detail", facts: { background: "transparent", lighting: "directional" } },
    ],
  });
  const report = computeCoverage(object);
  assert.deepEqual(report.missing, []);
  assert.equal(report.satisfied, false);
  assert.deepEqual(rules(report, "warn"), ["background:neutral", "lighting:even"]);
  assert.deepEqual(report.ruleFindings.find((f) => f.rule === "background:neutral")?.references, [id(2)]);
  const style = computeCoverage(
    EntityCardInputSchema.parse({
      id: "look",
      kind: "style",
      name: "Look",
      description: "Editorial",
      createdBy: "agent",
      palette: ["#fff"],
      cameraGrammar: "locked",
      editGrammar: "cuts",
      references: [{ assetId: id(1), role: "style-board", facts: { containsOtherPeople: true } }],
    }),
  );
  assert.deepEqual(rules(style, "warn"), ["styleWithoutSubject"]);
});

test("CLI coverage action and board show facts, fixed sentence and voice samples escaped", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "entity-coverage-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(path.join(rootDir, "public/projects/test"), { recursive: true });
  writeFileSync(path.join(rootDir, "public/projects/test/project.json"), "{}");
  const imported = ["red", "blue"].map((color) => {
    const file = path.join(rootDir, `${color}.png`);
    const made = spawnSync(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=32x32`, "-frames:v", "1", file],
      {
        encoding: "utf8",
      },
    );
    assert.equal(made.status, 0, made.stderr);
    return importAsset({
      rootDir,
      projectId: "test",
      sourceFile: file,
      provenance: { origin: "agent-harness", tool: "Codex", model: "unknown" },
    }).asset;
  });
  const card: EntityCardInput = {
    id: "host",
    kind: "character",
    name: "Host",
    description: "Narrator",
    appearance: { physical: "Illustrated astronaut" },
    persona: { role: "Teacher" },
    createdBy: "agent",
    fixedSentence: 'The host <b>"Ada"</b> wears an orange suit.',
    voice: { description: "warm", consent: { status: "not-applicable" }, sampleAssetIds: [imported[1].id] },
    references: [
      {
        assetId: imported[0].id,
        role: "front",
        notes: "<img src=x onerror=alert(1)>",
        facts: { yawDeg: 0, outfitId: "<suit>" },
      },
    ],
  };
  saveEntityVersion("test", card, { rootDir });
  const runner = path.resolve("node_modules/tsx/dist/cli.mjs"),
    cli = path.resolve("scripts/entity-card.ts");
  const run = spawnSync(
    process.execPath,
    [runner, cli, "--project", "test", "--action", "coverage", "--kind", "character", "--id", "host"],
    { cwd: rootDir, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim().split("\n").length, 1);
  const out = JSON.parse(run.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.metadata.entity.revision, 1);
  assert.equal(out.metadata.coverage.satisfied, false);
  assert.ok(out.metadata.coverage.missing.includes("face-closeup"));
  assert.ok(out.metadata.coverage.present.includes("voice-sample"));
  const missing = spawnSync(process.execPath, [runner, cli, "--project", "test", "--action", "coverage"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).error, "INVALID_INPUT");

  const html = readFileSync(path.join(rootDir, createAssetBoard("test", rootDir).file), "utf8");
  assert.match(html, /Fixed sentence: <q>The host &lt;b&gt;&quot;Ada&quot;&lt;\/b&gt; wears an orange suit\.<\/q>/);
  assert.match(html, /front · yawDeg=0, outfitId=&lt;suit&gt;/);
  assert.equal(html.includes("<img src=x"), false);
  assert.ok(html.includes(`Voice samples: <code>${imported[1].id}</code>`));
  assert.match(html, /Coverage \(advisory\): not satisfied · missing/);
  assert.equal(/<script/i.test(html), false);
  // Coverage reads the pinned version too.
  assert.equal(computeCoverage(getEntityVersion("test", "character", "host", { rootDir }).version).revision, 1);
});
