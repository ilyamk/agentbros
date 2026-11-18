/**
 * RFC 0004 WP13a: the review host on the console server. Every review:ui route under `/api/review/<project>/…` against
 * the unchanged services, and the parity plan's security and session behaviours adapted to the console's session
 * (the review:ui parity checklist, "Security and session behaviours" 1–16, RU-H04–H07, RU-SE07).
 */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { consoleCookieName } from "../src/lib/console/http/auth";
import type { ConsoleServer } from "../src/lib/console/server";
import { REVIEW_ACTIONS, REVIEW_READS } from "../src/lib/console/review/routes";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { makeRoot, PROJECT, postHeaders, raw, removeRoot, startTestServer } from "./helpers/console-server";

const BARE = "bare-film";
const base = `/api/review/${PROJECT}`;

function timeline(projectId: string) {
  return {
    version: 1 as const,
    projectId,
    timebase: { num: 30, den: 1 },
    tracks: [
      {
        id: "visual",
        kind: "visual" as const,
        clips: [
          {
            id: "hook",
            assetId: "scene:hook",
            start: { num: 0, den: 1 },
            source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
            rate: { num: 1, den: 1 },
            transition: { kind: "cut" as const },
            captions: [],
          },
        ],
      },
    ],
  };
}

const move = (start: number) => ({ type: "move", trackId: "visual", clipId: "hook", start: { num: start, den: 1 } });

