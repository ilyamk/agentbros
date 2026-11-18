/**
 * Console media and thumbnails (RFC 0004 FR7, WP2): Range 206/416, HEAD, `@out/` renders, text documents as
 * text/plain, ffmpeg thumbnails cached by content hash, and a missing ffmpeg as a JSON 503.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { parseRange } from "../src/lib/local-server/range";
import type { ConsoleServer } from "../src/lib/console/server";
import { mediaUrl, thumbUrl } from "../src/lib/console/urls";
import { makeRoot, PROJECT, raw, removeRoot, startTestServer } from "./helpers/console-server";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

describe("console media", () => {
  let root: string;
  let server: ConsoleServer;
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  const auth = () => ({ "x-console-token": server.token });

  before(async () => {
    root = makeRoot();
    const project = path.join(root, "public/projects", PROJECT);
    mkdirSync(path.join(project, "renders"), { recursive: true });
    writeFileSync(path.join(project, "renders/clip.mp4"), bytes);
    writeFileSync(path.join(project, "renders/empty.mp4"), "");
    writeFileSync(path.join(project, "notes.md"), "# <script>alert(1)</script>");
    writeFileSync(path.join(project, "strategy.json"), "{}");
    writeFileSync(path.join(project, "animatic.html"), "<!doctype html><title>Animatic</title>");
    writeFileSync(path.join(project, "bundle.js"), "alert(1)");
    mkdirSync(path.join(root, "out", PROJECT), { recursive: true });
    writeFileSync(path.join(root, "out", PROJECT, "vertical.mp4"), bytes);
    server = await startTestServer(root);
  });
  after(async () => {
    await server?.close();
    removeRoot(root);
  });

  test("parseRange follows the review server's rules", () => {
    assert.deepEqual(parseRange(undefined, 10), { start: 0, end: 9, partial: false });
    assert.deepEqual(parseRange("bytes=2-5", 10), { start: 2, end: 5, partial: true });
    assert.deepEqual(parseRange("bytes=7-", 10), { start: 7, end: 9, partial: true });
    assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9, partial: true });
    assert.deepEqual(parseRange("bytes=2-50", 10), { start: 2, end: 9, partial: true });
    for (const bad of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=0-1,3-4", "items=0-1", "bytes=-"])
      assert.equal(parseRange(bad, 10), null, bad);
  });

  test("full GET, 206 ranges, 416 and HEAD", async () => {
    const url = mediaUrl(PROJECT, { path: "renders/clip.mp4" });
    const full = await raw(server.port, { path: url, headers: auth() });
    assert.equal(full.status, 200);
    assert.equal(full.headers["content-type"], "video/mp4");
    assert.equal(full.headers["accept-ranges"], "bytes");
    assert.deepEqual(full.body, bytes);
    const part = await raw(server.port, { path: url, headers: { ...auth(), Range: "bytes=100-199" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers["content-range"], "bytes 100-199/1000");
    assert.deepEqual(part.body, bytes.subarray(100, 200));
    const suffix = await raw(server.port, { path: url, headers: { ...auth(), Range: "bytes=-10" } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(suffix.body, bytes.subarray(990));
    const bad = await raw(server.port, { path: url, headers: { ...auth(), Range: "bytes=5000-" } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers["content-range"], "bytes */1000");
    const head = await raw(server.port, { method: "HEAD", path: url, headers: { ...auth(), Range: "bytes=0-9" } });
    assert.equal(head.status, 206);
    assert.equal(head.headers["content-length"], "10");
    assert.equal(head.body.length, 0);
    const empty = await raw(server.port, { path: mediaUrl(PROJECT, { path: "renders/empty.mp4" }), headers: auth() });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.length, 0);
  });

  test("renders and text documents are served, structured data and executable files are refused", async () => {
    const out = await raw(server.port, {
      path: mediaUrl(PROJECT, { root: "out", path: "vertical.mp4" }),
      headers: { ...auth(), Range: "bytes=0-0" },
    });
    assert.equal(out.status, 206);
    const notes = await raw(server.port, { path: mediaUrl(PROJECT, { path: "notes.md" }), headers: auth() });
    assert.equal(notes.status, 200);
    assert.equal(notes.headers["content-type"], "text/plain; charset=utf-8");
    for (const file of ["strategy.json", "animatic.html", "bundle.js"]) {
      const refused = await raw(server.port, { path: mediaUrl(PROJECT, { path: file }), headers: auth() });
      assert.equal(refused.status, 403, file);
    }
    const query = await raw(server.port, { path: `${mediaUrl(PROJECT, { path: "notes.md" })}?x=1`, headers: auth() });
    assert.equal(query.status, 400);
  });

  test(
    "thumbnails: a JPEG frame cached by content hash and parameters",
    { skip: !hasFfmpeg && "ffmpeg not installed" },
    async () => {
      const project = path.join(root, "public/projects", PROJECT);
      const made = spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=red:s=64x36:d=1:r=10",
          "-pix_fmt",
          "yuv420p",
          "-y",
          path.join(project, "renders/red.mp4"),
        ],
        { stdio: "ignore" },
      );
      assert.equal(made.status, 0);
      const url = thumbUrl(PROJECT, { path: "renders/red.mp4" }, { t: 0.5, w: 32 });
      const first = await raw(server.port, { path: url, headers: auth() });
      assert.equal(first.status, 200, first.text);
      assert.equal(first.headers["content-type"], "image/jpeg");
      assert.equal(first.body[0], 0xff);
      assert.equal(first.body[1], 0xd8);
      const cache = path.join(root, "out/console/cache/thumbs");
      const count = () => readdirSync(cache).flatMap((dir) => readdirSync(path.join(cache, dir))).length;
      assert.equal(count(), 1);
      const second = await raw(server.port, { path: url, headers: auth() });
      assert.deepEqual(second.body, first.body);
      assert.equal(count(), 1, "served from the cache");
      await raw(server.port, {
        path: thumbUrl(PROJECT, { path: "renders/red.mp4" }, { t: 0.5, w: 200 }),
        headers: auth(),
      });
      assert.equal(count(), 2, "other parameters, other entry");
      const badQuery = await raw(server.port, { path: `${url}&z=1`, headers: auth() });
      assert.equal(badQuery.status, 400);
      const tooWide = await raw(server.port, {
        path: thumbUrl(PROJECT, { path: "renders/red.mp4" }, { w: 5000 }),
        headers: auth(),
      });
      assert.equal(tooWide.status, 400);
    },
  );

  test("a missing ffmpeg is a JSON FFMPEG_MISSING error", async () => {
    const other = await startTestServer(root, { ffmpeg: path.join(root, "no-such-ffmpeg") });
    try {
      const res = await raw(other.port, {
        path: thumbUrl(PROJECT, { path: "renders/clip.mp4" }, { t: 1, w: 64 }),
        headers: { "x-console-token": other.token },
      });
      assert.equal(res.status, 503);
      assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
      assert.equal(res.json().error, "FFMPEG_MISSING");
      assert.equal(existsSync(path.join(root, "out/console/cache/thumbs/none")), false);
    } finally {
      await other.close();
    }
  });
});
