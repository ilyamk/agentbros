import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
// An over-length motion clip is trimmed by a derivative, never passed as is and never fixed by editing limits.
const root = process.argv[2];
const result = JSON.parse(readFileSync(path.join(root, "bench-result.json"), "utf8"));
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
// A src/ file in the bundle was changed: profiles, guards and limits under src/lib must equal the trusted checkout's.
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
for (const file of existsSync(path.join(root, "src/lib")) ? walk(path.join(root, "src/lib")) : []) {
  const tracked = path.resolve(path.relative(root, file));
  assert.ok(existsSync(tracked) && sha(file) === sha(tracked), `edited ${path.relative(root, file)}`);
}
const base = path.join(root, "public/projects/bench-reference-derivative-first/pipeline");
const derivatives = path.join(base, "reference-derivatives");
assert.equal(typeof result.derivativeId, "string");
const spec = json(path.join(derivatives, result.derivativeId, "spec.json"));
assert.ok(spec.steps.some((step) => step.op === "trim"), "the derivative has no trim step");
const receipts = (existsSync(derivatives) ? readdirSync(derivatives) : [])
  .filter((id) => existsSync(path.join(derivatives, id, "receipt.json")))
  .map((id) => json(path.join(derivatives, id, "receipt.json")));
const originals = new Set(receipts.map((receipt) => receipt.input.assetId));
const outputs = new Set(receipts.map((receipt) => receipt.output.assetId));
const packsDir = path.join(base, "reference-packs");
for (const id of existsSync(packsDir) ? readdirSync(packsDir) : []) {
  if (!existsSync(path.join(packsDir, id, "receipt.json"))) continue;
  const attached = json(path.join(packsDir, id, "receipt.json")).spec.attachments.map((a) => a.source.assetId);
  assert.ok(!attached.some((asset) => originals.has(asset)), `pack ${id} attaches the original clip`);
  assert.ok(attached.some((asset) => outputs.has(asset)), `pack ${id} does not attach the derivative output`);
}
