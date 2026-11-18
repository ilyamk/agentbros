import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import {
  resolveScriptHostProduct,
  validateScriptHostProduct,
  validateScriptHostReceipt,
  verifyScriptHostReceipt,
  resolveScriptHostPin,
  SCRIPT_HOST_PRODUCT_DESCRIPTOR_SHA256,
} from "../src/lib/backends/native-composition-instances-script-host-product";
import {
  verifyInstancesReceipt,
  validateInstancesReceipt,
} from "../src/lib/backends/native-composition-instances-receipt";
import { digest } from "../src/lib/jobs/model-artifacts";
import { snapshotInstanceFile } from "../src/lib/backends/native-composition-instances-files";
const dir = "tests/fixtures/hyperframes-engine/";
test("fixed additive C24 authority binds observed source transform, inherited23 hooks and false genuine acceptance; C23 unchanged", () => {
  const p = resolveScriptHostProduct(),
    receipt = verifyScriptHostReceipt(),
    pin = resolveScriptHostPin();
  assert.equal(p.executionProfile, "static-local-instances-v2");
  assert.equal(p.sourceProfile, "static-local-instances-v1");
  assert.equal(p.activation, "instances-c24-v1");
  assert.equal(p.engineBytes, 518857);
  assert.equal(p.genuineRuntimeAccepted, false);
  assert.equal(p.hookCount, 23);
  assert.equal(p.bindingTransform.replacement.start, 26950);
  assert.equal(p.bindingTransform.replacement.end, 27047);
  assert.match(p.bindingTransform.replacement.text, /instanceArmScript\(params\.host/);
  assert.equal(receipt.buildReceiptSha256, p.receipt.sha256);
  assert.equal(receipt.productDescriptorSha256, digest(fs.readFileSync(dir + "instances-script-host-product-v1.json")));
  assert.equal(pin.profile, p.executionProfile);
  assert.equal(Object.isFrozen(p.bindingTransform.replacement), true);
  assert.notEqual(verifyInstancesReceipt().buildReceiptSha256, receipt.buildReceiptSha256);
  assert.equal(
    JSON.parse(fs.readFileSync(dir + p.scriptHostContract.file, "utf8")).status,
    "source-prepared-runtime-unavailable",
  );
});
test("closed C24 descriptor refuses unknown/path/source/runtime/version/bytes and claimed live acceptance including correct supplied checksum", () => {
  const p = resolveScriptHostProduct();
  for (const v of [
    null,
    { ...p, version: 2 },
    { ...p, activation: "instances-c23-v1" },
    { ...p, executionProfile: "static-local-instances-v1" },
    { ...p, extra: true },
    { ...p, genuineRuntimeAccepted: true },
    { ...p, engineBytes: 518855 },
    { ...p, recipe: { ...p.recipe, file: "../outside" } },
    { ...p, parentRuntimeSha256: "0".repeat(64) },
    { ...p, bindingTransform: { ...p.bindingTransform, outputSourceSha256: "0".repeat(64) } },
  ])
    assert.throws(() => validateScriptHostProduct(v, SCRIPT_HOST_PRODUCT_DESCRIPTOR_SHA256));
  assert.throws(() => validateScriptHostProduct(p, "0".repeat(64)), /checksum/);
  const missing = { ...p } as Record<string, unknown>;
  delete missing.bindingTransform;
  assert.throws(() => validateScriptHostProduct(missing, SCRIPT_HOST_PRODUCT_DESCRIPTOR_SHA256));
});
test("full exact encoded C24 receipt rejects cross-v1 evidence, rehashed counterfeit, transform/loaded/parent/23hooks drift", () => {
  const p = resolveScriptHostProduct(),
    raw = fs.readFileSync(dir + p.receipt.file),
    receipt = JSON.parse(raw.toString());
  validateScriptHostReceipt(receipt, digest(raw));
  for (const change of [
    (r: any) => {
      r.bindingTransforms[p.bindingTransform.source].replacement.text += " ";
    },
    (r: any) => {
      r.bindingTransforms[p.bindingTransform.source].outputSourceSha256 = "0".repeat(64);
    },
    (r: any) => {
      r.inheritedC23ReceiptSha256 = "0".repeat(64);
    },
    (r: any) => {
      delete r.loaded[Object.keys(r.loaded)[0]];
    },
    (r: any) => {
      r.patches[p.bindingTransform.source].replacements.pop();
    },
    (r: any) => {
      r.extra = true;
    },
  ]) {
    const altered = structuredClone(receipt);
    change(altered);
    assert.throws(() => validateScriptHostReceipt(altered, p.receipt.sha256), /authority/);
    assert.throws(
      () => validateScriptHostReceipt(altered, digest(JSON.stringify(altered, null, 2) + "\n")),
      /checksum/,
    );
  }
  const old = fs.readFileSync(dir + p.parentReceipt.file);
  assert.throws(() => validateScriptHostReceipt(JSON.parse(old.toString()), digest(old)), /checksum/);
  assert.throws(() => validateInstancesReceipt(receipt, digest(raw)), /receipt differs/);
});
test("resolver consumes bounded exact descriptor bytes and rechecks packages; corruption through consumed FD refuses without source writes", () => {
  const original = fs.readSync;
  let changed = false;
  fs.readSync = ((...args: any[]) => {
    const n = (original as any)(...args);
    if (n && !changed) {
      changed = true;
      args[1][0] = 0;
    }
    return n;
  }) as any;
  syncBuiltinESMExports();
  try {
    assert.throws(() => resolveScriptHostProduct());
    assert.equal(changed, true);
  } finally {
    fs.readSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(verifyScriptHostReceipt().productDescriptorSha256, SCRIPT_HOST_PRODUCT_DESCRIPTOR_SHA256);
});
test("same regular package reader rejects alias/FIFO/oversize/late replacement using only owned small opaque files", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "c24-reader-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "input");
  fs.writeFileSync(file, "immutable");
  assert.throws(() => snapshotInstanceFile(file, root, 1), /bounded/);
  fs.symlinkSync(file, path.join(root, "alias"));
  assert.throws(() => snapshotInstanceFile(path.join(root, "alias"), root, 1024), /symlink/);
  assert.equal(spawnSync("mkfifo", [path.join(root, "fifo")], { timeout: 1000 }).status, 0);
  assert.throws(() => snapshotInstanceFile(path.join(root, "fifo"), root, 1024), /regular/);
  const read = fs.readSync;
  let mutated = false;
  fs.readSync = ((...args: any[]) => {
    const n = (read as any)(...args);
    if (!mutated) {
      mutated = true;
      fs.renameSync(file, file + ".old");
      fs.writeFileSync(file, "immutable");
    }
    return n;
  }) as any;
  syncBuiltinESMExports();
  try {
    assert.throws(() => snapshotInstanceFile(file, root, 1024), /changed/);
  } finally {
    fs.readSync = read;
    syncBuiltinESMExports();
  }
});
