import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  extractInstanceDocument,
  preflightCompositionInstances,
  validateInstanceViewport,
  type InstanceGraph,
} from "../src/lib/backends/native-composition-instances-extract";
import {
  createInstanceController,
  HYPERFRAMES_INSTANCES_PIN,
  instancesPrelude,
} from "../src/lib/backends/native-composition-instances-prelude";
import { verifyInstancesReceipt } from "../src/lib/backends/native-composition-instances-receipt";
import { snapshotInstanceFile } from "../src/lib/backends/native-composition-instances-files";
import { HtmlCaptureSchema, captureHtml } from "../src/lib/backends/html";
import { fullPlayerPrelude } from "../src/lib/backends/hyperframes-player";
import { digest } from "../src/lib/jobs/model-artifacts";
/** Explicit synthetic DOM. This is not HTML parser/browser/engine execution. */
class E {
  namespaceURI = "http://www.w3.org/1999/xhtml";
  nodeType = 1;
  parentElement: E | null = null;
  children: E[] = [];
  value = "";
  values: Record<string, string>;
  tagName: string;
  constructor(tag: string, attributes: Record<string, string> = {}, text = "") {
    this.tagName = tag.toUpperCase();
    this.values = { ...attributes };
    this.value = text;
  }
  get attributes() {
    return Object.entries(this.values).map(([name, value]) => ({ name, value }));
  }
  get childNodes(): (E | { nodeType: number; textContent: string })[] {
    return [...(this.value ? [{ nodeType: 3, textContent: this.value }] : []), ...this.children];
  }
  get textContent(): string {
    return this.value + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.value = value;
  }
  get id() {
    return this.getAttribute("id") ?? "";
  }
  get src() {
    return this.getAttribute("src") ?? "";
  }
  get type() {
    return this.getAttribute("type") ?? "";
  }
  get isConnected(): boolean {
    return this.tagName === "HTML" || Boolean(this.parentElement?.isConnected);
  }
  get nextElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  // Finite fake for root-probe observed scalar shorthand expansion, not a CSS parser.
  get style() {
    const values = new Map<string, string>(),
      priorities = new Map<string, string>();
    for (const declaration of (this.values.style ?? "").split(";").filter((v) => v.trim())) {
      const at = declaration.indexOf(":"),
        key = declaration.slice(0, at).trim(),
        raw = declaration.slice(at + 1).trim(),
        priority = /\s*!important$/.test(raw) ? "important" : "",
        value = raw.replace(/\s*!important$/, "");
      const keys =
        (key === "margin" || key === "padding") && /^(?:0|-?[0-9]+(?:\.[0-9]+)?px)$/.test(value)
          ? ["top", "right", "bottom", "left"].map((side) => key + "-" + side)
          : key === "overflow"
            ? ["overflow-x", "overflow-y"]
            : [key];
      for (const physical of keys) {
        values.set(physical, value === "0" && physical !== key ? "0px" : value);
        priorities.set(physical, priority);
      }
    }
    return Object.assign(values, {
      getPropertyValue: (key: string) => values.get(key) ?? "",
      getPropertyPriority: (key: string) => priorities.get(key) ?? "",
      *[Symbol.iterator]() {
        yield* values.keys();
      },
    });
  }
  getAttribute(name: string) {
    return this.values[name] ?? null;
  }
  hasAttribute(name: string) {
    return Object.hasOwn(this.values, name);
  }
  append(child: E) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
}
class D {
  documentElement = new E("html");
  head = this.documentElement.append(new E("head"));
  body = this.documentElement.append(new E("body"));
  currentScript: E | null = null;
  querySelectorAll(selector: string) {
    const all: E[] = [];
    const visit = (el: E) => {
      all.push(el);
      el.children.forEach(visit);
    };
    visit(this.documentElement);
    return all.filter(
      (el) =>
        selector === "*" ||
        (selector === "[data-composition-id]" && el.hasAttribute("data-composition-id")) ||
        (selector === "audio,video" && ["AUDIO", "VIDEO"].includes(el.tagName)),
    );
  }
}
const script = (id: string, target: string, duration = id === "root" ? 2 : 1) =>
  `const timeline=gsap.timeline({paused:true});timeline.to("#${target}",{opacity:1,duration:${duration},ease:"none"},0);window.__timelines["${id}"]=timeline;`;
function source(root = false) {
  const d = new D(),
    r = d.body.append(
      new E("div", {
        id: root ? "root" : "leaf",
        "data-composition-id": root ? "root" : "leaf",
        "data-start": "0",
        "data-duration": "2",
        ...(!root ? { style: "position:relative" } : {}),
        ...(root ? { "data-width": "64", "data-height": "64", "data-fps": "8" } : {}),
      }),
    );
  if (root) {
    r.append(
      new E("div", {
        id: "a",
        "data-composition-id": "a",
        "data-composition-src": "leaf.html",
        "data-start": "0",
        "data-duration": "1",
      }),
    );
    r.append(
      new E("div", {
        id: "b",
        "data-composition-id": "b",
        "data-composition-src": "leaf.html",
        "data-start": "1",
        "data-duration": "1",
        "data-media-start": "0.25",
      }),
    );
    r.append(new E("span", { id: "title", style: "opacity:0" }, "Root"));
  } else {
    r.append(new E("span", { id: "box", style: "opacity:0" }, "Leaf"));
    r.append(
      new E("video", {
        id: "footage",
        src: "footage.mp4",
        "data-start": "0.5",
        "data-duration": "0.25",
        "data-playback-rate": "2",
        "data-media-start": "0",
      }),
    );
    r.append(
      new E("audio", {
        id: "voice",
        src: "voice.wav",
        "data-start": "0.5",
        "data-duration": "0.25",
        "data-volume": "0.5",
        muted: "",
      }),
    );
  }
  r.append(new E("script", {}, script(root ? "root" : "leaf", root ? "title" : "box")));
  return d;
}
const extract = (document: D, name = "") =>
  extractInstanceDocument(document as unknown as Document, name, ["leaf.html", "footage.mp4", "voice.wav"]);
async function graph(initialRootOverflow = false, initialLeafOverflow = false, separateSources = false) {
  const assets = ["leaf.html", ...(separateSources ? ["second.html"] : []), "footage.mp4", "voice.wav"];
  return preflightCompositionInstances(
    "ROOT-BYTES",
    {
      "leaf.html": "LEAF-BYTES",
      "unused.html": "UNUSED-BYTES",
      ...(separateSources ? { "second.html": "SECOND-BYTES" } : {}),
    },
    assets,
    async (html, name) => {
      const d = source(html === "ROOT-BYTES");
      if (separateSources && html === "ROOT-BYTES")
        d.body.children[0].children[1].values["data-composition-src"] = "second.html";
      if (initialRootOverflow && html === "ROOT-BYTES") d.body.children[0].values.style = "overflow:hidden";
      if (initialLeafOverflow && html !== "ROOT-BYTES")
        d.body.children[0].children[0].values.style += ";overflow:hidden";
      return extractInstanceDocument(d as unknown as Document, name, assets);
    },
  );
}
const clone = (e: E): E => {
  const result = new E(e.tagName, e.values, e.value);
  for (const child of e.children) result.append(clone(child));
  return result;
};
async function setup(initialRootOverflow = false, initialLeafOverflow = false, separateSources = false) {
  const g = await graph(initialRootOverflow, initialLeafOverflow, separateSources),
    d = source(true);
  if (separateSources) d.body.children[0].children[1].values["data-composition-src"] = "second.html";
  if (initialRootOverflow) d.body.children[0].values.style = "overflow:hidden";
  const w = {} as any,
    violations: string[] = [],
    cap = createInstanceController(g, d as unknown as Document, w, (message) => {
      violations.push(message);
      throw Error(message);
    });
  class Timeline {
    parent: unknown;
    at = 0;
    children: Timeline[] = [];
    constructor(
      readonly elements: E[],
      readonly seconds = 2,
    ) {}
    totalTime() {}
    startTime() {
      return this.at;
    }
    duration() {
      return this.seconds;
    }
    getChildren() {
      return [{ targets: () => this.elements }, ...this.children];
    }
  }
  w.gsap = { core: { Timeline } };
  const root = d.body.children[0],
    a = root.children[0],
    b = root.children[1],
    rootScript = root.children[3];
  const tl = (elements: E[]) => new Timeline(elements);
  const publishRoot = () => {
    d.currentScript = rootScript;
    w.__timelines.root = tl([root.children[2]]);
    d.currentScript = null;
  };
  const installStyle = () => {
    const style = fakeInertStyle();
    cap.instanceRegisterInertStyle(style as unknown as Element);
    d.head.append(style);
    attachFakeSheet(style);
    return style;
  };
  const mount = (host: E) => {
    const authoredId = cap.instanceSourceRootId(host as unknown as Element, host.getAttribute("data-composition-src")!);
    const original = source().body.children[0];
    assert.equal(original.getAttribute("data-composition-id"), authoredId);
    assert.notEqual(host.getAttribute("data-composition-id"), authoredId);
    if (initialLeafOverflow) original.children[0].values.style += ";overflow:hidden";
    const leaf = clone(original);
    for (const name of ["id", "data-composition-id", "data-start", "data-duration"]) delete leaf.values[name];
    leaf.values["data-hf-authored-id"] = "leaf";
    leaf.values["data-hf-inner-root"] = "true";
    leaf.values.style = (leaf.values.style ? leaf.values.style + ";" : "") + "width:100%;height:100%";
    assert.equal(leaf.style.getPropertyValue("position"), "relative");
    leaf.children = leaf.children.filter((e) => e.tagName !== "SCRIPT");
    host.append(leaf);
    return leaf;
  };
  const publishLeaf = (host: E) => {
    const injected = new E("script", {}, "PINNED WRAPPER " + g.documents["leaf.html"].record.script);
    cap.instanceArmScript(host as unknown as Element, injected as unknown as HTMLScriptElement);
    d.body.append(injected);
    d.currentScript = injected;
    const acquire = w.__avcPrivateInstanceAcquire;
    delete w.__avcPrivateInstanceAcquire;
    const authority = acquire(injected);
    authority.registry.leaf = new Timeline([host.children[0].children[0]], 1);
    d.currentScript = null;
    return injected;
  };
  const normalize = (targets: E[]) => {
    cap.treeNormalize("before", targets as unknown as Element[]);
    for (const target of targets) {
      target.values["data-hf-authored-duration"] =
        target.values["data-duration"] ?? target.values["data-hf-authored-duration"];
      delete target.values["data-duration"];
    }
    cap.treeNormalize("after", targets as unknown as Element[]);
  };
  const prepare = () =>
    cap.instancePrepareMedia(() => {
      for (const [i, el] of d.querySelectorAll("audio,video").entries())
        el.values["data-hf-render-id"] = (el.tagName === "VIDEO" ? "video" : "audio") + i;
    });
  const ready = async (withInertStyle = true) => {
    publishRoot();
    if (withInertStyle) installStyle();
    cap.treeGuard("before-mount", [a, b] as unknown as Element[]);
    await cap.instanceFetch(a as unknown as Element, "leaf.html");
    mount(a);
    normalize([a, b]);
    await cap.instanceFetch(b as unknown as Element, "https://avc.invalid/leaf.html");
    mount(b);
    cap.treeGuard("before-mount", []);
    cap.treeGuard("mounted", [a, b] as unknown as Element[]);
    prepare();
    publishLeaf(a);
    publishLeaf(b);
    cap.treeGuard("scripts-complete", [a, b] as unknown as Element[]);
    w.__clipManifest = {
      durationSeconds: 2,
      clips: [
        { id: "a" },
        { id: "b" },
        { id: "i1_box" },
        { id: "i2_box" },
        { id: "video0" },
        { id: "audio1" },
        { id: "video2" },
        { id: "audio3" },
      ],
    };
    cap.treeReady();
  };
  return {
    g,
    d,
    w,
    cap,
    root,
    a,
    b,
    rootScript,
    tl,
    publishRoot,
    installStyle,
    mount,
    publishLeaf,
    normalize,
    prepare,
    ready,
    violations,
  };
}

