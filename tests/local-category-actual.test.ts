import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createConnection } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import {
  LocalCategoryConfigSchema,
  executeCategoryWorker,
  ingestLocalCategory,
} from "../src/lib/ingest/local-category";
import {
  validateCategoryRuntime,
  validateCategoryReceipt,
  searchCategoryFrames,
  CATEGORY_RECEIPT_LIMIT,
} from "../src/lib/ingest/category-evidence";
import { boundedEvidenceJson, boundedEvidenceHash } from "../src/lib/ingest/bounded-evidence";
import { CategoryScoreSchema } from "../src/types/category-search";
import { ingestMedia, readSourceIndex } from "../src/lib/ingest";
import { importAsset, hashFile } from "../src/lib/assets/registry";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { planBroll, applyBroll } from "../src/lib/ingest/broll";
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  pin = z
    .object({
      file: z.string(),
      hash,
      bytes: z
        .number()
        .int()
        .positive()
        .max(16 * 1024 * 1024),
      kind: z.string(),
      label: z.string(),
      rights: z.string(),
    })
    .strict();
const Inputs = z
  .object({
    version: z.literal(1),
    existing: z.array(pin).length(3),
    synthetic: z.array(pin).length(2),
    orientations: z
      .array(z.object({ orientation: z.number().int().min(1).max(8), raw: pin, physical: pin }).strict())
      .length(8),
    diagnosticCategoryIds: z.array(z.string()).min(1).max(8),
    expectedLabels: z.string(),
    humanGroundTruth: z.literal(false),
    approved: z.literal(false),
  })
  .strict();
