import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPublicDestination } from "../src/lib/media-fetch/http";
import { addReference } from "../src/lib/reference/add";

const repo = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repo, "node_modules/tsx/dist/cli.mjs");
// Literal hosts and localhost names are refused without any DNS query or download.
const internal = [
  "http://127.0.0.1/a.mp4",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]/a.mp4",
  "http://[::ffff:127.0.0.1]/a.mp4",
  "http://10.0.0.8/a.mp4",
  "http://192.168.1.2/a.mp4",
  "http://localhost/a.mp4",
  "http://cam.local/a.mp4",
  "https://user:pass" + "@example.com/a.mp4",
  "file:///etc/passwd",
  "ftp://example.com/a.mp4",
];

test("the reference link pre-flight refuses private, loopback, link-local and non-http destinations", async () => {
  for (const url of internal) await assert.rejects(assertPublicDestination(url), /non-public|forbidden|Invalid/i, url);
  assert.equal((await assertPublicDestination("https://93.184.215.14/a.mp4")).hostname, "93.184.215.14");
});

test("addReference refuses an internal link before yt-dlp runs", (t) => {
  const library = mkdtempSync(path.join(tmpdir(), "ref-add-url-"));
  t.after(() => rmSync(library, { recursive: true, force: true }));
  const previous = process.env.REFERENCE_UVX;
  process.env.REFERENCE_UVX = "/nonexistent/uvx-must-not-run";
  t.after(() => {
    if (previous === undefined) delete process.env.REFERENCE_UVX;
    else process.env.REFERENCE_UVX = previous;
  });
  for (const url of internal)
    assert.throws(
      () => addReference({ url, id: "internal", libraryRoot: library }),
      /Only public http and https links/,
      url,
    );
  assert.equal(existsSync(path.join(library, "internal")), false);
});

test("ref:add answers one INVALID_INPUT envelope for an internal link", (t) => {
  const library = mkdtempSync(path.join(tmpdir(), "ref-add-url-cli-"));
  t.after(() => rmSync(library, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [tsx, path.join(repo, "scripts/ref-add.ts"), "--url", "http://169.254.169.254/x.mp4", "--library-root", library],
    {
      encoding: "utf8",
      cwd: repo,
      env: { ...process.env, REFERENCE_UVX: "/nonexistent/uvx-must-not-run" },
      timeout: 30000,
    },
  );
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const envelope = JSON.parse(lines[0]!);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, "INVALID_INPUT");
});