test("inert wrappers refuse visible direct text, attrs, identities/order and extra children; formatting whitespace remains (synthetic DOM)", () => {
  for (const key of ["documentElement", "head", "body"] as const) {
    const clean = source(true);
    clean[key].value = " \n\t ";
    assert.doesNotThrow(() => extract(clean));
    for (const mutate of [
      (d: D) => {
        d[key].value = "UNAPPROVED OUTSIDE ROOT COPY";
      },
      (d: D) => {
        d[key].values.class = "outside";
      },
      (d: D) => {
        d[key].namespaceURI = "urn:foreign";
      },
      (d: D) => {
        d[key].append(new E("span", {}, "outside"));
      },
    ]) {
      const d = source(true);
      mutate(d);
      assert.throws(() => extract(d));
    }
  }
  const reordered = source(true);
  reordered.documentElement.children.reverse();
  assert.throws(() => extract(reordered), /wrapper/);
});
test("late wrapper text/attrs/children/replacements fail closed at readiness; registered scripts remain exact (synthetic DOM)", async () => {
  for (const key of ["documentElement", "head", "body"] as const)
    for (const mutate of [
      (d: D) => {
        d[key].value = "LATE OUTSIDE ROOT COPY";
      },
      (d: D) => {
        d[key].values.id = "late";
      },
      (d: D) => {
        d[key].append(new E("span", {}, "late"));
      },
      (d: D) => {
        d[key].namespaceURI = "urn:foreign";
      },
      (d: D) => {
        const old = d[key],
          replacement = clone(old);
        replacement.parentElement = old.parentElement;
        if (old.parentElement) old.parentElement.children[old.parentElement.children.indexOf(old)] = replacement;
        d[key] = replacement;
      },
    ]) {
      const s = await setup();
      await s.ready();
      mutate(s.d);
      assert.throws(() => s.cap.treeReady(), /wrapper|body|root/);
      assert.throws(() => s.cap.treeReady());
    }
  const reordered = await setup();
  await reordered.ready();
  reordered.d.documentElement.children.reverse();
  assert.throws(() => reordered.cap.treeReady(), /wrapper/);
  const scriptsReordered = await setup();
  await scriptsReordered.ready();
  scriptsReordered.d.body.children = [scriptsReordered.root, ...scriptsReordered.d.body.children.slice(1).reverse()];
  assert.throws(() => scriptsReordered.cap.treeReady(), /injected/);
  for (const mutate of [
    (script: E) => {
      script.value += " changed";
    },
    (script: E) => {
      script.values.type = "module";
    },
    (script: E) => {
      script.tagName = "DIV";
    },
    (script: E) => {
      script.append(new E("span"));
    },
  ]) {
    const s = await setup();
    await s.ready();
    mutate(s.d.body.children[1]);
    assert.throws(() => s.cap.treeReady(), /injected/);
  }
});
test("only exact genuine wrapper CSS normalization is allowed; no priorities or unrelated declarations (synthetic DOM)", async () => {
  const s = await setup();
  for (const e of [s.d.documentElement, s.d.head, s.d.body]) e.value = "\n  ";
  await s.ready();
  for (const e of [s.d.documentElement, s.d.body])
    e.values.style = "margin:0px;padding:0;overflow:hidden;width:64px;height:64px";
  s.cap.treeReady();
  for (const style of [
    "margin:1px",
    "padding:0 !important",
    "overflow:visible",
    "width:65px",
    "height:63px",
    "background-color:#000000",
    "position:absolute",
  ]) {
    const bad = await setup();
    await bad.ready();
    bad.d.body.values.style = style;
    assert.throws(() => bad.cap.treeReady(), /wrapper style/);
  }
  const bad = await setup();
  await bad.ready();
  bad.d.head.values.style = "";
  assert.throws(() => bad.cap.treeReady(), /wrapper attribute/);
});
test("inert actual DOM values derive scripts/IDs/styles/host/media; caller records are not a production input (synthetic DOM)", () => {
  const root = extract(source(true)),
    leaf = extract(source());
  assert.deepEqual(
    root.record.hosts.map((h) => h.source),
    ["leaf.html", "leaf.html"],
  );
  assert.equal(root.record.script, script("root", "title"));
  assert.deepEqual(leaf.record.mediaIds, ["footage", "voice"]);
  assert.equal(leaf.root.children[1].attributes["data-playback-rate"], "2");
  const d = source();
  d.body.children[0].children[0].values.id = "changed";
  assert.deepEqual(extract(d).record.localIds, ["changed", "footage", "voice"]);
});
test("unknown retained tag/attribute/private IDs/source/script placement wrappers and source-kind reject inertly", () => {
  const cases = [
    (d: D) => (d.body.children[0].children[0].values.onclick = "run()"),
    (d: D) => (d.body.children[0].values["data-hf-authored-duration"] = "2"),
    (d: D) => (d.body.children[0].children[0].values.id = "__render_frame_x"),
    (d: D) => d.head.append(new E("link", { href: "https://evil" })),
    (d: D) => (d.body.children[0].children[1].values.src = "../footage.mp4"),
    (d: D) => (d.body.children[0].children[1].values.src = "voice.wav"),
    (d: D) => d.body.children[0].append(new E("script", {}, script("leaf", "box"))),
    (d: D) => (d.body.children[0].children[0].tagName = "CANVAS"),
    (d: D) => (d.body.children[0].values["data-start"] = "0.0"),
    (d: D) => (d.body.children[0].children[3].values.type = "module"),
    (d: D) => (d.body.children[0].children[0].values["data-end"] = "1"),
  ];
  for (const mutate of cases) {
    const d = source();
    mutate(d);
    assert.throws(() => extract(d), /Instance inert DOM/);
  }
});
test("semantic snapshot preflight pins ALL bytes incl unused without parsing unused; expanded repeated instances are distinct", async () => {
  let reads = 0;
  const g = await preflightCompositionInstances(
    "ROOT-BYTES",
    { "leaf.html": "LEAF-BYTES", "unused.html": "never-parsed" },
    ["leaf.html", "footage.mp4", "voice.wav"],
    async (html, name) => {
      reads++;
      assert.notEqual(html, "never-parsed");
      return extract(source(html === "ROOT-BYTES"), name);
    },
  );
  assert.equal(reads, 2);
  assert.equal(g.instances.length, 2);
  assert.equal(g.mediaCount, 4);
  assert.equal(g.instances[0].sourceSha256, g.instances[1].sourceSha256);
  assert.notEqual(g.instances[0].id, g.instances[1].id);
  assert.equal((g as any).unused[0].sha256, digest("never-parsed"));
  const changed = await graph();
  assert.notEqual(g.graphSha256, changed.graphSha256);
  await assert.rejects(
    preflightCompositionInstances("ROOT", Object.create({ "leaf.html": "LEAF" }), [], async () =>
      extract(source(true)),
    ),
    /allowlist/,
  );
});
test("missing/shifted root or recursive leaf/root-media cannot hand off to authored execution", async () => {
  for (const mutate of [
    (d: D) => delete d.body.children[0].values["data-start"],
    (d: D) => (d.body.children[0].values["data-start"] = "1"),
  ]) {
    let handoff = false;
    await assert.rejects(async () => {
      await preflightCompositionInstances("ROOT", { "leaf.html": "LEAF" }, ["leaf.html"], async () => {
        const d = source(true);
        mutate(d);
        return extract(d);
      });
      handoff = true;
    }, /root data-start/);
    assert.equal(handoff, false);
  }
  await assert.rejects(
    preflightCompositionInstances("ROOT", { "leaf.html": "LEAF" }, ["leaf.html"], async (html) =>
      extract(source(true)),
    ),
    /direct leaves/,
  );
});
test("private controller authenticates interleaving real-node shape, separate registry/clip/media IDs and exact ancestor clocks (synthetic capabilities only)", async () => {
  const s = await setup();
  await s.ready();
  assert.deepEqual(Object.keys(s.w.__timelines), ["root", "a", "b"]);
  assert.notEqual(s.w.__timelines.a, s.w.__timelines.b);
  assert.equal(s.w.__timelines.leaf, undefined);
  const boxA = s.a.children[0].children[0],
    boxB = s.b.children[0].children[0];
  assert.equal(boxA.id, boxB.id);
  assert.notEqual(s.cap.instanceClipId(boxA as unknown as Element), s.cap.instanceClipId(boxB as unknown as Element));
  s.w.__timelines.a.parent = s.w.__timelines.root;
  s.w.__timelines.a.at = 0;
  s.w.__timelines.b.parent = s.w.__timelines.root;
  s.w.__timelines.b.at = 1;
  s.w.__timelines.root.children = [s.w.__timelines.a, s.w.__timelines.b];
  s.cap.treeReady();
  s.cap.treeMediaGuard(s.a.children[0].children[1] as unknown as Element, 0.5, 0.75);
  s.cap.treeMediaGuard(s.b.children[0].children[1] as unknown as Element, 1.25, 1.5);
  s.w.__timelines = s.w.__timelines;
  assert.equal(s.violations.length, 0);
});
test("unowned root publication/registry replacement permanently latch without a later successful continuation", async () => {
  for (const attack of [
    (s: any) => {
      s.w.__timelines.root = s.tl([s.root.children[2]]);
    },
    (s: any) => {
      s.w.__timelines = {};
    },
    (s: any) => Object.defineProperty(s.w.__timelines, "fake", { value: s.tl([]) }),
  ]) {
    const s = await setup();
    assert.throws(() => attack(s), /controller/);
    assert.throws(() => s.publishRoot(), /controller/);
    assert.ok(s.violations.length >= 2);
  }
});
test("unplanned/replayed/wrong host fetch and source aliases, metadata mutation and detached clones latch after valid style prerequisite", async () => {
  for (const attack of [
    async (s: any) => s.cap.instanceFetch(s.a, "leaf.html"),
    async (s: any) => {
      s.cap.treeGuard("before-mount", [s.a, s.b]);
      await s.cap.instanceFetch(s.a, "leaf.html");
      await s.cap.instanceFetch(s.a, "leaf.html");
    },
    async (s: any) => {
      s.cap.treeGuard("before-mount", [s.a, s.b]);
      await s.cap.instanceFetch(s.a, "leaf.html?x");
    },
    async (s: any) => {
      s.a.values["data-media-start"] = "0.1";
      s.cap.treeGuard("before-mount", [s.a]);
    },
    async (s: any) => s.cap.instanceFetch(clone(s.a), "leaf.html"),
  ]) {
    const s = await setup();
    s.publishRoot();
    s.installStyle();
    await assert.rejects(
      () => attack(s),
      /unplanned|host metadata|host ownership|new unsupported attribute: data-media-start/,
    );
    assert.throws(() => s.cap.treeReady(), /controller/);
  }
});
test("private acquisition wrong/current/replayed/script shadow/reflection/cross-leaf targets fail closed", async () => {
  for (const mode of ["wrong-script", "not-deleted", "cross-target", "registry-alias", "replay"]) {
    const s = await setup();
    s.publishRoot();
    s.installStyle();
    s.cap.treeGuard("before-mount", [s.a, s.b] as unknown as Element[]);
    await s.cap.instanceFetch(s.a as unknown as Element, "leaf.html");
    s.mount(s.a);
    await s.cap.instanceFetch(s.b as unknown as Element, "leaf.html");
    s.mount(s.b);
    s.prepare();
    const injected = new E("script", {}, s.g.documents["leaf.html"].record.script);
    s.cap.instanceArmScript(s.a as unknown as Element, injected as unknown as HTMLScriptElement);
    s.d.body.append(injected);
    s.d.currentScript = injected;
    const acquire = s.w.__avcPrivateInstanceAcquire;
    if (mode !== "not-deleted") delete s.w.__avcPrivateInstanceAcquire;
    if (mode === "wrong-script" || mode === "not-deleted") {
      assert.throws(() => acquire(mode === "wrong-script" ? s.rootScript : injected), /acquisition/);
      continue;
    }
    const authority = acquire(injected);
    if (mode === "replay") {
      assert.throws(() => acquire(injected), /acquisition/);
      continue;
    }
    assert.throws(() => {
      authority.registry[mode === "registry-alias" ? "a" : "leaf"] = s.tl([
        mode === "cross-target" ? s.b.children[0].children[0] : s.a.children[0].children[0],
      ]);
    }, /outside|authority/);
  }
});
test("unknown collectible/new node, mutable native render IDs/timeline/metadata/script content and malformed sanitizer refuse", async () => {
  for (const attack of [
    (s: any) => s.cap.instanceClipId(new E("span", { id: "box" })),
    (s: any) => {
      s.a.children[0].children[1].values["data-hf-render-id"] = "forged";
      s.cap.treeReady();
    },
    (s: any) => {
      s.a.values["data-hf-authored-duration"] = "1.0";
      s.cap.treeReady();
    },
    (s: any) => {
      s.a.children[0].append(new E("span", { id: "other" }));
      s.cap.treeReady();
    },
    (s: any) => {
      s.d.body.children[1].value += "MUTATED";
      s.cap.treeReady();
    },
    (s: any) => {
      s.a.children[0].children[0].values.style = "opacity:0;left:50px";
      s.cap.treeReady();
    },
    (s: any) => s.cap.treeNormalize("after", [s.a]),
    (s: any) => {
      s.a.children[0].children.reverse();
      s.cap.treeReady();
    },
    (s: any) => {
      s.w.__timelines.a.elements.push(s.b.children[0].children[0]);
      s.cap.treeReady();
    },
  ]) {
    const s = await setup();
    await s.ready();
    assert.throws(() => attack(s), /controller/);
  }
});
test("strict root+instance 5ns boundaries and post-dispose retained callbacks refuse (no clock execution)", async () => {
  for (const [start, end, host] of [
    [0.5, 1.000000005, "a"],
    [0.999999995, 1.5, "b"],
    [1, 2.000000005, "b"],
  ] as const) {
    const s = await setup();
    await s.ready();
    assert.throws(
      () => s.cap.treeMediaGuard((host === "a" ? s.a : s.b).children[0].children[1] as unknown as Element, start, end),
      /ancestor/,
    );
  }
  const s = await setup();
  await s.ready();
  s.cap.treeMediaGuard(s.a.children[0].children[1] as unknown as Element, 0, 1);
  s.cap.dispose();
  assert.throws(() => s.cap.instanceClipId(s.a as unknown as Element), /disposed/);
  await assert.rejects(s.cap.instanceFetch(s.a as unknown as Element, "leaf.html"), /disposed/);
});
test("new explicit profile/pin/receipt/parser closure is additive and generated controller/prelude parse only", async () => {
  const base = {
    protocol: "hyperframes-player",
    htmlFile: "/local/root.html",
    assetRoot: "/local",
    assets: ["runtime.js", "gsap.js"],
    width: 64,
    height: 64,
    fps: 8,
    frames: [0],
    playerRuntime: { runtimeAsset: "runtime.js", gsapAsset: "gsap.js" },
  };
  assert.equal(HtmlCaptureSchema.parse(base).playerRuntime?.compositionProfile, undefined);
  assert.equal(
    HtmlCaptureSchema.parse({
      ...base,
      playerRuntime: {
        ...base.playerRuntime,
        mediaProfile: "native-local-media-v1",
        compositionProfile: "static-local-instances-v1",
      },
    }).playerRuntime?.compositionProfile,
    HYPERFRAMES_INSTANCES_PIN.profile,
  );
  assert.throws(() =>
    HtmlCaptureSchema.parse({
      ...base,
      playerRuntime: { ...base.playerRuntime, compositionProfile: "static-local-instances-v1" },
    }),
  );
  assert.equal(verifyInstancesReceipt().buildReceiptSha256, HYPERFRAMES_INSTANCES_PIN.buildReceiptSha256);
  const g = await graph();
  validateInstanceViewport(g, { width: 64, height: 64, fps: 8 });
  assert.throws(() => validateInstanceViewport(g, { width: 64, height: 64, fps: 9 }), /viewport/);
  new vm.Script(instancesPrelude(g));
  new vm.Script(fullPlayerPrelude("", "", {}, 8, 64, 64, {}, undefined, g));
  assert.ok(!fullPlayerPrelude("", "", {}, 8, 64, 64, {}).includes("instanceController"));
  new Function("__name", "return (" + extractInstanceDocument.toString() + ")");
});
test("wrong new pin refuses before capture/browser/publication, original-byte UTF8 and regular-reader symlink/FIFO boundaries", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "instance-source-"));
  try {
    const html = path.join(directory, "root.html");
    writeFileSync(html, "ROOT");
    writeFileSync(path.join(directory, "runtime.js"), "WRONG");
    writeFileSync(path.join(directory, "gsap.js"), "WRONG");
    const output = path.join(directory, "out");
    await assert.rejects(
      captureHtml(
        {
          protocol: "hyperframes-player",
          htmlFile: html,
          assetRoot: directory,
          assets: ["runtime.js", "gsap.js"],
          width: 64,
          height: 64,
          fps: 8,
          frames: [0],
          playerRuntime: {
            runtimeAsset: "runtime.js",
            gsapAsset: "gsap.js",
            mediaProfile: "native-local-media-v1",
            compositionProfile: "static-local-instances-v1",
          },
        },
        output,
      ),
      /runtime snapshot/,
    );
    assert.equal(existsSync(output), false);
    writeFileSync(html, Buffer.from([0xff]));
    await assert.rejects(
      captureHtml(
        {
          protocol: "hyperframes-player",
          htmlFile: html,
          assetRoot: directory,
          assets: ["runtime.js", "gsap.js"],
          width: 64,
          height: 64,
          fps: 8,
          frames: [0],
          playerRuntime: {
            runtimeAsset: "runtime.js",
            gsapAsset: "gsap.js",
            mediaProfile: "native-local-media-v1",
            compositionProfile: "static-local-instances-v1",
          },
        },
        output,
      ),
      /UTF-8/,
    );
    symlinkSync(html, path.join(directory, "alias"));
    assert.throws(() => snapshotInstanceFile(path.join(directory, "alias"), directory, 1024), /symlink/);
    assert.throws(() => snapshotInstanceFile(html, directory, 0), /regular/);
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [path.join(directory, "fifo")]);
      const start = Date.now();
      assert.throws(() => snapshotInstanceFile(path.join(directory, "fifo"), directory, 1024), /regular/);
      assert.ok(Date.now() - start < 1000);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native frame creation requires exact video/render ID/parent and rejects detached or moved overlays (synthetic only)", async () => {
  for (const bad of [false, true]) {
    const s = await setup();
    await s.ready();
    const video = s.a.children[0].children[1],
      image = new E("img", { id: "__render_frame_video0__", "data-avc-native-frame": "" });
    s.a.children[0].children.splice(2, 0, image);
    image.parentElement = s.a.children[0];
    if (bad) image.values.id = "__render_frame_wrong__";
    if (bad) {
      assert.throws(
        () => s.cap.instanceRegisterFrame(video as unknown as Element, image as unknown as Element),
        /ownership/,
      );
      continue;
    }
    s.cap.instanceRegisterFrame(video as unknown as Element, image as unknown as Element);
    s.cap.treeReady();
    image.parentElement = s.b.children[0];
    assert.throws(() => s.cap.treeReady(), /frame changed/);
  }
});
test("counterfeit timeline and unregistered nested timeline cannot pass genuine constructor/owner validation", async () => {
  const s = await setup();
  s.d.currentScript = s.rootScript;
  assert.throws(() => {
    s.w.__timelines.root = { totalTime() {}, duration: () => 2, getChildren: () => [] };
  }, /genuine timeline/);
  const nested = await setup();
  await nested.ready();
  nested.w.__timelines.root.children = [nested.tl([nested.a.children[0].children[0]])];
  assert.throws(() => nested.cap.treeReady(), /nested timeline/);
});

