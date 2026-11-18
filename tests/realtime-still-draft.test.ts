import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSplitOriginal, assertStaticImageBytes } from "../src/lib/review-ui/split-original";
import { AssetRecordSchema } from "../src/types/assets";
import { digest } from "../src/lib/jobs/model-artifacts";
import { RealtimeEditorStore, RealtimeDeriveSchema } from "../src/lib/realtime/editor";
import { RealtimeReviewService } from "../src/lib/review-ui/realtime";
import { RealtimeStillDraftSchema, prepareRealtimeStill, listRealtimeStills } from "../src/lib/realtime/still-input";
import { startReviewServer } from "../src/lib/review-ui/server";
import { LocalEditorChannel } from "../src/lib/realtime/channel";
// Fixed encoded byte DATA, no encoder/decoder/probe. JPEG below is deliberately opaque signature DATA.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
function fixture(t: test.TestContext, jpeg = false) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "still-draft-data-"))),
    project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const bytes = jpeg ? Buffer.from([255, 216, 255, 255, 217]) : png,
    hash = digest(bytes),
    file = path.join(project, "assets/imported", hash + (jpeg ? ".jpg" : ".png"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  const asset = AssetRecordSchema.parse({
    schemaVersion: 1,
    id: "sha256:" + hash,
    hash,
    revision: 1,
    createdAt: "2026-10-12T00:00:00Z",
    kind: "image",
    files: {
      original: "projects/demo/assets/imported/" + path.basename(file),
      bytes: bytes.length,
      mime: jpeg ? "image/jpeg" : "image/png",
    },
    media: { width: 1, height: 1, codec: jpeg ? "mjpeg" : "png", hasAudio: false },
    provenance: { origin: "manual", tool: "static encoded DATA fixture; no physical import/decode" },
    rights: { licence: "unknown" },
    entityLinks: [],
    status: "candidate",
  });
  const registryFile = path.join(project, "pipeline/asset-registry.json"),
    registry = { schemaVersion: 1, revision: 1, assets: [asset] };
  writeFileSync(registryFile, JSON.stringify(registry));
  const store = new RealtimeEditorStore(root, "demo", "edit");
  store.create(1);
  const draft = {
    assetId: asset.id,
    assetSha256: hash,
    registrySha256: digest(readFileSync(registryFile)),
    revisionId: "still",
    sessionId: "still-session",
    input: { prompt: "New supplied direction", seed: 0 },
    highUsd: 0.5,
    limits: { maxFrames: 1, maxInputBytes: 4194304, maxResponseBytes: 1048576, maxControls: 4, timeoutMs: 2000 },
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    project,
    bytes,
    file,
    asset,
    registry,
    registryFile,
    store,
    draft,
    service: new RealtimeReviewService(root, "demo"),
  };
}
const snapshot = (f: ReturnType<typeof fixture>) => ({
  state: readFileSync(path.join(f.store.directory, "000.json")),
  original: readFileSync(f.file),
  registry: readFileSync(f.registryFile),
  members: readdirSync(f.store.directory),
});
test("PNG/JPEG same consumed original bytes create one fixed offline request, exact SHA and explicit new quote; no fresh JPEG decode claim", (t) => {
  for (const jpeg of [false, true]) {
    const f = fixture(t, jpeg),
      before = snapshot(f),
      prepared = prepareRealtimeStill(f.root, "demo", f.draft);
    assert.equal(prepared.sourceInput.physicalDecodeVerified, false);
    assert.deepEqual(Buffer.from(String(prepared.request.operation.input.image_url).split(",")[1], "base64"), f.bytes);
    prepared.recheck();
    prepared.close();
    assert.throws(prepared.recheck, /closed/);
    const state = f.service.mutate({ action: "add-asset", editorId: "edit", expected: 0, draft: f.draft });
    assert.equal(state.sequence, 1);
    assert.equal(state.revisions[0].status, "draft");
    assert.equal(state.committedUsd, 0);
    assert.equal(state.queued, undefined);
    assert.equal(state.inFlight, undefined);
    assert.equal(state.providerAck, false);
    assert.deepEqual(readFileSync(f.file), before.original);
    assert.deepEqual(readFileSync(f.registryFile), before.registry);
    assert.deepEqual(readFileSync(path.join(f.store.directory, "000.json")), before.state);
    const request = f.store.request("still");
    assert.equal(digest(Buffer.from(String(request.operation.input.image_url).split(",")[1], "base64")), f.asset.hash);
    assert.equal(request.quote.confidence, "user-bound");
    assert.equal(request.quote.providerEnforced, false);
    assert.equal(request.quote.highUsd, 0.5);
  }
});
test("strict new selector refuses executable/image/model/path/limits authority and invalid controls; derive still cannot replace image", (t) => {
  const f = fixture(t);
  for (const bad of [
    { ...f.draft, path: f.file },
    { ...f.draft, mime: "image/png" },
    { ...f.draft, operation: {} },
    { ...f.draft, input: { ...f.draft.input, image_url: "spoof" } },
    { ...f.draft, highUsd: 0 },
    { ...f.draft, input: { ...f.draft.input, seed: -1 } },
    { ...f.draft, input: { ...f.draft.input, prompt: "" } },
    { ...f.draft, limits: { ...f.draft.limits, maxFrames: 3 } },
    { ...f.draft, registrySha256: "a" },
  ])
    assert.equal(RealtimeStillDraftSchema.safeParse(bad).success, false);
  assert.equal(
    RealtimeDeriveSchema.safeParse({
      sourceRevision: "old",
      revisionId: "new",
      sessionId: "fresh",
      input: { image_url: "replacement" },
    }).success,
    false,
  );
});
test("registered kind/MIME/codec/size/dimensions/path spoof refuses even with fresh registry SHA", (t) => {
  for (const change of [
    (a: any) => (a.kind = "audio"),
    (a: any) => (a.files.mime = "image/webp"),
    (a: any) => (a.media.codec = "gif"),
    (a: any) => (a.media.width = 4097),
    (a: any) => (a.media.width = 2),
    (a: any) => (a.media.hasAudio = true),
    (a: any) => (a.files.bytes = 2097153),
    (a: any) => (a.files.original = a.files.original.replace("demo", "foreign")),
  ]) {
    const f = fixture(t);
    change(f.registry.assets[0]);
    writeFileSync(f.registryFile, JSON.stringify(f.registry));
    assert.throws(() =>
      prepareRealtimeStill(f.root, "demo", { ...f.draft, registrySha256: digest(readFileSync(f.registryFile)) }),
    );
    assert.equal(f.store.read().sequence, 0);
  }
});
test("source checksum/PNG CRC/APNG and encoded wire bound refuse without editor publication", (t) => {
  const f = fixture(t);
  const original = readFileSync(f.file);
  writeFileSync(f.file, Buffer.alloc(original.length));
  assert.throws(() => prepareRealtimeStill(f.root, "demo", f.draft), /checksum/);
  writeFileSync(f.file, original);
  const corrupt = Buffer.from(original);
  corrupt[30] ^= 1;
  assert.throws(() => assertStaticImageBytes(f.file, corrupt), /checksum/);
  const type = Buffer.from("acTL"),
    chunk = Buffer.alloc(12);
  type.copy(chunk, 4);
  let crc = 0xffffffff;
  for (const byte of type) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8);
  assert.throws(
    () => assertStaticImageBytes(f.file, Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)])),
    /Animated PNG/,
  );
  assert.throws(
    () => prepareRealtimeStill(f.root, "demo", { ...f.draft, limits: { ...f.draft.limits, maxInputBytes: 1 } }),
    /bounded message/,
  );
  assert.equal(f.store.read().sequence, 0);
});
test("same FD pin refuses late source, registry or config changes and remains explicitly closeable", (t) => {
  for (const target of ["source", "registry", "config"]) {
    const f = fixture(t),
      prepared = prepareRealtimeStill(f.root, "demo", f.draft);
    try {
      writeFileSync(
        target === "source" ? f.file : target === "registry" ? f.registryFile : path.join(f.project, "project.json"),
        target === "source" ? Buffer.alloc(f.bytes.length) : '{"changed":true}',
      );
      assert.throws(prepared.recheck, /changed/);
      assert.equal(f.store.read().sequence, 0);
    } finally {
      prepared.close();
    }
  }
});
test("leaf/ancestor aliases and FIFO are finite refusals; source aliases cannot masquerade as originals", (t) => {
  const f = fixture(t),
    other = path.join(f.project, "other");
  writeFileSync(other, f.bytes);
  rmSync(f.file);
  symlinkSync(other, f.file);
  assert.throws(() => prepareRealtimeStill(f.root, "demo", f.draft), /regular\/non-alias/);
  rmSync(f.file);
  assert.equal(spawnSync("mkfifo", [f.file], { timeout: 1000 }).status, 0);
  assert.throws(() => prepareRealtimeStill(f.root, "demo", f.draft), /regular\/non-alias/);
  rmSync(f.file);
  writeFileSync(f.file, f.bytes);
  const dir = path.dirname(f.file),
    moved = dir + "-saved";
  const fs = requireFs();
  fs.renameSync(dir, moved);
  symlinkSync(moved, dir);
  assert.throws(() => prepareRealtimeStill(f.root, "demo", f.draft), /parent alias/);
});
import * as fs from "node:fs";
const requireFs = () => fs;
test("readonly list is bounded metadata without original reads, rejects stale registry and candidate count>128", (t) => {
  const f = fixture(t),
    list = listRealtimeStills(f.root, "demo");
  assert.equal(list.metadataOnly, true);
  assert.equal(list.sources[0].assetSha256, f.asset.hash);
  assert.equal("image_url" in list.sources[0], false);
  writeFileSync(f.registryFile, JSON.stringify({ ...f.registry, revision: 2 }));
  assert.throws(() => prepareRealtimeStill(f.root, "demo", f.draft), /registry checksum/);
  const assets = Array.from({ length: 129 }, (_, i) => {
    const hash = i.toString(16).padStart(64, "0");
    return {
      ...f.asset,
      id: "sha256:" + hash,
      hash,
      files: { ...f.asset.files, original: "projects/demo/assets/imported/" + hash + ".png" },
    };
  });
  writeFileSync(f.registryFile, JSON.stringify({ ...f.registry, assets }));
  assert.throws(() => listRealtimeStills(f.root, "demo"), /128 candidates/);
});
test("CAS/reused IDs/new quote and source request corruption refuse without mutating prior request/state", (t) => {
  const f = fixture(t);
  f.service.mutate({ action: "add-asset", editorId: "edit", expected: 0, draft: f.draft });
  const before = readFileSync(path.join(f.store.directory, "001.json")),
    request = f.store.read().revisions[0].request,
    original = readFileSync(path.join(f.root, request.path));
  for (const [expected, draft] of [
    [0, { ...f.draft, revisionId: "fresh", sessionId: "fresh" }],
    [1, f.draft],
    [1, { ...f.draft, revisionId: "fresh", sessionId: "still-session" }],
    [1, { ...f.draft, revisionId: "fresh", sessionId: "fresh", highUsd: 0 }],
  ] as const)
    assert.throws(() => f.service.mutate({ action: "add-asset", editorId: "edit", expected, draft }));
  assert.deepEqual(readFileSync(path.join(f.store.directory, "001.json")), before);
  assert.deepEqual(readFileSync(path.join(f.root, request.path)), original);
});
test("active local lease and unknown predecessor from different session block new still draft across service", async (t) => {
  const f = fixture(t),
    channel = new LocalEditorChannel(f.root, "demo", "edit", "old");
  const before = snapshot(f);
  assert.throws(
    () => f.service.mutate({ action: "add-asset", editorId: "edit", expected: 0, draft: f.draft }),
    /history\/lease/,
  );
  const pending = channel.accept(
    Buffer.from(
      JSON.stringify({
        version: 1,
        localSessionId: "old",
        editorId: "edit",
        messageId: "lost",
        expectedSequence: 0,
        action: "queue",
        revisionId: "absent",
      }),
    ),
  );
  channel.close();
  await pending;
  assert.throws(
    () => f.service.mutate({ action: "add-asset", editorId: "edit", expected: 0, draft: f.draft }),
    /history\/lease/,
  );
  assert.equal(f.store.read().sequence, 0);
  assert.deepEqual(snapshot(f), before);
});
test("authenticated same-origin HTTP metadata/add-asset records only one draft; no provider/socket execution", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ rootDir: f.root, projectId: "demo" });
  t.after(() => app.close());
  const headers = { "x-review-token": app.token, origin: app.origin, "content-type": "application/json" },
    url = app.origin + "/api/realtime";
  assert.equal((await fetch(app.origin + "/api/realtime/still-sources")).status, 403);
  const listing = await (await fetch(app.origin + "/api/realtime/still-sources", { headers })).json();
  assert.equal(listing.sources.length, 1);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { ...headers, origin: "" },
        body: JSON.stringify({ action: "add-asset", editorId: "edit", expected: 0, draft: f.draft }),
      })
    ).status,
    403,
  );
  const result = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "add-asset", editorId: "edit", expected: 0, draft: f.draft }),
  });
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal((await result.json()).sequence, 1);
  assert.equal(app.channels.diagnostics().sockets, 0);
  assert.equal(app.channels.diagnostics().issued, 0);
  assert.equal(fs.existsSync(path.join(f.project, "pipeline/operations.json")), false);
});
test("real local CLI add-asset uses small project selector file and service CAS; duplicate cannot replay", (t) => {
  const f = fixture(t),
    file = path.join(f.project, "pipeline/still-input.json");
  writeFileSync(file, JSON.stringify(f.draft));
  const script = path.resolve("scripts/realtime-editor.ts"),
    tsx = path.resolve("node_modules/tsx/dist/cli.mjs"),
    env = { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR! },
    run = () =>
      spawnSync(
        process.execPath,
        [
          tsx,
          script,
          "--project",
          "demo",
          "--editor",
          "edit",
          "--action",
          "add-asset",
          "--expected",
          "0",
          "--asset-draft",
          "pipeline/still-input.json",
        ],
        { cwd: f.root, env, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS, maxBuffer: 65536 },
      );
  const first = run();
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const body = JSON.parse(first.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.metadata.editor.sequence, 1);
  const second = run();
  assert.notEqual(second.status, 0);
  assert.equal(JSON.parse(second.stdout).ok, false);
  assert.equal(f.store.read().sequence, 1);
  assert.equal(f.store.read().committedUsd, 0);
});

