import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ingestLocalMedia, embedSourceIndexes, embedLocalQuery } from "../src/lib/ingest/local-analysis";
import {
  LocalWorkerConfigSchema,
  probeLocalWorker,
  runLocalWorker,
  localModelHash,
} from "../src/lib/ingest/local-worker";
import { readSourceIndex } from "../src/lib/ingest";
import { searchEmbeddings } from "../src/lib/ingest/embeddings";
import { proposeSelect, type SourceSelect } from "../src/lib/ingest/selects";
import { evaluateLocalAsr, evaluateLocalRetrieval } from "../src/lib/ingest/local-evaluation";
import { inspectAsset } from "../src/lib/assets/inspect";
import { hashFile } from "../src/lib/assets/registry";
const samples = [
  {
    id: "english",
    language: "en",
    reference:
      "This product helps you organize your videos. The demonstration shows a simple editing workflow. Results depend on the material you provide.",
  },
  {
    id: "russian",
    language: "ru",
    reference:
      "Этот инструмент помогает создавать видео. Сначала мы выбираем нужные материалы. Результат зависит от качества исходной записи.",
  },
  {
    id: "education",
    language: "en",
    reference:
      "The water cycle includes evaporation, condensation, and precipitation. Water vapor cools and forms clouds before rain falls.",
  },
  {
    id: "captions",
    language: "ru",
    reference:
      "Пользователь выбирает шаблон субтитров и настраивает размер шрифта. Текст должен оставаться читаемым на экране телефона.",
  },
];
const labels = [
  {
    text: "Why does rain fall from clouds?",
    expected: "education",
  },
  {
    text: "Как показать работу видеоредактора?",
    expected: "english",
  },
  {
    text: "How can I change subtitle typography?",
    expected: "captions",
  },
  {
    text: "Почему качество записи влияет на результат?",
    expected: "russian",
  },
];
/** Opt-in actual models. Preparation is separate; this test never downloads anything. */
test(
  "actual installed multilingual ASR and CPU embeddings keep provenance, cache and protected review evidence",
  {
    skip: process.env.RUN_LOCAL_INFERENCE_TESTS !== "1",
    timeout: 600000,
  },
  async () => {
    const configRoot = process.env.LOCAL_INFERENCE_CONFIG_DIR,
      fixtureRoot = process.env.LOCAL_INFERENCE_FIXTURE_ROOT,
      artifactsRoot = process.env.LOCAL_INFERENCE_ARTIFACTS_DIR;
    assert.ok(
      configRoot && fixtureRoot && artifactsRoot,
      "Explicit trusted configurations/fixtures/artifacts are required",
    );
    assert.ok(
      [configRoot, fixtureRoot, artifactsRoot].every((file) => path.isAbsolute(file)),
      "Use absolute installed paths",
    );
    const config = (name: string) =>
      LocalWorkerConfigSchema.parse({
        ...JSON.parse(readFileSync(path.join(configRoot, `${name}.json`), "utf8")),
        workerFile: path.resolve(import.meta.dirname, "../scripts/workers/local-analysis.py"),
      });
    const asrConfig = config("asr"),
      embeddingConfig = config("embedding");
    assert.equal(asrConfig.engine, "whisper.cpp");
    assert.equal(embeddingConfig.engine, "sentence-transformers");
    // A marker alone is insufficient: verify the inherited OS network denial.
    assert.equal(process.env.LOCAL_INFERENCE_NETWORK_SANDBOX, "1", "Run inside an OS deny-network sandbox");
    const networkProbe = spawnSync(
      embeddingConfig.executable,
      ["-c", 'import socket; socket.socket().bind(("127.0.0.1",0))'],
      {
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.notEqual(networkProbe.status, 0);
    assert.match(networkProbe.stderr, /Operation not permitted|Permission denied/);
    const asrCapability = probeLocalWorker(asrConfig),
      embeddingCapability = probeLocalWorker(embeddingConfig);
    assert.equal(asrCapability.available, true);
    assert.equal(embeddingCapability.available, true);
    mkdirSync(artifactsRoot, {
      recursive: true,
    });
    const runRoot = mkdtempSync(path.join(artifactsRoot, "actual-run-")),
      cwd = process.cwd();
    mkdirSync(path.join(runRoot, "public/projects/offline"), {
      recursive: true,
    });
    writeFileSync(path.join(runRoot, "public/projects/offline/project.json"), "{}");
    const report: {
      [key: string]: unknown;
    } = {
      schemaVersion: 1,
      networkProbe: {
        denied: true,
        error: networkProbe.stderr.trim(),
      },
      asrCapability,
      embeddingCapability,
      fixtures: "macOS synthetic speech; not human recording/creative approval",
      samples: [],
      retrieval: [],
    };
    try {
      const legacyRoot = process.env.LOCAL_INFERENCE_LEGACY_RUN_ROOT;
      if (legacyRoot) {
        assert.ok(path.isAbsolute(legacyRoot));
        const legacy = JSON.parse(readFileSync(path.join(legacyRoot, "report.json"), "utf8")) as {
          samples: { indexFile: string }[];
        };
        process.chdir(legacyRoot);
        for (const sample of legacy.samples) {
          const before = hashFile(sample.indexFile);
          const stored = JSON.parse(readFileSync(sample.indexFile, "utf8"));
          assert.equal(stored.localAnalysis.segmentation, undefined);
          const replay = readSourceIndex("offline", sample.indexFile);
          assert.deepEqual(replay.segments, stored.segments);
          assert.equal(replay.cacheKey, stored.cacheKey);
          assert.equal(hashFile(sample.indexFile), before);
        }
        report.legacyIndexReplay = { indexes: legacy.samples.length, unchanged: true, runRoot: legacyRoot };
      }
      process.chdir(runRoot);
      const indexes: ReturnType<typeof readSourceIndex>[] = [],
        bySample = new Map<string, ReturnType<typeof readSourceIndex>>();
      for (const sample of samples) {
        const sourceFile = path.join(fixtureRoot, `${sample.id}.wav`);
        assert.equal(existsSync(sourceFile), true);
        const before = hashFile(sourceFile),
          duration = inspectAsset(sourceFile).media.durationSec!;
        const request = {
          projectId: "offline",
          sourceFile,
          config: {
            ...asrConfig,
            language: sample.language,
          },
          options: {
            protectedSpans: [
              {
                startSec: 0,
                endSec: duration,
                reason: "Entire supplied synthetic statement retained pending human review",
              },
            ],
          },
        };
        const started = performance.now(),
          fresh = await ingestLocalMedia(request),
          elapsedMs = performance.now() - started,
          index = readSourceIndex("offline", fresh.file);
        assert.equal(fresh.workerCacheHit, false);
        assert.equal(index.localAnalysis!.reviewRequired, true);
        assert.ok(index.segments.every((row) => row.evidence.some((e) => e.kind === "local-asr")));
        const cached = await ingestLocalMedia(request);
        assert.equal(cached.workerCacheHit, true);
        assert.equal(cached.cacheHit, true);
        assert.equal(cached.cacheKey, fresh.cacheKey);
        assert.equal(hashFile(sourceFile), before);
        const hypothesis = index.segments.map((row) => ({
          text: row.text,
          startSec: row.startSec,
          endSec: row.endSec,
        }));
        const metrics = evaluateLocalAsr(
          [
            {
              text: sample.reference,
              startSec: 0,
              endSec: duration,
            },
          ],
          hypothesis,
        );
        assert.ok(Number.isFinite(metrics.wordErrorRate)); // No fabricated accuracy threshold.
        const proposal = proposeSelect(
          index,
          {
            cacheKey: index.cacheKey,
            assetId: index.assetId,
            sourceHash: index.sourceHash,
            segmentId: index.segments[0]!.id,
          } as SourceSelect,
          0,
        );
        assert.equal(proposal.startSec, 0);
        assert.equal(proposal.endSec, duration);
        assert.equal(proposal.reviewRequired, true);
        indexes.push(index);
        bySample.set(sample.id, index);
        (report.samples as unknown[]).push({
          id: sample.id,
          reference: sample.reference,
          sourceFile,
          sourceHash: before,
          durationSec: duration,
          indexFile: fresh.file,
          workerEvidence: fresh.workerEvidence,
          elapsedMs,
          hypothesis,
          metrics,
          protectedProposal: proposal,
          cacheVerified: true,
        });
      }
      const started = performance.now(),
        corpus = await embedSourceIndexes("offline", indexes, embeddingConfig),
        corpusMs = performance.now() - started;
      assert.equal(corpus.cacheHit, false);
      assert.equal(corpus.pack.space.dimensions, embeddingConfig.dimensions);
      assert.equal((await embedSourceIndexes("offline", indexes, embeddingConfig)).cacheHit, true);
      const qualityRows = [];
      for (const label of labels) {
        const queryStarted = performance.now(),
          query = await embedLocalQuery("offline", label.text, embeddingConfig, corpus.pack.space),
          elapsedMs = performance.now() - queryStarted;
        assert.equal(query.cacheHit, false);
        const replay = await embedLocalQuery("offline", label.text, embeddingConfig, corpus.pack.space);
        assert.equal(replay.cacheHit, true);
        assert.deepEqual(replay.query, query.query);
        const hits = searchEmbeddings(indexes, corpus.pack, query.query, 10),
          expected = bySample.get(label.expected)!;
        const row = {
          expectedSegmentIds: expected.segments.map((segment) => `${expected.cacheKey}:${segment.id}`),
          rankedSegmentIds: hits.map((hit) => `${hit.cacheKey}:${hit.segmentId}`),
        };
        qualityRows.push(row);
        const proposal = proposeSelect(
          indexes.find((index) => index.cacheKey === hits[0]!.cacheKey)!,
          hits[0]! as unknown as SourceSelect,
          0,
        );
        assert.equal(proposal.reviewRequired, true);
        assert.equal(hits[0]!.automaticSelection, false);
        (report.retrieval as unknown[]).push({
          ...label,
          ...row,
          hits,
          elapsedMs,
          workerEvidence: query.workerEvidence,
          protectedProposal: proposal,
          cacheVerified: true,
        });
      }
      await assert.rejects(
        () =>
          runLocalWorker(
            embeddingConfig,
            {
              operation: "embed",
              texts: ["This is a long unreduced statement. ".repeat(100)],
              sourcePins: [],
            },
            "offline",
          ),
        /sequence window/,
      );
      report.oversizedSemanticWindowRejected = true;
      const originalModelHash = localModelHash(embeddingConfig.modelPath);
      const promptedModelPath = path.join(runRoot, "prompted-model-negative");
      cpSync(embeddingConfig.modelPath, promptedModelPath, { recursive: true });
      const promptConfigFile = path.join(promptedModelPath, "config_sentence_transformers.json");
      const promptConfig = JSON.parse(readFileSync(promptConfigFile, "utf8"));
      writeFileSync(
        promptConfigFile,
        JSON.stringify({
          ...promptConfig,
          prompts: { retrieval: "query: ".repeat(40) },
          default_prompt_name: "retrieval",
        }),
      );
      await assert.rejects(
        () =>
          runLocalWorker(
            { ...embeddingConfig, modelPath: promptedModelPath },
            {
              operation: "embed",
              texts: ["Short input with a configured model prompt."],
              sourcePins: [],
            },
            "offline",
          ),
        /configured default prompt/,
      );
      assert.equal(localModelHash(embeddingConfig.modelPath), originalModelHash);
      report.promptedModelRejected = { copy: promptedModelPath, originalModelHash, originalUnchanged: true };
      report.corpus = {
        file: corpus.file,
        workerEvidence: corpus.workerEvidence,
        items: corpus.pack.items.length,
        space: corpus.pack.space,
        elapsedMs: corpusMs,
        cacheVerified: true,
      };
      report.retrievalMetrics = evaluateLocalRetrieval(qualityRows);
      await assert.rejects(
        () =>
          embedLocalQuery(
            "offline",
            labels[0]!.text,
            {
              ...embeddingConfig,
              revision: `${embeddingConfig.revision}-different`,
            },
            corpus.pack.space,
          ),
        /differs/,
      );
      const corrupted = readFileSync(corpus.workerEvidence, "utf8"),
        cache = JSON.parse(corrupted);
      cache.output.vectors[0][0] += 0.125;
      writeFileSync(corpus.workerEvidence, JSON.stringify(cache));
      try {
        await assert.rejects(() => embedSourceIndexes("offline", indexes, embeddingConfig), /checksum/);
      } finally {
        writeFileSync(corpus.workerEvidence, corrupted);
      }
      report.staleModelAndCorruptCacheRejected = true;
      report.acceptance = "actual local inference and evidence integrity; no human/production approval";
    } finally {
      process.chdir(cwd);
      writeFileSync(path.join(runRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
      writeFileSync(
        path.join(artifactsRoot, "latest-run.json"),
        JSON.stringify({
          runRoot,
          report: path.join(runRoot, "report.json"),
        }) + "\n",
      );
    }
  },
);
