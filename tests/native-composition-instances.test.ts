import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { digest } from "../src/lib/jobs/model-artifacts";
import {
  validateInstanceScript,
  INSTANCE_PARSER_PIN,
  validateInstanceParserProvenance,
} from "../src/lib/backends/native-instance-script";
import {
  validateCompositionInstances as validate,
  validateInstanceMediaWindow,
  type InstanceGraphInput,
} from "../src/lib/backends/native-composition-instances";
import { validateStaticCompositionTree } from "../src/lib/backends/native-composition-tree";

const script = (id: string, target = "card") =>
  `const timeline = gsap.timeline({paused:true});\ntimeline.to("#${target}", {opacity:1,scale:1,duration:1,ease:"power2.out"},0);\nwindow.__timelines["${id}"] = timeline;`;
const document = (authoredId: string, localIds = ["card"]): InstanceGraphInput["root"] => ({
  html: `<div data-composition-id="${authoredId}"></div>`,
  authoredId,
  duration: 2,
  start: 0,
  localIds,
  mediaIds: [],
  script: script(authoredId, localIds[0]),
  styles: ["position:absolute;width:64px;height:64px;background-color:#AABBCC;opacity:0"],
  hosts: [],
  unsupported: [],
});
const fixture = (): InstanceGraphInput => ({
  root: {
    ...document("root", ["background"]),
    duration: 4,
    hosts: [
      { id: "first", source: "tile.html", start: 0, duration: 1, inPoint: 0 },
      { id: "second", source: "tile.html", start: 2, duration: 1, inPoint: 0.5 },
    ],
  },
  assets: { "tile.html": document("tile") },
});
const context = { authoredId: "tile", ownedTargetIds: ["card"], duration: 2 };

