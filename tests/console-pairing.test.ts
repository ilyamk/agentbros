/**
 * One-use pairing links (RFC 0004 D15, A1; src/lib/console/pairing.ts): a code is single use, expires, is capped at
 * five outstanding, is stored only as an HMAC bound to this checkout's token (0600), and is redeemed only by a
 * same-origin `POST /api/session/pair`, which returns the token and sets the media cookie; every pairing is recorded.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { consoleCookieName, mediaReadValue } from "../src/lib/console/http/auth";
import {
  browserFamily,
  issuePairingCode,
  PAIR_MAX_OUTSTANDING,
  PAIR_TTL_MS,
  PAIRING_FILE,
  pairedBrowsers,
  pairingUrl,
  redeemPairingCode,
} from "../src/lib/console/pairing";
import type { ConsoleServer } from "../src/lib/console/server";
import { makeRoot, raw, removeRoot, startTestServer } from "./helpers/console-server";

describe("pairing codes", () => {
  let root: string;
  before(() => (root = makeRoot()));
  after(() => removeRoot(root));

  test("single use, never stored in clear, file 0600", () => {
    const code = issuePairingCode(root);
    assert.match(code, /^[a-f0-9]{32}$/);
    const file = path.join(root, PAIRING_FILE);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!readFileSync(file, "utf8").includes(code), "only an HMAC of the code is stored");
    assert.equal(redeemPairingCode(root, code, { userAgent: "curl/8.7.1" }), true);
    assert.equal(redeemPairingCode(root, code), false, "single use");
    assert.equal(pairedBrowsers(root).at(-1)?.agent, "curl");
    assert.ok(!readFileSync(file, "utf8").includes("8.7.1"), "only the browser family is kept");
  });

  test("expires after the TTL", () => {
    const now = new Date();
    const code = issuePairingCode(root, now);
    assert.equal(redeemPairingCode(root, code, { now: new Date(now.getTime() + PAIR_TTL_MS + 1) }), false);
  });

  test("at most five outstanding: the oldest goes first", () => {
    const codes = Array.from({ length: PAIR_MAX_OUTSTANDING + 1 }, () => issuePairingCode(root));
    assert.equal(redeemPairingCode(root, codes[0]!), false, "evicted");
    for (const code of codes.slice(1)) assert.equal(redeemPairingCode(root, code), true);
  });

  test("bound to this checkout's token; malformed codes are refused", () => {
    const code = issuePairingCode(root);
    assert.equal(redeemPairingCode(root, code, { token: "b".repeat(64) }), false, "another checkout's token");
    for (const bad of ["", "x".repeat(32), code.toUpperCase(), `${code}0`])
      assert.equal(redeemPairingCode(root, bad), false);
  });

  test("URLs and browser families", () => {
    assert.equal(pairingUrl("http://127.0.0.1:4317/", "a".repeat(32)), `http://127.0.0.1:4317/#pair=${"a".repeat(32)}`);
    assert.equal(
      pairingUrl("http://127.0.0.1:4317", "c".repeat(32), "promo-acme", "timeline"),
      `http://127.0.0.1:4317/#pair=${"c".repeat(32)}&project=promo-acme&view=timeline`,
    );
    assert.equal(browserFamily("Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/18 Safari/605.1.15"), "Safari");
    assert.equal(browserFamily("Mozilla/5.0 AppleWebKit/537.36 Chrome/131.0 Safari/537.36"), "Chrome");
    assert.equal(browserFamily(undefined), "Unknown");
  });
});

describe("POST /api/session/pair", () => {
  let root: string;
  let server: ConsoleServer;
  const pair = (code: string, headers: Record<string, string>) =>
    raw(server.port, {
      method: "POST",
      path: "/api/session/pair",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ code }),
    });

  before(async () => {
    root = makeRoot();
    server = await startTestServer(root);
  });
  after(async () => {
    await server?.close();
    removeRoot(root);
  });

  test("a same-origin page exchanges a code once for the token and the media cookie", async () => {
    const code = issuePairingCode(root);
    const ok = await pair(code, { Origin: server.origin, "Sec-Fetch-Site": "same-origin", "User-Agent": "Chrome/131" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json(), { ok: true, token: server.token });
    const cookie = String(ok.headers["set-cookie"]);
    assert.ok(cookie.startsWith(`${consoleCookieName(server.token)}=${mediaReadValue(server.token)}; HttpOnly`));
    const again = await pair(code, { Origin: server.origin });
    assert.equal(again.status, 403);
    assert.doesNotMatch(again.text, new RegExp(server.token));
    // Recorded and listed for the header (Settings), not for the cookie.
    const listed = await raw(server.port, {
      path: "/api/session/pairings",
      headers: { "x-console-token": server.token },
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.json().paired.at(-1).agent, "Chrome");
    assert.equal(
      (await raw(server.port, { path: "/api/session/pairings", headers: { Cookie: cookie.split(";")[0]! } })).status,
      403,
    );
  });

  test("wrong or missing Origin, a cross-site fetch and a bad body are refused, and the code survives them", async () => {
    const code = issuePairingCode(root);
    const refused: Record<string, string>[] = [
      {},
      { Origin: "http://evil.example" },
      { Origin: `http://127.0.0.1:${server.port + 1}` },
      { Origin: server.origin, "Sec-Fetch-Site": "same-site" },
      { Origin: server.origin, "Sec-Fetch-Site": "cross-site" },
      { Origin: server.origin, "Sec-Fetch-Site": "none" },
    ];
    for (const headers of refused) assert.equal((await pair(code, headers)).status, 403, JSON.stringify(headers));
    const bad = await raw(server.port, {
      method: "POST",
      path: "/api/session/pair",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code, extra: 1 }),
    });
    assert.ok(bad.status >= 400 && bad.status < 500);
    assert.equal((await pair(code, { Origin: server.origin })).status, 200, "still redeemable by the page");
  });
});
