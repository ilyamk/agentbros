import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  getHarnessOperation,
  harnessDigest,
  importResult,
  listCapabilities,
  readHarnessJson,
  requestAsset,
} from "../src/lib/assets/harness-runtime";
import { hashFile, importAsset, readAssetRegistry } from "../src/lib/assets/registry";
import { approveEntityVersion, saveEntityVersion } from "../src/lib/entities/service";
import { HarnessAssetRequestSchema, HarnessAssetResultSchema } from "../src/types/harness-assets";

const code = (expected: string) => (e: unknown) => (e as { code?: string }).code === expected;
function fixture(t: test.TestContext, runtime: "codex" | "claude" = "codex") {
  const rootDir = mkdtempSync(path.join(tmpdir(), "harness-runtime-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const project = path.join(rootDir, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  writeFileSync(
    path.join(rootDir, "cap-evidence.json"),
    JSON.stringify({ fixture: true, tool: "fixture.image", runtime }),
  );
  writeFileSync(
    path.join(rootDir, "tool-result.json"),
    JSON.stringify({ fixture: true, tool: "fixture.image", runtime, model: "unknown" }),
  );
  const png = path.join(rootDir, "original.png");
  const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=48x32", "-frames:v", "1", png], {
    encoding: "utf8",
  });
  assert.equal(made.status, 0, made.stderr);
  const capabilities = {
    schemaVersion: 1,
    runtime,
    sessionId: "fixture-session",
    evidenceKind: "supplied-runtime",
    evidence: { file: "cap-evidence.json", sha256: hashFile(path.join(rootDir, "cap-evidence.json")) },
    observedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    tools: [
      {
        toolId: "fixture.image",
        available: true,
        kinds: ["image"],
        operations: ["generate", "edit"],
        selectableModels: [],
        quota: "unknown",
        localOriginalOutput: true,
      },
    ],
  };
  const request = {
    schemaVersion: 1,
    requestId: "character-sheet-01",
    projectId: "demo",
    toolId: "fixture.image",
    kind: "image",
    operation: "generate",
    purpose: "character card candidate",
    prompt: "Original character sheet",
    requestedModel: "Desired Model 9",
    acceptanceCriteria: ["Consistent wardrobe"],
    width: 48,
    height: 32,
  };
  const result = () => ({
    schemaVersion: 1,
    requestId: request.requestId,
    requestHash: harnessDigest(HarnessAssetRequestSchema.parse(request)),
    runtime,
    toolId: request.toolId,
    model: "unknown",
    original: { file: "original.png", sha256: hashFile(png) },
    toolResultEvidence: { file: "tool-result.json", sha256: hashFile(path.join(rootDir, "tool-result.json")) },
    rights: { licence: "unknown", commercialAllowed: "unknown", attributionRequired: "unknown" },
    billing: { status: "unknown" },
  });
  return {
    rootDir,
    project,
    png,
    capabilities,
    request,
    result,
    opFile: path.join(project, `pipeline/harness/${request.requestId}.json`),
  };
}

test("discovery has explicit missing/expired/exhausted/local-original unavailability, no model invention", (t) => {
  const f = fixture(t);
  assert.equal(listCapabilities(undefined, f.rootDir).status, "unavailable");
  const discovery = listCapabilities(f.capabilities, f.rootDir);
  assert.equal(discovery.status, "available");
  assert.deepEqual(discovery.availableTools[0].selectableModels, []);
  assert.equal(discovery.availableTools[0].quota, "unknown");
  assert.equal(
    listCapabilities({ ...f.capabilities, expiresAt: "2026-01-02T00:00:00.000Z" }, f.rootDir).status,
    "unavailable",
  );
  for (const override of [{ available: false }, { quota: "exhausted" }, { localOriginalOutput: false }])
    assert.equal(
      listCapabilities({ ...f.capabilities, tools: [{ ...f.capabilities.tools[0], ...override }] }, f.rootDir).status,
      "unavailable",
    );
  assert.throws(
    () => requestAsset({ ...f.request, modelPolicy: "require-selectable-model" }, f.capabilities, f),
    code("VALIDATION"),
  );
  assert.equal(existsSync(f.opFile), false);
});

