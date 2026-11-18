import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { digest } from "../src/lib/jobs/model-artifacts";
import { HYPERFRAMES_INSTANCES_PIN } from "../src/lib/backends/native-composition-instances-prelude";
import { controlled, source, ElementFake, evaluateScript } from "./helpers/instances-script-host-dom";
const dir = "tests/fixtures/hyperframes-engine/",
  require = createRequire(import.meta.url),
  cacheBefore = new Set(Object.keys(require.cache)),
  recipe = require("./fixtures/hyperframes-engine/prepare-instances-script-host.cjs"),
  importedRecipeModules = Object.keys(require.cache).filter((name) => !cacheBefore.has(name)),
  contract = JSON.parse(readFileSync(dir + "instances-script-host-contract.json", "utf8")),
  fixture = JSON.parse(readFileSync(dir + "instances-script-host-consumer.json", "utf8"));
const original = readFileSync(dir + "instances-script-host-original-loader.ts.txt", "utf8");
const inherited = recipe.reconstructSource(contract.source, original);

test("pure derivative import pins immutable C23 predecessors and source excerpts without loading a compiler", () => {
  for (const [name, sha] of Object.entries(contract.predecessors)) assert.equal(digest(readFileSync(dir + name)), sha);
  for (const [name, sha] of Object.entries(contract.sourceFixtures))
    assert.equal(digest(readFileSync(dir + name)), sha);
  assert.deepEqual(importedRecipeModules, [
    require.resolve("./fixtures/hyperframes-engine/prepare-instances-script-host.cjs"),
  ]);
  assert.equal(contract.inheritedFinalPrivateHookCount, 23);
  assert.equal(contract.correctiveSourceReplacementCount, 1);
  assert.equal(contract.status, "source-prepared-runtime-unavailable");
  assert.equal(
    digest(readFileSync(dir + contract.futureReceipt)),
    "c7e38582522f7d1f5e14f4a4a4804fd8bf4aabed809bed7cafa97a4d284e7767",
  );
  assert.equal(HYPERFRAMES_INSTANCES_PIN.runtimeSha256, contract.predecessorRuntimeSha256);
  assert.equal(recipe.CONTRACT_SHA, digest(readFileSync(dir + "instances-script-host-contract.json")));
  assert.equal(fixture.positionUnit, "javascript-utf16-code-units");
  assert.equal(fixture.hashEncoding, "utf8");
  assert.equal(fixture.parentRuntimeSha256, HYPERFRAMES_INSTANCES_PIN.runtimeSha256);
  assert.equal(fixture.parentRuntimeBytes, 518855);
  for (const value of [...Object.values(fixture.functions), ...Object.values(fixture.variables)] as any[]) {
    assert.equal(digest(value.source), value.sha256);
    assert.equal(value.end - value.start, value.source.length);
  }
});
test("exact whole-source patch changes solely scoped params.host and rejects changed/missing/duplicate C23 source", () => {
  assert.equal(digest(inherited), contract.predecessorSourceSha256);
  const corrected = recipe.patchScriptHost(inherited);
  assert.equal(corrected.text, inherited.replace(contract.original, contract.replacement));
  assert.equal(corrected.transform.replacement.original, contract.original);
  assert.equal(corrected.transform.predecessorSourceSha256, digest(inherited));
  assert.equal(corrected.transform.outputSourceSha256, digest(corrected.text));
  for (const invalid of [
    inherited + " ",
    inherited.replace(contract.original, ""),
    inherited + contract.original,
    corrected.text,
  ])
    assert.throws(() => recipe.patchScriptHost(invalid), /identity mismatch/);
  assert.throws(() => recipe.reconstructSource(contract.source, original + " "), /original source identity/);
});
test("historical prepared recipe retains inherited23 hooks and correction; accepted canonical receipt has separate activation", () => {
  const text = recipe.deriveBuildRecipe();
  new vm.Script(text);
  assert.match(text, /bindingTransforms:__bindingTransforms/);
  assert.match(text, /finalPrivateHookCount:23/);
  assert.match(text, /instances-script-host-provenance\.json/);
  assert.match(text, /__bindingPatch\(transformed,__bindingContract\)/);
  assert.match(text, /contents,loader:'ts'/);
  assert.match(text, /__bindingInheritedReceipt\.resolutionManifests/);
  assert.match(text, /flag:'wx'/);
  assert.ok(!text.includes("finalPrivateHookCount:24"));
  assert.equal(
    digest(readFileSync(dir + contract.futureReceipt)),
    "c7e38582522f7d1f5e14f4a4a4804fd8bf4aabed809bed7cafa97a4d284e7767",
  );
});