function wrapperDiagnostic(error: unknown) {
  const message = String(error),
    marker = "wrapperDiagnostic=";
  assert.ok(message.includes(marker), message);
  return JSON.parse(message.slice(message.indexOf(marker) + marker.length));
}
test("error-only wrapper diagnostics distinguish finite initial refusal reasons and root-publication context", async () => {
  const cases: [string, (s: Awaited<ReturnType<typeof setup>>) => void, number | null][] = [
    [
      "wrapper-missing",
      (s) => {
        s.d.head = null as any;
      },
      1,
    ],
    [
      "wrapper-tag",
      (s) => {
        s.d.head.tagName = "DIV";
      },
      1,
    ],
    [
      "wrapper-namespace",
      (s) => {
        s.d.body.namespaceURI = "urn:foreign";
      },
      2,
    ],
    [
      "wrapper-direct-text",
      (s) => {
        s.d.body.value = "OUTSIDE";
      },
      2,
    ],
    [
      "wrapper-parent",
      (s) => {
        s.d.head.parentElement = null;
      },
      null,
    ],
    [
      "wrapper-child-count",
      (s) => {
        s.d.documentElement.append(new E("span"));
      },
      null,
    ],
    [
      "wrapper-child-order",
      (s) => {
        s.d.documentElement.children.reverse();
      },
      null,
    ],
    [
      "head-child",
      (s) => {
        s.d.head.append(new E("style", { id: "__hf-audio-group-inert" }, "hf-audio-group{display:none!important}"));
      },
      1,
    ],
    [
      "wrapper-attribute",
      (s) => {
        s.d.body.values.class = "outside";
      },
      2,
    ],
    [
      "wrapper-style",
      (s) => {
        s.d.body.values.style = "margin:1px";
      },
      2,
    ],
  ];
  for (const [reason, mutate, index] of cases) {
    const s = await setup();
    mutate(s);
    let error: unknown;
    try {
      s.publishRoot();
    } catch (e) {
      error = e;
    }
    const diagnostic = wrapperDiagnostic(error);
    assert.equal(diagnostic.reason, reason);
    assert.equal(diagnostic.wrapperIndex, index);
    assert.equal(diagnostic.phase, "root-publication");
    assert.equal(diagnostic.rootAuthenticated, false);
    assert.equal(diagnostic.rootPublished, false);
    assert.equal(diagnostic.currentScript, "unknown");
    assert.equal(diagnostic.sourceSha256, s.g.rootSha256);
    if (reason === "head-child") {
      assert.equal(diagnostic.wrappers[1].children, 1);
      assert.equal(diagnostic.wrappers[1].firstChildren[0].exactKnownInertStyleText, true);
    }
  }
});
test("error-only diagnostics retain first poisoned snapshot after restored text and later different wrapper fault", async () => {
  const s = await setup();
  await s.ready();
  s.d.body.value = "LATE OUTSIDE";
  let first: unknown;
  try {
    s.cap.treeReady();
  } catch (e) {
    first = e;
  }
  const diagnostic = wrapperDiagnostic(first);
  assert.equal(diagnostic.reason, "wrapper-direct-text");
  assert.equal(diagnostic.phase, "guard:validate");
  assert.equal(diagnostic.rootAuthenticated, true);
  assert.equal(diagnostic.rootPublished, true);
  assert.equal(diagnostic.currentScript, "none");
  s.d.body.value = "";
  s.d.head.append(new E("style"));
  let later: unknown;
  try {
    s.cap.treeReady();
  } catch (e) {
    later = e;
  }
  assert.equal(String(later), String(first));
  assert.equal(s.violations.length, 2);
});
test("error-only wrapper/body/injected-script diagnostics preserve object and script ownership refusals", async () => {
  for (const [reason, mutate] of [
    [
      "wrapper-identity",
      (s: Awaited<ReturnType<typeof setup>>) => {
        const replacement = clone(s.d.body);
        replacement.parentElement = s.d.documentElement;
        s.d.documentElement.children[1] = replacement;
        s.d.body = replacement;
      },
    ],
    [
      "body-shape",
      (s: Awaited<ReturnType<typeof setup>>) => {
        s.d.body.append(new E("span"));
      },
    ],
    [
      "injected-script",
      (s: Awaited<ReturnType<typeof setup>>) => {
        s.d.body.children[1].value += "MUTATED";
      },
    ],
  ] as const) {
    const s = await setup();
    await s.ready();
    mutate(s);
    assert.throws(
      () => s.cap.treeReady(),
      (error) => {
        assert.equal(wrapperDiagnostic(error).reason, reason);
        return true;
      },
    );
  }
  for (const owner of ["injected", "root"] as const) {
    const s = await setup();
    await s.ready();
    s.d.currentScript = owner === "root" ? s.rootScript : s.d.body.children[1];
    s.d.head.append(new E("span"));
    assert.throws(
      () => s.cap.treeReady(),
      (error) => {
        assert.equal(wrapperDiagnostic(error).currentScript, owner);
        return true;
      },
    );
  }
});
test("wrapper diagnostic payload is bounded to three wrappers/two children and finite strings, with no HEAD allowance", async () => {
  const s = await setup();
  await s.ready();
  for (let i = 0; i < 20; i++) s.d.head.append(new E("style", { id: "x".repeat(10000) }, "y".repeat(10000)));
  assert.throws(
    () => s.cap.treeReady(),
    (error) => {
      const diagnostic = wrapperDiagnostic(error);
      assert.equal(diagnostic.reason, "inert-style-shape");
      assert.equal(diagnostic.wrappers.length, 3);
      assert.equal(diagnostic.wrappers[1].children, 21);
      assert.equal(diagnostic.wrappers[1].firstChildren.length, 2);
      assert.equal(
        diagnostic.wrappers.reduce((n: number, w: any) => n + w.firstChildren.length, 0),
        2,
      );
      for (const wrapper of diagnostic.wrappers)
        for (const node of [wrapper, ...wrapper.firstChildren]) {
          assert.ok((node.tag ?? "").length <= 24);
          assert.ok((node.id ?? "").length <= 64);
          assert.ok((node.textLiteral ?? "").length <= 120);
        }
      assert.equal(diagnostic.wrappers[1].firstChildren[1].textLength, 10000);
      assert.ok(String(error).length < 16000);
      return true;
    },
  );
});