for (const runtime of ["codex", "claude"] as const)
  test(`${runtime} supplied handoff persists no-spend intent and original candidate, repeat request/import idempotent`, (t) => {
    const f = fixture(t, runtime),
      plan = requestAsset(f.request, f.capabilities, { rootDir: f.rootDir, dryRun: true });
    assert.equal(plan.operation.status, "awaiting-import");
    assert.equal(existsSync(f.opFile), false);
    const created = requestAsset(f.request, f.capabilities, f);
    assert.equal(created.resumed, false);
    const before = readFileSync(f.opFile, "utf8");
    const resumed = requestAsset(f.request, f.capabilities, {
      rootDir: f.rootDir,
      now: new Date("2100-01-01T00:00:00.000Z"),
    });
    assert.equal(resumed.resumed, true);
    assert.equal(readFileSync(f.opFile, "utf8"), before);
    const dry = importResult("demo", f.result(), { rootDir: f.rootDir, dryRun: true });
    assert.equal(dry.operation.status, "awaiting-import");
    assert.equal(readAssetRegistry("demo", f.rootDir).revision, 0);
    const imported = importResult("demo", f.result(), f);
    assert.equal(imported.operation.status, "complete");
    assert.equal(imported.operation.receipt!.creativeApproval, "required");
    assert.equal(imported.operation.receipt!.provenance.model, "unknown");
    assert.deepEqual(imported.operation.receipt!.provenance.billing, { status: "unknown" });
    const asset = readAssetRegistry("demo", f.rootDir).assets[0];
    assert.equal(asset.status, "candidate");
    assert.equal(asset.provenance.origin, "agent-harness");
    assert.deepEqual(readFileSync(path.join(f.rootDir, "public", asset.files.original)), readFileSync(f.png));
    const replay = importResult("demo", f.result(), f);
    assert.equal(replay.resumed, true);
    assert.equal(readAssetRegistry("demo", f.rootDir).revision, 1);
    assert.equal(requestAsset(f.request, f.capabilities, f).operation.status, "complete");
  });

test("request IDs bind prompt, runtime/capabilities and project snapshot; unavailable never persists", (t) => {
  const f = fixture(t);
  requestAsset(f.request, f.capabilities, f);
  assert.throws(() => requestAsset({ ...f.request, prompt: "changed" }, f.capabilities, f), code("VALIDATION"));
  assert.throws(() => requestAsset(f.request, { ...f.capabilities, sessionId: "other" }, f), code("VALIDATION"));
  writeFileSync(path.join(f.project, "project.json"), '{"changed":true}');
  assert.throws(() => getHarnessOperation("demo", f.request.requestId, f.rootDir), code("VALIDATION"));
  const other = fixture(t);
  assert.throws(
    () => requestAsset(other.request, { ...other.capabilities, tools: [] }, other),
    code("STAGE_INCOMPLETE"),
  );
  assert.equal(existsSync(other.opFile), false);
});

