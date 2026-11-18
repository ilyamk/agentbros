import test from "node:test";
import { createHash } from "node:crypto";
import { readRejectedObservation } from "../src/lib/ingest/rejected-observation";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { EXISTING_CORPUS, CORPUS_REFERENCES } from "../src/lib/ingest/corpus-fixtures";
import {
  prepareExistingCorpus,
  readPreparedCorpus,
  runCorpusDiagnostics,
  captureCorpusFile,
  observedNetworkDenial,
} from "../src/lib/ingest/corpus-diagnostics";
import { LocalWorkerConfigSchema } from "../src/lib/ingest/local-worker";
const observeRejected = process.env.RUN_REJECTED_ASR_OBSERVATION_TESTS === "1";
const enabled = process.env.RUN_CORPUS_DIAGNOSTICS_TESTS === "1" || observeRejected;
test(
  "actual fixed existing EN/RU corpus: intended scripts, all hypotheses, cache and fail-closed lineage",
  { skip: !enabled, timeout: 240000 },
  async () => {
    const primary = process.env.CORPUS_SOURCE_ROOT,
      output = process.env.CORPUS_ARTIFACT_ROOT;
    assert.ok(primary && output, "Explicit existing originals/artifact roots required");
    assert.equal(observedNetworkDenial(), true, "Actual requires inherited OS deny-network");
    const root = realpathSync(mkdtempSync(path.join(output, "actual-"))),
      mirror = path.join(root, "original-source-mirror"),
      workerFile = path.resolve("scripts/workers/local-analysis.py");
    for (const file of new Set([
      ...EXISTING_CORPUS.map((s) => s.file),
      ...Object.values(CORPUS_REFERENCES).map((r) => r.file),
    ])) {
      const target = path.join(mirror, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, captureCorpusFile(path.join(primary, file), 10 * 1024 * 1024).bytes, { flag: "wx" });
    }
    const prepared = prepareExistingCorpus(mirror, path.join(root, "prepared")),
      manifestPin = captureCorpusFile(prepared.file).sha256;
    assert.equal(prepared.cacheHit, false);
    assert.equal(prepareExistingCorpus(mirror, path.join(root, "prepared")).cacheHit, true);
    assert.equal(readPreparedCorpus(prepared.file, manifestPin).entries.length, 6);
    const manifestBytes = readFileSync(prepared.file),
      marker = path.join(path.dirname(prepared.file), "manifest.sha256"),
      markerBytes = readFileSync(marker);
    const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex"),
      toolMarker = path.join(root, "receipt-tool-ran"),
      fakeTool = path.join(root, "receipt-tool");
    writeFileSync(fakeTool, `#!/bin/sh\ntouch '${toolMarker}'\nprintf 'fake\\n'\n`, { mode: 0o700 });
    const forged = JSON.parse(manifestBytes.toString());
    forged.tools.ffprobe = { path: fakeTool, sha256: hash(readFileSync(fakeTool)), versionSha256: hash("fake\n") };
    forged.key = hash(
      JSON.stringify({
        version: 1,
        sourceRoot: forged.sourceRoot,
        originals: EXISTING_CORPUS,
        references: CORPUS_REFERENCES,
        tools: forged.tools,
        helperSha256: forged.helperSha256,
        fixturesSha256: forged.fixturesSha256,
      }),
    );
    writeFileSync(prepared.file, JSON.stringify(forged));
    writeFileSync(marker, hash(readFileSync(prepared.file)) + "\n");
    assert.throws(() => prepareExistingCorpus(mirror, path.join(root, "prepared")), /trusted tool pin/);
    assert.equal(existsSync(toolMarker), false);
    writeFileSync(prepared.file, manifestBytes);
    writeFileSync(marker, markerBytes);
    const mutated = JSON.parse(manifestBytes.toString());
    mutated.entries[0].input.originalClockOffsetSec = 0;
    writeFileSync(prepared.file, JSON.stringify(mutated));
    assert.throws(() => readPreparedCorpus(prepared.file, manifestPin), /checksum/);
    writeFileSync(marker, captureCorpusFile(prepared.file).sha256 + "\n");
    assert.throws(() => readPreparedCorpus(prepared.file, manifestPin), /checksum/);
    assert.throws(() => readPreparedCorpus(prepared.file), /lineage/);
    writeFileSync(prepared.file, manifestBytes);
    writeFileSync(marker, markerBytes);
    const input = path.join(path.dirname(prepared.file), prepared.manifest.entries[0]!.input.path),
      inputBytes = readFileSync(input);
    const damaged = Buffer.from(inputBytes);
    damaged[damaged.length - 1] ^= 1;
    writeFileSync(input, damaged);
    assert.throws(() => readPreparedCorpus(prepared.file, manifestPin), /lineage/);
    writeFileSync(input, inputBytes);
    const original = path.join(mirror, EXISTING_CORPUS[0]!.file),
      originalBytes = readFileSync(original);
    writeFileSync(original, "changed");
    assert.throws(() => readPreparedCorpus(prepared.file, manifestPin), /source changed/);
    writeFileSync(original, originalBytes);
    const config = LocalWorkerConfigSchema.parse({
      ...JSON.parse(readFileSync(path.join(primary, "out/qa/offline-inference/runtime/configs/asr.json"), "utf8")),
      workerFile,
      wordTimingMethod: "native-word-segments-v1",
      timeoutMs: 30000,
    });
    const engineBefore = captureCorpusFile(config.engineExecutable!, 256 * 1024 * 1024).sha256,
      modelBefore = captureCorpusFile(config.modelPath, 256 * 1024 * 1024).sha256;
    mkdirSync(path.join(root, "public/projects/corpus"), { recursive: true });
    writeFileSync(path.join(root, "public/projects/corpus/project.json"), "{}");
    const prior = process.cwd();
    process.chdir(root);
    try {
      const request = {
          manifestFile: prepared.file,
          manifestSha256: manifestPin,
          config,
          projectId: "corpus",
          ...(observeRejected ? { retainRejectedObservation: true } : {}),
        },
        first = await runCorpusDiagnostics(request);
      assert.equal(first.report.entries.length, 6);
      assert.equal(first.report.observedOsNetworkDenial, true);
      assert.equal(first.report.humanGroundTruth, false);
      assert.equal(first.report.approved, false);
      for (const row of first.report.entries) {
        assert.ok(["hypothesis", "refused", "unavailable"].includes(row.state as string));
        if (row.state === "hypothesis") {
          assert.equal(row.approved, false);
          assert.equal(row.commercialAllowed, "unknown");
          assert.equal(row.cacheReplay, true);
        }
      }
      // At least one genuine hypothesis; strict refusals remain valid recorded diagnostic outcomes.
      const hypotheses = first.report.entries.filter((r) => r.state === "hypothesis");
      assert.ok(hypotheses.length > 0);
      for (const row of hypotheses)
        if (row.lexicalFallback) {
          assert.equal((row.nativeWordAttempt as { state: string }).state, "refused");
          assert.equal((row.words as { state: string }).state, "unavailable");
        }

      if (observeRejected) {
        assert.equal(
          first.report.entries.filter((r) => r.state === "hypothesis").length,
          4,
          "Frozen real corpus accepted4 remains unchanged",
        );
        const rejected = first.report.entries.filter((r) => r.state === "refused");
        assert.equal(rejected.length, 2);
        for (const row of rejected)
          for (const attempt of [row.nativeWordAttempt, row.paragraphAttempt]) {
            const descriptor = (
              attempt as {
                rejectedObservation: { state: string; file: string; sha256: string; lexicalHypothesis: string };
              }
            ).rejectedObservation;
            assert.equal(descriptor.state, "quarantined");
            assert.ok(descriptor.lexicalHypothesis.trim());
            const entry = prepared.manifest.entries.find((e) => e.id === row.id)!;
            const observation = readRejectedObservation("corpus", descriptor.file, descriptor.sha256, {
              manifestFile: prepared.file,
              manifestSha256: manifestPin,
              corpusKey: prepared.manifest.key,
              entryId: entry.id,
              originalSha256: entry.original.sha256,
              inputSha256: entry.input.sha256,
            });
            assert.equal(observation.accepted, false);
            assert.equal(observation.timingUse, "forbidden");
            assert.equal(observation.lexicalHypothesis, descriptor.lexicalHypothesis);
          }
      }
      const replay = await runCorpusDiagnostics(request);
      assert.equal(replay.report.entries.filter((r) => r.initialCacheHit === true).length, hypotheses.length);
      assert.deepEqual(
        first.report.entries.map((r) => r.fullHypothesis),
        replay.report.entries.map((r) => r.fullHypothesis),
      );
      const firstBytes = readFileSync(first.file),
        evidence = first.report.entries[0]!.workerEvidence as string,
        evidenceBytes = readFileSync(evidence);
      writeFileSync(evidence, "{}");
      const corrupt = await runCorpusDiagnostics(request);
      assert.equal(corrupt.report.entries[0]!.state, "refused");
      assert.deepEqual(readFileSync(first.file), firstBytes);
      writeFileSync(evidence, evidenceBytes);
      const registryFile = path.resolve("public/projects/corpus/pipeline/asset-registry.json"),
        registryBytes = readFileSync(registryFile),
        registry = JSON.parse(registryBytes.toString());
      registry.assets[0].rights.commercialAllowed = true;
      writeFileSync(registryFile, JSON.stringify(registry));
      await assert.rejects(runCorpusDiagnostics(request), /unknown rights/);
      writeFileSync(registryFile, registryBytes);
      assert.equal(captureCorpusFile(config.engineExecutable!, 256 * 1024 * 1024).sha256, engineBefore);
      assert.equal(captureCorpusFile(config.modelPath, 256 * 1024 * 1024).sha256, modelBefore);
      for (const sample of EXISTING_CORPUS)
        assert.equal(captureCorpusFile(path.join(primary, sample.file), 10 * 1024 * 1024).sha256, sample.hash);
      const acceptance = {
        version: 1,
        root,
        manifest: prepared.file,
        manifestSha256: manifestPin,
        sourceHelperSha256: prepared.manifest.helperSha256,
        first: { file: first.file, sha256: first.sha256 },
        replay: { file: replay.file, sha256: replay.sha256 },
        corruption: { file: corrupt.file, sha256: corrupt.sha256 },
        engineSha256: engineBefore,
        modelSha256: modelBefore,
        observedOsNetworkDenial: true,
        providerSpendUsd: 0,
        humanGroundTruth: false,
        allOriginalsUnchanged: true,
        metrics: first.report.entries.map((r) => ({
          id: r.id,
          state: r.state,
          metrics: r.metrics,
          words: r.words,
          nativeWordAttempt: r.nativeWordAttempt,
          lexicalFallback: r.lexicalFallback,
          workerIdentityHash: r.workerIdentityHash,
        })),
        limitations: first.report.limitations,
      };
      writeFileSync(path.join(root, "acceptance.json"), JSON.stringify(acceptance, null, 2) + "\n", { flag: "wx" });
      console.error("Retained corpus acceptance:", path.join(root, "acceptance.json"));
    } finally {
      process.chdir(prior);
    }
  },
);