/** Explicit finite CSSOM fake: no HTML/CSS parser or browser evidence. */
function fakeInertStyle() {
  return Object.assign(new E("style", { id: "__hf-audio-group-inert" }, "hf-audio-group{display:none!important}"), {
    sheet: null as any,
  });
}
function attachFakeSheet(element: ReturnType<typeof fakeInertStyle>) {
  const declaration = {
    length: 1,
    item: (_index: number) => "display",
    getPropertyValue: (_key: string) => "none",
    getPropertyPriority: (_key: string) => "important",
  };
  const sheet: any = { ownerNode: element, href: null, disabled: false, cssRules: [] };
  sheet.cssRules = [{ type: 1, parentStyleSheet: sheet, selectorText: "hf-audio-group", style: declaration }];
  element.sheet = sheet;
  return sheet;
}
test("C22 private detached stylesheet registration preserves exact wrapper and fake CSSOM at readiness", async () => {
  const s = await setup();
  await s.ready(true);
  s.cap.treeReady();
  assert.equal(s.violations.length, 0);
  assert.equal(s.d.head.children.length, 1);
  const generated = fullPlayerPrelude("", "", {}, 8, 64, 64, {}, undefined, s.g),
    capText = generated.slice(
      generated.indexOf(" const cap={"),
      generated.indexOf("window.__HF_EXPORT_RENDER_SEEK_CONFIG"),
    );
  assert.ok(
    capText.includes("instanceRegisterInertStyle"),
    "exact observed C22 runtime receives private hook only for instances",
  );
});
test("C22 source registration denies wrong lifecycle, connected/counterfeit/replayed Elements and permanently latches", async () => {
  for (const mode of [
    "before-root",
    "after-mount",
    "connected",
    "wrong-id",
    "extra-attr",
    "wrong-tag",
    "wrong-namespace",
    "wrong-text",
    "child",
    "current-script",
    "replayed",
  ]) {
    const s = await setup(),
      style = fakeInertStyle();
    if (mode !== "before-root") s.publishRoot();
    if (mode === "after-mount") {
      s.installStyle();
      s.cap.treeGuard("before-mount", [s.a, s.b] as unknown as Element[]);
    }
    if (mode === "connected") s.d.head.append(style);
    if (mode === "wrong-id") style.values.id = "fake";
    if (mode === "extra-attr") style.values.class = "fake";
    if (mode === "wrong-tag") style.tagName = "DIV";
    if (mode === "wrong-namespace") style.namespaceURI = "urn:foreign";
    if (mode === "wrong-text") style.value += " changed";
    if (mode === "child") style.append(new E("span"));
    if (mode === "current-script") s.d.currentScript = s.rootScript;
    if (mode === "replayed") s.cap.instanceRegisterInertStyle(style as unknown as Element);
    assert.throws(() => s.cap.instanceRegisterInertStyle(style as unknown as Element), /controller/);
    style.value = "hf-audio-group{display:none!important}";
    assert.throws(() => s.cap.treeReady(), /controller/);
  }
});
test("C22 fake DOM stylesheet duplicates/removal/replacement/tag/namespace/id/text/attrs/children remain exact and poisoned", async () => {
  for (const mutate of [
    (s: any) => {
      s.d.head.append(fakeInertStyle());
    },
    (s: any) => {
      s.d.head.children = [];
    },
    (s: any) => {
      const replacement = fakeInertStyle();
      replacement.parentElement = s.d.head;
      attachFakeSheet(replacement);
      s.d.head.children = [replacement];
    },
    (s: any) => {
      s.d.head.children[0].tagName = "DIV";
    },
    (s: any) => {
      s.d.head.children[0].namespaceURI = "urn:foreign";
    },
    (s: any) => {
      s.d.head.children[0].values.id = "fake";
    },
    (s: any) => {
      s.d.head.children[0].value += " changed";
    },
    (s: any) => {
      s.d.head.children[0].values.media = "all";
    },
    (s: any) => {
      s.d.head.children[0].append(new E("span"));
    },
  ]) {
    const s = await setup();
    await s.ready(true);
    mutate(s);
    assert.throws(
      () => s.cap.treeReady(),
      (error) => {
        assert.equal(wrapperDiagnostic(error).reason, "inert-style-shape");
        return true;
      },
    );
    assert.throws(() => s.cap.treeReady(), /controller/);
  }
});
test("C22 explicit fake CSSOM rejects owner/sheet/rule/declaration mutations and inaccessible CSSOM, retaining first refusal", async () => {
  for (const mutate of [
    (style: any) => {
      style.sheet = null;
    },
    (style: any) => {
      style.sheet.ownerNode = fakeInertStyle();
    },
    (style: any) => {
      style.sheet.href = "https://external.invalid/sheet";
    },
    (style: any) => {
      style.sheet.disabled = true;
    },
    (style: any) => {
      style.sheet = { ...style.sheet };
    },
    (style: any) => {
      style.sheet.cssRules.push({ ...style.sheet.cssRules[0] });
    },
    (style: any) => {
      style.sheet.cssRules = [];
    },
    (style: any) => {
      style.sheet.cssRules[0].type = 4;
    },
    (style: any) => {
      style.sheet.cssRules[0].parentStyleSheet = {};
    },
    (style: any) => {
      style.sheet.cssRules[0].selectorText = "body";
    },
    (style: any) => {
      style.sheet.cssRules[0].style.length = 2;
    },
    (style: any) => {
      style.sheet.cssRules[0].style.item = () => "visibility";
    },
    (style: any) => {
      style.sheet.cssRules[0].style.getPropertyValue = () => "block";
    },
    (style: any) => {
      style.sheet.cssRules[0].style.getPropertyPriority = () => "";
    },
    (style: any) => {
      Object.defineProperty(style.sheet, "cssRules", {
        get() {
          throw Error("inaccessible");
        },
      });
    },
  ]) {
    const s = await setup();
    await s.ready(true);
    mutate(s.d.head.children[0]);
    let error: unknown;
    try {
      s.cap.treeReady();
    } catch (e) {
      error = e;
    }
    assert.equal(wrapperDiagnostic(error).reason, "inert-style-sheet");
    assert.equal(s.violations.length, 1);
    assert.throws(
      () => s.cap.treeReady(),
      (later) => {
        assert.equal(String(later), String(error));
        return true;
      },
    );
  }
});
test("C22 SOURCE registration keeps outside-root text/HEAD identities and old unregistered STYLE refusal intact", async () => {
  for (const key of ["documentElement", "head", "body"] as const) {
    const s = await setup();
    await s.ready(true);
    s.d[key].value = "OUTSIDE";
    assert.throws(
      () => s.cap.treeReady(),
      (error) => {
        assert.equal(wrapperDiagnostic(error).reason, "wrapper-direct-text");
        return true;
      },
    );
    s.d[key].value = "";
    assert.throws(() => s.cap.treeReady(), /controller/);
  }
  const replaced = await setup();
  await replaced.ready(true);
  const oldHead = replaced.d.head,
    replacement = clone(oldHead);
  replacement.parentElement = replaced.d.documentElement;
  replaced.d.documentElement.children[0] = replacement;
  replaced.d.head = replacement;
  assert.throws(() => replaced.cap.treeReady(), /wrapper identity/);
  const old = await setup();
  old.publishRoot();
  old.d.head.append(fakeInertStyle());
  assert.throws(
    () => old.cap.treeGuard("before-mount", []),
    (error) => {
      assert.equal(wrapperDiagnostic(error).reason, "head-child");
      return true;
    },
  );
});

