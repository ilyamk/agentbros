import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, readdirSync, existsSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  RealtimeEditorStore,
  RealtimeDeriveSchema,
  readRealtimeDerive,
  readRealtimeEditorRequest,
} from "../src/lib/realtime/editor";
import { startReviewServer } from "../src/lib/review-ui/server";
import { realtimeReviewFixture } from "./helpers/review-realtime";
import { planRealtimeSession } from "../src/lib/realtime/session";
import { digest } from "../src/lib/jobs/model-artifacts";
function fixture(t: test.TestContext) {
  const f = realtimeReviewFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const store = new RealtimeEditorStore(f.root, "demo", "draft");
  store.create(2);
  store.add(0, f.request("first"));
  return { ...f, store };
}
const patch = (revisionId = "second") => ({
  sourceRevision: "first",
  revisionId,
  sessionId: `derived-${revisionId}`,
  input: {
    prompt: "New local creative direction",
    seed: 123,
    num_inference_steps: 4,
    image_size: "square_hd" as const,
    enable_interpolation: true,
  },
  quote: {
    currency: "USD" as const,
    lowUsd: 0,
    expectedUsd: 0.3,
    highUsd: 0.6,
    bounded: true as const,
    confidence: "user-bound" as const,
    providerEnforced: false,
    source: "Explicit new offline planning bound",
    asOf: "2026-10-11",
  },
});
test("derive preserves exact original bytes, transport and limits; immutable lineage and fresh quote create only a draft", (t) => {
  const f = fixture(t),
    before = f.store.read(),
    source = before.revisions[0],
    sourceFile = path.resolve(f.root, source.request.path),
    bytes = readFileSync(sourceFile),
    snapshot = readFileSync(path.join(f.store.directory, "001.json"));
  const state = f.store.derive(1, patch()),
    original = f.store.request("first"),
    derived = f.store.request("second");
  assert.equal(state.sequence, 2);
  assert.equal(state.revisions[1].status, "draft");
  assert.deepEqual(state.revisions[1].derivedFrom, { revisionId: "first", requestSha256: digest(bytes) });
  assert.deepEqual(state.revisions[0], source);
  assert.equal(derived.operation.input.image_url, original.operation.input.image_url);
  assert.deepEqual({ ...derived.operation, input: undefined }, { ...original.operation, input: undefined });
  assert.deepEqual(derived.limits, original.limits);
  assert.equal(derived.quote.highUsd, 0.6);
  assert.equal(derived.quote.confidence, "user-bound");
  assert.notEqual(state.revisions[1].inputHash, source.inputHash);
  assert.equal(state.committedUsd, 0);
  for (const key of ["queued", "inFlight", "selected"]) assert.equal(state[key as keyof typeof state], undefined);
  assert.deepEqual(readFileSync(sourceFile), bytes);
  assert.deepEqual(readFileSync(path.join(f.store.directory, "001.json")), snapshot);
  assert.equal(existsSync(path.join(f.project, "pipeline/financial-state.json")), false);
  assert.equal(existsSync(path.join(f.root, ".cache/realtime")), false);
  assert.deepEqual(new RealtimeEditorStore(f.root, "demo", "draft").read(), state);
});
test("derive strict patch rejects transport/image/limits changes, unknown fields, inherited quotes and source/CAS reuse", (t) => {
  const f = fixture(t),
    before = readdirSync(f.store.directory);
  const bad: unknown[] = [
    { ...patch(), quote: undefined },
    { ...patch(), quote: { ...patch().quote, confidence: "provider-quote" } },
    { ...patch(), quote: { ...patch().quote, providerEnforced: true } },
    { ...patch(), input: { image_url: "data:image/png;base64,YQ==" } },
    { ...patch(), input: { num_inference_steps: 9 } },
    { ...patch(), input: { seed: -1 } },
    { ...patch(), input: { schedule_mu: 0.2 } },
    { ...patch(), input: { output_feedback_strength: 2 } },
    { ...patch(), input: { image_size: "landscape" } },
    { ...patch(), input: {} },
    { ...patch(), limits: {} },
    { ...patch(), sourceRevision: "missing" },
    { ...patch(), revisionId: "first" },
    { ...patch(), sessionId: "ui-first" },
    { ...patch(), quote: { ...patch().quote, token: "secret" } },
    { ...patch(), input: { prompt: "a".repeat(4097) } },
  ];
  for (const value of bad) assert.throws(() => f.store.derive(1, value as ReturnType<typeof patch>));
  assert.throws(() => f.store.derive(0, patch()), /conflict/);
  assert.deepEqual(readdirSync(f.store.directory), before);
  const req = f.request("limited");
  req.limits.maxFrames = 1;
  f.store.add(1, req);
  assert.throws(() => f.store.derive(2, { ...patch(), sourceRevision: "limited" }), /interpolation/);
});
test("large pinned originals are reused server-side with a small patch and corruption/lineage mismatches fail closed", (t) => {
  const f = fixture(t),
    request = f.request("large");
  request.operation.input.image_url = "data:image/png;base64," + Buffer.alloc(512 * 1024, 5).toString("base64");
  f.store.add(1, request);
  const value = { ...patch(), sourceRevision: "large" };
  f.store.derive(2, value);
  assert.equal(f.store.request("second").operation.input.image_url, request.operation.input.image_url);
  const file = path.join(f.store.directory, "003.json"),
    state = JSON.parse(readFileSync(file, "utf8"));
  state.revisions[2].derivedFrom.requestSha256 = "a".repeat(64);
  writeFileSync(file, JSON.stringify(state));
  assert.throws(() => f.store.read(), /lineage/);
  writeFileSync(
    file,
    JSON.stringify({
      ...state,
      revisions: state.revisions.map((r: any, i: number) =>
        i === 2 ? { ...r, derivedFrom: { revisionId: "large", requestSha256: state.revisions[1].request.sha256 } } : r,
      ),
    }),
  );
  writeFileSync(path.resolve(f.root, state.revisions[1].request.path), "{}");
  assert.throws(() => f.store.derive(3, { ...patch("third"), sourceRevision: "large" }), /hash/);
});
test("readback rejects self-consistent child input or limit edits outside its recorded lineage", (t) => {
  const f = fixture(t);
  f.store.derive(1, patch());
  const stateFile = path.join(f.store.directory, "002.json"),
    originalState = readFileSync(stateFile),
    state = JSON.parse(originalState.toString()),
    child = state.revisions[1],
    requestFile = path.resolve(f.root, child.request.path),
    originalRequest = readFileSync(requestFile);
  for (const edit of ["image", "limits"]) {
    const request = JSON.parse(originalRequest.toString());
    if (edit === "image") request.operation.input.image_url = "data:image/png;base64,YQ==";
    else request.limits.timeoutMs++;
    const bytes = Buffer.from(JSON.stringify(request));
    writeFileSync(requestFile, bytes);
    child.request.sha256 = digest(bytes);
    child.inputHash = planRealtimeSession(request).inputHash;
    writeFileSync(stateFile, JSON.stringify(state));
    assert.throws(() => f.store.read(), /pinned/);
  }
  writeFileSync(requestFile, originalRequest);
  writeFileSync(stateFile, originalState);
  assert.equal(f.store.read().sequence, 2);
});
test("CLI bounded derive JSON emits one envelope and never executes; FIFO/symlink/oversize patches fail before writes", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "patch.json");
  writeFileSync(file, JSON.stringify(patch()));
  const script = path.resolve("scripts/realtime-editor.ts"),
    tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
  const run = (p: string, expected = "1") =>
    spawnSync(
      process.execPath,
      [
        tsx,
        script,
        "--project",
        "demo",
        "--editor",
        "draft",
        "--action",
        "derive",
        "--expected",
        expected,
        "--patch",
        p,
      ],
      { cwd: f.root, encoding: "utf8", timeout: 30000, env: { ...process.env, FAL_KEY: "", FAL_REALTIME_TOKEN: "" } },
    );
  const good = run(file);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.equal(good.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(good.stdout).metadata.offline, true);
  assert.equal(f.store.read().sequence, 2);
  const conflict = run(file);
  assert.equal(conflict.status, 1);
  assert.match(JSON.parse(conflict.stdout).message, /conflict/);
  writeFileSync(file, " ".repeat(16385));
  const bad = run(file, "2");
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).message, /regular file bound/);
  assert.equal(f.store.read().sequence, 2);
  const link = path.join(f.root, "patch-link.json");
  symlinkSync(file, link);
  assert.throws(() => readRealtimeDerive(link), /symlink/);
  assert.equal(existsSync(path.join(f.root, ".cache/realtime")), false);
});
test(
  "POSIX FIFO requests, patch and pinned artifacts are refused without waiting for a writer",
  { skip: process.platform === "win32" },
  (t) => {
    const f = fixture(t),
      fifo = path.join(f.root, "fifo");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    assert.throws(() => readRealtimeDerive(fifo), /regular/);
    assert.throws(() => readRealtimeEditorRequest(fifo), /regular/);
    const source = path.resolve(f.root, f.store.read().revisions[0].request.path);
    rmSync(source);
    assert.equal(spawnSync("mkfifo", [source]).status, 0);
    const child = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        path.resolve("scripts/realtime-editor.ts"),
        "--project",
        "demo",
        "--editor",
        "draft",
        "--action",
        "status",
      ],
      { cwd: f.root, timeout: 30000, encoding: "utf8" },
    );
    assert.equal(child.status, 1, child.stderr);
    assert.match(JSON.parse(child.stdout).message, /regular/);
  },
);
test("authenticated HTTP derive uses small source controls only, explicit quote and CAS with no implicit execution", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(() => app.close());
  const headers = { "x-review-token": app.token, "content-type": "application/json", origin: app.origin };
  const url = app.origin + "/api/realtime/derive-source?editor=draft&revision=first";
  assert.equal((await fetch(url)).status, 403);
  const summary = await (await fetch(url, { headers })).json();
  assert.equal(summary.sourceRevision, "first");
  assert.equal(summary.requestSha256, f.store.read().revisions[0].request.sha256);
  assert.equal(summary.providerBilling, false);
  assert.equal("image_url" in summary.input, false);
  assert.equal("quote" in summary, false);
  assert.equal(JSON.stringify(summary).includes("base64"), false);
  const post = (expected: number, value: unknown = patch()) =>
    fetch(app.origin + "/api/realtime", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "derive", editorId: "draft", expected, patch: value }),
    });
  assert.equal((await post(0)).status, 409);
  assert.equal((await post(1, { ...patch(), executable: "/bin/sh" })).status, 400);
  const response = await post(1);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sequence, 2);
  assert.equal((await post(1)).status, 409);
  assert.equal(f.store.read().committedUsd, 0);
  assert.equal(f.store.read().selected, undefined);
  assert.equal(existsSync(path.join(f.root, ".cache/realtime")), false);
  assert.equal(
    (await post(2, { ...patch("third"), quote: { ...patch().quote, source: "x".repeat(17000) } })).status,
    400,
  );
  const concurrent = await Promise.all([post(2, patch("third")), post(2, patch("fourth"))]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  assert.equal(f.store.read().sequence, 3);
});