test("result identity/hash/model/dimensions/alpha and unknown billing are checked before import", (t) => {
  const f = fixture(t);
  requestAsset(f.request, f.capabilities, f);
  for (const override of [
    { requestHash: "0".repeat(64) },
    { toolId: "other.tool" },
    { runtime: "claude" },
    { original: { file: "original.png", sha256: "0".repeat(64) } },
    { billing: { status: "unknown", apiUsd: 0 } },
  ])
    assert.throws(() => importResult("demo", { ...f.result(), ...override }, f), code("VALIDATION"));
  assert.equal(readAssetRegistry("demo", f.rootDir).revision, 0);
  assert.equal(getHarnessOperation("demo", f.request.requestId, f.rootDir).status, "awaiting-import");
  const alpha = fixture(t);
  requestAsset({ ...alpha.request, transparency: "required" }, alpha.capabilities, alpha);
  const alphaRequest = HarnessAssetRequestSchema.parse({ ...alpha.request, transparency: "required" });
  assert.throws(
    () => importResult("demo", { ...alpha.result(), requestHash: harnessDigest(alphaRequest) }, alpha),
    code("VALIDATION"),
  );
  const size = fixture(t);
  requestAsset({ ...size.request, width: 96 }, size.capabilities, size);
  assert.throws(
    () =>
      importResult(
        "demo",
        {
          ...size.result(),
          requestHash: harnessDigest(HarnessAssetRequestSchema.parse({ ...size.request, width: 96 })),
        },
        size,
      ),
    code("VALIDATION"),
  );
  const exact = fixture(t),
    caps = {
      ...exact.capabilities,
      tools: [{ ...exact.capabilities.tools[0], selectableModels: [exact.request.requestedModel] }],
    },
    req = { ...exact.request, modelPolicy: "require-selectable-model" };
  requestAsset(req, caps, exact);
  assert.throws(
    () =>
      importResult(
        "demo",
        { ...exact.result(), requestHash: harnessDigest(HarnessAssetRequestSchema.parse(req)) },
        exact,
      ),
    code("VALIDATION"),
  );
});

test("fulfilled result becomes immutable including rights/billing evidence; duplicate registry keeps prior metadata and own receipt", (t) => {
  const f = fixture(t);
  const old = importAsset({
    projectId: "demo",
    rootDir: f.rootDir,
    sourceFile: f.png,
    provenance: { origin: "manual" },
    rights: { licence: "creator-supplied" },
  });
  requestAsset(f.request, f.capabilities, f);
  const imported = importResult("demo", f.result(), f);
  assert.equal(imported.operation.receipt!.duplicate, true);
  assert.equal(imported.operation.receipt!.registryMetadataPreserved, true);
  assert.equal(imported.operation.receipt!.provenance.origin, "agent-harness");
  assert.deepEqual(readAssetRegistry("demo", f.rootDir).assets[0], old.asset);
  assert.throws(() => importResult("demo", { ...f.result(), rights: { licence: "CC0" } }, f), code("VALIDATION"));
  assert.throws(
    () =>
      importResult("demo", { ...f.result(), billing: { status: "reported", apiUsd: 0, source: "invented-change" } }, f),
    code("VALIDATION"),
  );
});

test("interrupted importing state resumes after registry commit with exactly one original", (t) => {
  const f = fixture(t),
    requested = requestAsset(f.request, f.capabilities, f),
    result = HarnessAssetResultSchema.parse(f.result());
  writeFileSync(
    f.opFile,
    JSON.stringify({ ...requested.operation, status: "importing", result, resultHash: harnessDigest(result) }),
  );
  importAsset({ projectId: "demo", rootDir: f.rootDir, sourceFile: f.png, provenance: { origin: "manual" } });
  assert.equal(importResult("demo", f.result(), f).operation.status, "complete");
  assert.equal(readAssetRegistry("demo", f.rootDir).revision, 1);
});