test("C22 mandatory private stylesheet refuses first handoff and every controlled loader/media phase without no-style fallback", async () => {
  for (const phase of ["before-mount", "mounted", "scripts-complete", "validate"]) {
    const s = await setup();
    s.publishRoot();
    assert.equal(s.d.head.children.length, 0);
    assert.throws(
      () => s.cap.treeGuard(phase, [s.a, s.b] as unknown as Element[]),
      (error) => {
        assert.equal(wrapperDiagnostic(error).reason, "missing-inert-style");
        assert.equal(wrapperDiagnostic(error).phase, "guard:" + phase);
        return true;
      },
    );
    assert.equal(s.a.children.length, 0);
    assert.equal(s.b.children.length, 0);
    await assert.rejects(s.cap.instanceFetch(s.a as unknown as Element, "leaf.html"), /private inert style required/);
  }
  for (const action of [
    (s: any) => s.cap.treeNormalize("before", [s.a]),
    (s: any) => s.cap.instanceArmScript(s.a, new E("script")),
    (s: any) => s.cap.instancePrepareMedia(() => assert.fail("assigner must not run")),
    (s: any) => s.cap.instanceClipId(s.a),
    (s: any) => s.cap.treeMediaGuard(s.a, 0, 1),
    (s: any) => s.cap.instanceRegisterFrame(s.a, new E("img")),
  ]) {
    const s = await setup();
    s.publishRoot();
    assert.throws(
      () => action(s),
      (error) => {
        assert.equal(wrapperDiagnostic(error).reason, "missing-inert-style");
        return true;
      },
    );
  }
});
test("C22 descriptor phase revalidates exact registered STYLE/CSSOM after successful ready", async () => {
  const s = await setup();
  await s.ready();
  const video = s.a.children[0].children[1];
  (s.d.head.children[0] as any).sheet.disabled = true;
  assert.throws(
    () => s.cap.treeMediaGuard(video as unknown as Element, 0, 1),
    (error) => {
      const diagnostic = wrapperDiagnostic(error);
      assert.equal(diagnostic.reason, "inert-style-sheet");
      assert.equal(diagnostic.phase, "media-guard");
      return true;
    },
  );
  (s.d.head.children[0] as any).sheet.disabled = false;
  assert.throws(() => s.cap.treeReady(), /inert stylesheet/);
});
test("generated full prelude consumes exact private C22 closure in VM trusted fake stand-in; no real engine/author code", async () => {
  const g = await graph(),
    d = source(true),
    w: any = { __avcGuard: { violations: [] } };
  const gsap = `window.gsap={ticker:{add(){},sleep(){}},core:{Timeline:class{constructor(elements){this.elements=elements;}duration(){return 2;}totalTime(){}getChildren(){return [{targets:()=>this.elements}];}}}};`;
  const trusted = `const privateClock=window.__avcPrivateEngineClock;delete window.__avcPrivateEngineClock;window.testCap=privateClock;document.currentScript=document.body.children[0].children[3];window.__timelines.root=new window.gsap.core.Timeline([document.body.children[0].children[2]]);document.currentScript=null;const style=testMakeStyle();privateClock.instanceRegisterInertStyle(style);document.head.append(style);testAttachSheet(style);document.documentElement.values.style='margin:0;padding:0;overflow:hidden';document.body.values.style='margin:0;padding:0;overflow:hidden';const authenticatedRoot=document.body.children[0];authenticatedRoot.values.style='position:relative;overflow:hidden;width:'+authenticatedRoot.getAttribute('data-width')+'px;height:'+authenticatedRoot.getAttribute('data-height')+'px';privateClock.treeGuard('before-mount',[document.body.children[0].children[0],document.body.children[0].children[1]]);`;
  vm.runInNewContext(fullPlayerPrelude(trusted, gsap, {}, 8, 64, 64, undefined, undefined, g), {
    window: w,
    document: d,
    URL,
    TextEncoder,
    Response,
    location: { href: "https://avc.invalid/index.html" },
    testMakeStyle: fakeInertStyle,
    testAttachSheet: attachFakeSheet,
  });
  assert.equal(w.testCap.instanceMode, true);
  assert.equal(typeof w.testCap.instanceRegisterInertStyle, "function");
  assert.equal(typeof w.testCap.instanceSourceRootId, "function");
  assert.equal(w.instanceSourceRootId, undefined);
  assert.equal(Object.hasOwn(w, "__avcPrivateEngineClock"), false);
  assert.equal(w.instanceRegisterInertStyle, undefined);
  assert.equal(d.head.children.length, 1);
  assert.equal(w.__avcGuard.violations.length, 0);
  assert.equal(d.body.children[0].style.getPropertyValue("overflow-x"), "hidden");
  assert.equal(d.body.children[0].style.getPropertyValue("overflow-y"), "hidden");
  assert.equal(d.body.children[0].style.getPropertyValue("width"), "64px");
  for (const native of [false, true]) {
    const legacy: any = { __avcGuard: { violations: [] } };
    vm.runInNewContext(
      fullPlayerPrelude(
        "window.testCap=window.__avcPrivateEngineClock;delete window.__avcPrivateEngineClock;",
        gsap,
        {},
        8,
        64,
        64,
        native ? {} : undefined,
      ),
      {
        window: legacy,
        document: new D(),
        HTMLMediaElement: class {},
        URL,
        TextEncoder,
        Response,
        location: { href: "https://avc.invalid/index.html" },
      },
    );
    assert.equal(legacy.testCap.instanceRegisterInertStyle, undefined);
    assert.equal(legacy.testCap.instanceSourceRootId, undefined);
    assert.equal(legacy.testCap.instanceMode, undefined);
  }
  // Tree cap uses its own existing closure; inspect generated cap without running a tree engine.
  const treeOnly = fullPlayerPrelude("", gsap, {}, 8, 64, 64, {}, { nodes: [] } as any);
  const cap = treeOnly.slice(
    treeOnly.indexOf(" const cap={"),
    treeOnly.indexOf("window.__HF_EXPORT_RENDER_SEEK_CONFIG"),
  );
  assert.ok(!cap.includes("instanceRegisterInertStyle"));
  assert.ok(!cap.includes("instanceMode"));
});

test("C22 every controlled loader phase rechecks duplicate/replaced/disabled/wrong-rule/owner sheet with valid lifecycle prerequisite", async () => {
  for (const phase of ["before-mount", "mounted", "scripts-complete", "validate"])
    for (const mutate of [
      (s: any) => s.d.head.append(fakeInertStyle()),
      (s: any) => {
        const replacement = fakeInertStyle();
        replacement.parentElement = s.d.head;
        attachFakeSheet(replacement);
        s.d.head.children = [replacement];
      },
      (s: any) => {
        s.d.head.children[0].sheet.disabled = true;
      },
      (s: any) => {
        s.d.head.children[0].sheet.cssRules[0].selectorText = "body";
      },
      (s: any) => {
        s.d.head.children[0].sheet.ownerNode = fakeInertStyle();
      },
    ]) {
      const s = await setup();
      await s.ready();
      mutate(s);
      assert.throws(
        () => s.cap.treeGuard(phase, []),
        (error) => {
          const diagnostic = wrapperDiagnostic(error);
          assert.match(diagnostic.reason, /^inert-style-(shape|sheet)$/);
          assert.equal(diagnostic.phase, "guard:" + phase);
          return true;
        },
      );
      assert.throws(() => s.cap.treeReady(), /wrapper inert/);
    }
  const missing = await setup();
  missing.publishRoot();
  await assert.rejects(missing.cap.instanceFetch(missing.a as unknown as Element, "leaf.html"), (error) => {
    assert.equal(wrapperDiagnostic(error).reason, "missing-inert-style");
    assert.equal(wrapperDiagnostic(error).phase, "instance-fetch");
    return true;
  });
});

