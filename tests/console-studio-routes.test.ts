/**
 * The console's Remotion Studio routes (RFC 0004 §17, D21 as amended 2026-11-18): `GET /api/projects/<id>/studio`
 * behind the token, `POST …/studio` and `POST …/studio/stop` behind the token and the exact Origin, the argv they
 * spawn, error mapping into the envelope, and, with the real runner, that the console's request runs while the project
 * is paused (the grant), as an agent's would not.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeControl } from "../src/lib/console/control";
import type { CliRunner } from "../src/lib/console/control-actions";
import { notImplementedActions } from "../src/lib/console/data";
import { loadOrCreateSessionToken } from "../src/lib/console/session";
import { studioActions } from "../src/lib/console/studio-actions";
import { StudioOpenResponseSchema, StudioStatusResponseSchema, type CliEnvelope } from "../src/types/console";
import { makeRoot, postHeaders, raw, removeRoot, startTestServer, PROJECT } from "./helpers/console-server";

const STUDIO = `/api/projects/${PROJECT}/studio`;

function setup(t: TestContext) {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  writeFileSync(
    path.join(root, "public/projects", PROJECT, "project.json"),
    JSON.stringify({ name: "Demo", formats: ["vertical", "square"], scenes: [] }),
  );
  return root;
}

/** A fake runner: records each call and answers `reply`. */
function fakeRun(reply: CliEnvelope) {
  const calls: { script: string; args: string[]; timeoutMs: number }[] = [];
  const run: CliRunner = async (_root, script, args, timeoutMs) => {
    calls.push({ script, args, timeoutMs });
    return reply;
  };
  return { run, calls };
}

async function serve(t: TestContext, root: string, run: CliRunner) {
  const server = await startTestServer(root, { actions: { ...notImplementedActions, ...studioActions(root, run) } });
  t.after(() => server.close());
  return server;
}

test("GET …/studio needs the token and answers the status without spawning", async (t) => {
  const root = setup(t);
  const { run, calls } = fakeRun({ ok: true });
  const server = await serve(t, root, run);
  const anonymous = await raw(server.port, { path: STUDIO });
  assert.equal(anonymous.status, 403, "the server refuses every unauthenticated JSON read with 403");
  const reply = await raw(server.port, { path: STUDIO, headers: { "x-console-token": server.token } });
  assert.equal(reply.status, 200, reply.text);
  const status = StudioStatusResponseSchema.parse(reply.json());
  assert.equal(status.available, true);
  assert.deepEqual(status.formats, ["vertical", "square"]);
  assert.equal(status.target?.composition, "ProjectVertical");
  assert.equal(status.running, undefined);
  assert.equal(calls.length, 0, "the status spawns nothing");
  const query = await raw(server.port, { path: `${STUDIO}?x=1`, headers: { "x-console-token": server.token } });
  assert.equal(query.status, 400);
  const missing = await raw(server.port, {
    path: "/api/projects/nope/studio",
    headers: { "x-console-token": server.token },
  });
  assert.equal(missing.status, 404);
});

test("POST …/studio needs the token and the exact Origin, then spawns studio:open with the format", async (t) => {
  const root = setup(t);
  const { run, calls } = fakeRun({
    ok: true,
    outputs: [],
    metadata: { url: "http://127.0.0.1:3001/ProjectSquare", reused: false },
  });
  const server = await serve(t, root, run);
  const body = JSON.stringify({ format: "square" });
  const noToken = await raw(server.port, {
    method: "POST",
    path: STUDIO,
    headers: { Origin: server.origin, "Content-Type": "application/json" },
    body,
  });
  assert.ok([401, 403].includes(noToken.status), String(noToken.status));
  const noOrigin = await raw(server.port, {
    method: "POST",
    path: STUDIO,
    headers: { "x-console-token": server.token, "Content-Type": "application/json" },
    body,
  });
  assert.equal(noOrigin.status, 403);
  const foreign = await raw(server.port, {
    method: "POST",
    path: STUDIO,
    headers: postHeaders(server, { Origin: "http://evil.example" }),
    body,
  });
  assert.equal(foreign.status, 403);
  assert.equal(calls.length, 0);
  const ok = await raw(server.port, { method: "POST", path: STUDIO, headers: postHeaders(server), body });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(StudioOpenResponseSchema.parse(ok.json()), {
    ok: true,
    url: "http://127.0.0.1:3001/ProjectSquare",
    reused: false,
  });
  assert.deepEqual(
    calls.map((call) => [call.script, call.args]),
    [["studio-open.ts", ["--project", PROJECT, "--format", "square"]]],
  );
  assert.ok(calls[0]!.timeoutMs >= 90_000, "long enough for a cold bundle");
  const extra = await raw(server.port, {
    method: "POST",
    path: STUDIO,
    headers: postHeaders(server),
    body: JSON.stringify({ format: "square", entry: "../x.ts" }),
  });
  assert.equal(extra.status, 400, "the body is strict: no entry or composition from the page");
  const empty = await raw(server.port, { method: "POST", path: STUDIO, headers: postHeaders(server), body: "{}" });
  assert.equal(empty.status, 200);
  assert.deepEqual(calls.at(-1)!.args, ["--project", PROJECT]);
});