import { syncBuiltinESMExports } from "node:module";
test("same FD growth and replacement-FIFO after lstat refuse finitely before source publication", async (t) => {
  for (const mode of ["growth", "fifo"]) {
    const f = fixture(t),
      module = await import("node:fs"),
      originalRead = module.default.readSync,
      originalOpen = module.default.openSync,
      inode = fs.statSync(f.file).ino;
    let changed = false;
    if (mode === "growth")
      module.default.readSync = ((...args: Parameters<typeof originalRead>) => {
        const n = Reflect.apply(originalRead, module.default, args);
        if (!changed && fs.fstatSync(args[0]).ino === inode) {
          changed = true;
          fs.appendFileSync(f.file, " ");
        }
        return n;
      }) as typeof originalRead;
    else
      module.default.openSync = ((...args: Parameters<typeof originalOpen>) => {
        if (!changed && String(args[0]) === f.file) {
          changed = true;
          rmSync(f.file);
          assert.equal(spawnSync("mkfifo", [f.file], { timeout: 1000 }).status, 0);
        }
        return Reflect.apply(originalOpen, module.default, args);
      }) as typeof originalOpen;
    syncBuiltinESMExports();
    try {
      assert.throws(() => prepareRealtimeStill(f.root, "demo", f.draft), /changed/);
      assert.equal(changed, true);
      assert.equal(f.store.read().sequence, 0);
    } finally {
      module.default.readSync = originalRead;
      module.default.openSync = originalOpen;
      syncBuiltinESMExports();
    }
  }
});
test("late imported parent replacement is rejected while same original FD remains owned", (t) => {
  const f = fixture(t),
    prepared = prepareRealtimeStill(f.root, "demo", f.draft),
    directory = path.dirname(f.file),
    moved = directory + "-owned";
  try {
    fs.renameSync(directory, moved);
    symlinkSync(moved, directory);
    assert.throws(prepared.recheck, /parent changed/);
    assert.equal(f.store.read().sequence, 0);
  } finally {
    prepared.close();
  }
});

