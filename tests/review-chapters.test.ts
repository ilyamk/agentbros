import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync, truncateSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { inspectChapters } from "../src/lib/review-ui/chapters";
import { ChapterInspectionInputs } from "../src/lib/longform/inspection-inputs";
import { AssetRecordSchema } from "../src/types/assets";
import { projectChapterPlan, renderChapters, remotionChapterBackend } from "../src/lib/longform/runner";
import { createHash } from "node:crypto";
import { startReviewServer } from "../src/lib/review-ui/server";
import { chapterFixture, r } from "./helpers/review-chapters";
const withFixture = (t: { after: Function }) => {
  const f = chapterFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  return f;
};
test("chapter navigation consumes exact bounds and source slices without writes", (t) => {
  const f = withFixture(t),
    before = readFileSync(f.manifestFile);
  const result = inspectChapters(f.project, f.request, f.root);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.deepEqual(result.selected.start, r(0));
  assert.deepEqual(result.selected.tracks[0].clips[0].source.end, r(30));
  assert.equal(result.readonly, true);
  assert.equal(result.selected.reuse.verified, false);
  assert.deepEqual(readFileSync(f.manifestFile), before);
  assert.equal(f.store.read().revision, 0);
  const second = inspectChapters(
    f.project,
    { ...f.request, chapterId: "second", manifestSha256: result.manifestSha256 },
    f.root,
  );
  assert.equal(second.status, "ready");
  if (second.status === "ready") assert.deepEqual(second.selected.tracks[0].clips[0].source.start, r(30));
});
test("legacy absence is compatible but removed supplied manifest is stale", (t) => {
  const f = withFixture(t);
  rmSync(f.manifestFile);
  assert.equal(inspectChapters(f.project, f.request, f.root).status, "absent");
  assert.throws(() => inspectChapters(f.project, { ...f.request, manifestSha256: "0".repeat(64) }, f.root), /changed/);
});
test("revision/hash/manifest and unknown selection cannot inspect stale inputs", (t) => {
  const f = withFixture(t);
  assert.throws(() => inspectChapters(f.project, { ...f.request, expectedRevision: 4 }, f.root));
  assert.throws(() => inspectChapters(f.project, { ...f.request, timelineHash: "0".repeat(64) }, f.root));
  assert.throws(() => inspectChapters(f.project, { ...f.request, manifestSha256: "0".repeat(64) }, f.root), /changed/);
  assert.throws(() => inspectChapters(f.project, { ...f.request, chapterId: "missing" }, f.root), /Unknown/);
});
test("outside extent and protected context cuts refuse", (t) => {
  const f = withFixture(t);
  writeFileSync(
    f.manifestFile,
    JSON.stringify({ ...f.manifest, chapters: [{ ...f.manifest.chapters[0], end: r(91) }] }),
  );
  assert.throws(() => inspectChapters(f.project, f.request, f.root), /exceeds/);
  writeFileSync(
    f.manifestFile,
    JSON.stringify({
      ...f.manifest,
      protectedSpans: [{ id: "context", start: r(20), end: r(40), reason: "caveat", requires: [], note: "Keep" }],
    }),
  );
  assert.throws(() => inspectChapters(f.project, f.request, f.root), /protected/);
});
test("metadata FIFO, leaf/parent aliases and oversize are refused", (t) => {
  const f = withFixture(t);
  rmSync(f.manifestFile);
  execFileSync("mkfifo", [f.manifestFile]);
  assert.throws(() => inspectChapters(f.project, f.request, f.root), /regular/);
  rmSync(f.manifestFile);
  const other = path.join(f.root, "other.json");
  writeFileSync(other, JSON.stringify(f.manifest));
  symlinkSync(other, f.manifestFile);
  assert.throws(() => inspectChapters(f.project, f.request, f.root));
  rmSync(f.manifestFile);
  writeFileSync(f.manifestFile, " ".repeat(256 * 1024 + 1));
  assert.throws(() => inspectChapters(f.project, f.request, f.root), /size/);
});
test("finite source/output hashing refuses aliases/FIFO and detects changed bytes", (t) => {
  const f = withFixture(t),
    input = path.join(f.root, "input");
  writeFileSync(input, "original");
  const capture = new ChapterInspectionInputs();
  capture.hash(input, f.root);
  writeFileSync(input, "changed");
  assert.throws(() => capture.assertUnchanged(), /changed/);
  rmSync(input);
  execFileSync("mkfifo", [input]);
  assert.throws(() => new ChapterInspectionInputs().hash(input, f.root), /regular/);
  rmSync(input);
  symlinkSync(f.manifestFile, input);
  assert.throws(() => new ChapterInspectionInputs().hash(input, f.root), /regular/);
});
test("cache malformed and output escape cannot masquerade as reusable", (t) => {
  const f = withFixture(t),
    cache = path.join(f.root, "out/demo/chapters/landscape/cache.json");
  mkdirSync(path.dirname(cache), { recursive: true });
  writeFileSync(cache, "[]");
  assert.throws(() => inspectChapters(f.project, f.request, f.root));
  writeFileSync(
    cache,
    JSON.stringify({
      first: { fingerprint: "0".repeat(64), output: "/tmp/not-owned.mp4", outputHash: "1".repeat(64) },
    }),
  );
  assert.throws(
    () => inspectChapters(f.project, f.request, f.root),
    /path mismatch|Invalid bounded chapter cache entry/,
  );
});
test("chapter endpoint uses existing token/origin and read-only request contract", async (t) => {
  const f = withFixture(t),
    app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(() => app.close());
  const url = app.origin + "/api/chapter-inspection";
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(f.request),
      })
    ).status,
    403,
  );
  const headers = { "x-review-token": app.token, origin: app.origin, "content-type": "application/json" };
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(f.request) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).readonly, true);
  assert.equal(f.store.read().revision, 0);
});