describe("console review host", () => {
  let root: string;
  let server: ConsoleServer;
  let cookie: string;
  const auth = () => ({ "x-console-token": server.token });
  const get = (route: string, headers: Record<string, string> = auth()) =>
    raw(server.port, { path: `${base}/${route}`, headers });
  const post = (route: string, body: unknown, headers: Record<string, string> = postHeaders(server)) =>
    raw(server.port, {
      method: "POST",
      path: `${base}/${route}`,
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  before(async () => {
    root = makeRoot();
    const project = path.join(root, "public/projects", PROJECT);
    writeFileSync(path.join(project, "pipeline/qa.md"), "<script>window.hacked=true</script>");
    writeFileSync(path.join(project, "pipeline/qa.json"), "x".repeat(2 * 1024 * 1024 + 1));
    writeFileSync(path.join(project, ".env"), "SECRET=1\n");
    mkdirSync(path.join(root, "out", PROJECT), { recursive: true });
    writeFileSync(path.join(root, "out", PROJECT, "landscape.mp4"), Buffer.alloc(4096, 1));
    new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json")).initialize(timeline(PROJECT));
    // An uninitialized project (no journal), a symlinked alias and a campaign container.
    mkdirSync(path.join(root, "public/projects", BARE, "pipeline"), { recursive: true });
    writeFileSync(path.join(root, "public/projects", BARE, "project.json"), "{}");
    symlinkSync(project, path.join(root, "public/projects/alias-film"));
    const campaign = path.join(root, "public/projects/spring-campaign/pipeline/campaign-production");
    mkdirSync(campaign, { recursive: true });
    writeFileSync(path.join(campaign, "owner.json"), JSON.stringify({ version: 1, campaignId: "spring-campaign" }));
    server = await startTestServer(root);
    const session = await raw(server.port, { method: "POST", path: "/api/session", headers: postHeaders(server) });
    cookie = String(session.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    assert.ok(cookie.startsWith(consoleCookieName(server.token) + "="));
  });

  after(async () => {
    await server?.close();
    removeRoot(root);
  });

  test("route table mirrors every review:ui JSON route", () => {
    assert.deepEqual(Object.keys(REVIEW_READS).sort(), [
      "compare",
      "realtime",
      "realtime/channel-state",
      "realtime/derive-source",
      "realtime/request",
      "realtime/still-sources",
      "review-pack",
      "state",
    ]);
    assert.deepEqual(Object.keys(REVIEW_ACTIONS).sort(), [
      "audio-position-proposal",
      "authored-copy-proposal",
      "chapter-inspection",
      "dry-run",
      "group-move-proposal",
      "mutate",
      "realtime",
      "realtime/channel-ticket",
      "visual-reframe-proposal",
      "visual-remove-proposal",
      "visual-slip-proposal",
      "visual-split-proposal",
    ]);
  });

  test("state, dry-run, edit, undo, redo, snapshot, compare and choose run through the unchanged service", async () => {
    const state = (await get("state")).json();
    assert.equal(state.projectId, PROJECT);
    assert.equal(state.revision, 0);
    assert.equal(state.budget.status, "uninitialized");
    assert.ok(state.outputs.includes("@out/landscape.mp4"));
    const dry = await post("dry-run", { expectedRevision: 0, command: move(15) });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json().revision, 0);
    assert.match(dry.json().timelineHash, /^[a-f0-9]{64}$/);
    assert.equal((await get("state")).json().revision, 0, "dry-run never writes");
    const edited = await post("mutate", { action: "edit", expectedRevision: 0, command: move(15) });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.json().revision, 1);
    assert.equal((await post("mutate", { action: "undo", expectedRevision: 1 })).json().redoCount, 1);
    assert.equal((await post("mutate", { action: "redo", expectedRevision: 2 })).json().revision, 3);
    const snap = (await post("mutate", { action: "snapshot", expectedRevision: 3, label: "take one" })).json();
    assert.equal(snap.snapshots.length, 1);
    const hash = snap.snapshots[0].hash;
    const compared = (await get(`compare?left=current&right=${hash}`)).json();
    assert.equal(compared.equal, true);
    const chosen = await post("mutate", { action: "choose", expectedRevision: 3, snapshotHash: hash, actor: "me" });
    assert.equal(chosen.json().selected.snapshotHash, hash);
  });

  test("409 for a stale revision, 400 for other errors, 404 for an unknown route", async () => {
    const stale = await post("mutate", { action: "edit", expectedRevision: 99, command: move(3) });
    assert.equal(stale.status, 409);
    assert.equal(stale.json().error, "CONFLICT");
    assert.equal((await post("dry-run", { expectedRevision: 99, command: move(3) })).status, 409);
    const shell = await post("mutate", { action: "shell", command: "rm -rf /" });
    assert.equal(shell.status, 400, "no exec surface: unknown actions fail the schema");
    assert.equal((await post("group-move-proposal", {})).status, 400);
    assert.equal((await get("render")).status, 404);
    assert.equal((await post("generate", {})).status, 404, "no paid or provider route");
    assert.equal((await get("realtime/request?editor=missing&revision=x")).status, 400);
  });

  test("bodies: exact application/json, 64 KiB, strict schemas", async () => {
    const body = { expectedRevision: 0, command: move(3) };
    const charset = await post(
      "dry-run",
      body,
      postHeaders(server, { "Content-Type": "application/json; charset=utf-8" }),
    );
    assert.equal(charset.status, 400);
    assert.match(charset.json().message, /JSON content type required/);
    const big = await post("realtime", JSON.stringify({ action: "create", pad: "x".repeat(65 * 1024) }));
    assert.equal(big.status, 400);
    assert.match(big.json().message, /exceeds 64 KiB/);
    assert.equal((await post("dry-run", { ...body, extra: true })).status, 400);
    assert.equal(
      (await post("realtime/channel-ticket", { editorId: "e", localSessionId: "s", provider: "x" })).status,
      400,
    );
  });

  test("JSON reads need the x-console-token header; the cookie opens only the file route", async () => {
    const sameOrigin = { Cookie: cookie, "Sec-Fetch-Site": "same-origin" };
    assert.equal((await get("state", {})).status, 403);
    assert.equal((await get("state", { "x-console-token": "f".repeat(64) })).status, 403);
    assert.equal((await get("state", { "x-console-token": "é".repeat(64) })).status, 403);
    assert.equal((await get("state", sameOrigin)).status, 403, "cookie is not enough for review JSON");
    assert.equal((await get("realtime", sameOrigin)).status, 403);
    const file = await get("file?path=%40out%2Flandscape.mp4", sameOrigin);
    assert.equal(file.status, 200);
    assert.equal(file.headers["content-type"], "video/mp4");
    const head = await raw(server.port, {
      method: "HEAD",
      path: `${base}/file?path=%40out%2Flandscape.mp4`,
      headers: { Cookie: cookie },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-length"], "4096");
    assert.equal((await get("file?path=%40out%2Flandscape.mp4", {})).status, 403);
    // POST: the cookie never authenticates a mutation.
    const cookieOnly = { Cookie: cookie, Origin: server.origin, "Content-Type": "application/json" };
    assert.equal((await post("mutate", { action: "undo", expectedRevision: 0 }, cookieOnly)).status, 403);
  });

  test("Host must be 127.0.0.1:<port> or localhost:<port>; a present Origin must be exact; POST needs Origin", async () => {
    for (const host of ["evil.example", `evil.example:${server.port}`, `127.0.0.1:${server.port + 1}`])
      assert.equal((await get("state", { ...auth(), Host: host })).status, 403, host);
    assert.equal((await get("state", { ...auth(), Host: `localhost:${server.port}` })).status, 200);
    assert.equal((await get("state", { ...auth(), Origin: "https://attacker.invalid" })).status, 403);
    assert.equal((await get("state", { ...auth(), "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await get("state", { ...auth(), "Sec-Fetch-Site": "same-site" })).status, 403);
    const body = { expectedRevision: 0, command: move(3) };
    const { Origin: _origin, ...noOrigin } = postHeaders(server);
    assert.equal((await post("dry-run", body, noOrigin)).status, 403);
    assert.equal((await post("dry-run", body, postHeaders(server, { Origin: "http://127.0.0.1:1" }))).status, 403);
    assert.equal(
      (await post("dry-run", body, postHeaders(server, { Origin: `http://localhost:${server.port}` }))).status,
      403,
      "the Origin must match the Host the request came through",
    );
  });

  test("every review response carries the security headers and the console CSP", async () => {
    for (const res of [
      await get("state"),
      await get("file?path=pipeline%2Fqa.md"),
      await get("state", {}),
      await post("mutate", { action: "shell" }),
    ]) {
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      const csp = String(res.headers["content-security-policy"]);
      for (const directive of [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self'",
        "media-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ])
        assert.ok(csp.includes(directive), `${directive} in ${csp}`);
    }
  });

  test("request and header timeouts are 10 s", () => {
    assert.equal(server.server.requestTimeout, 10_000);
    assert.equal(server.server.headersTimeout, 10_000);
  });

  test("file: review allowlist, reports as text/plain capped at 2 MiB, Range and 416", async () => {
    const report = await get("file?path=pipeline%2Fqa.md");
    assert.equal(report.status, 200);
    assert.match(String(report.headers["content-type"]), /^text\/plain/);
    assert.match(report.text, /<script>/, "served as text, never as HTML");
    const capped = await get("file?path=pipeline%2Fqa.json");
    assert.equal(capped.status, 400);
    assert.match(capped.json().message, /exceeds 2 MiB/);
    for (const file of [
      ".env",
      "../../.env",
      "project.json",
      "pipeline/timeline-edit.json",
      `../${BARE}/project.json`,
      "@realtime/x/y/0",
    ])
      assert.equal((await get(`file?path=${encodeURIComponent(file)}`)).status, 400, file);
    const range = await get("file?path=%40out%2Flandscape.mp4", { ...auth(), Range: "bytes=0-15" });
    assert.equal(range.status, 206);
    assert.equal(range.body.length, 16);
    assert.equal(range.headers["content-range"], "bytes 0-15/4096");
    assert.equal((await get("file?path=%40out%2Flandscape.mp4", { ...auth(), Range: "bytes=99999-" })).status, 416);
  });

  test("a symlinked report is refused (O_NOFOLLOW, ancestors real-pathed)", async () => {
    const project = path.join(root, "public/projects", PROJECT);
    symlinkSync(path.join(project, ".env"), path.join(project, "pipeline/editorial-qa.md"));
    try {
      assert.equal((await get("file?path=pipeline%2Feditorial-qa.md")).status, 400);
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(path.join(project, "pipeline/editorial-qa.md"));
    }
  });

  test("project ids are validated and confined: invalid 400, missing 404, symlinked project 403", async () => {
    assert.equal((await raw(server.port, { path: "/api/review/..%2F..%2Fetc/state", headers: auth() })).status, 400);
    assert.equal((await raw(server.port, { path: "/api/review/Not_Valid/state", headers: auth() })).status, 400);
    const missing = await raw(server.port, { path: "/api/review/no-such-film/state", headers: auth() });
    assert.equal(missing.status, 404);
    assert.equal(missing.json().error, "PROJECT_NOT_FOUND");
    assert.equal((await raw(server.port, { path: "/api/review/alias-film/state", headers: auth() })).status, 403);
    // A reserved id (out/console belongs to the console) is refused even when such a folder exists.
    mkdirSync(path.join(root, "public/projects/console"), { recursive: true });
    writeFileSync(path.join(root, "public/projects/console/project.json"), "{}");
    const reserved = await raw(server.port, { path: "/api/review/console/state", headers: auth() });
    assert.equal(reserved.status, 400);
    assert.match(reserved.json().message, /reserved/);
    assert.equal(server.review.loaded("console"), false);
  });

  test("an uninitialized journal renders empty and edits refuse (RU-SE07)", async () => {
    const res = await raw(server.port, { path: `/api/review/${BARE}/state`, headers: auth() });
    assert.equal(res.status, 200, res.text);
    const state = res.json();
    assert.equal(state.revision, null);
    assert.equal(state.timelineHash, null);
    assert.deepEqual(state.tracks, []);
    assert.deepEqual(state.journal, []);
    assert.equal(state.redoCount, 0);
    const dry = await raw(server.port, {
      method: "POST",
      path: `/api/review/${BARE}/dry-run`,
      headers: postHeaders(server),
      body: JSON.stringify({ expectedRevision: 0, command: move(3) }),
    });
    assert.equal(dry.status, 400);
    const chapters = await raw(server.port, {
      method: "POST",
      path: `/api/review/${BARE}/chapter-inspection`,
      headers: postHeaders(server),
      body: JSON.stringify({
        expectedRevision: 0,
        timelineHash: "0".repeat(64),
        manifestSha256: null,
        format: "landscape",
      }),
    });
    assert.equal(chapters.status, 400);
  });

  test("services are created per project on first use and kept", async () => {
    const first = server.review.get(PROJECT);
    assert.equal(server.review.get(PROJECT), first);
    assert.notEqual(server.review.get(BARE).service, first.service);
    assert.equal(first.service.projectId, PROJECT);
  });

  test("a campaign container is served by the campaign handler by default: timeline routes are 404", async () => {
    const res = await raw(server.port, { path: "/api/review/spring-campaign/state", headers: auth() });
    assert.equal(res.status, 404);
    assert.equal(res.json().error, "CAMPAIGN_PROJECT");
    assert.equal(server.review.loaded("spring-campaign"), false);
  });

  test("a replacement campaign handler receives the campaign's review routes", async () => {
    const seen: string[] = [];
    const other = await startTestServer(root, {
      review: {
        campaign: async (_req, res, input) => {
          seen.push(`${input.project}:${input.rest.join("/")}`);
          if (input.rest[0] !== "state") return false;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ campaign: input.project }));
          return true;
        },
      },
    });
    try {
      const h = { "x-console-token": other.token };
      const res = await raw(other.port, { path: "/api/review/spring-campaign/state", headers: h });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json(), { campaign: "spring-campaign" });
      assert.equal((await raw(other.port, { path: "/api/review/spring-campaign/nope", headers: h })).status, 404);
      assert.deepEqual(seen, ["spring-campaign:state", "spring-campaign:nope"]);
    } finally {
      await other.close();
    }
  });
});