test("new asset draft preserves accepted derive image pin and old Split byte guards without decoding", (t) => {
  const f = fixture(t);
  assertSplitOriginal(f.file, f.asset.hash, "image");
  f.service.mutate({ action: "add-asset", editorId: "edit", expected: 0, draft: f.draft });
  const old = f.store.request("still"),
    requestBytes = readFileSync(path.join(f.root, f.store.read().revisions[0].request.path));
  f.store.derive(1, {
    sourceRevision: "still",
    revisionId: "derived",
    sessionId: "derived-session",
    input: { prompt: "Second explicit direction", seed: 3 },
    quote: { ...old.quote, highUsd: 0.6, expectedUsd: 0.6, source: "Fresh explicit derive planning bound" },
  });
  assert.equal(f.store.request("derived").operation.input.image_url, old.operation.input.image_url);
  assert.deepEqual(readFileSync(path.join(f.root, f.store.read().revisions[0].request.path)), requestBytes);
  assert.equal(f.store.read().committedUsd, 0);
});
test("unsent draft bound is not a charge; existing handoff aggregate ceiling still blocks unaffordable input", (t) => {
  const f = fixture(t);
  f.service.mutate({ action: "add-asset", editorId: "edit", expected: 0, draft: { ...f.draft, highUsd: 2 } });
  assert.equal(f.store.read().committedUsd, 0);
  f.service.mutate({ action: "queue", editorId: "edit", expected: 1, revisionId: "still" });
  const before = readFileSync(path.join(f.store.directory, "002.json"));
  assert.throws(() => f.service.mutate({ action: "handoff", editorId: "edit", expected: 2 }), /ceiling/);
  assert.deepEqual(readFileSync(path.join(f.store.directory, "002.json")), before);
  assert.equal(f.store.read().committedUsd, 0);
});
test("full32 draft capacity refuses new asset publication without changing saved request/history members", (t) => {
  const f = fixture(t),
    prepared = prepareRealtimeStill(f.root, "demo", f.draft);
  try {
    for (let i = 0; i < 32; i++) f.store.add(i, { ...prepared.request, revisionId: "r" + i, sessionId: "s" + i });
  } finally {
    prepared.close();
  }
  const members = readdirSync(f.store.directory),
    state = readFileSync(path.join(f.store.directory, "032.json"));
  assert.throws(
    () => f.service.mutate({ action: "add-asset", editorId: "edit", expected: 32, draft: f.draft }),
    /capacity/,
  );
  assert.deepEqual(readdirSync(f.store.directory), members);
  assert.deepEqual(readFileSync(path.join(f.store.directory, "032.json")), state);
});
