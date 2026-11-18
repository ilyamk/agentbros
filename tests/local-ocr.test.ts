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
import { LocalOcrConfigSchema, ingestLocalOcr, probeLocalOcr } from "../src/lib/ingest/local-ocr";
import { ingestMedia, readSourceIndex } from "../src/lib/ingest";
import { sourceIndexCacheKey } from "../src/lib/ingest/ocr-evidence";
import { hashFile, importAsset } from "../src/lib/assets/registry";
import { searchSourceIndexes } from "../src/lib/ingest/selects";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { planBroll, applyBroll } from "../src/lib/ingest/broll";
import { pathToFileURL } from "node:url";
const worker = path.resolve(import.meta.dirname, "fixtures/ocr-worker.mjs");
function fixture() {
  const cwd = process.cwd(),
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "offline OCR ")));
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
    engine: "apple-vision" as const,
    executable,
    executableHash: hashFile(executable),
    workerSource: worker,
    workerSourceHash: hashFile(worker),
    revision: 3 as const,
    languages: ["en-US", "ru-RU"],
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
    cleanup: () => {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const supported = { skip: process.platform !== "darwin" };
test(
  "OCR derived index preserves original cached bytes/transcript, one-frame candidates, immutable receipt and lexical replay",
  supported,
  async () => {
    const f = fixture();
    try {
      const fresh = await ingestLocalOcr({ projectId: "test", indexFile: f.base.file, config: f.config });
      assert.equal(fresh.cacheHit, false);
      assert.equal(fresh.workerCacheHit, false);
      assert.equal(fresh.index.ocrAnalysis?.occurrence, "sampled-decoded-frame-v1");
      assert.deepEqual(readFileSync(f.base.file), f.originalBytes);
      assert.deepEqual(fresh.index.segments.slice(0, 1), f.base.index!.segments);
      const ocr = fresh.index.segments.filter((s) => s.evidence[0]?.kind === "ocr");
      assert.equal(ocr.length, 2);
      assert.equal(ocr[0]!.startSec, 0);
      assert.equal(ocr[0]!.endSec, 0.033333);
      assert.equal(ocr[1]!.startSec, 1);
      assert.equal(ocr[1]!.endSec, 1.033333);
      assert.equal(searchSourceIndexes([fresh.index], "NOT DELETED")[0]!.evidence[0]!.kind, "ocr");
      const replay = await ingestLocalOcr({ projectId: "test", indexFile: f.base.file, config: f.config });
      assert.equal(replay.workerCacheHit, true);
      assert.equal(replay.cacheHit, true);
      assert.equal(replay.file, fresh.file);
      assert.deepEqual(readSourceIndex("test", fresh.file), fresh.index);
      const original = f.store.read();
      const plan = planBroll(
        {
          version: 1,
          projectId: "test",
          indexFile: path.relative(f.project, fresh.file),
          retrieval: { method: "lexical", query: "NOT DELETED" },
          segmentId: "ocr-frame-0-0",
          contextSec: 0,
          trackId: "cutaway",
          clipId: "ocr-cutaway",
          outputStart: { num: 0, den: 1 },
          expectedRevision: original.revision,
        },
        { rootDir: f.root },
      );
      assert.equal(plan.selection.endSec, 2, "Existing supplied statement remains protected around frame candidate");
      const review = {
        planHash: plan.planHash,
        assetHash: plan.assetHash,
        reviewedBy: "synthetic-only",
        evidence: "Fixture declaration, not human creative/publication approval",
      };
      applyBroll(plan, review, { rootDir: f.root, dryRun: true });
      assert.deepEqual(f.store.read(), original);
      const forged = JSON.parse(readFileSync(fresh.file, "utf8"));
      forged.segments[1].text = "FRAME DELETED";
      writeFileSync(fresh.file, JSON.stringify(forged));
      assert.throws(() => readSourceIndex("test", fresh.file), /immutable raw evidence/);
      assert.throws(() => applyBroll(plan, review, { rootDir: f.root }), /immutable raw evidence/);
      assert.deepEqual(f.store.read(), original);
    } finally {
      f.cleanup();
    }
  },
);
test(
  "OCR corrupted receipts/cache/base clocks/frame pins/runtime fail closed without reinterpreting old index",
  supported,
  async () => {
    const f = fixture();
    try {
      const fresh = await ingestLocalOcr({ projectId: "test", indexFile: f.base.file, config: f.config });
      const receipt = readFileSync(fresh.receiptFile);
      const corrupted = JSON.parse(receipt.toString());
      corrupted.frames[0].observations[0].text = "FRAME DELETED";
      writeFileSync(fresh.receiptFile, JSON.stringify(corrupted));
      await assert.rejects(
        () => ingestLocalOcr({ projectId: "test", indexFile: f.base.file, config: f.config }),
        /checksum/,
      );
      assert.throws(() => readSourceIndex("test", fresh.file), /checksum/);
      writeFileSync(fresh.receiptFile, receipt);
      const altered = JSON.parse(f.originalBytes.toString());
      altered.source.timestamps[0] = 0.1;
      writeFileSync(f.base.file, JSON.stringify(altered));
      assert.throws(() => readSourceIndex("test", fresh.file), /base index checksum/);
      writeFileSync(f.base.file, f.originalBytes);
      writeFileSync(f.config.executable, "changed");
      await assert.rejects(() => probeLocalOcr(f.config), /checksum/);
    } finally {
      f.cleanup();
    }
  },
);
test("OCR unsupported host/config/language/oversized frame counts and aliases reject explicitly", async () => {
  assert.throws(() => LocalOcrConfigSchema.parse({ engine: "apple-vision", revision: 2 }));
  const f = fixture();
  try {
    assert.equal((await probeLocalOcr({ ...f.config, executable: path.join(f.root, "missing") })).available, false);
    if (process.platform !== "darwin") {
      assert.equal((await probeLocalOcr(f.config)).available, false);
      return;
    }
    await assert.rejects(() => probeLocalOcr({ ...f.config, languages: ["fr-FR"] }), /Unsupported/);
    await assert.rejects(
      () => ingestLocalOcr({ projectId: "test", indexFile: f.base.file, config: { ...f.config, maxFrames: 1 } }),
      /maxFrames/,
    );
    symlinkSync(f.base.file, path.join(f.project, "linked.json"));
    await assert.rejects(
      () => ingestLocalOcr({ projectId: "test", indexFile: path.join(f.project, "linked.json"), config: f.config }),
      /symlink/,
    );
    assert.equal(sourceIndexCacheKey(f.base.index!), f.base.cacheKey);
  } finally {
    f.cleanup();
  }
});
test(
  "OCR bounded worker rejects protocol/box/count/hash/runtime/output negatives and timeout kills owned descendants",
  supported,
  async () => {
    const f = fixture();
    try {
      for (const mode of [
        "wrong-key",
        "missing-frame",
        "wrong-hash",
        "wrong-runtime",
        "box",
        "empty",
        "extra-line",
        "overflow",
      ]) {
        writeFileSync(f.mode, mode);
        await assert.rejects(
          () => ingestLocalOcr({ projectId: "test", indexFile: f.base.file, config: f.config }),
          /./,
          mode,
        );
      }
      writeFileSync(f.mode, "timeout");
      await assert.rejects(
        () => ingestLocalOcr({ projectId: "test", indexFile: f.base.file, config: { ...f.config, timeoutMs: 500 } }),
        /timeout/,
      );
      assert.ok(existsSync(f.mode + ".pid"));
      const pid = Number(readFileSync(f.mode + ".pid", "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.throws(() => process.kill(pid, 0));
    } finally {
      f.cleanup();
    }
  },
);
test("OCR JSON FIFO refuses promptly and last sampled frame cannot claim a container/audio tail", async () => {
  const f = fixture();
  try {
    const fifo = path.join(f.project, "input-fifo");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    const module = pathToFileURL(path.resolve(import.meta.dirname, "../src/lib/ingest/ocr-evidence.ts")).href;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        path.resolve(import.meta.dirname, "../node_modules/tsx/dist/loader.mjs"),
        "--input-type=module",
        "-e",
        `import * as ocrModule from ${JSON.stringify(module)};const {readOcrJson}=ocrModule.default??ocrModule;try{readOcrJson(${JSON.stringify(fifo)});process.exit(2)}catch(e){console.log(String(e))}`,
      ],
      { encoding: "utf8", timeout: 2000 },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
    assert.match(child.stdout, /bounded regular file/);
    await assert.rejects(
      () => ingestLocalOcr({ projectId: "test", indexFile: fifo, config: f.config }),
      /bounded regular file/,
    );
    assert.throws(() => readSourceIndex("test", fifo), /regular file/);
    assert.throws(
      () =>
        planBroll(
          {
            version: 1,
            projectId: "test",
            indexFile: "input-fifo",
            retrieval: { method: "lexical", query: "test" },
            segmentId: "test",
            trackId: "cutaway",
            clipId: "cutaway",
            outputStart: { num: 0, den: 1 },
            expectedRevision: 0,
          },
          { rootDir: f.root },
        ),
      /bounded regular file/,
    );
    const terminal = JSON.parse(f.originalBytes.toString());
    terminal.source.durationSec = 12;
    terminal.thumbnails[1].sourceFrame.num = terminal.source.timestamps.length - 1;
    terminal.thumbnails[1].timeSec = terminal.source.timestamps.at(-1);
    writeFileSync(f.base.file, JSON.stringify(terminal));
    await assert.rejects(
      () => ingestLocalOcr({ projectId: "test", indexFile: f.base.file, config: f.config }),
      /terminal frame extent is unverified/,
    );
  } finally {
    f.cleanup();
  }
});