const observedWrapperRows = [
  ["margin-top", "0px"],
  ["margin-right", "0px"],
  ["margin-bottom", "0px"],
  ["margin-left", "0px"],
  ["padding-top", "0px"],
  ["padding-right", "0px"],
  ["padding-bottom", "0px"],
  ["padding-left", "0px"],
  ["overflow-x", "hidden"],
  ["overflow-y", "hidden"],
] as const;
test("controlled a651 probe golden10 CSSOM rows pass only HTML/BODY with exact dimensions and empty priorities", async () => {
  const s = await setup();
  await s.ready();
  for (const key of ["documentElement", "body"] as const) {
    s.d[key].values.style = "margin:0;padding:0;overflow:hidden";
    assert.deepEqual(
      [...s.d[key].style].map((name) => [
        name,
        s.d[key].style.getPropertyValue(name),
        s.d[key].style.getPropertyPriority(name),
      ]),
      observedWrapperRows.map(([name, value]) => [name, value, ""]),
    );
    s.cap.treeReady();
    s.d[key].values.style += ";width:64px;height:64px";
    s.cap.treeReady();
  }
  const head = await setup();
  await head.ready();
  head.d.head.values.style = "margin-top:0px";
  assert.throws(() => head.cap.treeReady(), /wrapper attribute/);
  for (const key of ["documentElement", "body"] as const) {
    const initial = source(true);
    initial[key].values.style = "margin-top:0px";
    assert.throws(() => extract(initial), /wrapper/);
  }
});
test("all10 physical equivalents reject each wrongvalue/priority on both wrappers with exact first consumed diagnostic and latch", async () => {
  for (const wrapper of ["documentElement", "body"] as const)
    for (const [key, value] of observedWrapperRows)
      for (const kind of ["value", "priority"]) {
        const s = await setup();
        await s.ready();
        const bad = kind === "value" ? (value === "0px" ? "1px" : "visible") : value;
        s.d[wrapper].values.style = key + ":" + bad + (kind === "priority" ? " !important" : "");
        let first: unknown;
        try {
          s.cap.treeReady();
        } catch (e) {
          first = e;
        }
        const diagnostic = wrapperDiagnostic(first);
        assert.equal(diagnostic.reason, "wrapper-style");
        assert.equal(diagnostic.wrapperIndex, wrapper === "documentElement" ? 0 : 2);
        assert.deepEqual(diagnostic.styleDeclaration, {
          key,
          value: bad,
          priority: kind === "priority" ? "important" : "",
        });
        s.d[wrapper].values.style = key + ":" + value;
        let restored: unknown;
        try {
          s.cap.treeReady();
        } catch (e) {
          restored = e;
        }
        assert.equal(String(restored), String(first));
      }
  for (const style of [
    "margin-inline-start:0px",
    "padding-block-start:0px",
    "overflow-inline:hidden",
    "zoom:1",
    "margin-top:-1px",
    "padding-left:10%",
    "padding-right:1em",
    "padding-bottom:calc(0px)",
    "margin-top:url(local)",
    "width:65px",
    "height:63px",
    "background-color:#000000",
    "transform:scale(1)",
  ]) {
    const s = await setup();
    await s.ready();
    s.d.body.values.style = style;
    assert.throws(
      () => s.cap.treeReady(),
      (error) => {
        assert.equal(wrapperDiagnostic(error).reason, "wrapper-style");
        return true;
      },
    );
  }
});
test("first offending key/value/priority diagnostic is consumed once, bounded and retained without style rereads", async () => {
  const s = await setup();
  await s.ready();
  const key = "x".repeat(1000),
    value = "v".repeat(1000),
    priority = "p".repeat(1000);
  let valueReads = 0,
    priorityReads = 0;
  Object.defineProperty(s.d.body, "style", {
    get: () => ({
      *[Symbol.iterator]() {
        yield key;
      },
      getPropertyValue() {
        valueReads++;
        return value;
      },
      getPropertyPriority() {
        priorityReads++;
        return priority;
      },
    }),
  });
  let error: unknown;
  try {
    s.cap.treeReady();
  } catch (e) {
    error = e;
  }
  const diagnostic = wrapperDiagnostic(error);
  assert.deepEqual(diagnostic.styleDeclaration, {
    key: key.slice(0, 32),
    value: value.slice(0, 80),
    priority: priority.slice(0, 16),
  });
  assert.equal(valueReads, 1);
  assert.equal(priorityReads, 1);
  assert.throws(
    () => s.cap.treeReady(),
    (later) => {
      assert.equal(String(later), String(error));
      return true;
    },
  );
  assert.equal(valueReads, 1);
  assert.equal(priorityReads, 1);
});

function elementStyleDiagnostic(error: unknown) {
  const message = String(error),
    marker = "elementStyleDiagnostic=";
  assert.ok(message.includes(marker), message);
  return JSON.parse(message.slice(message.indexOf(marker) + marker.length));
}
test("only authenticated composition root accepts source applyClipLayout physical overflow semantics including immutable initial root values", async () => {
  for (const initiallyDeclared of [false, true]) {
    const s = await setup(initiallyDeclared);
    await s.ready();
    s.root.values.style = "position:relative;overflow:hidden;width:64px;height:64px";
    assert.equal(s.root.style.getPropertyValue("overflow-x"), "hidden");
    assert.equal(s.root.style.getPropertyValue("overflow-y"), "hidden");
    s.cap.treeReady();
    assert.equal(s.violations.length, 0);
  }
});
test("both root overflow axes reject values and priorities before initial-equality shortcut with exact owned-node latched context", async () => {
  for (const initiallyDeclared of [false, true])
    for (const key of ["overflow-x", "overflow-y"])
      for (const [value, priority] of [
        ["visible", ""],
        ["auto", ""],
        ["scroll", ""],
        ["clip", ""],
        ["hidden", "important"],
      ]) {
        const s = await setup(initiallyDeclared);
        await s.ready();
        s.root.values.style = "overflow:hidden;" + key + ":" + value + (priority ? " !important" : "");
        let first: unknown;
        try {
          s.cap.treeReady();
        } catch (e) {
          first = e;
        }
        const diagnostic = elementStyleDiagnostic(first);
        assert.equal(diagnostic.reason, "root-overflow");
        assert.equal(diagnostic.rootObject, true);
        assert.equal(diagnostic.actualId, "root");
        assert.equal(diagnostic.owner, "root");
        assert.equal(diagnostic.privateId, "root");
        assert.equal(diagnostic.sourceSha256, s.g.rootSha256);
        assert.deepEqual(diagnostic.styleDeclaration, { key, value, priority });
        s.root.values.style = "overflow:hidden";
        assert.throws(
          () => s.cap.treeReady(),
          (later) => {
            assert.equal(String(later), String(first));
            return true;
          },
        );
      }
});
test("new overflow on host/leaf/media/animated target remains forbidden despite matching root semantics", async () => {
  for (const which of ["host", "leaf", "media", "target"])
    for (const key of ["overflow-x", "overflow-y"]) {
      const s = await setup();
      await s.ready();
      const element =
        which === "host"
          ? s.a
          : which === "leaf"
            ? s.a.children[0]
            : which === "media"
              ? s.a.children[0].children[1]
              : s.a.children[0].children[0];
      element.values.style = (element.values.style ?? "") + ";" + key + ":hidden";
      assert.throws(
        () => s.cap.treeReady(),
        (error) => {
          const diagnostic = elementStyleDiagnostic(error);
          assert.equal(diagnostic.reason, "new-property");
          assert.equal(diagnostic.rootObject, false);
          assert.equal(diagnostic.actualId, element.id);
          assert.deepEqual(diagnostic.styleDeclaration, { key, value: "hidden", priority: "" });
          return true;
        },
      );
    }
});
test("root layout/sizing/network/unknown style diagnostics retain source guards and exact consumed ownership", async () => {
  for (const [style, reason, key] of [
    ["overflow-inline:hidden", "new-property", "overflow-inline"],
    ["position:absolute", "root-layout", "position"],
    ["width:65px", "root-sizing", "width"],
    ["height:63px", "root-sizing", "height"],
  ]) {
    const s = await setup();
    await s.ready();
    s.root.values.style = style;
    assert.throws(
      () => s.cap.treeReady(),
      (error) => {
        const diagnostic = elementStyleDiagnostic(error);
        assert.equal(diagnostic.reason, reason);
        assert.equal(diagnostic.rootObject, true);
        assert.equal(diagnostic.styleDeclaration.key, key);
        return true;
      },
    );
  }
  const network = await setup();
  await network.ready();
  network.a.children[0].children[0].values.style += ";color:url(https://external.invalid)";
  assert.throws(
    () => network.cap.treeReady(),
    (error) => {
      assert.equal(elementStyleDiagnostic(error).reason, "network");
      return true;
    },
  );
});
test("non-wrapper diagnostic bounds consumed maps and never rereads getters after first latch", async () => {
  const s = await setup();
  await s.ready();
  const target = s.a.children[0].children[0],
    key = "k".repeat(1000),
    value = "v".repeat(1000),
    priority = "p".repeat(1000);
  let styleReads = 0,
    valueReads = 0,
    priorityReads = 0;
  Object.defineProperty(target, "style", {
    get() {
      styleReads++;
      return {
        *[Symbol.iterator]() {
          yield "opacity";
          yield key;
        },
        getPropertyValue(name: string) {
          valueReads++;
          return name === "opacity" ? "0" : value;
        },
        getPropertyPriority(name: string) {
          priorityReads++;
          return name === "opacity" ? "" : priority;
        },
      };
    },
  });
  let error: unknown;
  try {
    s.cap.treeReady();
  } catch (e) {
    error = e;
  }
  const diagnostic = elementStyleDiagnostic(error);
  assert.deepEqual(diagnostic.styleDeclaration, {
    key: key.slice(0, 32),
    value: value.slice(0, 80),
    priority: priority.slice(0, 16),
  });
  assert.equal(diagnostic.owner, "a");
  assert.equal(diagnostic.rootObject, false);
  assert.equal(styleReads, 1);
  assert.equal(valueReads, 2);
  assert.equal(priorityReads, 2);
  assert.throws(
    () => s.cap.treeReady(),
    (later) => {
      assert.equal(String(later), String(error));
      return true;
    },
  );
  assert.equal(styleReads, 1);
  assert.equal(valueReads, 2);
  assert.equal(priorityReads, 2);
});

