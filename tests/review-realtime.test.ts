import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { startReviewServer } from "../src/lib/review-ui/server";
import { RealtimeEditorStore } from "../src/lib/realtime/editor";
import { realtimeReviewFixture, publishedFixture } from "./helpers/review-realtime";

test("realtime review routes preserve auth/origin/strict body bounds and offline CAS actions", async (t) => {
  const f = realtimeReviewFixture(),
    app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(async () => {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  const headers = { "x-review-token": app.token, "content-type": "application/json", origin: app.origin };
  const post = (input: unknown, h = headers) =>
    fetch(app.origin + "/api/realtime", { method: "POST", headers: h, body: JSON.stringify(input) });
  assert.equal((await fetch(app.origin + "/api/realtime")).status, 403);
  assert.equal(
    (await post({ action: "create", editorId: "draft", ceilingUsd: 1 }, { ...headers, origin: "https://evil.test" }))
      .status,
    403,
  );
  assert.equal(
    (await post({ action: "create", editorId: "draft", ceilingUsd: 1 }, { ...headers, origin: "" })).status,
    403,
  );
  assert.equal((await post({ action: "execute", editorId: "draft" })).status, 400);
  assert.equal((await post({ action: "create", editorId: "draft", ceilingUsd: 1, executable: "/bin/sh" })).status, 400);
  assert.equal((await post({ action: "create", editorId: "draft", ceilingUsd: 1 })).status, 200);
  assert.equal((await post({ action: "create", editorId: "draft", ceilingUsd: 1 })).status, 409);
  let state = await (await post({ action: "add", editorId: "draft", expected: 0, request: f.request("first") })).json();
  assert.equal(state.sequence, 1);
  assert.equal((await post({ action: "queue", editorId: "draft", expected: 0, revisionId: "first" })).status, 409);
  state = await (await post({ action: "queue", editorId: "draft", expected: 1, revisionId: "first" })).json();
  state = await (await post({ action: "handoff", editorId: "draft", expected: 2 })).json();
  assert.equal(state.committedUsd, 0.5);
  assert.equal(state.providerAck, false);
  assert.equal((await post({ action: "handoff", editorId: "draft", expected: 3 })).status, 400);
  assert.equal((await post({ action: "recover", editorId: "draft", expected: 3 })).status, 200);
  const store = new RealtimeEditorStore(f.root, "demo", "draft");
  assert.equal(store.read().revisions[0].status, "uncertain");
  assert.equal(store.read().committedUsd, 0.5);
  assert.equal(
    (
      await post({
        action: "add",
        editorId: "draft",
        expected: 4,
        request: { ...f.request("wrong"), projectId: "other" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await post({ action: "create", editorId: "a".repeat(100), ceilingUsd: 1, extra: "x".repeat(65536) })).status,
    400,
  );
  const listed = await (await fetch(app.origin + "/api/realtime", { headers })).json();
  assert.equal(listed.editors.length, 1);
  assert.equal(listed.offline, true);
  assert.equal(
    (await fetch(app.origin + "/api/realtime/request?editor=draft&revision=first", { headers })).status,
    200,
  );
});

test("verified published result selection uses authenticated range media and corruption/late/path checks", async (t) => {
  const f = realtimeReviewFixture(),
    app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(async () => {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  const headers = { "x-review-token": app.token, "content-type": "application/json", origin: app.origin };
  const post = (input: unknown) =>
    fetch(app.origin + "/api/realtime", { method: "POST", headers, body: JSON.stringify(input) });
  const store = new RealtimeEditorStore(f.root, "demo", "draft");
  store.create(1);
  store.add(0, f.request("first"));
  store.queue(1, "first");
  store.handoff(2);
  const capture = await publishedFixture(f, "first"),
    manifest = path.relative(f.project, capture.outputs[0]);
  for (const invalid of [capture.outputs[0], "../../outside.json", "image.png"])
    assert.equal(
      (await post({ action: "complete", editorId: "draft", expected: 3, revisionId: "first", manifest: invalid }))
        .status,
      400,
    );
  const attach = await post({ action: "complete", editorId: "draft", expected: 3, revisionId: "first", manifest });
  assert.equal(attach.status, 200, await attach.text());
  assert.equal(
    (await post({ action: "complete", editorId: "draft", expected: 4, revisionId: "first", manifest })).status,
    400,
  );
  const selected = await (await post({ action: "select", editorId: "draft", expected: 4, revisionId: "first" })).json();
  assert.equal(selected.frames.length, 1);
  const url = app.origin + "/file?path=" + encodeURIComponent(selected.frames[0].file);
  assert.equal((await fetch(url)).status, 403);
  const range = await fetch(url, { headers: { ...headers, range: "bytes=0-15" } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 16);
  assert.equal((await fetch(url, { headers: { ...headers, range: "bytes=99999999-" } })).status, 416);
  store.add(5, f.request("second"));
  store.queue(6, "second");
  store.handoff(7);
  const red = path.join(f.project, "red.png");
  const redImage = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x32",
    "-frames:v",
    "1",
    red,
  ]);
  assert.equal(redImage.status, 0);
  const second = await publishedFixture(f, "second", readFileSync(red));
  store.complete(8, "second", second.outputs[0]);
  store.select(9, "second");
  const newer = app.service.realtime.view("draft");
  assert.notEqual(newer.frames[0].file, selected.frames[0].file);
  assert.notEqual(newer.frames[0].sha256, selected.frames[0].sha256);
  assert.equal(
    (await fetch(url, { headers })).status,
    400,
    "Old view reference must never redirect to new selected bytes",
  );
  const newUrl = app.origin + "/file?path=" + encodeURIComponent(newer.frames[0].file);
  assert.equal((await fetch(newUrl, { headers })).status, 200);
  writeFileSync(second.outputs[1], "corrupt");
  assert.equal((await fetch(newUrl, { headers })).status, 400);
  const status = await fetch(app.origin + "/api/realtime?editor=draft", { headers });
  assert.equal(status.status, 400);
});

test("project-file add supports bounded originals without expanding HTTP body and rejects symlinks", async (t) => {
  const f = realtimeReviewFixture(),
    app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(async () => {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  const store = new RealtimeEditorStore(f.root, "demo", "draft");
  store.create(1);
  writeFileSync(path.join(f.project, "input.json"), JSON.stringify(f.request("first")));
  const post = (requestFile: string) =>
    fetch(app.origin + "/api/realtime", {
      method: "POST",
      headers: { "x-review-token": app.token, origin: app.origin, "content-type": "application/json" },
      body: JSON.stringify({ action: "add-file", editorId: "draft", expected: 0, requestFile }),
    });
  assert.equal((await post("../other/input.json")).status, 400);
  symlinkSync(path.join(f.project, "input.json"), path.join(f.project, "linked.json"));
  assert.equal((await post("linked.json")).status, 400);
  assert.equal((await post("input.json")).status, 200);
  assert.equal(store.read().sequence, 1);
});
