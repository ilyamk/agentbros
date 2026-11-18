import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dispatchAsset, interpretJsonResult } from "../src/lib/asset-dispatcher";
const original = process.cwd(),
  root = mkdtempSync(path.join(tmpdir(), "dispatch-pending-"));
process.chdir(root);
test.after(() => {
  process.chdir(original);
  rmSync(root, { recursive: true, force: true });
});
function setup(
  id: string,
  assets = [
    {
      id: "asset",
      kind: "ai-image",
      source: "fal-flux",
      targetPath: "assets/images/a.png",
      status: "pending",
      prompt: "Scene",
    },
  ],
) {
  const dir = path.join(root, "public/projects", id, "pipeline");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "asset-plan.json");
  writeFileSync(file, JSON.stringify({ assets }));
  return file;
}
for (const state of ["queued", "running", "unknown", "downloading", "validated"]) {
  test(`${state} preserves resumable metadata without marking done`, async () => {
    const id = `test-${state}`,
      file = setup(id);
    const result = await dispatchAsset(
      { projectId: id, assetId: "asset" },
      {
        dispatch: async () => ({
          ok: true,
          outputs: [],
          metadata: { state, operationId: "existing-op", nextAction: "resume" },
          elapsedMs: 0,
        }),
      },
    );
    const asset = JSON.parse(readFileSync(file, "utf8")).assets[0];
    assert.equal(asset.status, "running");
    assert.equal(asset.metadata.operationId, "existing-op");
    assert.equal(asset.metadata.state, state);
    assert.equal(result.metadata.pending, true);
    assert.deepEqual(result.outputs, []);
  });
}
test("published success requires non-empty local artifact while inline/manual still work", async () => {
  const file = setup("published");
  const missing = await dispatchAsset(
    { projectId: "published", assetId: "asset" },
    { dispatch: async () => ({ ok: true, outputs: ["missing.png"], metadata: { state: "published" }, elapsedMs: 0 }) },
  );
  assert.equal(missing.ok, false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).assets[0].status, "failed");
  const complete = await dispatchAsset(
    { projectId: "published", assetId: "asset" },
    {
      dispatch: async (_, __, target) => {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, "fixture");
        return { ok: true, outputs: [target], metadata: { state: "published" }, elapsedMs: 0 };
      },
    },
  );
  assert.equal(complete.ok, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).assets[0].status, "done");
  const inlineFile = setup("inline");
  await dispatchAsset(
    { projectId: "inline", assetId: "asset" },
    { dispatch: async () => ({ ok: true, outputs: [], metadata: { inline: true }, elapsedMs: 0 }) },
  );
  assert.equal(JSON.parse(readFileSync(inlineFile, "utf8")).assets[0].status, "done");
  const manualFile = setup("manual");
  await dispatchAsset(
    { projectId: "manual", assetId: "asset" },
    { dispatch: async () => ({ ok: true, outputs: [], metadata: { requiresManualDrop: true }, elapsedMs: 0 }) },
  );
  assert.equal(JSON.parse(readFileSync(manualFile, "utf8")).assets[0].status, "pending");
});
test("parallel dispatch status patches preserve both assets", async () => {
  const file = setup(
    "parallel",
    ["one", "two"].map((id) => ({
      id,
      kind: "ai-image",
      source: "fal-flux",
      targetPath: `assets/images/${id}.png`,
      status: "pending",
      prompt: "Scene",
    })),
  );
  await Promise.all(
    ["one", "two"].map((assetId) =>
      dispatchAsset(
        { projectId: "parallel", assetId },
        {
          dispatch: async () => {
            await new Promise((resolve) => setTimeout(resolve, assetId === "one" ? 10 : 1));
            return { ok: true, outputs: [], metadata: { state: "queued", operationId: assetId }, elapsedMs: 0 };
          },
        },
      ),
    ),
  );
  const assets = JSON.parse(readFileSync(file, "utf8")).assets;
  assert.deepEqual(
    assets.map((asset: any) => asset.metadata.operationId),
    ["one", "two"],
  );
});
test("JSON pending envelope never fabricates target output and failed exit cannot claim success", () => {
  const pending = interpretJsonResult(
    { ok: true, json: { ok: true, metadata: { state: "queued" } }, stdout: "", stderr: "", exitCode: 0 },
    "/missing.png",
  );
  assert.deepEqual(pending.outputs, []);
  assert.equal(
    interpretJsonResult({ ok: false, json: { ok: true }, stdout: "", stderr: "failure", exitCode: 1 }, "/missing.png")
      .ok,
    false,
  );
});