test("source/reference/evidence corruption, stale entity pins and corrupted operation fail closed", (t) => {
  const f = fixture(t);
  const ref = importAsset({
    projectId: "demo",
    rootDir: f.rootDir,
    sourceFile: f.png,
    provenance: { origin: "manual" },
  });
  const req = { ...f.request, references: [{ assetId: ref.asset.id, sha256: ref.asset.hash }] };
  requestAsset(req, f.capabilities, f);
  writeFileSync(path.join(f.rootDir, "public", ref.asset.files.original), "corrupt");
  assert.throws(() => getHarnessOperation("demo", f.request.requestId, f.rootDir), code("VALIDATION"));
  const evidence = fixture(t);
  requestAsset(evidence.request, evidence.capabilities, evidence);
  writeFileSync(path.join(evidence.rootDir, "cap-evidence.json"), "changed");
  assert.throws(() => importResult("demo", evidence.result(), evidence), code("VALIDATION"));
  const corrupt = fixture(t);
  requestAsset(corrupt.request, corrupt.capabilities, corrupt);
  const state = JSON.parse(readFileSync(corrupt.opFile, "utf8"));
  state.request.prompt = "tampered";
  writeFileSync(corrupt.opFile, JSON.stringify(state));
  assert.throws(() => getHarnessOperation("demo", corrupt.request.requestId, corrupt.rootDir), code("VALIDATION"));
  const entity = fixture(t);
  const card = saveEntityVersion(
    "demo",
    {
      kind: "object",
      id: "phone",
      name: "Phone",
      description: "Packshot",
      createdBy: "fixture",
      physical: { shape: "rectangle" },
    },
    { rootDir: entity.rootDir },
  );
  const pin = { kind: "object", entityId: "phone", revision: 1, contentHash: card.version.contentHash };
  assert.throws(
    () => requestAsset({ ...entity.request, entities: [pin] }, entity.capabilities, entity),
    code("STAGE_INCOMPLETE"),
  );
  approveEntityVersion(
    "demo",
    "object",
    "phone",
    1,
    { id: "fixture-human", kind: "human", authorizationEvidence: "synthetic test declaration" },
    { expectedRevision: 1, rootDir: entity.rootDir },
  );
  assert.throws(
    () =>
      requestAsset(
        { ...entity.request, entities: [{ ...pin, contentHash: "0".repeat(64) }] },
        entity.capabilities,
        entity,
      ),
    code("VALIDATION"),
  );
  assert.equal(
    requestAsset({ ...entity.request, entities: [pin] }, entity.capabilities, entity).operation.request.entities.length,
    1,
  );
});

test("completed status verifies receipt binding and corrupt/missing registry originals", (t) => {
  const f = fixture(t);
  requestAsset(f.request, f.capabilities, f);
  const imported = importResult("demo", f.result(), f);
  const state = JSON.parse(readFileSync(f.opFile, "utf8"));
  state.receipt.provenance.model = "invented-model";
  writeFileSync(f.opFile, JSON.stringify(state));
  assert.throws(() => getHarnessOperation("demo", f.request.requestId, f.rootDir), code("VALIDATION"));
  writeFileSync(f.opFile, JSON.stringify(imported.operation));
  writeFileSync(path.join(f.rootDir, "public", imported.operation.receipt!.original), "corrupted");
  assert.throws(() => getHarnessOperation("demo", f.request.requestId, f.rootDir), code("VALIDATION"));
});

test("workspace/symlink/invalid schema/locks/oversized JSON reject without arbitrary execution", (t) => {
  const f = fixture(t);
  requestAsset(f.request, f.capabilities, f);
  assert.throws(() => readHarnessJson(f.rootDir, path.join(f.rootDir, "../missing.json")), code("VALIDATION"));
  symlinkSync(f.png, path.join(f.rootDir, "linked.png"));
  assert.throws(
    () => importResult("demo", { ...f.result(), original: { file: "linked.png", sha256: hashFile(f.png) } }, f),
    code("VALIDATION"),
  );
  assert.throws(() => requestAsset({ ...f.request, executable: "/bin/sh" }, f.capabilities, f), code("VALIDATION"));
  assert.throws(
    () => listCapabilities({ ...f.capabilities, tools: [{ ...f.capabilities.tools[0], callback: "evil" }] }, f.rootDir),
    code("VALIDATION"),
  );
  writeFileSync(`${f.opFile}.lock`, "busy");
  assert.throws(() => importResult("demo", f.result(), f), code("TIMEOUT"));
  rmSync(`${f.opFile}.lock`);
  writeFileSync(path.join(f.rootDir, "too-big.json"), Buffer.alloc(8 * 1024 ** 2 + 1));
  assert.throws(() => readHarnessJson(f.rootDir, "too-big.json"), code("VALIDATION"));
  const escape = fixture(t);
  mkdirSync(path.join(escape.project, "pipeline"));
  symlinkSync(escape.rootDir, path.join(escape.project, "pipeline/harness"));
  assert.throws(() => requestAsset(escape.request, escape.capabilities, escape), code("VALIDATION"));
});

