import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { importAsset } from "../src/lib/assets/registry";
import {
  saveEntityVersion,
  approveEntityVersion,
  getEntityVersion,
  listEntities,
  resolveEntityReferences,
} from "../src/lib/entities/service";
import { createAssetBoard } from "../src/lib/entities/board";
import { EntityCardInputSchema, type EntityCardInput } from "../src/types/entities";

function setup(t: test.TestContext) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "entity-card-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const project = path.join(rootDir, "public/projects/test");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const image = path.join(rootDir, "front.png");
  const generated = spawnSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=40x40", "-frames:v", "1", image],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const asset = importAsset({
    rootDir,
    projectId: "test",
    sourceFile: image,
    provenance: { origin: "agent-harness", tool: "Codex", model: "unknown" },
  }).asset;
  const card: EntityCardInput = {
    id: "host",
    kind: "character",
    name: "Host",
    description: "Educational narrator",
    invariants: ["same facial proportions"],
    appearance: { physical: "Illustrated astronaut", wardrobe: "Orange suit" },
    persona: { role: "Teacher", traits: ["curious"] },
    createdBy: "agent",
    references: [{ assetId: asset.id, role: "front" }],
    likenessConsent: { status: "not-applicable" },
  };
  return { rootDir, project, asset, card };
}
const actor = { id: "creator", kind: "human" as const, authorizationEvidence: "Explicit local card approval" };
const code = (name: string) => (error: unknown) => (error as { code?: string }).code === name;

test("card revisions immutable; canonical stays pinned until explicit approval", (t) => {
  const { rootDir, project, card } = setup(t);
  const first = saveEntityVersion("test", card, { rootDir });
  assert.equal(first.status, "candidate");
  const original = readFileSync(path.join(project, "entities/character/host/versions/000001.json"), "utf8");
  approveEntityVersion("test", "character", "host", 1, actor, { rootDir, expectedRevision: 1 });
  const second = saveEntityVersion(
    "test",
    { ...card, description: "Updated delivery" },
    { rootDir, expectedRevision: 1 },
  );
  assert.equal(second.version.revision, 2);
  assert.equal(second.version.parentRevision, 1);
  assert.equal(getEntityVersion("test", "character", "host", { rootDir }).version.revision, 1);
  assert.equal(getEntityVersion("test", "character", "host", { rootDir, revision: 2 }).status, "candidate");
  assert.equal(readFileSync(path.join(project, "entities/character/host/versions/000001.json"), "utf8"), original);
  const approved = approveEntityVersion("test", "character", "host", 2, actor, { rootDir, expectedRevision: 2 });
  assert.equal(approved.approval?.consentInferred, false);
  const fork = saveEntityVersion("test", card, { rootDir, expectedRevision: 2, baseRevision: 1 });
  assert.equal(fork.version.revision, 3);
  assert.equal(fork.version.parentRevision, 1);
  assert.equal(listEntities("test", rootDir)[0].canonicalRevision, 2);
  assert.equal(listEntities("test", rootDir)[0].canonicalHistory.length, 2);
});

test("scene links exact approved character version; refs shared across formats", (t) => {
  const { rootDir, card } = setup(t);
  saveEntityVersion("test", card, { rootDir });
  const scene: EntityCardInput = {
    kind: "scene",
    id: "hook",
    name: "Hook",
    description: "Host introduces space",
    createdBy: "agent",
    action: "Host gestures at orbit",
    objective: "Explain gravity",
    blocking: "Host left, diagram right",
    links: [{ kind: "character", entityId: "host", revision: 1 }],
    shotIds: ["hook-closeup"],
  };
  saveEntityVersion("test", scene, { rootDir });
  assert.throws(
    () => approveEntityVersion("test", "scene", "hook", 1, actor, { rootDir, expectedRevision: 1 }),
    code("STAGE_INCOMPLETE"),
  );
  approveEntityVersion("test", "character", "host", 1, actor, { rootDir, expectedRevision: 1 });
  approveEntityVersion("test", "scene", "hook", 1, actor, { rootDir, expectedRevision: 1 });
  const ref = { kind: "character" as const, entityId: "host", revision: 1 };
  const vertical = resolveEntityReferences("test", ref, rootDir),
    landscape = resolveEntityReferences("test", ref, rootDir);
  assert.deepEqual(vertical.references, landscape.references);
  assert.equal(vertical.references[0].role, "front");
});

test("stale writes, missing references, corrupt media and forged consent rejected", (t) => {
  const { rootDir, project, asset, card } = setup(t);
  saveEntityVersion("test", card, { rootDir });
  assert.throws(() => saveEntityVersion("test", card, { rootDir }), code("VALIDATION"));
  assert.throws(
    () => approveEntityVersion("test", "character", "host", 1, actor, { rootDir, expectedRevision: 0 }),
    code("VALIDATION"),
  );
  assert.throws(
    () =>
      saveEntityVersion(
        "test",
        { ...card, references: [{ assetId: `sha256:${"0".repeat(64)}`, role: "front" }] },
        { rootDir, expectedRevision: 1 },
      ),
    code("FILE_NOT_FOUND"),
  );
  assert.throws(() => EntityCardInputSchema.parse({ ...card, likenessConsent: { status: "documented" } }));
  writeFileSync(path.join(rootDir, "public", asset.files.original), "altered");
  assert.throws(
    () => approveEntityVersion("test", "character", "host", 1, actor, { rootDir, expectedRevision: 1 }),
    code("VALIDATION"),
  );
  assert.equal(existsSync(path.join(project, "entities/character/host/approvals/000001.json")), false);
});

