import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { digest } from "../src/lib/jobs/model-artifacts";
import { HYPERFRAMES_INSTANCES_PIN } from "../src/lib/backends/native-composition-instances-prelude";
const dir = "tests/fixtures/hyperframes-engine/",
  contract = JSON.parse(readFileSync(dir + "instances-selection-contract.json", "utf8"));
test("C23 pure recipe import patches exactly one selection decision, preserves inactive expression and plan outputs; no compiler/build", () => {
  const require = createRequire(import.meta.url),
    before = new Set(Object.keys(require.cache)),
    { patchSourceSelection } = require("./fixtures/hyperframes-engine/prepare-instances-selection.cjs");
  const source = "function mounted(){\n" + contract.original + "\nreturn innerRoot;\n}";
  const result = patchSourceSelection(source);
  assert.equal(result.text, source.replace(contract.original, contract.replacement));
  assert.equal(result.replacement.start, source.indexOf(contract.original));
  assert.equal(result.replacement.original, contract.original);
  assert.equal(result.replacement.text, contract.replacement);
  assert.ok(contract.replacement.endsWith("isHtmlElement(plan.innerRoot) ? plan.innerRoot : null;"));
  assert.ok(!contract.replacement.slice(0, contract.replacement.indexOf("})() :")).includes("plan."));
  const imported = Object.keys(require.cache).filter((name) => !before.has(name));
  assert.ok(
    imported.every(
      (name) =>
        name.endsWith("/prepare-instances-selection.cjs") || name.endsWith("/instances-selection-contract.json"),
    ),
  );
  assert.ok(!imported.some((name) => /esbuild|typescript/.test(name))); // no compilation/build during import
});
test("C23 source-selection count corruption and missing/duplicate original refuse before any compiler/output", () => {
  const { patchSourceSelection } = createRequire(import.meta.url)(
    "./fixtures/hyperframes-engine/prepare-instances-selection.cjs",
  );
  assert.throws(() => patchSourceSelection("different"), /count mismatch/);
  assert.throws(() => patchSourceSelection(contract.original + "\n" + contract.original), /count mismatch/);
  assert.throws(() => patchSourceSelection(contract.original.replace("plan.innerRoot", "plan.root")), /count mismatch/);
});
const run = (params: any, plan: any, clock: any) =>
  vm.runInNewContext("(function(){" + contract.replacement + ";return innerRoot;})()", {
    params,
    plan,
    __avcClock: clock,
    isHtmlElement: (e: any) => e?.nodeType === 1 && e.namespaceURI === "http://www.w3.org/1999/xhtml",
  });
