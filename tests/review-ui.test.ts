import { USER_GRANT } from "./helpers/ceiling-grant";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startReviewServer } from "../src/lib/review-ui/server";
import { OperationStore } from "../src/lib/jobs/store";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
export function reviewFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "local-review-"));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  writeFileSync(path.join(project, "pipeline/qa.md"), "<script>window.hacked=true</script>");
  const timeline = {
    version: 1,
    projectId: "demo",
    timebase: { num: 30, den: 1 },
    tracks: [
      {
        id: "visual",
        kind: "visual",
        clips: [
          {
            id: "<img src=x onerror=alert(1)>",
            assetId: "scene:hook",
            start: { num: 0, den: 1 },
            source: {
              start: { num: 0, den: 1 },
              end: { num: 90, den: 1 },
              timebase: { num: 30, den: 1 },
            },
            rate: { num: 1, den: 1 },
            transition: { kind: "cut" },
            captions: [],
          },
        ],
      },
    ],
  };
  new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json")).initialize(timeline);
  return { root, project, clipId: timeline.tracks[0].clips[0].id };
}
test("loopback review enforces token, origin, bounded schema and project allowlist", async (t) => {
  const f = reviewFixture();
  const app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(async () => {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  const auth = { "x-review-token": app.token };
  assert.equal((await fetch(app.origin + "/api/state", { headers: { "x-review-token": "é".repeat(64) } })).status, 403);
  assert.equal((app.server.address() as { address: string }).address, "127.0.0.1");
  assert.equal((await fetch(app.origin + "/api/state")).status, 403);
  assert.equal(
    (
      await fetch(app.origin + "/api/state", {
        headers: { ...auth, origin: "https://attacker.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(app.origin + "/api/mutate", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  for (const file of ["../../.env", "project.json", "../other/pipeline/qa.md", "pipeline/timeline-edit.json"])
    assert.equal(
      (
        await fetch(app.origin + "/file?path=" + encodeURIComponent(file), {
          headers: auth,
        })
      ).status,
      400,
    );
  const response = await fetch(app.origin + "/file?path=pipeline%2Fqa.md", {
    headers: auth,
  });
  assert.match(response.headers.get("content-type")!, /text\/plain/);
  assert.match(await response.text(), /<script>/);
  assert.equal(
    (
      await fetch(app.origin + "/api/mutate", {
        method: "POST",
        headers: {
          ...auth,
          origin: app.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "shell", command: "rm" }),
      })
    ).status,
    400,
  );
  const state = await (await fetch(app.origin + "/api/state", { headers: auth })).json();
  assert.equal(state.budget.status, "uninitialized");
  assert.equal(state.revision, 0);
});
test("edits conflict safely, undo redo and snapshot decisions pin exact hashes", async (t) => {
  const f = reviewFixture();
  const app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(async () => {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  const request = async (body: unknown) => {
    const response = await fetch(app.origin + "/api/mutate", {
      method: "POST",
      headers: {
        "x-review-token": app.token,
        origin: app.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  let result = await request({
    action: "snapshot",
    expectedRevision: 0,
    label: "Original",
  });
  const original = result.data.snapshots[0].hash;
  result = await request({
    action: "edit",
    expectedRevision: 0,
    command: {
      type: "move",
      trackId: "visual",
      clipId: f.clipId,
      start: { num: 30, den: 1 },
    },
  });
  assert.equal(result.data.revision, 1);
  assert.equal(result.data.tracks[0].clips[0].start.num, 30);
  assert.equal((await request({ action: "undo", expectedRevision: 0 })).status, 409);
  result = await request({
    action: "snapshot",
    expectedRevision: 1,
    label: "Second",
  });
  const second = result.data.snapshots.find((s: { hash: string }) => s.hash !== original).hash;
  result = await request({ action: "undo", expectedRevision: 1 });
  assert.equal(result.data.revision, 2);
  assert.equal(result.data.tracks[0].clips[0].start.num, 0);
  result = await request({ action: "redo", expectedRevision: 2 });
  assert.equal(result.data.revision, 3);
  result = await request({
    action: "choose",
    expectedRevision: 3,
    snapshotHash: original,
    actor: "Declared reviewer",
  });
  assert.equal(result.data.selected.snapshotHash, original);
  assert.equal(result.data.timelineHash, second);
  const compare = app.service.compare(original, second);
  assert.equal(compare.equal, false);
  const file = path.join(f.project, "pipeline/review/snapshots", original + ".json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.timeline.projectId = "other";
  writeFileSync(file, JSON.stringify(saved));
  assert.throws(() => app.service.compare(original, second), /hash or project mismatch/);
});
test("symlink escaping and mismatched project journals are refused", async (t) => {
  const f = reviewFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const external = path.join(f.root, "outside.md");
  writeFileSync(external, "secret");
  rmSync(path.join(f.project, "pipeline/qa.md"));
  symlinkSync(external, path.join(f.project, "pipeline/qa.md"));
  await assert.rejects(startReviewServer({ projectId: "demo", rootDir: f.root }), /symlink/);
});

test("budget projects unknown actuals without leaking provider results; other journals are refused", async (t) => {
  const f = reviewFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const operations = new OperationStore("demo", {
    directory: path.join(f.project, "pipeline"),
  });
  operations.configure({ ceilingUsd: 10, maxJobUsd: 2 }, USER_GRANT);
  operations.reserveOperation({
    operationId: "pending",
    provider: "fal",
    endpoint: "verified/example",
    inputHash: "hash",
    assetId: "still",
    quote: {
      currency: "USD",
      lowUsd: 0.2,
      expectedUsd: 0.3,
      highUsd: 0.5,
      bounded: true,
      source: "test bound",
      asOf: "2026-10-11",
      confidence: "user-bound",
    },
  });
  const app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  try {
    const s = app.service.state();
    assert.equal(s.budget.jobs[0].actualUsd, null);
    assert.equal(s.budget.jobs[0].reservedUsd, 0.5);
    assert.equal("result" in s.budget.jobs[0], false);
    const response = await fetch(app.origin + "/api/mutate", {
      method: "POST",
      headers: {
        "x-review-token": app.token,
        origin: app.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "snapshot",
        expectedRevision: 0,
        label: "x".repeat(66000),
      }),
    });
    assert.equal(response.status, 400);
    const file = path.join(f.project, "pipeline/timeline-edit.json"),
      doc = JSON.parse(readFileSync(file, "utf8"));
    doc.timeline.projectId = "other";
    writeFileSync(file, JSON.stringify(doc));
    assert.throws(() => app.service.mutate({ action: "undo", expectedRevision: 0 }), /another project/);
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }
});

test("event evidence allows generated manifests/frames and denies bundle/provider files", async (t) => {
  const f = reviewFixture();
  const name = "vertical-12345678-1234-1234-1234-123456789abc";
  const directory = path.join(f.project, "pipeline/qa-evidence", name);
  mkdirSync(path.join(directory, "browser/bundle"), { recursive: true });
  for (const file of [
    "evidence.json",
    "contact-sheet.html",
    "frame-000030.png",
    "browser/browser-000030.png",
    "browser/bundle/index.js",
    "private-provider.json",
  ])
    writeFileSync(path.join(directory, file), "evidence");
  const app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(async () => {
    await app.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  const prefix = "pipeline/qa-evidence/" + name + "/";
  const state = app.service.state();
  assert.ok(state.reports.includes(prefix + "evidence.json"));
  assert.ok(state.reports.includes(prefix + "browser/browser-000030.png"));
  assert.throws(() => app.service.file(prefix + "browser/bundle/index.js"), /declared review/);
  assert.throws(() => app.service.file(prefix + "private-provider.json"), /declared review/);
});

test("dry-run is read-only, pins proposal, validates inputs and conflicts before mutation", async (t) => {
  const f = reviewFixture();
  const app = await startReviewServer({
    projectId: "demo",
    rootDir: f.root,
  });
  t.after(async () => {
    await app.close();
    rmSync(f.root, {
      recursive: true,
      force: true,
    });
  });
  const journal = path.join(f.project, "pipeline/timeline-edit.json");
  const before = readFileSync(journal);
  const command = {
    type: "move",
    trackId: "visual",
    clipId: f.clipId,
    start: {
      num: 30,
      den: 1,
    },
  };
  const response = await fetch(app.origin + "/api/dry-run", {
    method: "POST",
    headers: {
      "x-review-token": app.token,
      origin: app.origin,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      expectedRevision: 0,
      command,
    }),
  });
  assert.equal(response.status, 200);
  const proposal = await response.json();
  assert.equal(proposal.snapshot.durationInFrames, 120);
  assert.deepEqual(readFileSync(journal), before);
  assert.throws(() =>
    app.service.dryRun({
      expectedRevision: 0,
      command: {
        ...command,
        start: {
          num: -1,
          den: 1,
        },
      },
    }),
  );
  const after = app.service.mutate({
    action: "edit",
    expectedRevision: 0,
    command,
  });
  assert.equal(after.timelineHash, proposal.timelineHash);
  assert.throws(
    () =>
      app.service.dryRun({
        expectedRevision: 0,
        command,
      }),
    /revision conflict/,
  );
  const snap = app.service.mutate({
    action: "snapshot",
    expectedRevision: 1,
    label: "Working",
  }).snapshots[0];
  assert.equal(app.service.compare("current", snap.hash).equal, true);
  app.service.mutate({
    action: "undo",
    expectedRevision: 1,
  });
  assert.equal(app.service.compare("current", snap.hash).equal, false);
});
test("media uses authenticated session ranges and HEAD without arbitrary file or cookie mutation access", async (t) => {
  const f = reviewFixture();
  const out = path.join(f.root, "out/demo");
  mkdirSync(out, {
    recursive: true,
  });
  writeFileSync(path.join(out, "landscape.mp4"), Buffer.from("0123456789"));
  const app = await startReviewServer({
    projectId: "demo",
    rootDir: f.root,
  });
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
    rmSync(f.root, {
      recursive: true,
      force: true,
    });
  });
  const auth = {
    "x-review-token": app.token,
  };
  const session = await fetch(app.origin + "/api/session", {
    method: "POST",
    headers: {
      ...auth,
      origin: app.origin,
    },
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/file/);
  const url = app.origin + "/file?path=" + encodeURIComponent("@out/landscape.mp4");
  assert.equal((await fetch(url)).status, 403);
  for (const [range, expected, body] of [
    ["bytes=2-5", "bytes 2-5/10", "2345"],
    ["bytes=7-", "bytes 7-9/10", "789"],
    ["bytes=-3", "bytes 7-9/10", "789"],
  ]) {
    const r = await fetch(url, {
      headers: {
        cookie,
        range,
      },
    });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), expected);
    assert.equal(await r.text(), body);
  }
  for (const range of ["bytes=20-", "bytes=5-2", "bytes=-0", "bytes=0-1,3-4", "items=0-1"]) {
    const r = await fetch(url, {
      headers: {
        ...auth,
        range,
      },
    });
    assert.equal(r.status, 416);
    assert.equal(r.headers.get("content-range"), "bytes */10");
  }
  const head = await fetch(url, {
    method: "HEAD",
    headers: {
      cookie,
      range: "bytes=1-3",
    },
  });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get("content-length"), "3");
  assert.equal(await head.text(), "");
  assert.equal(
    (
      await fetch(app.origin + "/api/state", {
        headers: {
          cookie,
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url, {
        headers: {
          cookie,
          origin: "https://evil.invalid",
        },
      })
    ).status,
    403,
  );
  rmSync(path.join(out, "landscape.mp4"));
  symlinkSync(path.join(f.project, "project.json"), path.join(out, "landscape.mp4"));
  assert.equal(
    (
      await fetch(url, {
        headers: auth,
      })
    ).status,
    400,
  );
});

test("review:ui refuses an unsafe project ID before looking at any directory", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "review-ui-id-"));
  try {
    mkdirSync(path.join(cwd, "public"), { recursive: true });
    const repo = path.resolve(import.meta.dirname, "..");
    const child = spawnSync(
      process.execPath,
      [
        path.join(repo, "node_modules/tsx/dist/cli.mjs"),
        path.join(repo, "scripts/review-ui.ts"),
        "--project",
        "../public",
      ],
      { cwd, encoding: "utf8", timeout: 30000 },
    );
    assert.equal(child.status, 1, child.stderr);
    const lines = child.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const envelope = JSON.parse(lines[0]!);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error, "INVALID_INPUT");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
