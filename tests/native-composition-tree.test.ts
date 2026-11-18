import test from "node:test";
import assert from "node:assert/strict";
import {
  validateStaticCompositionTree as validate,
  staticTreeSourceName,
  validateTreeMediaWindow,
  type StaticTreeDocument,
} from "../src/lib/backends/native-composition-tree";
const sha = "a".repeat(64),
  document = (rootId: string | null, hosts: StaticTreeDocument["hosts"] = [], bytes = 100): StaticTreeDocument => ({
    rootId,
    rootDuration: 1,
    hosts,
    bytes,
    sha256: sha,
    mediaCount: 0,
    unsupported: [],
  });
const host = (id: string, src: string, parentId: string | null, start = 0.2, duration = 0.6, inPoint = 0) => ({
  id,
  src,
  parentId,
  start,
  duration,
  inPoint,
});
const fixture = () => ({
  root: document("root", [host("child", "child.html", "root")]),
  assets: {
    "child.html": document("child", [host("grandchild", "nested/grandchild.html", "child", 0.1, 0.4, 0.05)]),
    "nested/grandchild.html": document("grandchild", [host("leaf", "leaf.html", "grandchild", 0.1, 0.2)]),
    "leaf.html": document("leaf"),
  },
});

test("pure graph records preserve preorder/root-relative sources and exact origin/in-point ancestor windows; immutable stable source pin", () => {
  const input = fixture(),
    original = structuredClone(input),
    graph = validate(input);
  assert.deepEqual(input, original);
  assert.deepEqual(
    graph.nodes.map((n) => [n.id, n.depth, n.origin]),
    [
      ["child", 1, 0.2],
      ["grandchild", 2, 0.25000000000000006],
      ["leaf", 3, 0.3500000000000001],
    ],
  );
  assert.equal(graph.hostCount, 4);
  assert.equal(graph.totalBytes, 400);
  assert.equal(graph.graphSha256, validate(fixture()).graphSha256);
  const changed = fixture();
  changed.assets["leaf.html"].sha256 = "b".repeat(64);
  assert.notEqual(validate(changed).graphSha256, graph.graphSha256);
  assert.deepEqual(input, original);
});
test("structural pure graph rejects missing/cycle/repeated instances/IDs, bad parent/mismatched content roots, dynamic unsupported records", () => {
  const missing = fixture();
  delete (missing.assets as Record<string, StaticTreeDocument>)["leaf.html"];
  assert.throws(() => validate(missing), /allowlist/);
  const cycle = fixture();
  cycle.assets["leaf.html"].hosts = [host("cycle", "child.html", "leaf", 0, 0.1)];
  assert.throws(() => validate(cycle), /cycle/);
  const repeat = fixture();
  repeat.root.hosts.push(host("other", "child.html", "root"));
  assert.throws(() => validate(repeat), /repeated/);
  const dup = fixture();
  dup.assets["leaf.html"].hosts = [host("child", "other.html", "leaf")];
  assert.throws(() => validate(dup), /duplicate/);
  const parent = fixture();
  parent.root.hosts[0].parentId = "missing";
  assert.throws(() => validate(parent), /unresolved/);
  const mismatch = fixture();
  mismatch.assets["child.html"].rootId = "another";
  assert.throws(() => validate(mismatch), /differs/);
  const dynamic = fixture();
  dynamic.assets["child.html"].unsupported = ["inline template/dynamic external hosts"];
  assert.throws(() => validate(dynamic), /unsupported/);
});
test("literal root-relative paths refuse normalized URL aliases and inherited allowlist keys", () => {
  for (const src of [
    "/child.html",
    "./child.html",
    "../child.html",
    "a/../child.html",
    "https://evil/child.html",
    "child.html?q=1",
    "child.html#x",
    "child%2ehtml",
    "a\\child.html",
    " a.html",
    "a//child.html",
    "constructor",
    "toString",
  ])
    assert.throws(() => staticTreeSourceName(src));
  const input = fixture();
  input.root.hosts[0].src = "unlisted.html";
  Object.setPrototypeOf(input.assets, { "unlisted.html": document("child") });
  assert.throws(() => validate(input), /allowlist/);
  assert.equal(staticTreeSourceName("compositions/child_1.html"), "compositions/child_1.html");
});
test("depth/count/bytes/media and safe timing bounds refuse before mount; exact boundaries remain supported", () => {
  const depth = fixture();
  depth.assets["leaf.html"].hosts = [host("fourth", "fourth.html", "leaf", 0, 0.1)];
  (depth.assets as Record<string, StaticTreeDocument>)["fourth.html"] = document("fourth");
  assert.throws(() => validate(depth), /depth/);
  const count = { root: document("root"), assets: {} as Record<string, StaticTreeDocument> };
  for (let i = 0; i < 17; i++) {
    count.root.hosts.push(host("child" + i, "child" + i + ".html", "root"));
    count.assets["child" + i + ".html"] = document("child" + i);
  }
  assert.throws(() => validate(count), /child count/);
  count.root.hosts.pop();
  assert.equal(validate(count).nodes.length, 16);
  const bytes = fixture();
  bytes.assets["child.html"].bytes = 128 * 1024 + 1;
  assert.throws(() => validate(bytes), /child byte/);
  bytes.assets["child.html"].bytes = 128 * 1024;
  assert.doesNotThrow(() => validate(bytes));
  const total = structuredClone(count);
  total.root.bytes = 1024 * 1024;
  for (const row of Object.values(total.assets)) row.bytes = 128 * 1024;
  assert.throws(() => validate(total), /aggregate/);
  const many = fixture();
  for (let i = 0; i < 129; i++)
    (many.assets as Record<string, StaticTreeDocument>)["unused" + i + ".html"] = document("unused" + i);
  assert.throws(() => validate(many), /snapshot count/);
  const media = fixture();
  media.root.mediaCount = 8;
  media.assets["leaf.html"].mediaCount = 1;
  assert.throws(() => validate(media), /media count/);
  const timing = fixture();
  timing.root.hosts[0].start = Number.MAX_VALUE;
  timing.root.hosts[0].duration = Number.MAX_VALUE;
  assert.throws(() => validate(timing), /overflow|Too big/);
  const outside = fixture();
  outside.assets["child.html"].hosts[0].start = 1;
  assert.throws(() => validate(outside), /parent host window/);
});
test("native media bounds reject parent duration leakage even without in-point; retain genuine clipped source window", () => {
  const graph = validate(fixture());
  assert.throws(() => validateTreeMediaWindow(graph, ["root"], 0.9, 1.1), /root window/);
  assert.doesNotThrow(() => validateTreeMediaWindow(graph, ["root"], 0.9, 1));
  assert.throws(() => validateTreeMediaWindow(graph, ["root"], 0.9, 1.000000005), /root window/);
  assert.throws(
    () => validateTreeMediaWindow(graph, ["root", "child"], graph.nodes[0].windowStart - 5e-9, 0.5),
    /outside/,
  );
  assert.doesNotThrow(() => validateTreeMediaWindow(graph, ["root", "child", "grandchild", "leaf"], 0.36, 0.5));
  assert.throws(() => validateTreeMediaWindow(graph, ["root", "child"], 0.2, 0.9), /outside/);
  assert.throws(() => validateTreeMediaWindow(graph, ["root", "child", "grandchild"], 0.25, 0.4), /outside/);
  assert.throws(() => validateTreeMediaWindow(graph, ["root", "unknown"], 0.36, 0.5), /unknown/);
  assert.throws(() => validateTreeMediaWindow(graph, ["root", "child", "child"], 0.36, 0.5), /duplicate/);
  assert.throws(() => validateTreeMediaWindow(graph, ["root", "grandchild"], 0.36, 0.5), /chain mismatch/);
  assert.throws(() => validateTreeMediaWindow(graph, [], 0.36, 0.5), /exact root/);
});
test("strict pure graph schema refuses executable/unknown fields, nonfinite values, bad hashes and metadata; root bytes limited", () => {
  for (const mutate of [
    (x: any) => (x.command = { type: "seek" }),
    (x: any) => (x.root.bytes = -1),
    (x: any) => (x.root.sha256 = "claimed"),
    (x: any) => (x.root.rootId = null),
    (x: any) => (x.root.bytes = 1024 * 1024 + 1),
    (x: any) => (x.root.hosts[0].start = NaN),
    (x: any) => (x.root.hosts[0].duration = 0),
    (x: any) => (x.root.hosts[0].inPoint = -1),
    (x: any) => (x.root.hosts[0].script = "alert(1)"),
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => validate(input));
  }
});