test("board contains local preview, pinned version and escapes hostile card text", (t) => {
  const { rootDir, card } = setup(t);
  saveEntityVersion("test", { ...card, name: '<script>alert("x")</script>' }, { rootDir });
  approveEntityVersion("test", "character", "host", 1, actor, { rootDir, expectedRevision: 1 });
  const board = createAssetBoard("test", rootDir),
    html = readFileSync(path.join(rootDir, board.file), "utf8");
  assert.equal(board.entities, 1);
  assert.equal(board.assets, 1);
  assert.match(html, /<img src="\.\.\/assets\/imported\//);
  assert.match(html, /character\/host@1 · front · canonical/);
  assert.equal(html.includes('<script>alert("x")</script>'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /API billing: unknown/);
});

test("CLI requires explicit authorization for approval and returns one JSON", (t) => {
  const { rootDir, card } = setup(t);
  const input = path.join(rootDir, "card.json");
  writeFileSync(input, JSON.stringify(card));
  const runner = path.resolve("node_modules/tsx/dist/cli.mjs"),
    cli = path.resolve("scripts/entity-card.ts");
  const run = (args: string[]) =>
    spawnSync(process.execPath, [runner, cli, "--project", "test", ...args], { cwd: rootDir, encoding: "utf8" });
  const created = run(["--action", "create", "--input", input]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).metadata.status, "candidate");
  const invalid = run([
    "--action",
    "approve",
    "--kind",
    "character",
    "--id",
    "host",
    "--revision",
    "1",
    "--expected-revision",
    "1",
  ]);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error, "INVALID_INPUT");
  const approved = run([
    "--action",
    "approve",
    "--kind",
    "character",
    "--id",
    "host",
    "--revision",
    "1",
    "--expected-revision",
    "1",
    "--actor",
    "creator",
    "--authorization-evidence",
    "User approved this card",
    "--confirm-user-approval",
  ]);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(approved.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(approved.stdout).metadata.status, "approved");
});

test("entity destination traversal and escaping symlinks are rejected", (t) => {
  const { rootDir, project, card } = setup(t);
  assert.throws(() => saveEntityVersion("test", { ...card, id: "../escape" }, { rootDir }), code("VALIDATION"));
  const outside = path.join(rootDir, "outside");
  mkdirSync(outside);
  symlinkSync(outside, path.join(project, "entities"));
  assert.throws(() => saveEntityVersion("test", card, { rootDir }), code("INVALID_INPUT"));
});

test("approved harness still compiles into all format props without mutating source", async (t) => {
  const { rootDir, card } = setup(t);
  saveEntityVersion("test", card, { rootDir });
  approveEntityVersion("test", "character", "host", 1, actor, { rootDir, expectedRevision: 1 });
  const { compileEntityBindings } = await import("../src/lib/entities/bindings");
  const { ProjectConfigSchema } = await import("../src/types/video");
  const { projectToVideoProps } = await import("../src/lib/project-props");
  const source = ProjectConfigSchema.parse({
    name: "Lesson",
    productName: "Gravity",
    formats: ["vertical", "square", "landscape"],
    colors: {},
    musicVolume: 0,
    scenes: [{ id: "hook", text: "Gravity", visualType: "photo", imageUrl: "old.png", durationInFrames: 90 }],
  });
  const bindings = [
    {
      sceneId: "hook",
      entity: { kind: "character" as const, entityId: "host", revision: 1 },
      referenceRole: "front",
      target: "imageUrl" as const,
    },
  ];
  const compiled = compileEntityBindings("test", source, bindings, rootDir);
  assert.equal(source.scenes[0].imageUrl, "old.png");
  assert.match(compiled.scenes[0].imageUrl!, /^projects\/test\/assets\/imported\/[a-f0-9]{64}\.png$/);
  const paths = compiled.formats.map(
    (format) => projectToVideoProps(compiled, "test", format, false).scenes[0].imageUrl,
  );
  assert.equal(new Set(paths).size, 1);
  assert.throws(() => compileEntityBindings("test", source, [...bindings, ...bindings], rootDir), code("VALIDATION"));
});

test("object, location and style cards round-trip with their creative constraints", (t) => {
  const { rootDir } = setup(t);
  const base = {
    name: "Reference",
    description: "Production reference",
    createdBy: "agent",
    invariants: ["keep palette"],
  };
  saveEntityVersion(
    "test",
    {
      ...base,
      kind: "object",
      id: "product",
      physical: { shape: "round glass bottle", materials: ["glass"], dimensions: "15 cm tall", label: "ACME" },
    },
    { rootDir },
  );
  saveEntityVersion(
    "test",
    {
      ...base,
      kind: "location",
      id: "studio",
      geography: "interior",
      layout: "window on left",
      lighting: "soft side light",
      zones: ["desk", "window"],
    },
    { rootDir },
  );
  saveEntityVersion(
    "test",
    {
      ...base,
      kind: "style",
      id: "editorial",
      palette: ["#fff", "#111"],
      cameraGrammar: "locked medium shots",
      editGrammar: "motivated cuts",
      prohibitions: ["no strobe"],
    },
    { rootDir },
  );
  assert.equal(listEntities("test", rootDir).length, 3);
  assert.equal(getEntityVersion("test", "object", "product", { rootDir }).version.card.kind, "object");
});
