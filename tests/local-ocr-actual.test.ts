import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ingestMedia, readSourceIndex } from "../src/lib/ingest";
import { searchSourceIndexes } from "../src/lib/ingest/selects";
import { hashFile } from "../src/lib/assets/registry";
import { LocalOcrConfigSchema } from "../src/lib/ingest/local-ocr";
test(
  "actual native offline Vision OCR retains source-frame clocks/raw evidence/cache/search and corruption refusal",
  { skip: process.env.RUN_LOCAL_OCR_TESTS !== "1", timeout: 300000 },
  () => {
    assert.equal(process.platform, "darwin");
    const checkout = process.cwd(),
      configFile = process.env.LOCAL_OCR_CONFIG,
      images = process.env.LOCAL_OCR_FIXTURE_ROOT,
      artifacts = process.env.LOCAL_OCR_ARTIFACTS_DIR;
    assert.ok(configFile && images && artifacts && [configFile, images, artifacts].every((v) => path.isAbsolute(v)));
    const config = LocalOcrConfigSchema.parse(JSON.parse(readFileSync(configFile, "utf8"))),
      runtimeHash = hashFile(config.executable),
      sourceHash = hashFile(config.workerSource);
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(path.join(artifacts, "actual-run-")),
      project = path.join(root, "public/projects/test");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "project.json"), "{}");
    const report: Record<string, any> = {
      fixture:
        "Synthetic high-contrast native rendered English/Russian labels; not general OCR quality or human approval",
      apiCalls: 0,
      downloads: 0,
      providerSpendUsd: 0,
      config,
      receipts: [],
    };
    const save = (name: string, value: unknown) =>
      writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + "\n");
    const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
    const cli = (args: string[], success = true) => {
      const start = Date.now(),
        p = spawnSync(
          process.execPath,
          [
            "--import",
            path.resolve(checkout, "node_modules/tsx/dist/loader.mjs"),
            path.resolve(checkout, "scripts/media-ocr.ts"),
            "--config",
            configFile,
            ...args,
          ],
          { cwd: root, env, encoding: "utf8", timeout: 150000, maxBuffer: 1024 * 1024 },
        );
      assert.equal(p.error, undefined);
      assert.equal(p.stdout.trim().split("\n").length, 1, p.stdout);
      const value = JSON.parse(p.stdout);
      assert.equal(value.ok, success, JSON.stringify(value));
      assert.equal(p.status, success ? 0 : 1, p.stderr);
      const file = `receipt-${report.receipts.length}.json`;
      save(file, value);
      writeFileSync(path.join(root, file + ".stderr"), p.stderr);
      report.receipts.push({ file, sha256: hashFile(path.join(root, file)), args, elapsedMs: Date.now() - start });
      return value;
    };
    try {
      const denied = spawnSync(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          "(version 1)(allow default)(deny network*)",
          process.execPath,
          "-e",
          "require('node:net').createServer().listen(0,'127.0.0.1')",
        ],
        { env, encoding: "utf8", timeout: 10000 },
      );
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /EPERM|Operation not permitted/);
      report.networkProbe = { denied: true, stderr: denied.stderr };
      const english = path.join(images, "english.png"),
        russian = path.join(images, "russian.png");
      report.fixtureHashes = { english: hashFile(english), russian: hashFile(russian) };
      const video = path.join(root, "source.mp4");
      const ff = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-loop",
          "1",
          "-i",
          english,
          "-loop",
          "1",
          "-i",
          russian,
          "-filter_complex",
          "[0:v]trim=duration=1,setpts=PTS-STARTPTS[e];[1:v]trim=duration=1,setpts=PTS-STARTPTS[r];[e][r]concat=n=2:v=1:a=0[out]",
          "-map",
          "[out]",
          "-r",
          "30",
          "-t",
          "2",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          video,
        ],
        { env, encoding: "utf8", timeout: 30000 },
      );
      assert.equal(ff.status, 0, ff.stderr);
      const videoHash = hashFile(video),
        transcript = path.join(root, "supplied.json");
      writeFileSync(
        transcript,
        JSON.stringify({ segments: [{ text: "Do not delete supplied speech.", start: 0, end: 2 }] }),
      );
      process.chdir(root);
      const base = ingestMedia({
          projectId: "test",
          sourceFile: video,
          transcriptFile: transcript,
          options: { thumbnailEverySec: 1 },
        }),
        baseBytes = readFileSync(base.file);
      const probe = cli(["--action", "probe"]);
      assert.equal(probe.metadata.available, true);
      assert.equal(probe.metadata.identity.runtime.revision, 3);
      const args = ["--action", "ingest", "--project", "test", "--index", base.file],
        fresh = cli(args),
        replay = cli(args);
      assert.equal(fresh.metadata.workerCacheHit, false);
      assert.equal(fresh.metadata.cacheHit, false);
      assert.equal(replay.metadata.workerCacheHit, true);
      assert.equal(replay.metadata.cacheHit, true);
      assert.equal(fresh.metadata.file, replay.metadata.file);
      const index = readSourceIndex("test", fresh.metadata.file),
        raw = JSON.parse(readFileSync(fresh.metadata.receiptFile, "utf8"));
      assert.equal(raw.identityHash, index.ocrAnalysis!.identityHash);
      assert.equal(raw.frames.length, 2);
      assert.deepEqual(
        raw.frames.map((f: any) => [f.sourceFrame.num, f.timeSec]),
        [
          [0, 0],
          [30, 1],
        ],
      );
      const labels = ["VIDEO EDITING", "КАЧЕСТВО ЗАПИСИ"];
      const hits = labels.map((query, i) => {
        const found = searchSourceIndexes([index], query);
        assert.ok(found.length, query);
        const top = found[0]!;
        assert.equal(top.startSec, i);
        assert.ok(top.endSec - top.startSec < 0.034);
        assert.equal(top.evidence[0]!.kind, "ocr");
        return { query, fixedExpectedFrame: i * 30, actualText: top.text, startSec: top.startSec, endSec: top.endSec };
      });
      assert.deepEqual(index.segments.slice(0, base.index!.segments.length), base.index!.segments);
      assert.deepEqual(readFileSync(base.file), baseBytes);
      assert.equal(hashFile(video), videoHash);
      const receiptBytes = readFileSync(fresh.metadata.receiptFile),
        changed = JSON.parse(receiptBytes.toString());
      changed.frames[0].observations[0].text = "VIDEO NOT EDITING";
      writeFileSync(fresh.metadata.receiptFile, JSON.stringify(changed));
      const negative = cli(args, false);
      assert.match(negative.message, /checksum/);
      assert.throws(() => readSourceIndex("test", fresh.metadata.file), /checksum/);
      writeFileSync(fresh.metadata.receiptFile, receiptBytes);
      assert.equal(hashFile(config.executable), runtimeHash);
      assert.equal(hashFile(config.workerSource), sourceHash);
      report.acceptance =
        "Bounded actual installed Vision, two synthetic labels, immutable originals/cache and sampled-frame lexical retrieval";
      report.hits = hits;
      report.rawReceipt = fresh.metadata.receiptFile;
      report.rawReceiptHash = hashFile(fresh.metadata.receiptFile);
      report.baseFile = base.file;
      report.baseHash = hashFile(base.file);
      report.indexFile = fresh.metadata.file;
      report.indexHash = hashFile(fresh.metadata.file);
      report.videoHash = videoHash;
      report.originalTranscriptPreserved = true;
      report.rawCorruptionRefused = true;
      report.runtimeUnchanged = true;
    } finally {
      process.chdir(checkout);
      save("report.json", report);
      writeFileSync(
        path.join(artifacts, "latest-run.json"),
        JSON.stringify({ root, report: path.join(root, "report.json") }) + "\n",
      );
    }
  },
);
