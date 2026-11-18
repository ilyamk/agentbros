import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import {
  resolveInstanceProduct,
  validateInstanceProduct,
  INSTANCE_PRODUCT_DESCRIPTOR_SHA256,
} from "../src/lib/backends/native-composition-instances-product";
import {
  verifyInstancesReceipt,
  validateInstancesReceipt,
} from "../src/lib/backends/native-composition-instances-receipt";
import { HYPERFRAMES_INSTANCES_PIN } from "../src/lib/backends/native-composition-instances-prelude";
import { snapshotInstanceFile } from "../src/lib/backends/native-composition-instances-files";
import { digest } from "../src/lib/jobs/model-artifacts";
const dir = "tests/fixtures/hyperframes-engine/";
test("fixed C23 product resolves exact compiled package, without relabelling prepared/build-only status or native acceptance", () => {
  const product = resolveInstanceProduct(),
    pin = verifyInstancesReceipt();
  assert.equal(product.activation, "instances-c23-v1");
  assert.equal(product.genuineRuntimeAccepted, false);
  assert.equal(product.verificationScope, "compiled-source-reproduced");
  assert.equal(product.runtimeSha256, HYPERFRAMES_INSTANCES_PIN.runtimeSha256);
  assert.equal(product.engineBytes, 518855);
  assert.equal(pin.productDescriptorSha256, digest(fs.readFileSync(dir + "instances-selection-product-v1.json")));
  assert.equal(pin.buildReceiptSha256, product.receipt.sha256);
  assert.equal(Object.isFrozen(product), true);
  assert.equal(Object.isFrozen(product.receipt), true);
  assert.equal(
    JSON.parse(fs.readFileSync(dir + product.selectionContract.file, "utf8")).status,
    "source-prepared-runtime-unavailable",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(dir + product.receipt.file, "utf8")).status,
    "source-build-only-not-product-enabled",
  );
});
test("closed descriptor refuses wrong paths/version/status/hash/bytes/null/unknown/missing and duplicate raw encoding before authority", () => {
  const product = resolveInstanceProduct();
  for (const value of [
    null,
    { ...product, version: 2 },
    { ...product, extra: true },
    { ...product, genuineRuntimeAccepted: true },
    { ...product, engineBytes: 518438 },
    { ...product, recipe: { ...product.recipe, file: "../outside" } },
    { ...product, receipt: { ...product.receipt, bytes: 1 } },
    { ...product, sourceClosureSha256: "0".repeat(64) },
    { ...product, selectionContract: { ...product.selectionContract, sha256: "0".repeat(64) } },
  ])
    assert.throws(() => validateInstanceProduct(value, INSTANCE_PRODUCT_DESCRIPTOR_SHA256));
  const missing = { ...product } as Record<string, unknown>;
  delete missing.parentReceipt;
  assert.throws(() => validateInstanceProduct(missing, INSTANCE_PRODUCT_DESCRIPTOR_SHA256));
  assert.throws(() => validateInstanceProduct(product, "0".repeat(64)), /checksum/);
  const duplicate = '{"version":1,"version":1}';
  assert.throws(() => validateInstanceProduct(JSON.parse(duplicate), digest(duplicate)), /checksum/);
});
test("canonical receipt proof binds every hook/closure/parent/contract field including caller supplied correct SHA, oldC22 rejected", () => {
  const product = resolveInstanceProduct(),
    bytes = fs.readFileSync(dir + product.receipt.file),
    receipt = JSON.parse(bytes.toString());
  validateInstancesReceipt(receipt, digest(bytes));
  for (const change of [
    (r: any) => {
      r.patches["packages/core/src/runtime/compositionLoader.ts"].replacements.pop();
    },
    (r: any) => {
      r.loaded[Object.keys(r.loaded)[0]] = "0".repeat(64);
    },
    (r: any) => {
      r.inertStyleContractSha256 = "0".repeat(64);
    },
    (r: any) => {
      r.sourceRootSelectionContractSha256 = "0".repeat(64);
    },
    (r: any) => {
      r.c22ReceiptSha256 = "0".repeat(64);
    },
    (r: any) => {
      r.patchToolSha256 = "0".repeat(64);
    },
    (r: any) => {
      r.untrusted = true;
    },
  ]) {
    const altered = structuredClone(receipt);
    change(altered);
    assert.throws(() => validateInstancesReceipt(altered, product.receipt.sha256), /authority/);
    assert.throws(
      () => validateInstancesReceipt(altered, digest(JSON.stringify(altered, null, 2) + "\n")),
      /receipt differs/,
    );
  }
  const old = fs.readFileSync(dir + "instances-style-provenance.json");
  assert.throws(() => validateInstancesReceipt(JSON.parse(old.toString()), digest(old)), /receipt differs/);
  assert.throws(() => validateInstancesReceipt(null, product.receipt.sha256), /authority/);
});
test("fixed descriptor resolver refuses corrupted consumed bytes without package mutation or caller file selection", () => {
  const read = fs.readSync;
  let changed = false;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const count = (read as (...v: Parameters<typeof fs.readSync>) => number)(...args);
    if (!changed && count > 0) {
      changed = true;
      (args[1] as Buffer)[0] = 0;
    }
    return count;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => resolveInstanceProduct());
    assert.equal(changed, true);
  } finally {
    fs.readSync = read;
    syncBuiltinESMExports();
  }
  assert.equal(verifyInstancesReceipt().productDescriptorSha256, INSTANCE_PRODUCT_DESCRIPTOR_SHA256);
});
test("same package reader primitive refuses bounded/aliased/FIFO and late lexical replacement using own files only", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "instance-product-read-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "input.json");
  fs.writeFileSync(file, "immutable");
  assert.throws(() => snapshotInstanceFile(file, root, 1), /bounded/);
  const link = path.join(root, "alias");
  fs.symlinkSync(file, link);
  assert.throws(() => snapshotInstanceFile(link, root, 4096), /symlink/);
  const fifo = path.join(root, "pipe");
  assert.equal(spawnSync("mkfifo", [fifo], { timeout: 1000 }).status, 0);
  assert.throws(() => snapshotInstanceFile(fifo, root, 4096), /regular/);
  const read = fs.readSync;
  let changed = false;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const count = (read as (...v: Parameters<typeof fs.readSync>) => number)(...args);
    if (!changed) {
      changed = true;
      fs.renameSync(file, file + ".old");
      fs.writeFileSync(file, "immutable");
    }
    return count;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => snapshotInstanceFile(file, root, 4096), /changed/);
  } finally {
    fs.readSync = read;
    syncBuiltinESMExports();
  }
});
test("HTML immutable implementation closure binds active descriptor/recipe/contract/newreceipt, never old runtime fallback", () => {
  const source = fs.readFileSync("src/lib/backends/html.ts", "utf8");
  for (const name of [
    "native-composition-instances-product.ts",
    "instances-selection-product-v1.json",
    "prepare-instances-selection.cjs",
    "instances-selection-contract.json",
    "instances-selection-provenance.json",
  ])
    assert.ok(source.includes(name));
  assert.ok(
    !source.includes(
      'instanceBuildReceipt:"../../../tests/fixtures/hyperframes-engine/instances-style-provenance.json"',
    ),
  );
  assert.notEqual(
    HYPERFRAMES_INSTANCES_PIN.runtimeSha256,
    "b856e7ed182437e84d9870aaac9599f73ea841f4040ca0c6e107adb7aaafbcc8",
  );
});
