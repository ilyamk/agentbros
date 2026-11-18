import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
import { entrySource } from "./helpers/review-authored-copy-proof";
import * as geometry from "./helpers/copy-canvas-geometry";
import { inspectCopyText } from "./helpers/copy-text-geometry";
const canvasRect = { x: 0, y: 0, width: 1080, height: 1920 },
  fragment = { x: 60, y: 300, width: 200, height: 40 };
const manifest = {
  version: 1 as const,
  faces: [
    {
      family: "Arial",
      weight: 400,
      style: "normal" as const,
      original: "test/font.ttf",
      hash: "a".repeat(64),
      testedText: "Complete text",
    },
  ],
  roles: { primaryFont: "Arial" },
};
async function executeProbe(raw: geometry.CopyBox) {
  const marker = { isConnected: true },
    canvas = {
      getBoundingClientRect: () => ({ ...canvasRect, toJSON: () => canvasRect }),
      contains: (value: unknown) => value === marker,
      textContent: "Complete headlineComplete subtext",
    };
  const fonts = Object.assign([{ family: "Arial", weight: "400", style: "normal", status: "loaded" }], {
    ready: Promise.resolve(),
    status: "loaded",
  });
  const logs: string[] = [];
  let continued = 0,
    cancelled = 0,
    root: (() => unknown) | undefined;
  const effects: (() => unknown)[] = [];
  type ElementRecord = { type: unknown; props: Record<string, unknown>; children: ElementRecord[] };
  const React = {
    Fragment: Symbol("fragment"),
    createElement: (type: unknown, props: Record<string, unknown>, ...children: ElementRecord[]) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity),
    }),
  };
  let resolve!: () => void, reject!: (error: unknown) => void;
  const completed = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const modules: Record<string, unknown> = {
    react: {
      __esModule: true,
      default: React,
      useLayoutEffect: (effect: () => unknown) => {
        effects.push(effect);
      },
      useRef: () => ({ current: marker }),
    },
    remotion: {
      registerRoot: (value: () => unknown) => {
        root = value;
      },
      Composition: Symbol("composition"),
      useCurrentFrame: () => 30,
      useVideoConfig: () => ({ width: 1080, height: 1920 }),
      delayRender: () => 17,
      continueRender: (handle: number) => {
        assert.equal(handle, 17);
        continued++;
        resolve();
      },
      cancelRender: (error: unknown) => {
        cancelled++;
        reject(error);
      },
    },
  };
  const codeRoot = process.cwd();
  modules[path.join(codeRoot, "src/index.css")] = {};
  modules[path.join(codeRoot, "src/components/GenericProject")] = {
    GenericProject: () => null,
    calculateProjectMetadata: () => null,
  };
  modules[path.join(codeRoot, "tests/helpers/copy-canvas-geometry")] = geometry;
  modules[path.join(codeRoot, "tests/helpers/copy-text-geometry")] = {
    inspectCopyText,
    observeCopyText: (_canvas: unknown, text: string) => ({
      element: { textContent: text, getBoundingClientRect: () => ({ ...raw, toJSON: () => raw }) },
      observation: {
        text,
        nodes: [{ order: 0, text, fragments: [fragment], ancestry: { visible: true, opacity: 1, clips: [] } }],
        visible: true,
        opacity: 1,
        clips: [],
      },
    }),
  };
  const require = createRequire(import.meta.url),
    esbuild = createRequire(require.resolve("@remotion/bundler"))("esbuild");
  const compiled = esbuild.transformSync(entrySource(codeRoot, manifest), { loader: "tsx", format: "cjs" }).code;
  const context = vm.createContext({
    require: (name: string) => {
      assert.ok(Object.hasOwn(modules, name), "No unexpected VM import " + name);
      return modules[name];
    },
    exports: {},
    module: { exports: {} },
    console: {
      log: (value: string) => {
        logs.push(value);
      },
    },
    document: { fonts, querySelectorAll: () => [canvas] },
    getComputedStyle: () => ({ fontFamily: "Arial", fontSize: "100px", opacity: "1", whiteSpace: "pre-line" }),
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(compiled, context, { timeout: 500 });
  assert.ok(root);
  const tree = root() as ElementRecord,
    composition = tree.children[0];
  assert.equal(typeof composition.props.component, "function");
  const timeline = {
    tracks: [
      { id: "visual", clips: [{ payload: { scene: { headline: "Complete headline", subtext: "Complete subtext" } } }] },
    ],
  };
  const video = (composition.props.component as (props: unknown) => ElementRecord)({ timeline }),
    probe = video.children[1];
  (probe.type as (props: unknown) => unknown)(probe.props);
  assert.equal(effects.length, 1);
  effects[0]();
  const timer = setTimeout(() => reject(Error("Bounded CPU Probe did not release")), 1000);
  try {
    await completed;
  } finally {
    clearTimeout(timer);
  }
  assert.equal(continued, 1, "Normal hold release reached exactly once");
  assert.equal(cancelled, 0, "Expected invalid geometry must not cancelRender");
  const proofs = logs.filter((log) => log.startsWith("COPY_PROOF:"));
  assert.equal(proofs.length, 1);
  assert.ok(logs.some((log) => log.startsWith("COPY_DIAGNOSTIC:")));
  return JSON.parse(proofs[0].slice(11)) as {
    texts: {
      rawRect: geometry.CopyDiagnosticBox;
      rect: geometry.CopyDiagnosticBox;
      rectangleValidity: string;
      elementCriterion: { result: string };
      textCriterion: { result: string; issues: string[] };
    }[];
  };
}
test("generated Probe normally emits explicit FAIL receipts for zero/nonfinite element rectangles, without cancel", async () => {
  for (const raw of [
    { ...fragment, width: 0 },
    { ...fragment, height: 0 },
    { ...fragment, x: NaN },
    { ...fragment, y: Infinity },
    { ...fragment, width: -Infinity },
  ]) {
    const proof = await executeProbe(raw);
    assert.equal(proof.texts.length, 2);
    for (const row of proof.texts) {
      assert.equal(row.rectangleValidity, "invalid");
      assert.equal(row.elementCriterion.result, "fail");
      assert.equal(row.textCriterion.result, "fail");
      assert.ok(row.textCriterion.issues.includes("Intrinsic element rectangle is invalid"));
      assert.deepEqual(row.rawRect, geometry.copyDiagnosticObservation(canvasRect, raw).raw);
      assert.deepEqual(row.rect, geometry.copyDiagnosticObservation(canvasRect, raw).relative);
      let accepted = 0;
      assert.throws(() => {
        assert.equal(row.rectangleValidity, "valid");
        assert.equal(row.textCriterion.result, "pass");
        accepted++;
      });
      assert.equal(accepted, 0);
    }
  }
});
test("diagnostic path preserves exact finite overflow and explicit nonfinite identity without granting fit", () => {
  const outside = { ...fragment, x: -0.000001 };
  assert.equal(geometry.copyDiagnosticObservation(canvasRect, outside).rectangleValidity, "valid");
  assert.equal(geometry.copyDiagnosticObservation(canvasRect, outside).raw.x, -0.000001);
  assert.throws(() => geometry.relativeCopyBox(canvasRect, outside));
  const encoded = JSON.parse(
    geometry.copyDiagnosticJson({
      raw: { x: NaN, y: Infinity, width: -Infinity, height: 0 },
      fragment: [NaN, Infinity, -Infinity],
    }),
  );
  assert.deepEqual(encoded, {
    raw: { x: "NaN", y: "Infinity", width: "-Infinity", height: 0 },
    fragment: ["NaN", "Infinity", "-Infinity"],
  });
});