test("CLI emits complete single JSON envelopes for capabilities/request/import/status and failure", (t) => {
  const f = fixture(t),
    runner = path.resolve("node_modules/tsx/dist/cli.mjs"),
    script = path.resolve("scripts/harness-assets.ts");
  writeFileSync(path.join(f.rootDir, "capabilities.json"), JSON.stringify(f.capabilities));
  writeFileSync(path.join(f.rootDir, "request.json"), JSON.stringify(f.request));
  writeFileSync(path.join(f.rootDir, "result.json"), JSON.stringify(f.result()));
  const cli = (...args: string[]) => {
    const child = spawnSync(process.execPath, [runner, script, ...args], { cwd: f.rootDir, encoding: "utf8" });
    assert.equal(child.stdout.trim().split("\n").length, 1, child.stderr);
    return { child, envelope: JSON.parse(child.stdout) };
  };
  assert.equal(cli("--action", "capabilities").envelope.metadata.status, "unavailable");
  for (const args of [
    ["--action", "request", "--request", "request.json", "--capabilities", "capabilities.json"],
    ["--action", "import", "--project", "demo", "--result", "result.json"],
    ["--action", "status", "--project", "demo", "--request-id", f.request.requestId],
  ]) {
    const result = cli(...args);
    assert.equal(result.child.status, 0, result.child.stderr);
    assert.equal(result.envelope.ok, true);
    for (const output of result.envelope.outputs) assert.ok(existsSync(path.join(f.rootDir, output)));
  }
  const mismatch = cli(
    "--action",
    "request",
    "--project",
    "other",
    "--request",
    "request.json",
    "--capabilities",
    "capabilities.json",
  );
  assert.equal(mismatch.child.status, 1);
  assert.equal(mismatch.envelope.error, "INVALID_INPUT");
  const failed = cli("--action", "import", "--project", "demo", "--result", "../outside.json");
  assert.equal(failed.child.status, 1);
  assert.equal(failed.envelope.error, "VALIDATION");
});

test("FIFO without writer refuses JSON, operation, evidence and original before registry publication", (t) => {
  const moduleUrl = new URL("../src/lib/assets/harness-runtime.ts", import.meta.url).href;
  const script = `const module = await import(process.argv[1]);const api=module.default??module;const input=JSON.parse(process.argv[2]);try {
    if(input.action==='json')api.readHarnessJson(input.rootDir,input.file);
    else if(input.action==='operation')api.getHarnessOperation('demo',input.requestId,input.rootDir);
    else if(input.action==='evidence')api.listCapabilities(input.capabilities,input.rootDir);
    else api.importResult('demo',input.result,{rootDir:input.rootDir});
    console.log(JSON.stringify({returned:true}));
  }catch(error){console.log(JSON.stringify({code:error.code,message:error.message}));}`;
  for (const action of ["json", "operation", "evidence", "original"] as const) {
    const f = fixture(t),
      result = f.result();
    requestAsset(f.request, f.capabilities, f);
    const operationBefore = readFileSync(f.opFile),
      originalBefore = readFileSync(f.png);
    const target =
      action === "operation"
        ? f.opFile
        : action === "evidence"
          ? path.join(f.rootDir, "cap-evidence.json")
          : action === "original"
            ? f.png
            : path.join(f.rootDir, "fifo.json");
    if (existsSync(target)) rmSync(target);
    const fifo = spawnSync("mkfifo", [target], { encoding: "utf8", timeout: 1000 });
    assert.equal(fifo.status, 0, fifo.stderr);
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        moduleUrl,
        JSON.stringify({
          action,
          rootDir: f.rootDir,
          file: "fifo.json",
          requestId: f.request.requestId,
          capabilities: f.capabilities,
          result,
        }),
      ],
      {
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
        env: Object.fromEntries(
          ["PATH", "HOME", "TMPDIR"]
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]]),
        ),
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      code: "VALIDATION",
      message: "Harness file must be a nonempty bounded regular file.",
    });
    assert.equal(readAssetRegistry("demo", f.rootDir).revision, 0);
    if (action !== "operation") assert.deepEqual(readFileSync(f.opFile), operationBefore);
    if (action !== "original") assert.deepEqual(readFileSync(f.png), originalBefore);
  }
});
