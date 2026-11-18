import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { assertCutoutEngine, runDerivative } from "../src/lib/references/derive";
import { derivativeFixture as fixture, hasFfmpeg } from "./helpers/reference-derive";

const media = { skip: hasFfmpeg ? false : "needs ffmpeg and ffprobe" } as const;

test("cutout with matte-onnx runs when the weights are present", media, async (t) => {
  try {
    await assertCutoutEngine();
  } catch (error) {
    assert.equal((error as { code?: string }).code, "ASSET_MISSING");
    assert.match((error as Error).message, /assets:sync/);
    t.skip("matte ONNX weights are not downloaded");
    return;
  }
  if (spawnSync("uv", ["--version"]).status !== 0) return t.skip("needs uv");
  const f = fixture(t);
  const flat = await runDerivative(
    "demo",
    f.spec("frame", [
      { op: "extract-frame", at: "first" },
      { op: "scale", width: 160, height: 120, fit: "exact" },
    ]),
    f.rootDir,
  );
  const cut = await runDerivative(
    "demo",
    f.spec("cut", [{ op: "cutout", engine: "matte-onnx" }], { derivativeId: flat.receipt.id }),
    f.rootDir,
  );
  assert.equal(cut.receipt.engine.kind, "matte-onnx");
  assert.match(cut.receipt.engine.modelSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(cut.receipt.output.contentType, "image/png");
});
