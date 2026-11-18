import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { digest } from "../src/lib/jobs/model-artifacts";
import { HtmlCaptureSchema, captureHtml } from "../src/lib/backends/html";
import {
  preflightStaticCompositionTree,
  extractStaticTreeDocument,
  validateStaticCompositionTree,
  type StaticTreeDocument,
} from "../src/lib/backends/native-composition-tree";
import { staticTreePrelude, HYPERFRAMES_TREE_PIN } from "../src/lib/backends/native-composition-tree-prelude";
import { fullPlayerPrelude } from "../src/lib/backends/hyperframes-player";
const document = (rootId: string, hosts: StaticTreeDocument["hosts"] = []): StaticTreeDocument => ({
  rootId,
  rootDuration: 1,
  rootAttributes: { "data-composition-id": rootId, "data-duration": "1", "data-start": "0" },
  hosts,
  bytes: 1,
  sha256: "a".repeat(64),
  mediaCount: 0,
  unsupported: [],
});
const host = (id: string, src: string, parentId: string) => ({
  id,
  src,
  parentId,
  start: 0,
  duration: 1,
  inPoint: 0,
  authored: { start: null, duration: "1", inPoint: null },
});
const data = () => ({
  root: document("root", [host("child", "child.html", "root")]),
  assets: { "child.html": document("child", [host("grand", "grand.html", "child")]), "grand.html": document("grand") },
});

test("strict additive request accepts explicit tree+native profile, refuses missing dependency and unknown aliases; old omitted profile unaffected", () => {
  const base = {
    protocol: "hyperframes-player",
    htmlFile: "/local/root.html",
    assetRoot: "/local",
    assets: ["runtime.js", "gsap.js"],
    width: 64,
    height: 64,
    fps: 10,
    frames: [0],
    playerRuntime: { runtimeAsset: "runtime.js", gsapAsset: "gsap.js" },
  };
  assert.equal(HtmlCaptureSchema.parse(base).playerRuntime?.compositionProfile, undefined);
  const tree = {
    ...base,
    playerRuntime: {
      ...base.playerRuntime,
      mediaProfile: "native-local-media-v1",
      compositionProfile: "static-local-tree-v1",
    },
  };
  assert.equal(HtmlCaptureSchema.parse(tree).playerRuntime?.compositionProfile, HYPERFRAMES_TREE_PIN.profile);
  assert.throws(() =>
    HtmlCaptureSchema.parse({
      ...base,
      playerRuntime: { ...base.playerRuntime, compositionProfile: "static-local-tree-v1" },
    }),
  );
  assert.throws(() =>
    HtmlCaptureSchema.parse({ ...tree, playerRuntime: { ...tree.playerRuntime, compositionProfile: "recursive-all" } }),
  );
  assert.throws(() => HtmlCaptureSchema.parse({ ...tree, graph: data() }));
});

test("wrong tree bundle refuses before any capture worker/Chrome or publication", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tree-pin-denial-"));
  try {
    writeFileSync(path.join(root, "root.html"), '<div data-composition-id="root" data-duration="1"></div>');
    writeFileSync(path.join(root, "runtime.js"), "not pinned");
    writeFileSync(path.join(root, "gsap.js"), "not pinned");
    const out = path.join(root, "outputs");
    await assert.rejects(
      captureHtml(
        {
          protocol: "hyperframes-player",
          htmlFile: path.join(root, "root.html"),
          assetRoot: root,
          assets: ["runtime.js", "gsap.js"],
          width: 64,
          height: 64,
          fps: 10,
          frames: [0],
          playerRuntime: {
            runtimeAsset: "runtime.js",
            gsapAsset: "gsap.js",
            mediaProfile: "native-local-media-v1",
            compositionProfile: "static-local-tree-v1",
          },
        },
        out,
      ),
      /runtime snapshot differs/,
    );
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private traversal derives source SHA/byte pins, bounded preorder and refuses metadata spoof/unknown/prototype source before extra extraction (structural reader unit)", async () => {
  const records = data(),
    sources: { [key: string]: StaticTreeDocument } = {
      root: records.root,
      child: records.assets["child.html"],
      grand: records.assets["grand.html"],
    },
    calls: string[] = [];
  const reader = async (html: string, sha256: string, bytes: number) => {
    calls.push(html);
    return { ...sources[html], sha256, bytes };
  };
  const graph = await preflightStaticCompositionTree("root", { "child.html": "child", "grand.html": "grand" }, reader);
  assert.deepEqual(calls, ["root", "child", "grand"]);
  assert.equal(graph.rootSha256, digest("root"));
  assert.equal(graph.nodes[1].sourceSha256, digest("grand"));
  assert.equal(graph.totalBytes, 14);
  await assert.rejects(preflightStaticCompositionTree("root", {}, reader), /allowlist/);
  await assert.rejects(
    preflightStaticCompositionTree("root", { "child.html": "child" }, async (html, sha, bytes) => ({
      ...sources[html],
      sha256: "b".repeat(64),
      bytes,
    })),
    /source pin/,
  );
  const inherited = Object.create({ "child.html": "child" });
  await assert.rejects(preflightStaticCompositionTree("root", inherited, reader), /allowlist/);
  const before = calls.length;
  await assert.rejects(
    preflightStaticCompositionTree("root", { "child.html": "x".repeat(128 * 1024 + 1) }, reader),
    /child byte/,
  );
  assert.equal(calls.length, before + 1, "Oversized child never reaches extraction");
  await assert.rejects(preflightStaticCompositionTree("x".repeat(1024 * 1024 + 1), {}, reader), /root byte/);
});

