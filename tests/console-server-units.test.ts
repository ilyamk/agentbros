/** Units of src/lib/local-server and the console URL helpers (RFC 0004 WP2). */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { injectNonce } from "../src/lib/console/http/static";
import { mediaUrl, printableConsoleUrl, sessionUrl, thumbUrl } from "../src/lib/console/urls";
import {
  contentSecurityPolicy,
  errorReply,
  HttpError,
  hostAllowed,
  isSafeRelativePath,
  openRegularFile,
  readCookie,
  resolveConfined,
  REVIEW_CSP,
  sessionCookie,
  splitRequestTarget,
  tokensEqual,
} from "../src/lib/local-server";
import { isSafeRelativePath as contractSafe } from "../src/types/console";

test("tokensEqual is exact and never throws on length mismatch", () => {
  assert.equal(tokensEqual("abc", "abc"), true);
  assert.equal(tokensEqual("abd", "abc"), false);
  assert.equal(tokensEqual("ab", "abc"), false);
  assert.equal(tokensEqual(undefined, "abc"), false);
  assert.equal(tokensEqual("", ""), false);
});

test("hostAllowed accepts only the loopback names with this port", () => {
  assert.equal(hostAllowed("127.0.0.1:4317", 4317), true);
  assert.equal(hostAllowed("localhost:4317", 4317), true);
  assert.equal(hostAllowed("localhost:4317", 4317, { localhost: false }), false);
  for (const host of ["127.0.0.1", "127.0.0.1:4318", "0.0.0.0:4317", "evil.test:4317", "[::1]:4317", undefined])
    assert.equal(hostAllowed(host, 4317), false, String(host));
});

test("splitRequestTarget decodes segments without normalising dot segments", () => {
  assert.deepEqual(splitRequestTarget("/media/p/../x").segments, ["media", "p", "..", "x"]);
  assert.deepEqual(splitRequestTarget("/media/p/%2e%2e/x").segments, ["media", "p", "..", "x"]);
  assert.deepEqual(splitRequestTarget("/media/p/a%2Fb").segments, ["media", "p", "a/b"]);
  assert.deepEqual(splitRequestTarget("/").segments, []);
  assert.equal(splitRequestTarget("/a?x=1&y=2").query.get("y"), "2");
  assert.throws(() => splitRequestTarget("/a/%E0%A4%A"), HttpError);
  assert.throws(() => splitRequestTarget("http://evil/"), HttpError);
});

test("isSafeRelativePath matches the contract's rule", () => {
  for (const value of [
    "a",
    "a/b.mp4",
    "@out/x",
    "../a",
    "a/../b",
    "/a",
    "a//b",
    "a\\b",
    "C:/x",
    "file:x",
    "a/./b",
    "",
    "a\u0000",
  ])
    assert.equal(isSafeRelativePath(value), contractSafe(value), JSON.stringify(value));
});

test("resolveConfined refuses symlink segments and openRegularFile refuses non-files", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-confine-")));
  try {
    mkdirSync(path.join(base, "dir"));
    writeFileSync(path.join(base, "dir/a.txt"), "a");
    symlinkSync(path.join(base, "dir"), path.join(base, "link"));
    symlinkSync(path.join(base, "dir/a.txt"), path.join(base, "dir/b.txt"));
    assert.equal(resolveConfined(base, "dir/a.txt"), path.join(base, "dir/a.txt"));
    for (const relative of ["link/a.txt", "dir/b.txt", "../x", "/etc/passwd"])
      assert.throws(
        () => resolveConfined(base, relative),
        (error: HttpError) => error.status === 403,
        relative,
      );
    assert.throws(
      () => resolveConfined(base, "dir/none.txt"),
      (error: HttpError) => error.status === 404,
    );
    assert.throws(
      () => openRegularFile(path.join(base, "dir")),
      (error: HttpError) => error.status === 403,
    );
    assert.throws(
      () => openRegularFile(path.join(base, "dir/b.txt")),
      (error: HttpError) => error.status === 403,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("openRegularFile rejects a FIFO without blocking the server", { skip: process.platform === "win32" }, (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "console-fifo-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fifo = path.join(directory, "media.mp4");
  execFileSync("mkfifo", [fifo]);
  const probe = path.join(directory, "probe.ts");
  writeFileSync(
    probe,
    [
      'import assert from "node:assert/strict";',
      `import { openRegularFile } from ${JSON.stringify(path.resolve("src/lib/local-server/paths.ts"))};`,
      `assert.throws(() => openRegularFile(${JSON.stringify(fifo)}), { status: 403 });`,
    ].join("\n"),
  );
  const child = spawnSync("pnpm", ["exec", "tsx", probe], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
});

test("cookies, CSP, nonce injection and error replies", () => {
  assert.equal(readCookie("a=1; agentbros_console=tok; b=2", "agentbros_console"), "tok");
  assert.equal(readCookie(undefined, "x"), "");
  assert.equal(sessionCookie("agentbros_console", "abc"), "agentbros_console=abc; HttpOnly; SameSite=Strict; Path=/");
  assert.throws(() => sessionCookie("a;b", "c"));
  const directives = (csp: string) => new Set(csp.split("; "));
  assert.deepEqual(directives(contentSecurityPolicy()), directives(REVIEW_CSP));
  assert.match(
    contentSecurityPolicy({ styleNonce: "n0", fonts: true }),
    /style-src 'self' 'nonce-n0'.*font-src 'self'/,
  );
  assert.equal(
    injectNonce("<html><head><title>x</title></head></html>", "n1"),
    '<html><head>\n    <meta name="csp-nonce" content="n1"><title>x</title></head></html>',
  );
  assert.deepEqual(errorReply(new HttpError(409, "CONFLICT", "stale")), {
    status: 409,
    body: { ok: false, error: "CONFLICT", message: "stale" },
  });
  assert.equal(errorReply(new Error("nope")).status, 400);
  assert.equal(errorReply(new Error("x"), () => true).status, 409);
});

test("pnpm console prints the token URL only to a terminal or with --print-token (D15)", () => {
  const token = "a".repeat(64);
  const started = { url: sessionUrl("http://127.0.0.1:4317", token, "promo-acme"), baseUrl: "http://127.0.0.1:4317/" };
  const piped = printableConsoleUrl(started, { project: "promo-acme", isTTY: false });
  assert.deepEqual(piped, { url: "http://127.0.0.1:4317/#/projects/promo-acme", tokenInUrl: false });
  assert.ok(!piped.url.includes(token));
  assert.deepEqual(printableConsoleUrl(started, {}), { url: "http://127.0.0.1:4317/", tokenInUrl: false });
  assert.deepEqual(printableConsoleUrl(started, { isTTY: true }), { url: started.url, tokenInUrl: true });
  assert.deepEqual(printableConsoleUrl(started, { printToken: true }), { url: started.url, tokenInUrl: true });
});

test("URL helpers encode paths and keep the token in the fragment", () => {
  assert.equal(mediaUrl("p", { path: "renders/a b.mp4" }), "/media/p/renders/a%20b.mp4");
  assert.equal(mediaUrl("p", { root: "out", path: "vertical.mp4" }), "/media/p/@out/vertical.mp4");
  assert.equal(thumbUrl("p", { path: "x.mp4" }, { t: 1.5, w: 320 }), "/thumb/p/x.mp4?t=1.5&w=320");
  assert.equal(sessionUrl("http://127.0.0.1:4317", "ab", "p"), "http://127.0.0.1:4317/#token=ab&project=p");
});
