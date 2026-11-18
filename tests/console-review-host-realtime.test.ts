/**
 * RFC 0004 WP13a: the realtime review routes through the console's review host: list, create, add, view, request,
 * derive-source, still-sources, and the selected immutable preview served from `file?path=@realtime/…` with the opened
 * descriptor re-hashed (a corrupted frame is refused). Needs ffmpeg, like tests/review-realtime.test.ts.
 */
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { RealtimeEditorStore } from "../src/lib/realtime/editor";
import { postHeaders, raw, startTestServer } from "./helpers/console-server";
import { publishedFixture, realtimeReviewFixture } from "./helpers/review-realtime";

test("realtime routes and the SHA-verified @realtime preview work through /api/review/<project>/", async (t) => {
  const f = realtimeReviewFixture();
  const server = await startTestServer(f.root);
  t.after(async () => {
    await server.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  const auth = { "x-console-token": server.token };
  const get = (route: string, headers: Record<string, string> = auth) =>
    raw(server.port, { path: `/api/review/demo/${route}`, headers });
  const post = (body: unknown) =>
    raw(server.port, {
      method: "POST",
      path: "/api/review/demo/realtime",
      headers: postHeaders(server),
      body: JSON.stringify(body),
    });
  assert.deepEqual((await get("realtime")).json().editors, []);
  assert.equal((await post({ action: "create", editorId: "draft", ceilingUsd: 1 })).status, 200);
  assert.equal((await post({ action: "create", editorId: "draft", ceilingUsd: 1 })).status, 409);
  const store = new RealtimeEditorStore(f.root, "demo", "draft");
  store.add(0, f.request("first"));
  store.queue(1, "first");
  store.handoff(2);
  const listed = (await get("realtime")).json();
  assert.equal(listed.editors[0].editorId, "draft");
  assert.equal((await get("realtime?editor=draft")).json().sequence, 3);
  assert.equal((await get("realtime/request?editor=draft&revision=first")).status, 200);
  const stills = await get("realtime/still-sources");
  // Reaches the still service: without an asset registry it refuses (as in review:ui).
  assert.equal(stills.status, 400);
  assert.match(stills.json().message, /asset-registry\.json/);
  const capture = await publishedFixture(f, "first");
  const manifest = path.relative(f.project, capture.outputs[0]);
  const attach = await post({ action: "complete", editorId: "draft", expected: 3, revisionId: "first", manifest });
  assert.equal(attach.status, 200, attach.text);
  const derive = await get("realtime/derive-source?editor=draft&revision=first");
  assert.equal(derive.status, 200, derive.text);
  const selected = (await post({ action: "select", editorId: "draft", expected: 4, revisionId: "first" })).json();
  const file = `file?path=${encodeURIComponent(selected.frames[0].file)}`;
  const preview = await get(file);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers["content-type"], "image/png");
  const range = await get(file, { ...auth, Range: "bytes=0-15" });
  assert.equal(range.status, 206);
  assert.equal(range.body.length, 16);
  writeFileSync(capture.outputs[1], "corrupt");
  assert.equal((await get(file)).status, 400, "the opened descriptor no longer matches the selected SHA-256");
});