test("inert root origin refuses missing/nonzero before child parsing and authored handoff (structural sentinel only)", async () => {
  for (const value of [null, "0.125", "0.0", "1"]) {
    let authored = false,
      extractions = 0;
    const input = data();
    input.root.rootAttributes!["data-start"] = value;
    const run = async () => {
      await preflightStaticCompositionTree(
        "root",
        { "child.html": "child", "grand.html": "grand" },
        async (html, sha256, bytes) => {
          extractions++;
          return {
            ...(html === "root" ? input.root : (input.assets as Record<string, StaticTreeDocument>)[html + ".html"]),
            sha256,
            bytes,
          };
        },
      );
      authored = true;
    };
    await assert.rejects(run(), /explicit root data-start/);
    assert.equal(authored, false);
    assert.equal(extractions, 1, "Known unsupported root never traverses children");
  }
  const input = data();
  let authored = false;
  await preflightStaticCompositionTree(
    "root",
    { "child.html": "child", "grand.html": "grand" },
    async (html, sha256, bytes) => ({
      ...(html === "root" ? input.root : (input.assets as Record<string, StaticTreeDocument>)[html + ".html"]),
      sha256,
      bytes,
    }),
  );
  authored = true;
  assert.equal(authored, true, "Exact authored zero supports handoff");
});

