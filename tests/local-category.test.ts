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
  truncateSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { ingestLocalCategory, probeLocalCategory, LocalCategoryConfigSchema } from "../src/lib/ingest/local-category";
import { ingestLocalVisual } from "../src/lib/ingest/local-visual";
import { ingestLocalOcr } from "../src/lib/ingest/local-ocr";
import { CategoryQuerySchema, CategoryScoreSchema } from "../src/types/category-search";
import {
  validateCategoryRuntime,
  validateCategoryReceipt,
  searchCategoryFrames,
  categorySegments,
  categoryReceiptKey,
} from "../src/lib/ingest/category-evidence";
import { boundedEvidenceJson } from "../src/lib/ingest/bounded-evidence";
import { digest } from "../src/lib/jobs/model-artifacts";
import { ingestMedia, readSourceIndex } from "../src/lib/ingest";
import { sourceIndexCacheKey } from "../src/lib/ingest/ocr-evidence";
import { hashFile, importAsset } from "../src/lib/assets/registry";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { planBroll, applyBroll } from "../src/lib/ingest/broll";
const worker = path.resolve(import.meta.dirname, "fixtures/category-worker.mjs");
const query = {
  version: 1 as const,
  method: "native-image-category" as const,
  taxonomyHash: digest("cat\ndog"),
  identifier: "dog",
};
function fixture() {
  const cwd = process.cwd(),
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "offline category ")));
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
    engine: "apple-vision-classification" as const,
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
    cleanup: () => {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const supported = { skip: process.platform !== "darwin" };
const request = (f: ReturnType<typeof fixture>) => ({
  projectId: "test",
  indexFile: f.base.file,
  query,
  config: f.config,
});
test("strict taxonomy/score/query contracts refuse unordered/duplicate/unknown hashes, nonfinite and unsafe settings", () => {
  const runtime = {
    engine: "apple-vision-classification",
    revision: 2,
    osVersion: "fixture",
    inputPolicy: "classification-framework-default/full-image-region-v1",
    regionOfInterest: { x: 0, y: 0, width: 1, height: 1 },
    cpuOnly: true,
    orientationPolicy: "validated-jpeg-png-exif-1-through-8-v1",
    taxonomy: { identifiers: ["cat", "dog"], hash: query.taxonomyHash },
  };
  assert.deepEqual(validateCategoryRuntime(runtime), runtime);
  assert.throws(() => validateCategoryRuntime({ ...runtime, inputPolicy: "scaleFill" }));
  assert.throws(() => validateCategoryRuntime({ ...runtime, regionOfInterest: { x: 0, y: 0, width: 0.5, height: 1 } }));
  const { inputPolicy: _policy, regionOfInterest: _region, ...withoutPolicy } = runtime;
  const old = { ...withoutPolicy, crop: "scaleFill" };
  assert.throws(() => validateCategoryRuntime(old));
  assert.notEqual(
    categoryReceiptKey(digest(JSON.stringify(runtime)), "a".repeat(64), {}, []),
    categoryReceiptKey(digest(JSON.stringify(old)), "a".repeat(64), {}, []),
    "runtime input policy changes category cache generation",
  );
  for (const ids of [["dog", "cat"], ["cat", "cat"], [], ["bad\nlabel"]])
    assert.throws(() =>
      validateCategoryRuntime({ ...runtime, taxonomy: { identifiers: ids, hash: digest(ids.join("\n")) } }),
    );
  assert.throws(() => validateCategoryRuntime({ ...runtime, taxonomy: { ...runtime.taxonomy, hash: "a".repeat(64) } }));
  for (const score of [-1, 1.01, Infinity, NaN])
    assert.equal(CategoryScoreSchema.safeParse({ identifier: "cat", score }).success, false);
  for (const raw of [
    { ...query, confidence: 0.9 },
    { ...query, identifier: "" },
    { ...query, taxonomyHash: "no" },
  ])
    assert.equal(CategoryQuerySchema.safeParse(raw).success, false);
  for (const raw of [
    { engine: "CLIP" },
    {
      engine: "apple-vision-classification",
      executable: "/x",
      executableHash: "a".repeat(64),
      workerSource: "/s",
      workerSourceHash: "a".repeat(64),
      revision: 2,
      maxFrames: 33,
    },
    {
      engine: "apple-vision-classification",
      executable: "/x",
      executableHash: "a".repeat(64),
      workerSource: "/s",
      workerSourceHash: "a".repeat(64),
      revision: 2,
      timeoutMs: 120001,
    },
  ])
    assert.equal(LocalCategoryConfigSchema.safeParse(raw).success, false);
});
test(
  "category receipts preserve all native rows, missing-label distinction, exact ranks/nextPTS, cache/legacy/protected Broll/CAS/Undo",
  supported,
  async () => {
    const f = fixture();
    try {
      const fresh = await ingestLocalCategory(request(f));
      assert.equal(fresh.workerCacheHit, false);
      assert.deepEqual(
        fresh.hits.map((h) => [h.segmentId, h.score]),
        [
          ["category-frame-1", 0.9],
          ["category-frame-0", 0.1],
        ],
      );
      assert.equal(fresh.hits[0]!.endSec, 1.033333);
      assert.deepEqual(fresh.index.segments.slice(0, f.base.index!.segments.length), f.base.index!.segments);
      assert.deepEqual(readFileSync(f.base.file), f.originalBytes);
      const oldKey = digest(
        JSON.stringify({
          version: 1,
          sourceHash: f.base.index!.sourceHash,
          options: f.base.index!.options,
          transcriptHash: f.base.index!.transcript?.hash,
        }),
      );
      assert.equal(sourceIndexCacheKey(f.base.index!), oldKey);
      const publicFile = (ref: string) => path.join(f.root, "public", ref),
        raw = validateCategoryReceipt(boundedEvidenceJson(fresh.receiptFile).value);
      assert.deepEqual(
        raw.frames.map((r) => r.observations.length),
        [2, 1],
      );
      const cats = searchCategoryFrames(fresh.index, publicFile, { ...query, identifier: "cat" });
      assert.equal(cats.length, 1);
      assert.equal(cats[0]!.score, 0, "real returned zero is kept, omitted frame is not fabricated");
      assert.throws(
        () => searchCategoryFrames(fresh.index, publicFile, { ...query, identifier: "Cat" }),
        /exact supported/,
      );
      assert.throws(
        () => searchCategoryFrames(fresh.index, publicFile, { ...query, taxonomyHash: "a".repeat(64) }),
        /hash/,
      );
      assert.deepEqual(readSourceIndex("test", fresh.file), fresh.index);
      const second = await ingestLocalCategory({ ...request(f), query: { ...query, identifier: "cat" } });
      assert.equal(second.workerCacheHit, true);
      assert.equal(second.cacheHit, true);
      assert.equal(second.receiptFile, fresh.receiptFile);
      const queryFile = path.join(f.project, "query.json");
      writeFileSync(queryFile, JSON.stringify(query));
      const before = f.store.read();
      const plan = planBroll(
        {
          version: 1,
          projectId: "test",
          indexFile: path.relative(f.project, fresh.file),
          retrieval: { method: "native-image-category", queryFile: "query.json" },
          segmentId: "category-frame-1",
          trackId: "cutaway",
          clipId: "cutaway",
          outputStart: { num: 0, den: 1 },
          expectedRevision: 0,
        },
        { rootDir: f.root },
      );
      assert.equal(plan.sourceAudio, "muted-visual-track");
      assert.equal(plan.selection.startSec, 0);
      assert.equal(plan.selection.endSec, 2, "negated statement preserved");
      const review = {
        planHash: plan.planHash,
        assetHash: plan.assetHash,
        reviewedBy: "fixture",
        evidence: "Synthetic test-only declaration, not human approval",
      };
      applyBroll(plan, review, { rootDir: f.root, dryRun: true });
      assert.deepEqual(f.store.read(), before);
      const changed = applyBroll(plan, review, { rootDir: f.root });
      assert.deepEqual(changed.timeline.tracks.slice(0, -1), before.timeline.tracks);
      assert.equal(
        changed.timeline.tracks.at(-1)!.kind,
        "visual",
        "existing renderer owns muted visual track, never an added speech track",
      );
      assert.throws(() => applyBroll(plan, review, { rootDir: f.root }), /revision/);
      assert.deepEqual(f.store.undo(changed.revision).timeline, before.timeline);
      await assert.rejects(
        () =>
          ingestLocalOcr({
            projectId: "test",
            indexFile: fresh.file,
            config: {
              engine: "apple-vision",
              executable: "missing",
              executableHash: "a".repeat(64),
              workerSource: "missing",
              workerSourceHash: "a".repeat(64),
              revision: 3,
              languages: ["en-US"],
            },
          }),
        /no prior/,
      );
      await assert.rejects(
        () =>
          ingestLocalVisual({
            projectId: "test",
            indexFile: fresh.file,
            queryAssetId: "missing",
            config: { ...f.config, engine: "apple-vision-feature-print" },
          }),
        /no prior/,
      );
    } finally {
      f.cleanup();
    }
  },
);
test(
  "raw category/query/ranks/source/PTS and protected negation corruption fail before Broll writes",
  supported,
  async () => {
    const f = fixture();
    try {
      const result = await ingestLocalCategory(request(f)),
        indexBytes = readFileSync(result.file),
        receiptBytes = readFileSync(result.receiptFile),
        queryFile = path.join(f.project, "query.json");
      writeFileSync(queryFile, JSON.stringify(query));
      const plan = planBroll(
          {
            version: 1,
            projectId: "test",
            indexFile: path.relative(f.project, result.file),
            retrieval: { method: "native-image-category", queryFile: "query.json" },
            segmentId: "category-frame-1",
            trackId: "cutaway",
            clipId: "cutaway",
            outputStart: { num: 0, den: 1 },
            expectedRevision: 0,
          },
          { rootDir: f.root },
        ),
        before = readFileSync(f.store.file),
        review = {
          planHash: plan.planHash,
          assetHash: plan.assetHash,
          reviewedBy: "fixture",
          evidence: "Synthetic-only declaration",
        };
      for (const mutate of [
        (v: any) => (v.frames[0].observations[0].score = 0.7),
        (v: any) => (v.frames[1].timeSec = 0.5),
        (v: any) => (v.identity.runtime.osVersion = "changed"),
        (v: any) => (v.frames[0].hash = "a".repeat(64)),
      ]) {
        const raw = JSON.parse(receiptBytes.toString());
        mutate(raw);
        writeFileSync(result.receiptFile, JSON.stringify(raw));
        assert.throws(() => readSourceIndex("test", result.file), /checksum/);
        assert.throws(() => applyBroll(plan, review, { rootDir: f.root }), /checksum/);
        writeFileSync(result.receiptFile, receiptBytes);
      }
      for (const mutate of [
        (v: any) => (v.segments[1].startSec = 0.01),
        (v: any) => (v.segments[1].evidence[0].detail = "fake confidence"),
        (v: any) => (v.segments[0].text = "Do delete this caveat."),
      ]) {
        const raw = JSON.parse(indexBytes.toString());
        mutate(raw);
        writeFileSync(result.file, JSON.stringify(raw));
        assert.throws(() => readSourceIndex("test", result.file), /immutable|Transcript/);
        assert.throws(() => applyBroll(plan, review, { rootDir: f.root }), /immutable|transcript/i);
        writeFileSync(result.file, indexBytes);
      }
      writeFileSync(queryFile, JSON.stringify({ ...query, identifier: "cat" }));
      assert.throws(() => applyBroll(plan, review, { rootDir: f.root }), /absent from reproducible|changed|plan/i);
      assert.deepEqual(readFileSync(f.store.file), before);
      const raw = validateCategoryReceipt(JSON.parse(receiptBytes.toString()));
      raw.frames[0]!.observations.push({ identifier: "unknown", score: 1 });
      assert.throws(() => validateCategoryReceipt(raw), /supported/);
      const base = structuredClone(f.base.index!);
      base.source.timestamps[1] = undefined as unknown as number;
      assert.throws(
        () => categorySegments(base, validateCategoryReceipt(JSON.parse(receiptBytes.toString())), "a".repeat(64)),
        /nextPTS/,
      );
      const frame = path.join(f.root, "public", result.index.thumbnails[0]!.path);
      writeFileSync(frame, "changed");
      assert.throws(() => readSourceIndex("test", result.file), /checksum/);
      assert.deepEqual(readFileSync(f.store.file), before);
    } finally {
      f.cleanup();
    }
  },
);
test(
  "category pipeline refuses taxonomy/protocol/caps/aliases/FIFO/terminal and kills owned timeout descendants",
  supported,
  async () => {
    const f = fixture();
    try {
      for (const mode of [
        "bad-taxonomy",
        "wrong-key",
        "missing-frame",
        "wrong-hash",
        "wrong-runtime",
        "wrong-policy",
        "wrong-region",
        "legacy-crop",
        "unknown-label",
        "duplicate-label",
        "wrong-order",
        "negative-score",
        "oversized",
        "empty",
        "overflow",
        "extra-line",
      ]) {
        writeFileSync(f.mode, mode);
        await assert.rejects(() => ingestLocalCategory(request(f)), /./, mode);
      }
      writeFileSync(f.mode, "timeout");
      await assert.rejects(
        () => ingestLocalCategory({ ...request(f), config: { ...f.config, timeoutMs: 500 } }),
        /timeout/,
      );
      await new Promise((r) => setTimeout(r, 50));
      assert.throws(() => process.kill(Number(readFileSync(f.mode + ".pid", "utf8")), 0));
      writeFileSync(f.mode, "ok");
      await assert.rejects(
        () => ingestLocalCategory({ ...request(f), config: { ...f.config, maxFrames: 1 } }),
        /maxFrames/,
      );
      const alias = path.join(f.project, "alias");
      symlinkSync(f.base.file, alias);
      await assert.rejects(() => ingestLocalCategory({ ...request(f), indexFile: alias }), /symlink/);
      const fifo = path.join(f.project, "fifo");
      assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
      await assert.rejects(() => ingestLocalCategory({ ...request(f), indexFile: fifo }), /bounded regular/);
      const terminal = JSON.parse(f.originalBytes.toString());
      terminal.thumbnails[1].sourceFrame.num = terminal.source.timestamps.length - 1;
      terminal.thumbnails[1].timeSec = terminal.source.timestamps.at(-1);
      writeFileSync(f.base.file, JSON.stringify(terminal));
      await assert.rejects(() => ingestLocalCategory(request(f)), /terminal/);
    } finally {
      f.cleanup();
    }
  },
);
test("bounded category receipt reader refuses FIFO/symlink/sparse overflow without native execution", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "category-evidence-")));
  try {
    const file = path.join(root, "json");
    writeFileSync(file, "{}");
    const alias = path.join(root, "alias");
    symlinkSync(file, alias);
    assert.throws(() => boundedEvidenceJson(alias));
    const large = path.join(root, "large");
    writeFileSync(large, "");
    truncateSync(large, 8 * 1024 * 1024 + 1);
    assert.throws(() => boundedEvidenceJson(large, 8 * 1024 * 1024), /bounded/);
    if (process.platform !== "win32") {
      const fifo = path.join(root, "fifo");
      assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
      assert.throws(() => boundedEvidenceJson(fifo, 8 * 1024 * 1024), /bounded/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test(
  "category over OCR and image-distance verifies full prior chain; corrupted lower receipt cannot hide behind category pins",
  supported,
  async () => {
    const f = fixture();
    try {
      const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
      const prepare = (name: string) => {
        const source = path.resolve(import.meta.dirname, `fixtures/${name}-worker.mjs`),
          exe = path.join(f.root, `${name}-worker`);
        writeFileSync(
          exe,
          `#!/bin/sh\nexec ${quote(realpathSync(process.execPath))} ${quote(source)} ${quote(f.mode)}\n`,
          { mode: 0o700 },
        );
        return {
          executable: exe,
          executableHash: hashFile(exe),
          workerSource: source,
          workerSourceHash: hashFile(source),
          maxFrames: 2,
          timeoutMs: 10000,
        };
      };
      const ocr = await ingestLocalOcr({
        projectId: "test",
        indexFile: f.base.file,
        config: { ...prepare("ocr"), engine: "apple-vision", revision: 3, languages: ["en-US"] },
      });
      const queryImage = path.join(f.root, "query.png");
      const ff = spawnSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        path.join(f.root, "source.mp4"),
        "-frames:v",
        "1",
        queryImage,
      ]);
      assert.equal(ff.status, 0, ff.stderr?.toString());
      const asset = importAsset({ projectId: "test", sourceFile: queryImage, provenance: { origin: "manual" } }).asset;
      const visual = await ingestLocalVisual({
        projectId: "test",
        indexFile: ocr.file,
        queryAssetId: asset.id,
        config: { ...prepare("visual"), engine: "apple-vision-feature-print", revision: 2 },
      });
      const category = await ingestLocalCategory({ ...request(f), indexFile: visual.file });
      assert.deepEqual(category.index.ocrAnalysis, ocr.index.ocrAnalysis);
      assert.deepEqual(category.index.visualAnalysis, visual.index.visualAnalysis);
      assert.deepEqual(category.index.segments.slice(0, visual.index.segments.length), visual.index.segments);
      assert.deepEqual(readSourceIndex("test", category.file, { boundedEvidence: true }), category.index);
      const publicFile = (ref: string) => path.join(f.root, "public", ref);
      for (const file of [ocr.receiptFile, visual.receiptFile]) {
        const bytes = readFileSync(file);
        writeFileSync(file, "{}");
        assert.throws(() => searchCategoryFrames(category.index, publicFile, query), /checksum/);
        assert.throws(() => readSourceIndex("test", category.file), /checksum/);
        writeFileSync(file, bytes);
      }
    } finally {
      f.cleanup();
    }
  },
);
test("category CLI probe/unavailable and executor-free search error return oneJSON, no paid tools", async () => {
  const f = fixture();
  try {
    const config = path.join(f.root, "config.json");
    writeFileSync(config, JSON.stringify({ ...f.config, executable: path.join(f.root, "missing") }));
    const queryFile = path.join(f.project, "query.json");
    writeFileSync(queryFile, JSON.stringify(query));
    const cli = path.resolve(import.meta.dirname, "../scripts/media-category.ts"),
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
    assert.equal(JSON.parse(probe.stdout).metadata.available, false);
    const bad = run(["--action", "execute", "--config", config]);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(bad.stdout).error, "INVALID_INPUT");
    const absent = run(["--action", "search", "--project", "test", "--index", f.base.file, "--query", queryFile]);
    assert.equal(absent.status, 1);
    assert.equal(absent.stdout.trim().split("\n").length, 1);
    assert.match(JSON.parse(absent.stdout).message, /pinned analysis/);
    const escaping = run(["--action", "search", "--project", "test", "--index", f.base.file, "--query", config]);
    assert.equal(escaping.status, 1);
    assert.match(JSON.parse(escaping.stdout).message, /outside project/);
  } finally {
    f.cleanup();
  }
});
test("complete bounded taxonomy scores preserve every returned label at32 frames, without topK truncation", () => {
  const ids = Array.from({ length: 1303 }, (_, i) => `fixture-category-${String(i).padStart(4, "0")}`),
    taxonomy = { identifiers: ids, hash: digest(ids.join("\n")) };
  const runtime = {
    engine: "apple-vision-classification",
    revision: 2,
    osVersion: "synthetic-schema-only",
    inputPolicy: "classification-framework-default/full-image-region-v1",
    regionOfInterest: { x: 0, y: 0, width: 1, height: 1 },
    cpuOnly: true,
    orientationPolicy: "validated-jpeg-png-exif-1-through-8-v1",
    taxonomy,
  };
  const frames = Array.from({ length: 32 }, (_, i) => ({
    path: `projects/test/frame-${i}.png`,
    hash: "a".repeat(64),
    timeSec: i,
    sourceFrame: { num: i, den: 1 },
    width: 320,
    height: 180,
    observations: ids.map((identifier, j) => ({ identifier, score: j / 1303 })),
  }));
  const raw = {
    version: 1,
    key: "a".repeat(64),
    identityHash: "a".repeat(64),
    identity: { runtime, executableHash: "a".repeat(64), workerSourceHash: "a".repeat(64) },
    sourceHash: "a".repeat(64),
    baseIndex: { path: "projects/test/base.json", hash: "a".repeat(64), cacheKey: "a".repeat(64) },
    frames,
    outputHash: "a".repeat(64),
  };
  const receipt = validateCategoryReceipt(raw);
  assert.equal(receipt.frames.length, 32);
  assert.ok(receipt.frames.every((row) => row.observations.length === 1303));
  assert.equal(receipt.frames[31]!.observations[1302]!.identifier, ids[1302]);
  const hugeIds = Array.from({ length: 2048 }, (_, i) => `${String(i).padStart(4, "0")}-${"x".repeat(190)}`),
    hugeFrames = frames.map((frame) => ({
      ...frame,
      observations: hugeIds.map((identifier) => ({ identifier, score: 0.5 })),
    }));
  assert.throws(
    () =>
      validateCategoryReceipt({
        ...raw,
        identity: {
          ...raw.identity,
          runtime: { ...runtime, taxonomy: { identifiers: hugeIds, hash: digest(hugeIds.join("\n")) } },
        },
        frames: hugeFrames,
      }),
    /8MiB/,
  );
});

test(
  "same-byte frame ancestor replaced by symlink during worker refuses before receipt/index publication",
  supported,
  async () => {
    const f = fixture();
    try {
      const before = readFileSync(f.store.file);
      writeFileSync(f.mode, "swap-frame-parent");
      await assert.rejects(() => ingestLocalCategory(request(f)), /symlink|alias/);
      assert.deepEqual(readFileSync(f.store.file), before);
      const output = path.join(f.project, "pipeline/local-category");
      assert.ok(!existsSync(output) || !readdirSync(output).filter((name) => name.endsWith(".json")).length);
    } finally {
      f.cleanup();
    }
  },
);