test("authoritative readonly planner verifies matching cache hash and rejects execution", async (t) => {
  const f = withFixture(t),
    plan = projectChapterPlan("demo", f.manifest, { rootDir: f.root, readonlyInspection: true }),
    job = plan.jobs[0];
  mkdirSync(path.dirname(job.output), { recursive: true });
  const bytes = Buffer.from("hash-only cache fixture, not a decoded MP4");
  writeFileSync(job.output, bytes);
  writeFileSync(
    plan.cacheFile,
    JSON.stringify({
      first: {
        fingerprint: job.fingerprint,
        output: job.output,
        outputHash: createHash("sha256").update(bytes).digest("hex"),
      },
    }),
  );
  const result = inspectChapters(f.project, f.request, f.root);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.selected.reuse.action, "reuse");
  await assert.rejects(
    renderChapters(plan, {
      dryRun: false,
      render: async () => {
        throw Error("must not execute");
      },
    }),
    /Readonly/,
  );
  await assert.rejects(remotionChapterBackend(f.root)(job, path.join(f.root, "unused.mp4")), /Readonly/);
  writeFileSync(job.output, "corrupt");
  const changed = inspectChapters(f.project, f.request, f.root);
  if (changed.status === "ready") assert.equal(changed.selected.reuse.verified, false);
});
test("renderer closure and project context changes invalidate exact cache fingerprint", (t) => {
  const f = withFixture(t),
    plan = projectChapterPlan("demo", f.manifest, { rootDir: f.root, readonlyInspection: true }),
    job = plan.jobs[0];
  mkdirSync(path.dirname(job.output), { recursive: true });
  writeFileSync(job.output, "fixture");
  writeFileSync(
    plan.cacheFile,
    JSON.stringify({
      first: {
        fingerprint: job.fingerprint,
        output: job.output,
        outputHash: createHash("sha256").update("fixture").digest("hex"),
      },
    }),
  );
  const config = JSON.parse(readFileSync(path.join(f.project, "project.json"), "utf8"));
  config.colors.accent = "#123456";
  writeFileSync(path.join(f.project, "project.json"), JSON.stringify(config));
  const result = inspectChapters(f.project, f.request, f.root);
  if (result.status === "ready") {
    assert.equal(result.selected.reuse.verified, false);
    assert.notEqual(result.selected.reuse.fingerprint, job.fingerprint);
  }
});
test("unsupported derived artifacts preserve navigation with explicit reuse-unavailable", (t) => {
  const f = withFixture(t);
  writeFileSync(path.join(f.project, "pipeline/education.json"), "{}");
  const result = inspectChapters(f.project, f.request, f.root);
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.selected.reuse.verified, false);
    assert.match(result.selected.reuse.reason, /unsupported.*education/);
  }
});