test("private tree host controller rejects unplanned fetch/remount/dynamic metadata and timeline identity (fake DOM unit only, not upstream acceptance)", () => {
  const input = data(),
    graph = validateStaticCompositionTree(input),
    context = vm.createContext({ Map, Set, Object, Number, JSON, Error });
  const elements: any[] = [];
  const element = (attributes: Record<string, string>, parent: any = null) => ({
    attributes,
    parentElement: parent ? { closest: () => parent } : null,
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
    hasAttribute(name: string) {
      return Object.hasOwn(this.attributes, name);
    },
  });
  const root = element({ "data-composition-id": "root", "data-duration": "1", "data-start": "0" }),
    child = element(
      { "data-composition-id": "child", "data-composition-src": "child.html", "data-duration": "1" },
      root,
    ),
    grand = element(
      { "data-composition-id": "grand", "data-composition-src": "grand.html", "data-duration": "1" },
      child,
    );
  elements.push(root, child);
  Object.assign(context, {
    document: { querySelector: () => null, querySelectorAll: () => elements },
    window: {
      __clipManifest: { durationSeconds: 1 },
      __timelines: Object.fromEntries(
        ["root", "child", "grand"].map((id) => [
          id,
          {
            totalTime() {},
            getChildren() {},
            duration() {
              return 1;
            },
          },
        ]),
      ),
    },
  });
  vm.runInContext(
    `const refuse=m=>{throw Error(m)};${staticTreePrelude(graph)};globalThis.hostUnit={treeGuard,treeFetch,treeReady,treeNormalize};`,
    context,
  );
  const cap = context.hostUnit as any;
  assert.throws(() => cap.treeFetch("child.html"), /unplanned/);
  cap.treeGuard("before-mount", [child]);
  // Genuine sanitizer runs while the first child's fetch has not completed.
  child.attributes["data-hf-authored-duration"] = "1";
  assert.throws(() => cap.treeNormalize("before", [child]), /duration lifecycle/);
  delete child.attributes["data-hf-authored-duration"];
  assert.throws(() => cap.treeNormalize("after", [child]), /changed normalization/);
  assert.throws(() => cap.treeNormalize("invalid", []), /malformed/);
  assert.throws(() => cap.treeNormalize("before", [child, child]), /identity/);
  cap.treeNormalize("before", [child]);
  assert.throws(() => cap.treeNormalize("before", [child]), /pending/);
  child.attributes["data-hf-authored-duration"] = "1";
  delete child.attributes["data-duration"];
  cap.treeNormalize("after", [child]);
  cap.treeFetch("child.html");
  assert.throws(() => cap.treeFetch("child.html"), /repeated/);
  elements.push(grand);
  // Old child is normalized while newly mounted grandchild is raw.
  cap.treeGuard("before-mount", [grand]);
  cap.treeFetch("grand.html");
  cap.treeGuard("mounted", [child, grand]);
  cap.treeGuard("scripts-complete", [child, grand]);
  assert.throws(() => cap.treeReady(), /incomplete authenticated/);
  cap.treeNormalize("before", [grand]);
  grand.attributes["data-hf-authored-duration"] = "1";
  delete grand.attributes["data-duration"];
  elements.pop();
  assert.throws(() => cap.treeNormalize("after", [grand]), /detached/);
  elements.push(grand);
  cap.treeNormalize("after", [grand]);
  cap.treeReady();
  cap.treeGuard("mounted", [child, grand]);
  cap.treeNormalize("before", []);
  cap.treeNormalize("after", []);
  cap.treeReady();
  const fake = element({ ...child.attributes }, root);
  assert.throws(() => cap.treeNormalize("before", [fake]), /identity|non-DOM/);
  child.attributes["data-hf-authored-duration"] = "1.0";
  assert.throws(() => cap.treeReady(), /metadata/);
  child.attributes["data-hf-authored-duration"] = "1";
  child.attributes["data-duration"] = "1";
  assert.throws(() => cap.treeReady(), /duration lifecycle/);
  delete child.attributes["data-duration"];
  for (const attr of ["data-end", "data-hf-authored-end"]) {
    child.attributes[attr] = "1";
    assert.throws(() => cap.treeReady(), /end metadata/);
    delete child.attributes[attr];
  }
  elements.push(
    element({ "data-composition-id": "dynamic", "data-composition-src": "bad.html", "data-duration": "1" }, root),
  );
  assert.throws(() => cap.treeReady(), /unlisted/);
  elements.pop();
  assert.throws(() => cap.treeGuard("before-mount", [child]), /repeated/);
  (context.window as any).__timelines.child = {
    totalTime() {},
    getChildren() {},
    duration() {
      return 1;
    },
  };
  assert.throws(() => cap.treeReady(), /identity/);
});

test("inert extractor rejects authored private timing before graph handoff (fake DOM unit only)", () => {
  for (const name of ["data-hf-authored-duration", "data-hf-authored-end"]) {
    const document = {
      querySelector: (selector: string) => (selector.includes(name) ? {} : null),
      querySelectorAll: () => [],
    } as unknown as Document;
    assert.ok(
      extractStaticTreeDocument(document, "a".repeat(64), 1).unsupported.includes(
        "authored private timing attributes unsupported",
      ),
    );
  }
});

test("inert composition end refuses before authored handoff while media end is not blanket-refused (fake DOM unit)", async () => {
  let authored = false;
  const fake = {
    querySelector: (selector: string) =>
      selector === "[data-composition-id][data-end],[data-composition-src][data-end]" ? {} : null,
    querySelectorAll: () => [],
  } as unknown as Document;
  const record = extractStaticTreeDocument(fake, digest("root"), 4);
  assert.ok(record.unsupported.includes("composition end attributes unsupported"));
  await assert.rejects(async () => {
    await preflightStaticCompositionTree("root", {}, async () => record);
    authored = true;
  }, /composition end attributes/);
  assert.equal(authored, false);
  const mediaOnly = { querySelector: () => null, querySelectorAll: () => [] } as unknown as Document;
  assert.ok(
    !extractStaticTreeDocument(mediaOnly, "a".repeat(64), 1).unsupported.includes(
      "composition end attributes unsupported",
    ),
  );
});

test("generated private prelude/serialized inert extractor parse as JavaScript; omitted tree retains recursive denial and no tree capability", () => {
  const graph = validateStaticCompositionTree(data());
  new vm.Script(fullPlayerPrelude("", "", {}, 10, 64, 64, {}, graph));
  new Function("__name", "return (" + extractStaticTreeDocument.toString() + ")")((fn: unknown) => fn);
  const old = fullPlayerPrelude("", "", {}, 10, 64, 64, {});
  assert.match(old, /Recursive external children unsupported/);
  assert.match(old, /\[data-composition-src\],iframe/);
  assert.ok(!old.includes("treeGuard"));
  assert.ok(!old.includes("static-local-tree-v1"));
});