async function consumer(
  fixed: boolean,
  ambientHost = false,
  mutate?: (s: Awaited<ReturnType<typeof controlled>>) => void,
) {
  const s = await controlled(),
    diagnostics: any[] = [],
    arms: ElementFake[] = [],
    modes: string[] = [];
  const clock: any = {
    instanceMode: true,
    treeGuard: (phase: string, targets: any[]) => {
      modes.push(phase);
      s.cap.treeGuard(phase, targets);
    },
    instancePrepareMedia: (callback: any) => s.cap.instancePrepareMedia(callback),
    instanceSourceRootId: s.cap.instanceSourceRootId,
    instanceArmScript: (host: ElementFake, script: any) => {
      arms.push(host);
      s.cap.instanceArmScript(host as any, script);
    },
    instanceFetch: async (host: any, src: string) => {
      await s.cap.instanceFetch(host, src);
      return { ok: true, text: async () => "LEAF" };
    },
  };
  const context = vm.createContext({
    document: s.d,
    window: s.w,
    gsap: s.w.gsap,
    D: clock,
    CSS: { escape: (v: string) => v },
    URL,
    console,
    Array,
    Map,
    Set,
    ...(ambientHost ? { host: new ElementFake("div", { id: "foreign" }) } : {}),
    // Explicit fake realm adapters for absent styles/templates/SVG/media in this CPU fixture.
    nn: (v: any) => Array.from(v ?? []),
    ru: (e: any) => e?.querySelectorAll("script") ?? [],
    Zl: () => [],
    wh: (e: any) => e.querySelectorAll("script"),
    O1: () => {},
    ni: () => ({}),
    C0: () => {},
    Gu: async () => {},
    A0: async () => [],
    Uu: () => {},
    Um: () => {},
    DOMParser: class {
      parseFromString(value: string) {
        assert.equal(value, "LEAF");
        return source();
      }
    },
  });
  for (const item of Object.values(fixture.variables) as any[])
    vm.runInContext("var " + item.source + ";", context, { timeout: 1000 });
  for (const [name, item] of Object.entries(fixture.functions) as [string, any][]) {
    let code = item.source;
    if (name === "k0" && fixed) {
      const from = "D.instanceArmScript(host,x)",
        to = "D.instanceArmScript(e.host,x)";
      assert.equal(code.split(from).length - 1, 1);
      code = code.replace(from, to);
    }
    vm.runInContext(code, context, { timeout: 1000 });
  }
  evaluateScript(s, context);
  mutate?.(s);
  const load = vm.runInContext("M0", context);
  const run = () =>
    load({
      injectedStyles: [],
      injectedScripts: [],
      injectedLinks: [],
      parseDimensionPx: () => null,
      onDiagnostic: (value: any) => diagnostics.push(value),
    });
  return { ...s, clock, context, arms, modes, diagnostics, run };
}
test("actual retained full loader/mount/runScripts/externalcatch old free binding resets hosts and strict controller reports child-count", async () => {
  const s = await consumer(false);
  await assert.rejects(s.run, /incomplete mounted host.*child-count/);
  assert.equal(s.first.children.length, 0);
  assert.equal(s.second.children.length, 0);
  assert.deepEqual(s.arms, []);
  assert.ok(
    s.diagnostics.some(
      (p) => p.code === "external_composition_load_failed" && p.details.errorMessage === "host is not defined",
    ),
  );
  assert.ok(s.modes.includes("mounted"));
  assert.equal(s.modes.at(-1), "scripts-complete");
});
test("same actual consumer with sole owned binding invokes genuine controller and scoped publication for both instances", async () => {
  const s = await consumer(true);
  await s.run();
  assert.deepEqual(s.arms, [s.first, s.second]);
  assert.equal(s.first.children.length, 1);
  assert.equal(s.second.children.length, 1);
  assert.equal(s.first.id, "first");
  assert.equal(s.second.id, "second");
  assert.equal(s.first.children[0].children[0].id, "box");
  assert.equal(s.second.children[0].children[0].id, "box");
  assert.deepEqual(Object.keys(s.w.__timelines), ["root", "first", "second"]);
  assert.notEqual(s.w.__timelines.first, s.w.__timelines.second);
  assert.equal(s.w.__timelines.leaf, undefined);
  assert.deepEqual(s.diagnostics, []);
  assert.deepEqual(s.violations, []);
  assert.equal(s.d.currentScript, null);
  assert.equal(Object.hasOwn(s.w, "__avcPrivateInstanceAcquire"), false);
  assert.equal(s.modes.at(-1), "scripts-complete");
});
test("ambient foreign host cannot substitute authority: old consumer fails, corrected ignores ambient and retains real owned Element", async () => {
  const old = await consumer(false, true);
  await assert.rejects(old.run, /host ownership/);
  assert.ok(old.arms.some((p) => p !== old.first && p !== old.second));
  const fixed = await consumer(true, true);
  await fixed.run();
  assert.deepEqual(fixed.arms, [fixed.first, fixed.second]);
});
test("correct binding does not relax source selection, host metadata or currentScript/private publication gates", async () => {
  const sourceChanged = await consumer(true, false, (s) => (s.first.values["data-composition-src"] = "forged.html"));
  await assert.rejects(sourceChanged.run, /immutable attribute changed: data-composition-src/);
  const detached = await consumer(true, false, (s) => (s.first.parentElement = null));
  await assert.rejects(detached.run, /ownership|changed/);
  const replay = await consumer(true);
  await replay.run();
  const wrap = vm.runInContext("Iu", replay.context),
    injected = new ElementFake(
      "script",
      {},
      wrap(
        replay.graph.documents["leaf.html"].record.script,
        "leaf",
        "ERROR",
        '[data-composition-id=\"first\"]',
        "first",
        null,
        undefined,
        true,
      ),
    );
  replay.cap.instanceArmScript(replay.first as any, injected as any);
  assert.throws(() => replay.d.body.appendChild(injected), /timeline publication repeated/);
});
test("complete retained mount consumer inactive mode still runs original branch without private source/arm authority", async () => {
  const s = await consumer(true);
  s.clock.instanceMode = false;
  const plain: any = { document: s.d, gsap: s.w.gsap };
  (s.context as any).window = plain;
  const host = s.d.body.appendChild(new ElementFake("div", { id: "legacy", "data-composition-id": "leaf" }));
  const mount = vm.runInContext("k0", s.context),
    composition = await mount({
      host,
      authoredCompositionId: "leaf",
      runtimeCompositionId: "leaf",
      hostCompositionSrc: "leaf.html",
      sourceNode: source().body,
      hasTemplate: false,
      fallbackBodyInnerHtml: "",
      compositionUrl: null,
      injectedStyles: [],
      injectedScripts: [],
      injectedLinks: [],
      parseDimensionPx: () => null,
    });
  await composition.runScripts();
  assert.equal(host.children.length, 1);
  assert.deepEqual(s.arms, []);
  assert.equal(plain.__timelines.leaf.duration(), 1);
  assert.equal(Object.hasOwn(plain, "__avcPrivateInstanceAcquire"), false);
});