function parsed() {
  const node: any = { querySelectorAll: () => [root] },
    root: any = {
      nodeType: 1,
      namespaceURI: "http://www.w3.org/1999/xhtml",
      tagName: "DIV",
      parentElement: node,
      getAttribute: (key: string) => (key === "id" || key === "data-composition-id" ? "leaf" : null),
    };
  return { node, root };
}
test("exact generated loader fragment chooses authored leaf despite distinct named host and preserves all plan fields (VM fake only)", () => {
  const s = parsed(),
    host = { id: "first" },
    plan = Object.freeze({
      innerRoot: null,
      authoredCompositionId: "first",
      scriptCompositionId: "leaf",
      authoredRootId: null,
      variableDefaultCarriers: [],
    }),
    before = JSON.stringify(plan);
  let calls = 0;
  const chosen = run({ host, hostCompositionSrc: "leaf.html", sourceNode: s.node, hasTemplate: false }, plan, {
    instanceMode: true,
    instanceSourceRootId: (h: any, src: string) => {
      assert.equal(h, host);
      assert.equal(src, "leaf.html");
      calls++;
      return "leaf";
    },
  });
  assert.equal(chosen, s.root);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(plan), before);
  const legacy = parsed();
  assert.equal(
    run({}, Object.freeze({ innerRoot: legacy.root }), {
      instanceMode: false,
      instanceSourceRootId: () => assert.fail("inactive must not call capability"),
    }),
    legacy.root,
  );
  assert.equal(run({}, Object.freeze({ innerRoot: null }), { instanceMode: false }), null);
});
test("generated selection rejects forged/missing/duplicate roots, templates, namespace/parent/id drift (VM fake only)", () => {
  for (const mutate of [
    (s: any) => {
      s.node.querySelectorAll = () => [];
    },
    (s: any) => {
      s.node.querySelectorAll = () => [s.root, s.root];
    },
    (s: any) => {
      s.root.namespaceURI = "urn:foreign";
    },
    (s: any) => {
      s.root.nodeType = 3;
    },
    (s: any) => {
      s.root.tagName = "SPAN";
    },
    (s: any) => {
      s.root.parentElement = null;
    },
    (s: any) => {
      s.root.getAttribute = () => "forged";
    },
  ]) {
    const s = parsed();
    mutate(s);
    assert.throws(
      () =>
        run(
          { host: {}, hostCompositionSrc: "leaf.html", sourceNode: s.node, hasTemplate: false },
          { innerRoot: null },
          { instanceMode: true, instanceSourceRootId: () => "leaf" },
        ),
      /authenticated selection/,
    );
  }
  const s = parsed();
  assert.throws(
    () =>
      run(
        { host: {}, sourceNode: s.node, hasTemplate: true },
        { innerRoot: null },
        { instanceMode: true, instanceSourceRootId: () => "leaf" },
      ),
    /authenticated selection/,
  );
  assert.throws(
    () => run({ host: {}, sourceNode: s.node, hasTemplate: false }, { innerRoot: null }, { instanceMode: true }),
    /instanceSourceRootId/,
  );
});
test("C23 source-only contract keeps immutable prepared status and predecessors plus separate compiled C23 product; original loaded selection source pinned", () => {
  for (const [file, sha] of Object.entries(contract.predecessors)) assert.equal(digest(readFileSync(dir + file)), sha);
  assert.equal(contract.hookCount, 23);
  assert.equal(
    Object.values(contract.patchCounts).reduce((a: number, b: any) => a + b, 0),
    23,
  );
  assert.equal(contract.patchCounts["packages/core/src/runtime/compositionLoader.ts"], 6);
  assert.equal(contract.status, "source-prepared-runtime-unavailable");
  assert.equal(existsSync(dir + contract.futureReceipt), true);
  assert.match(contract.futureRuntimePin, /unavailable/);
  const original = JSON.parse(readFileSync(dir + "provenance.json", "utf8"));
  assert.equal(contract.originalSourceSha256, original.files["source/" + contract.source]);
  const recipe = readFileSync(dir + "prepare-instances-selection.cjs", "utf8");
  assert.ok(recipe.includes(digest(readFileSync(dir + "instances-selection-contract.json"))));
  assert.match(recipe, /C22 exact predecessor replacement changed/);
  assert.match(recipe, /selectionPredecessorOutputSha256/);
  assert.match(recipe, /sourceRootSelectionContractSha256/);
  assert.equal(
    HYPERFRAMES_INSTANCES_PIN.runtimeSha256,
    "5a33249f292aa6e9192d5f93a831e425fda423e08b4087d4cf72deae28043cd1",
  );
  assert.equal(
    HYPERFRAMES_INSTANCES_PIN.buildReceiptSha256,
    "a965b37cdc9c8adb7df96ea67656c9430ea0c3ae9558dc2d2e54d2a4f08304d2",
  );
});

test("actual C23 final write expressions exclusively refuse occupied receipt/output and retain partial publication (pure filesystem, no compiler)", (t) => {
  const source = readFileSync(dir + "prepare-instances-selection.cjs", "utf8");
  const receiptExpression = source.match(/fs\.writeFileSync\(receiptPath,[^;]+;/)?.[0],
    outputExpression = source.match(/fs\.writeFileSync\(output,[^;]+;/)?.[0];
  assert.ok(receiptExpression);
  assert.ok(outputExpression);
  assert.match(receiptExpression, /flag:'wx'/);
  assert.match(outputExpression, /flag:'wx'/);
  const root = mkdtempSync(path.join(tmpdir(), "c23-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receiptPath = path.join(root, "receipt.json"),
    output = path.join(root, "output.js"),
    receipt = { version: 1, prepared: true },
    bytes = Buffer.from("NEW BUNDLE"),
    oldReceipt = Buffer.from("IMMUTABLE RECEIPT"),
    oldOutput = Buffer.from("IMMUTABLE OUTPUT");
  const publishReceipt = () => vm.runInNewContext(receiptExpression, { fs, receiptPath, receipt }),
    publishOutput = () => vm.runInNewContext(outputExpression, { fs, output, bytes });
  writeFileSync(receiptPath, oldReceipt);
  assert.throws(publishReceipt, (error: any) => error.code === "EEXIST");
  assert.deepEqual(readFileSync(receiptPath), oldReceipt);
  assert.equal(existsSync(output), false);
  writeFileSync(output, oldOutput);
  assert.throws(publishOutput, (error: any) => error.code === "EEXIST");
  assert.deepEqual(readFileSync(output), oldOutput);
  assert.deepEqual(readFileSync(receiptPath), oldReceipt);
  rmSync(receiptPath);
  publishReceipt();
  const published = readFileSync(receiptPath);
  assert.deepEqual(JSON.parse(published.toString()), receipt);
  assert.throws(publishOutput, (error: any) => error.code === "EEXIST");
  assert.deepEqual(readFileSync(receiptPath), published);
  assert.deepEqual(readFileSync(output), oldOutput); // no rollback/two-file atomic claim
  rmSync(output);
  publishOutput();
  assert.deepEqual(readFileSync(output), bytes);
  assert.throws(publishReceipt, (error: any) => error.code === "EEXIST");
  assert.throws(publishOutput, (error: any) => error.code === "EEXIST");
  assert.deepEqual(readFileSync(receiptPath), published);
  assert.deepEqual(readFileSync(output), bytes);
});
