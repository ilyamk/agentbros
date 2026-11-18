import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { publishRenderReceipt } from "../src/lib/delivery/render-receipt";
import { hashFile } from "../src/lib/assets/registry";
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "render-receipt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/receipt");
  mkdirSync(path.join(dir, "voiceover"), { recursive: true });
  writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({
      name: "receipt",
      productName: "receipt",
      formats: ["square"],
      colors: {},
      musicVolume: 0,
      voiceoverEnabled: false,
      scenes: [{ id: "hook", text: "", visualType: "title", durationInFrames: 30 }],
    }),
  );
  mkdirSync(path.join(root, "out/receipt"), { recursive: true });
  return { root, dir, output: "out/receipt/square.mp4" };
}
test("receipt binds exact sources and output bytes; missing output never claims success", (t) => {
  const { root, output } = fixture(t),
    before = captureRenderIdentity("receipt", "square", { rootDir: root });
  assert.throws(() => publishRenderReceipt(output, before, before, root), /without producing/);
  writeFileSync(path.join(root, output), "mocked renderer bytes, not quality acceptance");
  const file = publishRenderReceipt(output, before, before, root),
    receipt = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(receipt.outputSha256, hashFile(path.join(root, output)));
  assert.equal(receipt.sourceSnapshotHash, before.sourceSnapshotHash);
  assert.equal(receipt.evidence, "renderer");
});
test("alignment and source changes invalidate snapshot and refuse receipt publication", (t) => {
  const { root, dir, output } = fixture(t);
  writeFileSync(path.join(dir, "voiceover/hook.words.json"), "[]");
  const before = captureRenderIdentity("receipt", "square", { rootDir: root });
  writeFileSync(path.join(root, output), "output");
  writeFileSync(path.join(dir, "voiceover/hook.words.json"), '[{"text":"new"}]');
  const after = captureRenderIdentity("receipt", "square", { rootDir: root });
  assert.notEqual(before.sourceSnapshotHash, after.sourceSnapshotHash);
  assert.throws(() => publishRenderReceipt(output, before, after, root), /changed while/);
  assert.equal(existsSync(path.join(root, `${output}.receipt.json`)), false);
});