const enabled = process.env.RUN_LOCAL_CATEGORY_TESTS === "1";
test(
  "actual pinned native taxonomy categories: all rows/misses, sourcePTS receipts/Broll and all8 EXIF diagnostic",
  { skip: !enabled, timeout: 180000 },
  async () => {
    const required = (name: string) => {
      const value = process.env[name];
      assert.ok(value, `Explicit ${name} required; no automatic preparation`);
      return value;
    };
    const configFile = required("LOCAL_CATEGORY_CONFIG"),
      configSha = required("LOCAL_CATEGORY_CONFIG_SHA256"),
      preparationFile = required("LOCAL_CATEGORY_PREPARATION"),
      preparationSha = required("LOCAL_CATEGORY_PREPARATION_SHA256"),
      manifestFile = required("LOCAL_CATEGORY_INPUTS"),
      manifestSha = required("LOCAL_CATEGORY_INPUTS_SHA256"),
      artifacts = required("LOCAL_CATEGORY_ARTIFACTS");
    const configRaw = boundedEvidenceJson(configFile, 65536);
    assert.equal(configRaw.hash, configSha);
    const config = LocalCategoryConfigSchema.parse(configRaw.value);
    // Only externally supplied trusted config selects the executable. Receipt-selected executable fields are never used.
    const preparation = boundedEvidenceJson(preparationFile, 65536);
    assert.equal(preparation.hash, preparationSha);
    const prepared = preparation.value as {
      sourceSha256: string;
      binarySha256: string;
      rawProbeSha256: string;
      taxonomyHash: string;
      osVersion: string;
      osBuild: string;
    };
    assert.equal(config.workerSourceHash, prepared.sourceSha256);
    assert.equal(config.executableHash, prepared.binarySha256);
    assert.equal(boundedEvidenceHash(config.workerSource, 1024 * 1024), config.workerSourceHash);
    assert.equal(boundedEvidenceHash(config.executable, 256 * 1024 * 1024), config.executableHash);
    const probe = boundedEvidenceJson(
      path.join(path.dirname(preparationFile), "taxonomy-probe.stdout"),
      CATEGORY_RECEIPT_LIMIT,
    );
    assert.equal(probe.hash, prepared.rawProbeSha256);
    const runtime = validateCategoryRuntime(probe.value);
    assert.equal(runtime.taxonomy.hash, prepared.taxonomyHash);
    const inputRaw = boundedEvidenceJson(manifestFile, 65536);
    assert.equal(inputRaw.hash, manifestSha);
    const inputs = Inputs.parse(inputRaw.value);
    for (const id of inputs.diagnosticCategoryIds) assert.ok(runtime.taxonomy.identifiers.includes(id));
    assert.deepEqual(
      inputs.orientations.map((row) => row.orientation),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    const originals = [
      ...inputs.existing,
      ...inputs.synthetic,
      ...inputs.orientations.flatMap((row) => [row.raw, row.physical]),
    ];
    for (const p of originals) assert.equal(boundedEvidenceHash(p.file, 16 * 1024 * 1024), p.hash);
    const cwd = process.cwd();
    mkdirSync(artifacts, { recursive: true });
    const root = realpathSync(mkdtempSync(path.join(artifacts, "actual-")));
    const project = path.join(root, "public/projects/test");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "project.json"), "{}");
    const record: Record<string, unknown> = {
      version: 1,
      configFile,
      configSha256: configSha,
      preparationSha256: preparationSha,
      inputManifestSha256: manifestSha,
      runtime,
      originals,
      providerSpendUsd: 0,
      humanGroundTruth: false,
      approved: false,
      positiveBatches: [],
      negativeChecks: [],
      limits:
        "Scores are uncalibrated native classifier observations; all diagnostic category ranks and misses retained; full-image ROI does not imply persistence/full-image ground truth. No render/PCM/listening acceptance.",
    };
    const persist = () => writeFileSync(path.join(root, "acceptance.json"), JSON.stringify(record, null, 2) + "\n");
    try {
      record.observedOsNetworkDenial = await new Promise<boolean>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: 9 });
        socket.setTimeout(1000, () => {
          socket.destroy();
          reject(Error("OS denial not observed"));
        });
        socket.on("connect", () => {
          socket.destroy();
          reject(Error("Network unexpectedly allowed"));
        });
        socket.on("error", (error: NodeJS.ErrnoException) => {
          socket.destroy();
          if (["EPERM", "EACCES"].includes(error.code!)) resolve(true);
          else reject(Error(`Expected OS denied-network error, got ${error.code}`));
        });
      });
      persist();
      const deadline = Date.now() + 120000;
      const remaining = () => {
        const ms = deadline - Date.now();
        assert.ok(ms > 100, "Native acceptance cycle exhausted120s deadline");
        return ms;
      };
      const direct = async (name: string, files: typeof originals, payload?: unknown) => {
        const raw = await executeCategoryWorker(
          config,
          payload ?? {
            version: 1,
            operation: "classify",
            key: "a".repeat(64),
            revision: 2,
            frames: files.map((p) => ({ file: p.file, hash: p.hash })),
          },
          Math.min(120000, remaining()),
        );
        writeFileSync(path.join(root, name + ".json"), JSON.stringify(raw) + "\n");
        return raw;
      };
      const parse = (raw: unknown, count: number) => {
        const response = z
          .object({
            version: z.literal(1),
            key: hash,
            runtime: z.unknown(),
            frames: z
              .array(
                z
                  .object({
                    hash,
                    width: z.number().int().positive().max(4096),
                    height: z.number().int().positive().max(4096),
                    observations: z.array(CategoryScoreSchema).min(1).max(2048),
                  })
                  .strict(),
              )
              .length(count),
          })
          .strict()
          .parse(raw);
        assert.deepEqual(validateCategoryRuntime(response.runtime), runtime);
        for (const f of response.frames) {
          assert.ok(f.width * f.height <= 4000000);
          assert.ok(
            f.observations.every(
              (row, i) =>
                runtime.taxonomy.identifiers.includes(row.identifier) &&
                (!i || Buffer.compare(Buffer.from(f.observations[i - 1]!.identifier), Buffer.from(row.identifier)) < 0),
            ),
          );
        }
        return response;
      };
      const existing = parse(await direct("existing-project-native-all-rows", inputs.existing), 3);
      assert.deepEqual(
        existing.frames.map((f) => f.hash),
        inputs.existing.map((f) => f.hash),
      );
      record.existingDiagnostics = existing.frames.map((f, i) => ({
        input: inputs.existing[i],
        returnedCount: f.observations.length,
        allRows: f.observations,
        queries: inputs.diagnosticCategoryIds.map((identifier) => {
          const ranked = [...f.observations].sort(
              (a, b) => b.score - a.score || Buffer.compare(Buffer.from(a.identifier), Buffer.from(b.identifier)),
            ),
            rank = ranked.findIndex((row) => row.identifier === identifier);
          return {
            identifier,
            rank: rank < 0 ? null : rank + 1,
            score: rank < 0 ? null : ranked[rank]!.score,
            state: rank < 0 ? "not-returned" : "observed",
            expectedHumanTruth: false,
          };
        }),
      }));
      persist();
      const orientationFiles = inputs.orientations.flatMap((row) => [row.raw, row.physical]),
        oriented = parse(await direct("all8-orientations-native-all-rows", orientationFiles), 16);
      assert.deepEqual(
        oriented.frames.map((f) => f.hash),
        orientationFiles.map((f) => f.hash),
      );
      record.orientationRows = oriented;
      persist();
      const orientationMetrics = inputs.orientations.map((row, i) => {
        const a = oriented.frames[2 * i]!,
          b = oriented.frames[2 * i + 1]!,
          physical = new Map(b.observations.map((v) => [v.identifier, v.score])),
          rawIds = new Set(a.observations.map((v) => v.identifier)),
          shared = a.observations.filter((v) => physical.has(v.identifier)),
          maxScoreDelta = shared.length
            ? Math.max(...shared.map((v) => Math.abs(v.score - physical.get(v.identifier)!)))
            : null;
        return {
          orientation: row.orientation,
          rawHash: row.raw.hash,
          physicalHash: row.physical.hash,
          rawReturnedCount: a.observations.length,
          physicalReturnedCount: b.observations.length,
          sharedCount: shared.length,
          maxScoreDelta,
          rawOnlyIds: a.observations.filter((v) => !physical.has(v.identifier)).map((v) => v.identifier),
          physicalOnlyIds: b.observations.filter((v) => !rawIds.has(v.identifier)).map((v) => v.identifier),
          interpretation:
            "Diagnostic only: ImageIO thumbnail PNG/JPEG paths are not pixel-identical; classifier need not distinguish rotations. No vector equality, accuracy or calibration threshold inferred.",
        };
      });
      record.orientationMetrics = orientationMetrics;
      persist();
      const bad = Buffer.from(readFileSync(inputs.orientations[0]!.raw.file)),
        exif = bad.indexOf(Buffer.from("Exif\0\0"));
      assert.ok(exif >= 0);
      const tiff = exif + 6,
        little = bad.toString("ascii", tiff, tiff + 2) === "II",
        u16 = (p: number) => (little ? bad.readUInt16LE(p) : bad.readUInt16BE(p)),
        u32 = (p: number) => (little ? bad.readUInt32LE(p) : bad.readUInt32BE(p)),
        ifd = tiff + u32(tiff + 4);
      let changed = false;
      for (let i = 0; i < u16(ifd); i++) {
        const e = ifd + 2 + i * 12;
        if (u16(e) === 0x112) {
          assert.equal(u16(e + 2), 3);
          assert.equal(u32(e + 4), 1);
          if (little) bad.writeUInt16LE(9, e + 8);
          else bad.writeUInt16BE(9, e + 8);
          changed = true;
        }
      }
      assert.ok(changed);
      const unknown = path.join(root, "unknown9.jpg");
      writeFileSync(unknown, bad);
      const p = inputs.existing[0]!,
        fifo = path.join(root, "fifo");
      execFileSync("mkfifo", [fifo], { timeout: 2000 });
      const alias = path.join(root, "alias.jpg");
      symlinkSync(p.file, alias);
      const parentAlias = path.join(root, "parent-alias");
      symlinkSync(path.dirname(p.file), parentAlias);
      const negatives: Array<[string, unknown, RegExp]> = [
        [
          "invalid9",
          {
            version: 1,
            operation: "classify",
            key: "a".repeat(64),
            revision: 2,
            frames: [{ file: unknown, hash: hashFile(unknown) }],
          },
          /EXIF orientation/,
        ],
        [
          "fifo",
          {
            version: 1,
            operation: "classify",
            key: "a".repeat(64),
            revision: 2,
            frames: [{ file: fifo, hash: p.hash }],
          },
          /regular/,
        ],
        [
          "symlink",
          {
            version: 1,
            operation: "classify",
            key: "a".repeat(64),
            revision: 2,
            frames: [{ file: alias, hash: p.hash }],
          },
          /alias/,
        ],
        [
          "parent-alias",
          {
            version: 1,
            operation: "classify",
            key: "a".repeat(64),
            revision: 2,
            frames: [{ file: path.join(parentAlias, path.basename(p.file)), hash: p.hash }],
          },
          /alias/,
        ],
        [
          "protocol",
          { version: 1, operation: "classify", key: "a".repeat(64), revision: 2, frames: [], unexpected: true },
          /fields/,
        ],
        [
          "checksum",
          {
            version: 1,
            operation: "classify",
            key: "a".repeat(64),
            revision: 2,
            frames: [{ file: p.file, hash: "0".repeat(64) }],
          },
          /checksum/,
        ],
      ];
      for (const [name, payload, pattern] of negatives) {
        let refusal: unknown;
        try {
          await direct("negative-" + name, [], payload);
        } catch (error) {
          refusal = error;
        }
        assert.ok(refusal instanceof Error, `Native ${name} must refuse`);
        writeFileSync(
          path.join(root, "negative-" + name + ".error.json"),
          JSON.stringify(
            {
              name,
              payload,
              message: refusal.message,
              stack: refusal.stack,
              interpretation: "Bounded executor refusal message; not a claim that full native stderr is retained.",
            },
            null,
            2,
          ) + "\n",
        );
        assert.match(refusal.message, pattern);
        (record.negativeChecks as unknown[]).push({ name, message: refusal.message });
        persist();
      }
      const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", ...args], { timeout: 15000 });
      const source = path.join(root, "source.mp4");
      ff([
        "-loop",
        "1",
        "-i",
        inputs.synthetic[0]!.file,
        "-loop",
        "1",
        "-i",
        inputs.synthetic[1]!.file,
        "-filter_complex",
        "[0:v]trim=duration=1.5,setpts=PTS-STARTPTS[a];[1:v]trim=duration=1.5,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-t",
        "3",
        source,
      ]);
      process.chdir(root);
      const video = importAsset({
        projectId: "test",
        sourceFile: source,
        provenance: { origin: "manual" },
        rights: {
          licence: "Synthetic fixture only, no production rights",
          checkedAsOf: "2026-10-12T00:00:00Z",
          attributionRequired: false,
          commercialAllowed: false,
        },
      }).asset;
      const transcript = path.join(root, "transcript.json");
      writeFileSync(
        transcript,
        JSON.stringify({ segments: [{ text: "Do not remove this protected explanation.", start: 0, end: 1.5 }] }),
      );
      const base = ingestMedia({
          projectId: "test",
          sourceFile: source,
          transcriptFile: transcript,
          options: {
            thumbnailEverySec: 1,
            protectedSpans: [{ startSec: 0, endSec: 1.5, reason: "Fixed negative statement" }],
          },
        }),
        baseBytes = readFileSync(base.file),
        available = remaining();
      assert.ok(available > 11000);
      const query = {
          version: 1,
          method: "native-image-category",
          taxonomyHash: runtime.taxonomy.hash,
          identifier: "screenshot",
        },
        request = {
          projectId: "test",
          indexFile: base.file,
          query,
          config: { ...config, timeoutMs: Math.min(30000, available - 10000) },
        };
      const result = await ingestLocalCategory(request);
      record.production = {
        indexFile: result.file,
        receiptFile: result.receiptFile,
        receiptSha256: hashFile(result.receiptFile),
        allRows: validateCategoryReceipt(boundedEvidenceJson(result.receiptFile, CATEGORY_RECEIPT_LIMIT).value).frames,
        allHits: result.hits,
      };
      persist();
      assert.deepEqual(readSourceIndex("test", result.file, { boundedEvidence: true }), result.index);
      assert.deepEqual(readFileSync(base.file), baseBytes);
      for (let i = 0; i < 3; i++)
        assert.equal(
          result.index.segments.find((s) => s.id === `category-frame-${i}`)!.endSec,
          base.index!.source.timestamps[30 * i + 1],
        );
      assert.ok(remaining() > 10000);
      const cached = await ingestLocalCategory({
        ...request,
        config: { ...config, timeoutMs: Math.min(30000, remaining() - 10000) },
      });
      assert.equal(cached.workerCacheHit, true);
      assert.equal(cached.cacheHit, true);
      const receipt = validateCategoryReceipt(boundedEvidenceJson(result.receiptFile, CATEGORY_RECEIPT_LIMIT).value),
        selected = receipt.frames[0]!.observations[0]!.identifier,
        actualQuery = { ...query, identifier: selected },
        queryFile = path.join(project, "query.json");
      writeFileSync(queryFile, JSON.stringify(actualQuery));
      const hits = searchCategoryFrames(result.index, (ref) => path.join(root, "public", ref), actualQuery),
        store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
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
                id: "original",
                assetId: video.id,
                start: { num: 0, den: 1 },
                source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
                captions: [],
              },
            ],
          },
        ],
      });
      const before = store.read();
      // First returned technical ID exercises application; it is not chosen for creative quality or high confidence.
      const plan = planBroll(
          {
            version: 1,
            projectId: "test",
            indexFile: path.relative(project, result.file),
            retrieval: { method: "native-image-category", queryFile: "query.json" },
            segmentId: hits.find((h) => h.segmentId === "category-frame-0")!.segmentId,
            trackId: "category-cutaway",
            clipId: "category-cutaway",
            outputStart: { num: 0, den: 1 },
            expectedRevision: 0,
          },
          { rootDir: root },
        ),
        review = {
          planHash: plan.planHash,
          assetHash: plan.assetHash,
          reviewedBy: "synthetic-test",
          evidence: "Fixture-only declaration, not human creative approval",
        };
      applyBroll(plan, review, { rootDir: root, dryRun: true });
      assert.deepEqual(store.read(), before);
      const after = applyBroll(plan, review, { rootDir: root });
      assert.deepEqual(after.timeline.tracks.slice(0, -1), before.timeline.tracks);
      assert.equal(plan.sourceAudio, "muted-visual-track");
      assert.deepEqual(store.undo(after.revision).timeline, before.timeline);
      const receiptBytes = readFileSync(result.receiptFile);
      writeFileSync(result.receiptFile, "{}");
      assert.throws(() => readSourceIndex("test", result.file), /checksum/);
      assert.throws(
        () => applyBroll({ ...plan, request: { ...plan.request, expectedRevision: 2 } }, review, { rootDir: root }),
        /checksum/,
      );
      writeFileSync(result.receiptFile, receiptBytes);
      const q = JSON.parse(readFileSync(queryFile, "utf8"));
      writeFileSync(queryFile, JSON.stringify({ ...q, identifier: "definitely-not-supported" }));
      assert.throws(() => planBroll({ ...plan.request, expectedRevision: 2 }, { rootDir: root }), /supported/);
      writeFileSync(queryFile, JSON.stringify(q));
      const indexBytes = readFileSync(result.file),
        forged = JSON.parse(indexBytes.toString());
      forged.segments.find((s: { id: string }) => s.id === "category-frame-0").evidence[0].detail =
        "forged calibrated confidence";
      writeFileSync(result.file, JSON.stringify(forged));
      assert.throws(() => readSourceIndex("test", result.file), /immutable/);
      writeFileSync(result.file, indexBytes);
      for (const p of originals) assert.equal(boundedEvidenceHash(p.file, 16 * 1024 * 1024), p.hash);
      assert.equal(boundedEvidenceHash(config.workerSource, 1024 * 1024), config.workerSourceHash);
      assert.equal(boundedEvidenceHash(config.executable, 256 * 1024 * 1024), config.executableHash);
      record.positiveBatches = [
        { name: "existing-project-images", frames: 3 },
        { name: "all8-raw-physical-orientation", frames: 16 },
        { name: "production-sampled-video", frames: 3 },
      ];
      record.originalsUnchanged = true;
      record.cacheReplay = true;
      record.originalTracksPreserved = true;
      record.undoExact = true;
      record.applicationIdentifier = selected;
      record.plan = plan;
      record.nativeCycleBudgetMs = 120000;
      record.remainingNativeBudgetMs = remaining();
      record.status = "passed";
      persist();
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.stack : String(error);
      persist();
      throw error;
    } finally {
      process.chdir(cwd);
    }
  },
);