test("unchanged predeclared non-root overflow remains compatible and changed axis remains immutable with owned diagnostic", async () => {
  const s = await setup(false, true);
  await s.ready();
  const box = s.a.children[0].children[0];
  assert.equal(box.style.getPropertyValue("overflow-x"), "hidden");
  assert.equal(box.style.getPropertyValue("overflow-y"), "hidden");
  s.cap.treeReady();
  assert.equal(s.violations.length, 0);
  box.values.style += ";overflow-x:visible";
  assert.throws(
    () => s.cap.treeReady(),
    (error) => {
      const diagnostic = elementStyleDiagnostic(error);
      assert.equal(diagnostic.reason, "immutable-value");
      assert.equal(diagnostic.rootObject, false);
      assert.equal(diagnostic.owner, "a");
      assert.deepEqual(diagnostic.styleDeclaration, { key: "overflow-x", value: "visible", priority: "" });
      return true;
    },
  );
});

test("prepared C23 scalar source selection authenticates host/source/loaded state once; originals and host namespace stay distinct", async () => {
  const s = await setup();
  s.publishRoot();
  s.installStyle();
  s.cap.treeGuard("before-mount", [s.a, s.b] as unknown as Element[]);
  await s.cap.instanceFetch(s.a as unknown as Element, "leaf.html");
  await s.cap.instanceFetch(s.b as unknown as Element, "leaf.html");
  assert.equal(s.cap.instanceSourceRootId(s.a as unknown as Element, "leaf.html"), "leaf");
  assert.equal(s.cap.instanceSourceRootId(s.b as unknown as Element, "leaf.html"), "leaf");
  assert.equal(s.a.id, "a");
  assert.equal(s.b.id, "b");
  assert.equal(s.g.documents["leaf.html"].root.attributes.id, "leaf");
  assert.throws(() => s.cap.instanceSourceRootId(s.a as unknown as Element, "leaf.html"), /selection ownership/);
  assert.equal(s.a.children.length, 0);
  assert.equal(s.b.children.length, 0);
  assert.throws(() => s.cap.treeReady(), /selection ownership/);
});
test("prepared C23 source selection refuses forged/unloaded/changed hosts and source identity before mount/publication", async () => {
  for (const attack of [
    (s: any) => s.cap.instanceSourceRootId(clone(s.a), "leaf.html"),
    (s: any) => s.cap.instanceSourceRootId(s.a, "wrong.html"),
    (s: any) => s.cap.instanceSourceRootId(s.a, new String("leaf.html")),
    (s: any) => {
      s.a.values["data-composition-src"] = "wrong.html";
      s.cap.instanceSourceRootId(s.a, "leaf.html");
    },
    (s: any) => {
      s.a.append(new E("div"));
      s.cap.instanceSourceRootId(s.a, "leaf.html");
    },
    (s: any) => {
      s.g.documents["leaf.html"].root.attributes.id = "forged";
      s.cap.instanceSourceRootId(s.a, "leaf.html");
    },
    (s: any) => {
      s.g.documents["leaf.html"].record.authoredId = "forged";
      s.cap.instanceSourceRootId(s.a, "leaf.html");
    },
  ]) {
    const s = await setup();
    s.publishRoot();
    s.installStyle();
    s.cap.treeGuard("before-mount", [s.a] as unknown as Element[]);
    await s.cap.instanceFetch(s.a as unknown as Element, "leaf.html");
    assert.throws(() => attack(s), /selection ownership|host ownership|host metadata/);
    assert.equal(s.w.__timelines.a, undefined);
    assert.equal(s.d.body.children.length, 1);
    assert.throws(() => s.cap.treeReady());
  }
  const notLoaded = await setup();
  notLoaded.publishRoot();
  notLoaded.installStyle();
  assert.throws(
    () => notLoaded.cap.instanceSourceRootId(notLoaded.a as unknown as Element, "leaf.html"),
    /selection ownership/,
  );
  const missing = await setup();
  missing.publishRoot();
  assert.throws(
    () => missing.cap.instanceSourceRootId(missing.a as unknown as Element, "leaf.html"),
    /private inert style/,
  );
});
test("faithful flattened leaf retains original position; missing sizing, priority, private timing or parent mutations still latch refusal", async () => {
  for (const change of [
    (s: any) => {
      s.a.children[0].values.style = "position:relative";
    },
    (s: any) => {
      s.a.children[0].values.style += ";width:99%";
    },
    (s: any) => {
      s.a.children[0].values.style += ";height:100% !important";
    },
    (s: any) => {
      delete s.a.children[0].values["data-hf-inner-root"];
    },
    (s: any) => {
      s.a.children[0].values["data-start"] = "0";
    },
    (s: any) => {
      s.a.children[0].parentElement = s.b;
    },
  ]) {
    const s = await setup();
    await s.ready();
    const leaf = s.a.children[0];
    assert.equal(leaf.style.getPropertyValue("position"), "relative");
    assert.equal(leaf.style.getPropertyValue("width"), "100%");
    assert.equal(leaf.getAttribute("id"), null);
    assert.equal(leaf.getAttribute("data-composition-id"), null);
    change(s);
    assert.throws(() => s.cap.treeReady(), /sizing|immutable attribute|unsupported attribute|ownership/);
    assert.throws(() => s.cap.treeReady());
  }
});

test("forged mounted private/source timing attrs refuse at mounted phase before leaf script authority/publication", async () => {
  for (const change of [
    (leaf: E) => {
      leaf.values["data-hf-authored-id"] = "forged";
    },
    (leaf: E) => {
      leaf.values["data-composition-id"] = "leaf";
    },
    (leaf: E) => {
      leaf.values["data-start"] = "0";
    },
    (leaf: E) => {
      leaf.values["data-duration"] = "2";
    },
  ]) {
    const s = await setup();
    s.publishRoot();
    s.installStyle();
    s.cap.treeGuard("before-mount", [s.a, s.b] as unknown as Element[]);
    await s.cap.instanceFetch(s.a as unknown as Element, "leaf.html");
    const leaf = s.mount(s.a);
    await s.cap.instanceFetch(s.b as unknown as Element, "leaf.html");
    s.mount(s.b);
    change(leaf);
    assert.throws(
      () => s.cap.treeGuard("mounted", [s.a, s.b] as unknown as Element[]),
      /immutable attribute|unsupported attribute/,
    );
    assert.equal(s.w.__timelines.a, undefined);
    assert.equal(s.w.__timelines.b, undefined);
    assert.equal(s.d.body.children.length, 1);
    assert.equal(Object.hasOwn(s.w, "__avcPrivateInstanceAcquire"), false);
  }
});

function mountedDiagnostic(error: unknown) {
  const match = String(error).match(/mountedHostDiagnostic=(\{.*\})/);
  assert.ok(match, String(error));
  return JSON.parse(match[1]);
}
test("mounted error snapshots preserve exact loaded/count predicate, phases and first latch (synthetic only)", async () => {
  for (const caller of ["prepare-media", "mounted", "scripts-complete", "validate"])
    for (const count of [0, 2]) {
      const s = await setup();
      s.publishRoot();
      s.installStyle();
      s.cap.treeGuard("before-mount", [s.a, s.b] as unknown as Element[]);
      await s.cap.instanceFetch(s.a as unknown as Element, "leaf.html");
      await s.cap.instanceFetch(s.b as unknown as Element, "leaf.html");
      if (count === 2) {
        s.a.append(new E("div", { id: "first", "data-hf-authored-id": "leaf", "data-hf-inner-root": "true" }));
        s.a.append(new E("span", { id: "second" }));
      }
      let first: unknown;
      try {
        if (caller === "prepare-media") s.prepare();
        else s.cap.treeGuard(caller, []);
      } catch (e) {
        first = e;
      }
      const diagnostic = mountedDiagnostic(first);
      assert.deepEqual(
        {
          reason: diagnostic.reason,
          phase: diagnostic.phase,
          caller: diagnostic.caller,
          hostId: diagnostic.hostId,
          sourceSha256: diagnostic.sourceSha256,
          loaded: diagnostic.loaded,
          pending: diagnostic.pending,
          selected: diagnostic.selected,
          connected: diagnostic.connected,
          rootParent: diagnostic.rootParent,
          childCount: diagnostic.childCount,
        },
        {
          reason: "child-count",
          phase: caller === "prepare-media" ? "prepare-media" : "guard:" + caller,
          caller: caller === "prepare-media" ? "instancePrepareMedia" : "treeGuard",
          hostId: "a",
          sourceSha256: s.g.instances[0].sourceSha256,
          loaded: true,
          pending: false,
          selected: false,
          connected: true,
          rootParent: true,
          childCount: count,
        },
      );
      assert.equal(diagnostic.firstChildren.length, Math.min(count, 2));
      s.a.children = [];
      s.b.children = [];
      for (const action of [() => s.cap.treeReady(), () => s.prepare(), () => s.cap.treeGuard("mounted", [])])
        assert.throws(action, (e) => String(e) === String(first));
    }
});
test("unloaded/pending versus loaded/selected snapshots do not grant mount authority (synthetic only)", async () => {
  for (const pending of [false, true]) {
    const s = await setup();
    s.publishRoot();
    s.installStyle();
    if (pending) s.cap.treeGuard("before-mount", [s.a, s.b] as unknown as Element[]);
    assert.throws(
      () => s.prepare(),
      (e) => {
        const d = mountedDiagnostic(e);
        assert.equal(d.reason, "not-loaded");
        assert.equal(d.loaded, false);
        assert.equal(d.pending, pending);
        assert.equal(d.selected, false);
        assert.equal(d.childCount, 0);
        return true;
      },
    );
  }
  const s = await setup();
  s.publishRoot();
  s.installStyle();
  s.cap.treeGuard("before-mount", [s.a, s.b] as unknown as Element[]);
  await s.cap.instanceFetch(s.a as unknown as Element, "leaf.html");
  s.mount(s.a);
  await s.cap.instanceFetch(s.b as unknown as Element, "leaf.html");
  s.cap.instanceSourceRootId(s.b as unknown as Element, "leaf.html");
  assert.throws(
    () => s.prepare(),
    (e) => {
      const d = mountedDiagnostic(e);
      assert.equal(d.hostId, "b");
      assert.equal(d.sourceSha256, s.g.instances[1].sourceSha256);
      assert.equal(d.loaded, true);
      assert.equal(d.selected, true);
      assert.equal(d.childCount, 0);
      return true;
    },
  );
});
test("mounted snapshots bound hostile child fields and exclude text/html/source URLs; earlier inert guard wins", async () => {
  const s = await setup();
  s.publishRoot();
  s.installStyle();
  s.cap.treeGuard("before-mount", [s.a, s.b] as unknown as Element[]);
  await s.cap.instanceFetch(s.a as unknown as Element, "leaf.html");
  await s.cap.instanceFetch(s.b as unknown as Element, "leaf.html");
  for (let i = 0; i < 4; i++) {
    const child = new E(
      "x".repeat(100),
      { id: "x".repeat(500), "data-hf-authored-id": "y".repeat(500) },
      "SECRET TEXT MUST NOT APPEAR",
    );
    child.namespaceURI = "z".repeat(500);
    s.a.append(child);
  }
  assert.throws(
    () => s.prepare(),
    (e) => {
      const d = mountedDiagnostic(e);
      assert.equal(d.childCount, 4);
      assert.equal(d.firstChildren.length, 2);
      for (const c of d.firstChildren) {
        assert.equal(c.tag.length, 24);
        assert.equal(c.id.length, 64);
        assert.equal(c.authoredId.length, 64);
        assert.equal(c.namespace.length, 64);
        assert.equal(c.retainedKnown, false);
        assert.equal(c.owner, "");
      }
      assert.ok(!String(e).includes("SECRET TEXT"));
      assert.ok(!String(e).includes("leaf.html"));
      assert.ok(String(e).length < 1600);
      return true;
    },
  );
  const missing = await setup();
  missing.publishRoot();
  assert.throws(
    () => missing.prepare(),
    (e) => {
      assert.equal(wrapperDiagnostic(e).reason, "missing-inert-style");
      assert.ok(!String(e).includes("mountedHostDiagnostic"));
      return true;
    },
  );
});

