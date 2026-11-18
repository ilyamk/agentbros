/**
 * RFC 0004 WP13e: campaign review on the console server (parity rows RU-CP01–06 and the campaign server differences
 * 17–20 of the review:ui parity checklist). Routes `GET campaign`, `POST selection` and `GET|HEAD file` under
 * `/api/review/<campaign>/`, behind the console's session rules; a campaign never gets timeline services.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { consoleCookieName, mediaReadValue } from "../src/lib/console/http/auth";
import { CAMPAIGN_PROJECT } from "../src/lib/console/review/campaign";
import { consoleReviewUrl } from "../src/lib/console/review/url";
import { sessionUrl } from "../src/lib/console/urls";
import type { ConsoleServer } from "../src/lib/console/server";
import { readSelection } from "../src/lib/campaigns/production/selection";
import { CAMPAIGN, makeCampaign } from "./helpers/campaign-review";
import { fileHash, fileHashAsync } from "../src/lib/campaigns/production/files";
import { makeRoot, postHeaders, raw, removeRoot, startTestServer } from "./helpers/console-server";

const base = `/api/review/${CAMPAIGN}`;

async function fixture(t: test.TestContext) {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  const campaign = await makeCampaign(root);
  // No review options: the console mounts the campaign handler by default (WP13f).
  const server = await startTestServer(root);
  t.after(() => server.close());
  return { root, server, ...campaign };
}

const auth = (server: ConsoleServer) => ({ "x-console-token": server.token });
const cookie = (server: ConsoleServer) => ({
  Cookie: `${consoleCookieName(server.token)}=${mediaReadValue(server.token)}`,
});

type State = {
  campaignId: string;
  planHash: string;
  selection: { revision: number; choices: { memberId: string; choice: string; note: string }[] };
  members: {
    id: string;
    excluded: boolean;
    heldForPilot: boolean;
    tasks: unknown[];
    outputs: { path: string; sha256: string }[];
  }[];
};

test("campaign state needs the token header and shows members with pinned outputs (RU-CP01, RU-CP02, RU-CP04)", async (t) => {
  const { server } = await fixture(t);
  assert.equal((await raw(server.port, { path: `${base}/campaign` })).status, 403);
  const viaCookie = await raw(server.port, {
    path: `${base}/campaign`,
    headers: { ...cookie(server), "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(viaCookie.status, 403, "JSON review reads need the header, like review:ui");
  const res = await raw(server.port, { path: `${base}/campaign`, headers: auth(server) });
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match(String(res.headers["content-security-policy"]), /media-src 'self'/);
  const state = res.json() as State;
  assert.equal(state.campaignId, CAMPAIGN);
  assert.match(state.planHash, /^[a-f0-9]{64}$/);
  assert.equal(state.selection.revision, 0);
  assert.equal(state.members.length, 1);
  assert.equal(state.members[0]!.id, "item");
  assert.deepEqual(
    state.members[0]!.outputs.map((pin) => pin.path),
    ["clip.mp4"],
  );
  assert.ok(state.members[0]!.tasks.length > 0);
});

test("host, origin and fetch-site rules apply to campaign routes", async (t) => {
  const { server } = await fixture(t);
  const get = (headers: Record<string, string>) => raw(server.port, { path: `${base}/campaign`, headers });
  assert.equal((await get({ ...auth(server), Host: "localhost:1" })).status, 403);
  assert.equal((await get({ ...auth(server), Origin: "http://evil.example" })).status, 403);
  assert.equal((await get({ ...auth(server), "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await get({ ...auth(server), "Sec-Fetch-Site": "same-site" })).status, 403);
});

test("file serves only receipt-pinned MP4s, with Range, HEAD, 416 and the media cookie (RU-CP04, item 19)", async (t) => {
  const { server, file } = await fixture(t);
  const bytes = readFileSync(file);
  const url = `${base}/file?path=clip.mp4`;
  assert.equal((await raw(server.port, { path: url })).status, 403);
  const whole = await raw(server.port, { path: url, headers: auth(server) });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers["content-type"], "video/mp4");
  assert.equal(whole.headers["accept-ranges"], "bytes");
  assert.deepEqual(whole.body, bytes);
  const part = await raw(server.port, { path: url, headers: { ...cookie(server), Range: "bytes=2-9" } });
  assert.equal(part.status, 206, "a <video> authenticates with the cookie");
  assert.equal(part.headers["content-range"], `bytes 2-9/${bytes.length}`);
  assert.deepEqual(part.body, bytes.subarray(2, 10));
  const head = await raw(server.port, { method: "HEAD", path: url, headers: auth(server) });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  const unsatisfiable = await raw(server.port, { path: url, headers: { ...auth(server), Range: "bytes=999999999-" } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers["content-range"], `bytes */${bytes.length}`);
  for (const other of ["../package.json", "item.json", "public/projects/item/project.json", ""]) {
    const refused = await raw(server.port, {
      path: `${base}/file?path=${encodeURIComponent(other)}`,
      headers: auth(server),
    });
    assert.equal(refused.status, 400, other);
    assert.match(refused.json().message, /outside the exact campaign render set/);
  }
  assert.equal(
    (await raw(server.port, { path: url, headers: { ...cookie(server), "Sec-Fetch-Site": "cross-site" } })).status,
    403,
  );
});

test("file verifies only the requested render, memoised by identity; errors carry no absolute path", async (t) => {
  const { server, root, file } = await fixture(t);
  const url = `${base}/file?path=clip.mp4`;
  // Another pinned output of the plan changes: /file does not re-verify it (the state route applies currency).
  const other = readdirSync(root).find((name) => name.endsWith(".json") && name !== "package.json")!;
  writeFileSync(path.join(root, other), '{"changed":true}');
  assert.equal((await raw(server.port, { path: url, headers: auth(server) })).status, 200);
  // Same identity → memo hit, with no re-read; a new identity (size) → re-hashed and refused.
  const hash = fileHash(file);
  assert.equal(fileHash(file), hash);
  writeFileSync(file, "tampered");
  assert.notEqual(fileHash(file), hash);
  const stale = await raw(server.port, { path: url, headers: auth(server) });
  assert.equal(stale.status, 400);
  assert.match(stale.json().message, /Stale campaign input: clip\.mp4/);
  rmSync(file);
  for (const route of ["file?path=clip.mp4", "campaign"]) {
    const res = await raw(server.port, { path: `${base}/${route}`, headers: auth(server) });
    assert.ok(!res.text.includes(root), `${route}: ${res.text}`);
  }
  const missing = await raw(server.port, { path: url, headers: auth(server) });
  assert.equal(missing.status, 400);
  assert.equal(missing.json().message, "Campaign file is not readable: clip.mp4");
});

test("fileHashAsync streams an open descriptor and shares the memo with fileHash", async (t) => {
  const { file } = await fixture(t);
  const fd = openSync(file, "r");
  try {
    assert.equal(await fileHashAsync(file, fd), createHash("sha256").update(readFileSync(file)).digest("hex"));
    assert.equal(await fileHashAsync(file, fd), fileHash(file));
  } finally {
    closeSync(fd);
  }
});

test("selection saves a draft; stale plan, revision or outputs answer 409; bad bodies 400 (RU-CP05)", async (t) => {
  const { server, root, file, run } = await fixture(t);
  const state = (await raw(server.port, { path: `${base}/campaign`, headers: auth(server) })).json() as State;
  const body = {
    planHash: state.planHash,
    expectedRevision: 0,
    memberId: "item",
    choice: "fix",
    note: "Fixture request for a new opening",
    outputs: state.members[0]!.outputs,
  };
  const post = (value: unknown, headers: Record<string, string> = postHeaders(server)) =>
    raw(server.port, {
      method: "POST",
      path: `${base}/selection`,
      headers,
      body: typeof value === "string" ? value : JSON.stringify(value),
    });
  assert.equal((await post(body, { Origin: server.origin, "Content-Type": "application/json" })).status, 403);
  assert.equal((await post(body, postHeaders(server, { Origin: "http://evil.example" }))).status, 403);
  assert.equal((await post(body, { ...auth(server), "Content-Type": "application/json" })).status, 403, "exact Origin");
  const charset = await post(body, postHeaders(server, { "Content-Type": "application/json; charset=utf-8" }));
  assert.equal(charset.status, 400);
  assert.match(charset.json().message, /JSON content type required/);
  assert.equal((await post(JSON.stringify({ ...body, note: "x".repeat(70 * 1024) }))).status, 400, "64 KiB cap");
  const extra = await post({ ...body, approved: true });
  assert.equal(extra.status, 400);
  assert.equal(extra.json().error, "VALIDATION");
  assert.equal((await post({ ...body, note: "x".repeat(2001) })).status, 400);
  assert.equal((await post({ ...body, choice: "approve" })).status, 400);
  const outside = await post({ ...body, memberId: "nobody" });
  assert.equal(outside.status, 400);
  assert.match(outside.json().message, /outside campaign/);

  const saved = await post(body);
  assert.equal(saved.status, 200);
  assert.equal(saved.json().revision, 1);
  const stored = readSelection(root, CAMPAIGN, state.planHash);
  assert.equal(stored.revision, 1);
  assert.equal(stored.choices[0]!["choice"], "fix");
  assert.equal(stored.choices[0]!["note"], "Fixture request for a new opening");

  const again = await post(body);
  assert.equal(again.status, 409);
  assert.equal(again.json().error, "CONFLICT");
  assert.equal(again.json().message, "Campaign review changed; refresh");
  assert.equal((await post({ ...body, planHash: "0".repeat(64), expectedRevision: 1 })).status, 409);
  const changedOutputs = await post({ ...body, expectedRevision: 1, outputs: [] });
  assert.equal(changedOutputs.status, 409, "outputs the reviewer did not see");
  assert.match(changedOutputs.json().message, /outputs or selection changed/);

  // A tampered render is hidden from the state and refused by file.
  writeFileSync(file, "tampered");
  const after = (await raw(server.port, { path: `${base}/campaign`, headers: auth(server) })).json() as State;
  assert.equal(after.members[0]!.outputs.length, 0);
  assert.equal((await raw(server.port, { path: `${base}/file?path=clip.mp4`, headers: auth(server) })).status, 400);
  await run();
  const stale = await post({ ...body, expectedRevision: 1 });
  assert.equal(stale.status, 409, "unseen same-plan output changes cannot inherit a displayed verdict");
});

test("a campaign container never gets timeline services; other review paths name the campaign view", async (t) => {
  const { server } = await fixture(t);
  for (const route of ["state", "compare?left=current&right=current", "realtime"]) {
    const res = await raw(server.port, { path: `${base}/${route}`, headers: auth(server) });
    assert.equal(res.status, 404, route);
    assert.equal(res.json().error, CAMPAIGN_PROJECT);
    assert.match(res.json().message, /campaign view/);
  }
  const ticket = await raw(server.port, {
    method: "POST",
    path: `${base}/realtime/channel-ticket`,
    headers: postHeaders(server),
    body: JSON.stringify({ editorId: "edit", localSessionId: "local" }),
  });
  assert.equal(ticket.status, 404);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${base}/realtime/channel`, ["v1", `t.${"a".repeat(64)}`], {
    headers: { Origin: server.origin },
  });
  const status = await new Promise<number>((resolve) => {
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => resolve(-1));
  });
  assert.equal(status, 403);
  assert.equal(server.review.loaded(CAMPAIGN), false);
});

test("the review:ui URL opens the project's Timeline page", () => {
  const token = "ab".repeat(32);
  assert.equal(
    sessionUrl("http://127.0.0.1:4317", token, "p", "timeline"),
    `http://127.0.0.1:4317/#token=${token}&project=p&view=timeline`,
  );
  assert.equal(
    sessionUrl("http://127.0.0.1:4317", token, undefined, "timeline"),
    `http://127.0.0.1:4317/#token=${token}`,
  );
  assert.equal(
    consoleReviewUrl(
      { url: sessionUrl("http://127.0.0.1:4317", token, "batch"), baseUrl: "http://127.0.0.1:4317/" },
      "batch",
    ),
    `http://127.0.0.1:4317/#token=${token}&project=batch&view=timeline`,
  );
  assert.throws(() => consoleReviewUrl({ url: "http://127.0.0.1:4317/", baseUrl: "http://127.0.0.1:4317/" }, "batch"));
});