test("pure direct siblings reuse source with independent ordered IDs/origins/source windows and stable immutable identity", () => {
  const input = fixture(),
    before = structuredClone(input),
    graph = validate(input);
  assert.deepEqual(input, before);
  assert.deepEqual(
    graph.instances.map((row) => [row.id, row.authoredId, row.origin, row.windowStart, row.windowEnd]),
    [
      ["first", "tile", 0, 0, 1],
      ["second", "tile", 1.5, 2, 3],
    ],
  );
  assert.equal(graph.files.length, 1);
  assert.equal(
    graph.totalBytes,
    Buffer.byteLength(input.root.html) + 2 * Buffer.byteLength(input.assets["tile.html"].html),
  );
  assert.equal(graph.graphSha256, validate(fixture()).graphSha256);
  assert.equal(graph.profile, "static-local-instances-v1");
  assert.equal(graph.hostCount, 3);
});
test("parser identity records actual installed version and consumed API file bytes, script source immutable", () => {
  const root = dirname(createRequire(import.meta.url).resolve("acorn/package.json"));
  assert.equal(INSTANCE_PARSER_PIN.esmSha256, digest(readFileSync(join(root, "dist/acorn.mjs"))));
  assert.equal(INSTANCE_PARSER_PIN.cjsSha256, digest(readFileSync(join(root, "dist/acorn.js"))));
  assert.equal(INSTANCE_PARSER_PIN.version, "8.19.0");
  const code = script("tile");
  const receipt = validateInstanceScript(code, context);
  assert.equal(receipt.scriptSha256, digest(code));
  assert.deepEqual(receipt.targets, ["card"]);
  assert.equal(receipt.duration, 1);
  assert.equal(receipt.calls, 1);
  for (const key of ["version", "esmSha256", "cjsSha256", "packageSha256", "licenseSha256"])
    assert.throws(
      () => validateInstanceParserProvenance({ ...INSTANCE_PARSER_PIN, [key]: "forged" }),
      /provenance mismatch/,
    );
  assert.throws(
    () => validateInstanceParserProvenance({ ...INSTANCE_PARSER_PIN, claimedVerified: true }),
    /provenance mismatch/,
  );
});
test("identity binds raw files including unused snapshots, every record/script/style and instance timing/order", () => {
  const initial = validate(fixture()).graphSha256;
  for (const mutate of [
    (x: InstanceGraphInput) => {
      x.assets["tile.html"].html += " ";
    },
    (x: InstanceGraphInput) => {
      x.assets["tile.html"].script += "\n";
    },
    (x: InstanceGraphInput) => {
      x.root.script += "\n";
    },
    (x: InstanceGraphInput) => {
      x.assets["tile.html"].styles = ["opacity:1"];
    },
    (x: InstanceGraphInput) => {
      x.root.hosts.reverse();
    },
    (x: InstanceGraphInput) => {
      x.root.hosts[1].inPoint = 0.25;
    },
    (x: InstanceGraphInput) => {
      x.assets["unused.html"] = document("unused");
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.notEqual(validate(input).graphSha256, initial);
  }
  const reordered = fixture();
  reordered.assets = { "unused.html": document("unused"), "tile.html": document("tile") };
  const reversed = structuredClone(reordered);
  reversed.assets = { "tile.html": document("tile"), "unused.html": document("unused") };
  assert.equal(validate(reordered).graphSha256, validate(reversed).graphSha256);
});
test("closed grammar permits finite literal set/from/fromTo/to and signed rotation only", () => {
  const code = `const timeline=gsap.timeline({paused:true});timeline.set("#card",{opacity:0},0);timeline.from("#card",{scale:0.8,rotation:-45,duration:.25},0);timeline.fromTo("#card",{color:"#123456"},{color:"#abcdef",duration:.5,ease:"none"},.25);timeline.to("#card",{opacity:1,duration:.5},1);window.__timelines["tile"]=timeline;`;
  assert.equal(validateInstanceScript(code, context).duration, 1.5);
});
test("all participating root/leaf scripts reject arbitrary globals rather than checking only reused templates", () => {
  for (const owner of ["root", "leaf"]) {
    const input = fixture();
    (owner === "root" ? input.root : input.assets["tile.html"]).script += "window.counter=1;";
    assert.throws(() => validate(input), /script/);
  }
});
test("global/reflective/dynamic executable forms refuse without evaluating marker", () => {
  const attacks = [
    "window.counter=1;",
    "globalThis.__instanceMarker=1;",
    "self.foo=1;",
    'document.body.innerHTML="";',
    'fetch("https://evil");',
    "setTimeout(()=>{},0);",
    "while(true){}",
    "for(;;){}",
    'eval("1");',
    'Function("return 1")();',
    "Object.setPrototypeOf({},{});",
    'timeline["to"]("#card",{opacity:1,duration:1},0);',
    'timeline.to("#card",{opacity:1,duration:1,onComplete:()=>{}},0);',
    'timeline.to("#card",{get opacity(){return 1},duration:1},0);',
    'timeline.to("#card",{...{opacity:1},duration:1},0);',
    'import("https://evil");',
    "window.__timelines={};",
    'window.__timelines["other"]=timeline;',
  ];
  for (const attack of attacks) {
    const code = script("tile").replace(
      'window.__timelines["tile"] = timeline;',
      attack + '\nwindow.__timelines["tile"] = timeline;',
    );
    assert.throws(() => validateInstanceScript(code, context), /Instance script:/, attack);
  }
  assert.equal((globalThis as Record<string, unknown>).__instanceMarker, undefined);
});
test("malformed/optional/shadow/typed declarations and publication forms refuse", () => {
  for (const code of [
    script("tile").replace("const timeline", "let timeline"),
    script("tile").replace("{paused:true}", "{paused:false}"),
    script("tile").replace("{paused:true}", "{paused:true,repeat:1}"),
    script("tile").replace("gsap.timeline(", "gsap.timeline?.("),
    script("tile").replace("window.__timelines", "window?.__timelines"),
    script("tile").replace("const timeline", "const window"),
    script("tile").replace("const timeline", "const timeline:number"),
    script("tile").replace('"tile"', '"other"'),
    script("tile").replace("opacity:1", "opacity:NaN"),
    "const timeline =",
  ])
    assert.throws(() => validateInstanceScript(code, context));
});
test("target ownership refuses selector escapes, sibling/child media IDs and root cross-internal selection", () => {
  for (const target of [
    "#card,#other",
    "body",
    "#card > *",
    "[id=card]",
    "#card:hover",
    "#other",
    "#__render_frame_card__",
  ])
    assert.throws(() => validateInstanceScript(script("tile").replace("#card", target), context), /selector/);
  const parent = fixture();
  parent.root.script = script("root", "card");
  assert.throws(() => validate(parent), /selector/);
  const overlap = fixture();
  overlap.root.localIds = ["card"];
  overlap.root.script = script("root", "card");
  assert.throws(() => validate(overlap), /ancestor ownership/);
  const rootId = fixture();
  rootId.root.localIds = ["tile"];
  rootId.root.script = script("root", "tile");
  assert.throws(() => validate(rootId), /identity collides/);
  const media = fixture();
  media.assets["tile.html"].mediaIds = ["card"];
  assert.throws(() => validate(media), /selector/);
  const hostTarget = fixture();
  hostTarget.root.script = script("root", "first");
  assert.doesNotThrow(() => validate(hostTarget));
});
test("literal properties/eases/colors/source windows and resource upper bounds fail closed", () => {
  for (const vars of [
    "opacity:2,duration:1",
    "scale:9,duration:1",
    "rotation:3601,duration:1",
    "opacity:1,duration:0",
    "opacity:1,duration:3",
    'opacity:1,duration:1,ease:"elastic.out"',
    'color:"red",duration:1',
    "opacity:1,duration:1,volume:1",
    "opacity:1,duration:1,currentTime:1",
    "opacity:1,duration:1,x:30",
    "opacity:1,opacity:0,duration:1",
    "opacity:1,duration:1,__proto__:null",
    'opacity:1,duration:1,css:{color:"#123456"}',
  ])
    assert.throws(() =>
      validateInstanceScript(
        `const timeline=gsap.timeline({paused:true});timeline.to("#card",{${vars}},0);window.__timelines["tile"]=timeline;`,
        context,
      ),
    );
  assert.throws(() => validateInstanceScript(script("tile") + " ".repeat(32768), context), /byte bound/);
  const calls = `const timeline=gsap.timeline({paused:true});${'timeline.to("#card",{opacity:1,duration:1},0);'.repeat(129)}window.__timelines["tile"]=timeline;`;
  assert.throws(() => validateInstanceScript(calls, context), /statement count/);
  const targets = Array.from({ length: 33 }, (_, i) => `card${i}`),
    many = `const timeline=gsap.timeline({paused:true});${targets.map((target) => `timeline.to("#${target}",{opacity:1,duration:1},0);`).join("")}window.__timelines["tile"]=timeline;`;
  assert.throws(() => validateInstanceScript(many, { ...context, ownedTargetIds: targets }), /target count/);
  assert.throws(() => validateInstanceScript('"use strict";' + script("tile"), context), /declaration/);
});
test("closed inline style declarations deny network/comments/escape/rule/animation syntax and dimension overflow", () => {
  for (const style of [
    "background-image:url(tile.html)",
    "color:var(--x)",
    "color:red",
    "color:#123456/*x*/",
    "width:8193px",
    "width:calc(2px)",
    '@import "tile.html"',
    "opacity:expression(1)",
    "transition:all 1s",
    "animation:spin 1s",
    "color:#123456;color:#ffffff",
    "display:grid",
    "--x:1",
    "color:#123456!important",
    "\\63olor:#123456",
    "body{color:#123456}",
  ]) {
    const input = fixture();
    input.assets["tile.html"].styles = [style];
    assert.throws(() => validate(input), /style/);
  }
});
test("direct leaves reject cycles/recursion/dynamic/duplicate/colliding identities while repeated leaf media IDs remain local", () => {
  const recursive = fixture();
  recursive.assets["tile.html"].hosts = [{ id: "grandchild", source: "tile.html", start: 0, duration: 1, inPoint: 0 }];
  assert.throws(() => validate(recursive), /recursion/);
  for (const mutate of [
    (x: InstanceGraphInput) => {
      x.root.hosts[1].id = "first";
    },
    (x: InstanceGraphInput) => {
      x.assets["tile.html"].localIds = ["card", "card"];
    },
    (x: InstanceGraphInput) => {
      x.assets["tile.html"].localIds.push("first");
    },
    (x: InstanceGraphInput) => {
      x.assets["tile.html"].authoredId = "root";
    },
    (x: InstanceGraphInput) => {
      x.assets["tile.html"].unsupported = ["dynamic host"];
    },
    (x: InstanceGraphInput) => {
      x.assets["tile.html"].mediaIds = ["missing"];
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => validate(input));
  }
  const media = fixture();
  media.assets["tile.html"].localIds.push("voice");
  media.assets["tile.html"].mediaIds = ["voice"];
  const graph = validate(media);
  assert.equal(graph.mediaCount, 2);
  assert.deepEqual(
    graph.instances.map((i) => i.mediaIds),
    [["voice"], ["voice"]],
  );
});
test("paths/unknown fields/inherited snapshots/unsafe numbers refuse and no unsupported aliases canonicalized", () => {
  for (const source of [
    "/tile.html",
    "./tile.html",
    "x/../tile.html",
    "tile.html?q=1",
    "tile%2ehtml",
    "https://evil/tile.html",
    "constructor",
  ]) {
    const input = fixture();
    input.root.hosts[0].source = source;
    assert.throws(() => validate(input));
  }
  const inherited = fixture();
  delete inherited.assets["tile.html"];
  Object.setPrototypeOf(inherited.assets, { "tile.html": document("tile") });
  assert.throws(() => validate(inherited), /allowlist/);
  for (const mutate of [
    (x: any) => {
      x.extra = true;
    },
    (x: any) => {
      x.root.start = 1;
    },
    (x: any) => {
      x.root.hosts[0].start = Infinity;
    },
    (x: any) => {
      x.root.hosts[0].duration = 0;
    },
    (x: any) => {
      x.root.hosts[0].inPoint = -1;
    },
    (x: any) => {
      x.root.hosts[0].script = "attack";
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => validate(input));
  }
});
test("expanded counts/bytes/media bind each mount, not only unique file cache", () => {
  const sixteen = fixture();
  sixteen.root.duration = 2;
  sixteen.root.hosts = Array.from({ length: 16 }, (_, i) => ({
    id: `instance${i}`,
    source: "tile.html",
    start: 0,
    duration: 1,
    inPoint: 0,
  }));
  assert.equal(validate(sixteen).instances.length, 16);
  const seventeen = structuredClone(sixteen);
  seventeen.root.hosts.push({ id: "overflow", source: "tile.html", start: 0, duration: 1, inPoint: 0 });
  assert.throws(() => validate(seventeen));
  const expanded = structuredClone(sixteen);
  expanded.assets["tile.html"].html = " ".repeat(128 * 1024);
  assert.throws(() => validate(expanded), /expanded aggregate/);
  const bytes = fixture();
  bytes.assets["tile.html"].html = " ".repeat(128 * 1024 + 1);
  assert.throws(() => validate(bytes), /snapshot child byte/);
  const media = structuredClone(sixteen);
  media.assets["tile.html"].localIds.push("voice");
  media.assets["tile.html"].mediaIds = ["voice"];
  assert.throws(() => validate(media), /expanded media/);
});
test("strict source and ancestor boundaries accept exact endpoint and reject 5ns outside without epsilon", () => {
  const graph = validate(fixture());
  assert.doesNotThrow(() => validateInstanceMediaWindow(graph, "second", 2, 3));
  for (const args of [
    ["second", 2 - 5e-9, 3],
    ["second", 2, 3 + 5e-9],
    ["first", 0, 4 + 5e-9],
    ["missing", 0, 0.5],
    ["first", NaN, 0.5],
  ] as const)
    assert.throws(() => validateInstanceMediaWindow(graph, args[0], args[1], args[2]));
  const beyond = fixture();
  beyond.root.hosts[1].duration = 2.000000005;
  assert.throws(() => validate(beyond), /root window/);
  const source = fixture();
  source.root.hosts[1].inPoint = 1.000000005;
  assert.throws(() => validate(source), /source window/);
});
test("legacy static tree still rejects repeated sources and authored root mismatch unchanged", () => {
  const doc = (rootId: string, hosts: any[] = []) => ({
    rootId,
    rootDuration: 4,
    hosts,
    bytes: 100,
    sha256: "a".repeat(64),
    mediaCount: 0,
    unsupported: [],
  });
  const hosts = [
    { id: "child", src: "child.html", parentId: "root", start: 0, duration: 1, inPoint: 0 },
    { id: "other", src: "child.html", parentId: "root", start: 2, duration: 1, inPoint: 0 },
  ];
  assert.throws(
    () => validateStaticCompositionTree({ root: doc("root", hosts), assets: { "child.html": doc("child") } }),
    /repeated/,
  );
  assert.throws(
    () => validateStaticCompositionTree({ root: doc("root", [hosts[0]]), assets: { "child.html": doc("template") } }),
    /differs/,
  );
});
