import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { digest } from "../src/lib/jobs/model-artifacts";
import { HYPERFRAMES_INSTANCES_PIN } from "../src/lib/backends/native-composition-instances-prelude";
import {
  validateInstancesReceipt,
  verifyInstancesReceipt,
} from "../src/lib/backends/native-composition-instances-receipt";
const dir = "tests/fixtures/hyperframes-engine/";
const contract = JSON.parse(readFileSync(dir + "instances-style-contract.json", "utf8"));
test("C22 prepared recipe has pure source-only import, exact detached hook and count failures without native build", () => {
  const require = createRequire(import.meta.url),
    before = new Set(Object.keys(require.cache)),
    { patchInertStyleSource } = require("../tests/fixtures/hyperframes-engine/prepare-instances-style.cjs");
  const source = "export function sample(doc:Document){\n" + contract.original + "\n}";
  const result = patchInertStyleSource(source);
  assert.equal(result.replacement.original, contract.original);
  assert.equal(result.replacement.text, contract.replacement);
  assert.equal(result.text, source.replace(contract.original, contract.replacement));
  assert.equal(result.replacement.start, source.indexOf(contract.original));
  assert.equal(result.replacement.end, result.replacement.start + contract.original.length);
  assert.ok(
    result.text.indexOf("instanceRegisterInertStyle(style)") < result.text.indexOf("doc.head.appendChild(style)"),
  );
  assert.throws(() => patchInertStyleSource("different original"), /count mismatch/);
  assert.throws(() => patchInertStyleSource(source + "\n" + contract.original), /count mismatch/);
  assert.throws(
    () => patchInertStyleSource(source.replace(contract.original, "  doc.head.append(style);")),
    /count mismatch/,
  );
  const imported = Object.keys(require.cache).filter((name) => !before.has(name));
  assert.equal(imported.length, 1);
  assert.ok(imported[0].endsWith("/prepare-instances-style.cjs"));
  const bytes = readFileSync(dir + "instances-style-provenance.json"),
    receipt = JSON.parse(bytes.toString());
  assert.equal(digest(bytes), "98f25707e7f5a5e7097e3bcf082d3a3c12c95aae059c63d139f11c2f02a9f584");
  assert.equal(receipt.engineSha256, "b856e7ed182437e84d9870aaac9599f73ea841f4040ca0c6e107adb7aaafbcc8");
  assert.equal(receipt.engineBytes, 518438);
  assert.equal(receipt.inertStyleContractSha256, digest(readFileSync(dir + "instances-style-contract.json")));
  assert.notEqual(verifyInstancesReceipt().buildReceiptSha256, digest(bytes));
});
test("C22 source contract preserves immutable C21/tree recipe receipts and exact22 hook inventory", () => {
  for (const [file, sha] of Object.entries(contract.predecessors)) assert.equal(digest(readFileSync(dir + file)), sha);
  assert.equal(contract.status, "source-prepared-runtime-unavailable");
  assert.equal(contract.hookCount, 22);
  assert.equal(
    Object.values(contract.patchCounts).reduce((a: number, b: any) => a + b, 0),
    22,
  );
  assert.equal(contract.patchCounts["packages/core/src/audioGroups.ts"], 1);
  const original = JSON.parse(readFileSync(dir + "provenance.json", "utf8"));
  assert.equal(contract.originalSourceSha256, original.files["source/packages/core/src/audioGroups.ts"]);
  const recipe = readFileSync(dir + "prepare-instances-style.cjs", "utf8");
  assert.match(recipe, /C21 exact predecessor replacement changed/);
  assert.match(recipe, /addedPrivateClockImport:!tree.patches/);
  assert.match(recipe, /C22 output already exists/);
  assert.match(recipe, /C22 receipt already exists/);
  assert.match(recipe, /c21ReceiptSha256/);
  assert.match(recipe, /Immutable C22 source contract mismatch/);
  assert.ok(recipe.includes(digest(readFileSync(dir + "instances-style-contract.json"))));
  assert.match(recipe, /inertStyleContractSha256/);
  assert.ok(recipe.includes("delete window.__avcPrivateEngineClock"));
  assert.equal(contract.futureRuntimePin, "unavailable until separately allocated independently reviewed build");
});

test("observed C22 receipt pure authority rejects wrong hash/engine/bytes/closure/contract without filesystem mutation", () => {
  const receipt = JSON.parse(readFileSync(dir + "instances-style-provenance.json", "utf8"));
  const sha = digest(readFileSync(dir + "instances-style-provenance.json"));
  assert.throws(() => validateInstancesReceipt(receipt, sha), /receipt differs/);
  assert.notEqual(sha, HYPERFRAMES_INSTANCES_PIN.buildReceiptSha256);
  const old = JSON.parse(readFileSync(dir + "instances-provenance.json", "utf8"));
  for (const [name, patch] of Object.entries(old.patches)) assert.deepEqual(receipt.patches[name], patch);
  assert.equal(
    Object.values(receipt.patches).reduce((n: number, p: any) => n + p.replacements.length, 0),
    22,
  );
  assert.deepEqual(receipt.resolutionManifests, old.resolutionManifests);
  assert.deepEqual(receipt.virtualInputs, old.virtualInputs);
  assert.deepEqual(receipt.loaded, old.loaded);
});