test("refusals map into the error envelope; a reply without a loopback URL is never passed on", async (t) => {
  const root = setup(t);
  const cases: [CliEnvelope, number, string][] = [
    [{ ok: false, error: "PAUSED", message: "Paused by the user." }, 409, "PAUSED"],
    [{ ok: false, error: "STAGE_INCOMPLETE", message: "No build yet." }, 409, "STAGE_INCOMPLETE"],
    [{ ok: false, error: "INVALID_INPUT", message: "Campaign container." }, 400, "INVALID_INPUT"],
    [{ ok: false, error: "TIMEOUT", message: "Studio did not answer." }, 504, "TIMEOUT"],
    [{ ok: false, error: "INTERNAL", message: "Exited." }, 500, "INTERNAL"],
    [{ ok: true, metadata: { url: "http://192.168.0.2:3000/ProjectVertical", reused: true } }, 500, "INTERNAL"],
    [{ ok: true, metadata: { url: "javascript:alert(1)" } }, 500, "INTERNAL"],
  ];
  for (const [reply, status, code] of cases) {
    const server = await serve(t, root, fakeRun(reply).run);
    const res = await raw(server.port, { method: "POST", path: STUDIO, headers: postHeaders(server), body: "{}" });
    assert.equal(res.status, status, JSON.stringify(reply));
    assert.equal(res.json().error, code);
  }
});

test("POST …/studio/stop spawns --stop and answers the fresh status; absent actions answer 501", async (t) => {
  const root = setup(t);
  const { run, calls } = fakeRun({ ok: true, outputs: [], metadata: { stopped: 1 } });
  const server = await serve(t, root, run);
  const res = await raw(server.port, {
    method: "POST",
    path: `${STUDIO}/stop`,
    headers: postHeaders(server),
    body: "{}",
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(StudioStatusResponseSchema.parse(res.json()).running, undefined);
  assert.deepEqual(calls[0]!.args, ["--project", PROJECT, "--stop"]);
  const bare = await startTestServer(root, { actions: notImplementedActions });
  t.after(() => bare.close());
  const get = await raw(bare.port, { path: STUDIO, headers: { "x-console-token": bare.token } });
  assert.equal(get.status, 501);
  const post = await raw(bare.port, { method: "POST", path: STUDIO, headers: postHeaders(bare), body: "{}" });
  assert.equal(post.status, 501);
});

test("on a paused project the console's request runs (signed grant): stop succeeds, open gets past the pause", async (t) => {
  const root = setup(t);
  loadOrCreateSessionToken(root);
  const dir = path.join(root, "public/projects", PROJECT);
  writeFileSync(path.join(dir, "pipeline/brief.json"), JSON.stringify({ renderMode: "bespoke" }));
  // A bespoke film with no build: opening is refused for that reason, never for the pause.
  rmSync(path.join(dir, "project.json"));
  writeControl(dir, { state: "paused", answer: "Pause for a moment.", channel: "console" });
  const server = await startTestServer(root, { actions: { ...notImplementedActions, ...studioActions(root) } });
  t.after(() => server.close());
  const stop = await raw(server.port, {
    method: "POST",
    path: `${STUDIO}/stop`,
    headers: postHeaders(server),
    body: "{}",
  });
  assert.equal(stop.status, 200, stop.text);
  assert.equal(StudioStatusResponseSchema.parse(stop.json()).available, false);
  const open = await raw(server.port, { method: "POST", path: STUDIO, headers: postHeaders(server), body: "{}" });
  assert.equal(open.status, 409, open.text);
  assert.equal(open.json().error, "STAGE_INCOMPLETE", "the grant lifted the pause; the film just has no build yet");
});