async function serializedMountedFixture(mode: "success" | "empty" | "two") {
  const inertSource = (root: boolean) => {
    const d = source(root);
    if (!root)
      d.body.children[0].children = d.body.children[0].children.filter((e) => !["AUDIO", "VIDEO"].includes(e.tagName));
    return d;
  };
  const g = await preflightCompositionInstances(
    "VM ROOT",
    { "leaf.html": "VM LEAF" },
    ["leaf.html"],
    async (html, name) =>
      extractInstanceDocument(inertSource(html === "VM ROOT") as unknown as Document, name, ["leaf.html"]),
  );
  const d = inertSource(true) as D & { querySelector: (selector: string) => null; getAnimations: () => never[] };
  d.querySelector = () => null;
  d.getAnimations = () => [];
  const w: any = { __avcGuard: { violations: [] } };
  const gsap = `window.gsap={ticker:{add(){},sleep(){}},core:{Timeline:class{constructor(elements,seconds=2){this.elements=elements;this.seconds=seconds;}duration(){return this.seconds;}totalTime(){}getChildren(){return [{targets:()=>this.elements}];}}}};`;
  const runtime = `const clock=window.__avcPrivateEngineClock;delete window.__avcPrivateEngineClock;window.testCap=clock;const root=document.body.children[0],hosts=root.children.slice(0,2);document.currentScript=root.children[3];window.__timelines.root=new window.gsap.core.Timeline([root.children[2]]);document.currentScript=null;const style=testMakeStyle();clock.instanceRegisterInertStyle(style);document.head.append(style);testAttachSheet(style);clock.treeGuard('before-mount',hosts);clock.setTimeout(()=>{window.timerObserved=true;},0);window.__hf={buildReady:{mounted:Promise.resolve().then(async()=>{await Promise.all(hosts.map(host=>clock.instanceFetch(host,'leaf.html')));testMount(hosts[0],clock);if(testMode!=='empty')testMount(hosts[1],clock);if(testMode==='two')hosts[1].append(testExtra());try{if(testMode==='empty')clock.instancePrepareMedia(()=>{});else clock.treeGuard('mounted',hosts);clock.instancePrepareMedia(()=>{});testNormalize(hosts,clock);for(const host of hosts)testPublish(host,clock);clock.treeGuard('scripts-complete',hosts);clock.publish('__clipManifest',{protocolVersion:1,fps:{numerator:8,denominator:1},compositionWidth:64,compositionHeight:64,durationInFrames:16,durationSeconds:2,clips:[]});clock.publish('__player',{pause(){},renderSeek(){},getDuration(){return 2;}});clock.publish('__hfWaitForSeekCompletion',async()=>{});clock.publish('__playerReady',true);clock.publish('__renderReady',true);}catch(error){window.firstMountedError=String(error);hosts[1].children=[];window.fixtureResetObserved=true;}})}};`;
  const context = {
    window: w,
    document: d,
    URL,
    TextEncoder,
    Response,
    location: { href: "https://avc.invalid/index.html" },
    DOMParser: class {
      parseFromString() {
        return { querySelector: () => null };
      }
    },
    testMode: mode,
    testMakeStyle: fakeInertStyle,
    testAttachSheet: attachFakeSheet,
    testExtra: () => new E("span", { id: "extra" }),
    testMount: (host: E, cap: any) => {
      const authored = cap.instanceSourceRootId(host, "leaf.html"),
        leaf = clone(inertSource(false).body.children[0]);
      assert.equal(authored, "leaf");
      for (const key of ["id", "data-composition-id", "data-start", "data-duration"]) delete leaf.values[key];
      leaf.values["data-hf-authored-id"] = "leaf";
      leaf.values["data-hf-inner-root"] = "true";
      leaf.values.style += ";width:100%;height:100%";
      leaf.children = leaf.children.filter((e) => e.tagName !== "SCRIPT");
      host.append(leaf);
    },
    testNormalize: (hosts: E[], cap: any) => {
      cap.treeNormalize("before", hosts);
      for (const host of hosts) {
        host.values["data-hf-authored-duration"] = host.values["data-duration"];
        delete host.values["data-duration"];
      }
      cap.treeNormalize("after", hosts);
    },
    testPublish: (host: E, cap: any) => {
      const script = new E("script", {}, "PINNED VM WRAPPER " + g.documents["leaf.html"].record.script);
      cap.instanceArmScript(host, script);
      d.body.append(script);
      d.currentScript = script;
      const acquire = w.__avcPrivateInstanceAcquire;
      delete w.__avcPrivateInstanceAcquire;
      acquire(script).registry.leaf = new w.gsap.core.Timeline([host.children[0].children[0]], 1);
      d.currentScript = null;
    },
  };
  vm.runInNewContext(
    fullPlayerPrelude(runtime, gsap, { "leaf.html": "VM LEAF" }, 8, 64, 64, undefined, undefined, g),
    context,
    { timeout: 1000 },
  );
  return { g, d, w };
}
test(
  "serialized player synthetic asynchronous mounted/media failure survives catch/reset and resource wrapper with first snapshot",
  { timeout: 3000 },
  async () => {
    for (const mode of ["empty", "two"] as const) {
      const s = await serializedMountedFixture(mode);
      await assert.rejects(s.w.__avcFullPlayer.flush(), (e) => {
        assert.match(String(e), /Full player resource\/clock guard violation/);
        const d = mountedDiagnostic(s.w.firstMountedError);
        assert.equal(d.hostId, "b");
        assert.equal(d.phase, mode === "empty" ? "prepare-media" : "guard:mounted");
        assert.equal(d.caller, mode === "empty" ? "instancePrepareMedia" : "treeGuard");
        assert.equal(d.childCount, mode === "empty" ? 0 : 2);
        assert.equal(d.selected, mode === "two");
        assert.equal(d.sourceSha256, s.g.instances[1].sourceSha256);
        assert.ok(String(e).includes(s.w.firstMountedError.replace(/^Error: /, "")));
        return true;
      });
      assert.equal(s.w.timerObserved, true);
      assert.equal(s.w.fixtureResetObserved, true);
      assert.equal(s.d.body.children[0].children[1].children.length, 0);
      assert.throws(
        () => s.w.testCap.treeGuard("validate", []),
        (e) => String(e) === s.w.firstMountedError,
      );
      s.w.__avcFullPlayer.dispose();
    }
  },
);
test(
  "serialized player successful synthetic full lifecycle preserves loader/media/script guards with no diagnostic",
  { timeout: 3000 },
  async () => {
    const s = await serializedMountedFixture("success");
    const ready = await s.w.__avcFullPlayer.flush();
    assert.equal(ready.durationFrames, 16);
    assert.equal(ready.loads, 2);
    assert.equal(s.w.timerObserved, true);
    assert.equal(Object.hasOwn(s.w, "__avcPrivateEngineClock"), false);
    assert.equal(s.w.firstMountedError, undefined);
    assert.deepEqual(s.w.__avcGuard.violations, []);
    s.w.__avcFullPlayer.dispose();
  },
);

test("offending second host diagnostic binds its distinct preflighted source SHA and known child owner", async () => {
  const s = await setup(false, false, true);
  s.publishRoot();
  s.installStyle();
  s.cap.treeGuard("before-mount", [s.a, s.b] as unknown as Element[]);
  await s.cap.instanceFetch(s.a as unknown as Element, "leaf.html");
  s.mount(s.a);
  await s.cap.instanceFetch(s.b as unknown as Element, "second.html");
  assert.notEqual(s.g.instances[0].sourceSha256, s.g.instances[1].sourceSha256);
  assert.equal(s.g.instances[1].sourceSha256, digest("SECOND-BYTES"));
  assert.throws(
    () => s.prepare(),
    (e) => {
      const d = mountedDiagnostic(e);
      assert.equal(d.hostId, "b");
      assert.equal(d.sourceSha256, digest("SECOND-BYTES"));
      return true;
    },
  );
  const known = await setup();
  await known.ready();
  known.a.append(new E("span", { id: "new" }));
  assert.throws(
    () => known.prepare(),
    (e) => {
      const d = mountedDiagnostic(e);
      assert.equal(d.firstChildren[0].retainedKnown, true);
      assert.equal(d.firstChildren[0].owner, "a");
      assert.equal(d.firstChildren[0].authoredId, "leaf");
      assert.equal(d.firstChildren[0].innerRoot, true);
      assert.equal(d.firstChildren[1].retainedKnown, false);
      return true;
    },
  );
});