test("registered immutable original checksum is verified and corruption/FIFO refused", (t) => {
  const f = withFixture(t),
    bytes = Buffer.from("original diagnostic image bytes"),
    hash = createHash("sha256").update(bytes).digest("hex"),
    source = "projects/demo/assets/imported/" + hash + ".png",
    original = path.join(f.root, "public", source);
  mkdirSync(path.dirname(original), { recursive: true });
  writeFileSync(original, bytes);
  const asset = AssetRecordSchema.parse({
    schemaVersion: 1,
    id: "sha256:" + hash,
    hash,
    revision: 1,
    createdAt: "2026-10-12T00:00:00Z",
    kind: "image",
    files: { original: source, bytes: bytes.length, mime: "image/png" },
    media: { width: 48, height: 32, codec: "png", hasAudio: false },
    provenance: { origin: "manual" },
    rights: {},
    status: "candidate",
  });
  writeFileSync(
    path.join(f.project, "pipeline/asset-registry.json"),
    JSON.stringify({ schemaVersion: 1, revision: 1, assets: [asset] }),
  );
  const doc = f.store.read();
  doc.timeline.tracks[0].clips[0].assetId = asset.id;
  delete doc.timeline.tracks[0].clips[0].payload;
  writeFileSync(f.store.file, JSON.stringify(doc));
  const request = {
    ...f.request,
    timelineHash: createHash("sha256").update(JSON.stringify(doc.timeline)).digest("hex"),
  };
  const result = inspectChapters(f.project, request, f.root);
  if (result.status === "ready") assert.equal(result.selected.reuse.dependencies?.[asset.id], hash);
  writeFileSync(original, "corrupt");
  assert.throws(() => inspectChapters(f.project, request, f.root), /checksum mismatch/);
  rmSync(original);
  execFileSync("mkfifo", [original]);
  assert.throws(() => inspectChapters(f.project, request, f.root));
});
test("readonly registry FIFO and parent alias cannot block or bypass inspection", (t) => {
  const f = withFixture(t),
    registry = path.join(f.project, "pipeline/asset-registry.json");
  execFileSync("mkfifo", [registry]);
  assert.throws(() => inspectChapters(f.project, f.request, f.root), /regular/);
  rmSync(registry);
  const directory = path.join(f.root, "alias");
  mkdirSync(directory);
  const original = path.join(directory, "registry.json");
  writeFileSync(original, "{}");
  symlinkSync(original, registry);
  assert.throws(() => inspectChapters(f.project, f.request, f.root));
});

test("readonly source closure rejects aliases and per-file oversize", (t) => {
  const f = withFixture(t),
    code = path.join(f.root, "code");
  mkdirSync(path.join(code, "src"), { recursive: true });
  writeFileSync(path.join(code, "package.json"), "{}");
  writeFileSync(path.join(code, "src/index.ts"), "// diagnostic");
  const input = path.join(code, "src/entry.ts");
  symlinkSync(path.join(code, "src/index.ts"), input);
  assert.throws(
    () => projectChapterPlan("demo", f.manifest, { rootDir: f.root, codeDir: code, readonlyInspection: true }),
    /alias/,
  );
  rmSync(input);
  writeFileSync(input, "");
  truncateSync(input, 64 * 1024 * 1024 + 1);
  assert.throws(
    () => projectChapterPlan("demo", f.manifest, { rootDir: f.root, codeDir: code, readonlyInspection: true }),
    /bounded/,
  );
});
test("absence pins detect late unsupported artifacts and alias parents", (t) => {
  const f = withFixture(t),
    capture = new ChapterInspectionInputs(),
    file = path.join(f.project, "pipeline/late.json");
  capture.absent(file, f.project);
  writeFileSync(file, "{}");
  assert.throws(() => capture.assertUnchanged(), /unsupported/);
  const alias = path.join(f.project, "aliased");
  symlinkSync(path.join(f.project, "pipeline"), alias);
  assert.throws(() => new ChapterInspectionInputs().absent(path.join(alias, "missing.json"), f.project), /alias/);
});
