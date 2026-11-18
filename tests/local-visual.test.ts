import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { ingestLocalVisual, probeLocalVisual } from "../src/lib/ingest/local-visual";
import { ingestLocalOcr } from "../src/lib/ingest/local-ocr";
import { ingestMedia, readSourceIndex } from "../src/lib/ingest";
import { sourceIndexCacheKey } from "../src/lib/ingest/ocr-evidence";
import { hashFile, importAsset } from "../src/lib/assets/registry";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { planBroll, applyBroll } from "../src/lib/ingest/broll";
const worker = path.resolve(import.meta.dirname, "fixtures/visual-worker.mjs");
function fixture() {
  const cwd = process.cwd(),
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "offline visual ")));
  const project = path.join(root, "public/projects/test");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const mode = path.join(root, "mode");
  writeFileSync(mode, "ok");
  const executable = path.join(root, "worker");
  const quote = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    executable,
    `#!/bin/sh\nexec ${quote(realpathSync(process.execPath))} ${quote(worker)} ${quote(mode)}\n`,
    { mode: 0o700 },
  );
  const source = path.join(root, "source.mp4");
  const ff = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x180:r=30:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    source,
  ]);
  assert.equal(ff.status, 0, ff.stderr?.toString());
  const transcript = path.join(root, "transcript.json");
  writeFileSync(transcript, JSON.stringify({ segments: [{ text: "Do not delete this caveat.", start: 0, end: 2 }] }));
  process.chdir(root);
  const asset = importAsset({
    projectId: "test",
    sourceFile: source,
    provenance: { origin: "manual" },
    rights: {
      licence: "Synthetic test declaration only",
      checkedAsOf: "2026-10-11T00:00:00Z",
      commercialAllowed: false,
      attributionRequired: false,
    },
  }).asset;
  const queryFile = path.join(root, "reference.png");
  const img = spawnSync("ffmpeg", ["-v", "error", "-i", source, "-frames:v", "1", queryFile]);
  assert.equal(img.status, 0, img.stderr?.toString());
  const query = importAsset({ projectId: "test", sourceFile: queryFile, provenance: { origin: "manual" } }).asset;
  const base = ingestMedia({
    projectId: "test",
    sourceFile: source,
    transcriptFile: transcript,
    options: { thumbnailEverySec: 1 },
  });
  const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
  store.initialize({
    version: 1,
    projectId: "test",
    timebase: { num: 30, den: 1 },
    tracks: [
      {
        id: "original",
        kind: "visual",
        clips: [
          {
            id: "original-clip",
            assetId: asset.id,
            start: { num: 0, den: 1 },
            source: { start: { num: 0, den: 1 }, end: { num: 60, den: 1 }, timebase: { num: 30, den: 1 } },
            captions: [],
          },
        ],
      },
    ],
  });
  const originalBytes = readFileSync(base.file);
  const config = {
    engine: "apple-vision-feature-print" as const,
    executable,
    executableHash: hashFile(executable),
    workerSource: worker,
    workerSourceHash: hashFile(worker),
    revision: 2 as const,
    maxFrames: 2,
    timeoutMs: 10000,
  };
  return {
    cwd,
    root,
    project,
    mode,
    base,
    originalBytes,
    config,
    store,
    query,
    cleanup: () => {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const supported = { skip: process.platform !== "darwin" };
test(
  "visual reference derives exact nextPTS candidates; ranks, protected speech, dry-run/CAS/undo and legacy bytes",
  supported,
  async () => {
    const f = fixture();
    try {
      const request = { projectId: "test", indexFile: f.base.file, queryAssetId: f.query.id, config: f.config };
      const fresh = await ingestLocalVisual(request);
      assert.equal(fresh.workerCacheHit, false);
      assert.equal(fresh.hits.length, 2);
      assert.equal(fresh.hits[0]!.segmentId, "visual-frame-1");
      assert.equal(fresh.hits[0]!.distance, 0.1);
      assert.deepEqual(readFileSync(f.base.file), f.originalBytes);
      assert.equal(sourceIndexCacheKey(f.base.index!), f.base.cacheKey);
      assert.deepEqual(fresh.index.segments.slice(0, 1), f.base.index!.segments);
      assert.equal(fresh.index.segments[2]!.startSec, 1);
      assert.equal(fresh.index.segments[2]!.endSec, 1.033333);
      assert.deepEqual(readSourceIndex("test", fresh.file), fresh.index);
      const cached = await ingestLocalVisual(request);
      assert.equal(cached.workerCacheHit, true);
      assert.equal(cached.cacheHit, true);
      const original = f.store.read();
      const plan = planBroll(
        {
          version: 1,
          projectId: "test",
          indexFile: path.relative(f.project, fresh.file),
          retrieval: { method: "native-image-distance" },
          segmentId: "visual-frame-1",
          contextSec: 0,
          trackId: "cutaway",
          clipId: "cutaway",
          outputStart: { num: 0, den: 1 },
          expectedRevision: 0,
        },
        { rootDir: f.root },
      );
      assert.equal(plan.selection.startSec, 0);
      assert.equal(plan.selection.endSec, 2, "full negated statement preserved");
      assert.equal(plan.sourceAudio, "muted-visual-track");
      const review = {
        planHash: plan.planHash,
        assetHash: plan.assetHash,
        reviewedBy: "synthetic-fixture",
        evidence: "Unit-only declaration, not human approval",
      };
      applyBroll(plan, review, { rootDir: f.root, dryRun: true });
      assert.deepEqual(f.store.read(), original);
      const result = applyBroll(plan, review, { rootDir: f.root });
      assert.deepEqual(result.timeline.tracks.slice(0, -1), original.timeline.tracks);
      assert.throws(() => applyBroll(plan, review, { rootDir: f.root }), /revision/);
      assert.deepEqual(f.store.undo(result.revision).timeline.tracks, original.timeline.tracks);
    } finally {
      f.cleanup();
    }
  },
);
test(
  "visual raw scores/query/frame/timecode corruption rejects on reread/apply without timeline writes",
  supported,
  async () => {
    const f = fixture();
    try {
      const fresh = await ingestLocalVisual({
        projectId: "test",
        indexFile: f.base.file,
        queryAssetId: f.query.id,
        config: f.config,
      });
      const plan = planBroll(
        {
          version: 1,
          projectId: "test",
          indexFile: path.relative(f.project, fresh.file),
          retrieval: { method: "native-image-distance" },
          segmentId: "visual-frame-1",
          trackId: "cutaway",
          clipId: "cutaway",
          outputStart: { num: 0, den: 1 },
          expectedRevision: 0,
        },
        { rootDir: f.root },
      );
      const review = {
        planHash: plan.planHash,
        assetHash: plan.assetHash,
        reviewedBy: "fixture",
        evidence: "Synthetic-only approval declaration",
      };
      const timeline = readFileSync(f.store.file),
        indexBytes = readFileSync(fresh.file),
        receiptBytes = readFileSync(fresh.receiptFile);
      for (const mutate of [
        (v: any) => (v.frames[0].distance = 0),
        (v: any) => (v.query.hash = "a".repeat(64)),
        (v: any) => (v.frames[0].timeSec = 0.1),
        (v: any) => (v.identity.runtime.osVersion = "forged"),
      ]) {
        const raw = JSON.parse(receiptBytes.toString());
        mutate(raw);
        writeFileSync(fresh.receiptFile, JSON.stringify(raw));
        assert.throws(() => readSourceIndex("test", fresh.file), /checksum/);
        assert.throws(() => applyBroll(plan, review, { rootDir: f.root }), /checksum/);
        writeFileSync(fresh.receiptFile, receiptBytes);
      }
      for (const mutate of [
        (v: any) => (v.segments[1].startSec = 0.01),
        (v: any) => (v.segments[1].evidence[0].detail = "rank forged"),
        (v: any) => (v.segments[0].text = "Do delete this caveat."),
      ]) {
        const index = JSON.parse(indexBytes.toString());
        mutate(index);
        writeFileSync(fresh.file, JSON.stringify(index));
        assert.throws(() => readSourceIndex("test", fresh.file), /immutable|Transcript/);
        assert.throws(() => applyBroll(plan, review, { rootDir: f.root }), /immutable|transcript/i);
        writeFileSync(fresh.file, indexBytes);
      }
      writeFileSync(path.join(f.root, "public", f.query.files.original), "changed-query");
      assert.throws(() => readSourceIndex("test", fresh.file), /query original changed/);
      assert.throws(() => applyBroll(plan, review, { rootDir: f.root }), /query original changed/);
      assert.deepEqual(readFileSync(f.store.file), timeline);
    } finally {
      f.cleanup();
    }
  },
);
test("visual rejects unsupported/unprepared runtime, aliases/FIFO, oversized batch and ambiguous terminal clock", async () => {
  const f = fixture();
  try {
    assert.equal((await probeLocalVisual({ ...f.config, executable: path.join(f.root, "missing") })).available, false);
    if (process.platform !== "darwin") {
      assert.equal((await probeLocalVisual(f.config)).available, false);
      return;
    }
    const request = { projectId: "test", indexFile: f.base.file, queryAssetId: f.query.id, config: f.config };
    await assert.rejects(() => ingestLocalVisual({ ...request, config: { ...f.config, maxFrames: 1 } }), /maxFrames/);
    await assert.rejects(() => ingestLocalVisual({ ...request, queryAssetId: "missing" }), /registered immutable/);
    symlinkSync(f.base.file, path.join(f.project, "alias"));
    await assert.rejects(() => ingestLocalVisual({ ...request, indexFile: path.join(f.project, "alias") }), /symlink/);
    const fifo = path.join(f.project, "fifo");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    await assert.rejects(() => ingestLocalVisual({ ...request, indexFile: fifo }), /bounded regular file/);
    const terminal = JSON.parse(f.originalBytes.toString());
    terminal.source.durationSec = 12;
    terminal.thumbnails[1].sourceFrame.num = terminal.source.timestamps.length - 1;
    terminal.thumbnails[1].timeSec = terminal.source.timestamps.at(-1);
    writeFileSync(f.base.file, JSON.stringify(terminal));
    await assert.rejects(() => ingestLocalVisual(request), /terminal frame extent/);
  } finally {
    f.cleanup();
  }
});
test("visual bounded protocol and whole-batch timeout kill owned descendants", supported, async () => {
  const f = fixture();
  try {
    const request = { projectId: "test", indexFile: f.base.file, queryAssetId: f.query.id, config: f.config };
    for (const mode of [
      "wrong-key",
      "missing-frame",
      "wrong-hash",
      "wrong-runtime",
      "wrong-orientation",
      "negative-distance",
      "oversized",
      "empty",
      "overflow",
      "extra-line",
    ]) {
      writeFileSync(f.mode, mode);
      await assert.rejects(() => ingestLocalVisual(request), /./, mode);
    }
    writeFileSync(f.mode, "timeout");
    // Leave time for the fixture to start before testing descendant cleanup under parallel load.
    await assert.rejects(() => ingestLocalVisual({ ...request, config: { ...f.config, timeoutMs: 5000 } }), /timeout/);
    assert.ok(existsSync(f.mode + ".pid"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(Number(readFileSync(f.mode + ".pid", "utf8")), 0));
  } finally {
    f.cleanup();
  }
});

test(
  "visual derivation over pinned OCR retains OCR/transcript receipt guarantees; reverse stacking refused explicitly",
  supported,
  async () => {
    const f = fixture();
    try {
      const ocrWorker = path.resolve(import.meta.dirname, "fixtures/ocr-worker.mjs"),
        ocrExe = path.join(f.root, "ocr-worker");
      const quote = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'";
      writeFileSync(
        ocrExe,
        `#!/bin/sh\nexec ${quote(realpathSync(process.execPath))} ${quote(ocrWorker)} ${quote(f.mode)}\n`,
        { mode: 0o700 },
      );
      const ocrConfig = {
        engine: "apple-vision" as const,
        executable: ocrExe,
        executableHash: hashFile(ocrExe),
        workerSource: ocrWorker,
        workerSourceHash: hashFile(ocrWorker),
        revision: 3 as const,
        languages: ["en-US"],
        maxFrames: 2,
        timeoutMs: 10000,
      };
      const ocr = await ingestLocalOcr({ projectId: "test", indexFile: f.base.file, config: ocrConfig });
      const visual = await ingestLocalVisual({
        projectId: "test",
        indexFile: ocr.file,
        queryAssetId: f.query.id,
        config: f.config,
      });
      assert.deepEqual(visual.index.segments.slice(0, ocr.index.segments.length), ocr.index.segments);
      assert.deepEqual(visual.index.ocrAnalysis, ocr.index.ocrAnalysis);
      assert.deepEqual(readSourceIndex("test", visual.file), visual.index);
      await assert.rejects(
        () => ingestLocalOcr({ projectId: "test", indexFile: visual.file, config: ocrConfig }),
        /no prior/,
      );
      const raw = JSON.parse(readFileSync(ocr.receiptFile, "utf8"));
      raw.frames[0].observations[0].text = "FRAME DELETED";
      writeFileSync(ocr.receiptFile, JSON.stringify(raw));
      assert.throws(() => readSourceIndex("test", visual.file), /OCR receipt checksum/);
    } finally {
      f.cleanup();
    }
  },
);
test("visual CLI is trusted-local only and emits exactly one JSON envelope", async () => {
  const f = fixture();
  try {
    const config = path.join(f.root, "config.json");
    writeFileSync(config, JSON.stringify({ ...f.config, executable: path.join(f.root, "missing") }));
    const cli = path.resolve(import.meta.dirname, "../scripts/media-visual.ts"),
      loader = path.resolve(import.meta.dirname, "../node_modules/tsx/dist/loader.mjs");
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["--import", loader, cli, ...args], {
        cwd: f.root,
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
        env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      });
    const probe = run(["--action", "probe", "--config", config]);
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim().split("\n").length, 1);
    const json = JSON.parse(probe.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.metadata.available, false);
    const invalid = run(["--action", "execute", "--config", config]);
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(invalid.stdout).error, "INVALID_INPUT");
  } finally {
    f.cleanup();
  }
});
