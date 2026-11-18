import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  localModelHash,
  probeLocalWorker,
  runLocalWorker,
  type LocalWorkerConfig,
} from "../src/lib/ingest/local-worker";
import { ingestLocalMedia, embedSourceIndexes, embedLocalQuery } from "../src/lib/ingest/local-analysis";
import { readSourceIndex } from "../src/lib/ingest";
import { searchEmbeddings } from "../src/lib/ingest/embeddings";
import { proposeSelect, type SourceSelect } from "../src/lib/ingest/selects";
const workerFile = path.resolve(import.meta.dirname, "fixtures/local-analysis-worker.mjs");
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "offline ingest ")),
    cwd = process.cwd();
  mkdirSync(path.join(root, "public/projects/test"), {
    recursive: true,
  });
  writeFileSync(path.join(root, "public/projects/test/project.json"), "{}");
  const modelPath = path.join(root, "fixture-model.txt");
  writeFileSync(modelPath, "ok");
  const config: LocalWorkerConfig = {
    executable: realpathSync(process.execPath),
    workerFile,
    modelPath,
    model: "injected-protocol-only",
    revision: "fixture-1",
    engine: "sentence-transformers",
    dimensions: 2,
    timeoutMs: 30000,
  };
  process.chdir(root);
  return {
    root,
    cwd,
    config,
    modelPath,
    cleanup: () => {
      process.chdir(cwd);
      rmSync(root, {
        recursive: true,
        force: true,
      });
    },
  };
}
test("offline worker pins model/config/query identity and caches bounded protocol results", async () => {
  const f = fixture();
  try {
    const payload = {
      operation: "embed" as const,
      texts: ["retain caveat"],
      sourcePins: ["a".repeat(64)],
    };
    const first = await runLocalWorker(f.config, payload, "test");
    assert.equal(first.cacheHit, false);
    const again = await runLocalWorker(f.config, payload, "test");
    assert.equal(again.cacheHit, true);
    assert.deepEqual(again.output, first.output);
    writeFileSync(f.modelPath, "offline-env");
    const changed = await runLocalWorker(f.config, payload, "test");
    assert.notEqual(first.key, changed.key);
    assert.equal(changed.cacheHit, false);
    assert.notEqual(
      (
        await runLocalWorker(
          {
            ...f.config,
            revision: "fixture-2",
          },
          payload,
          "test",
        )
      ).key,
      changed.key,
    );
    assert.notEqual(
      (
        await runLocalWorker(
          f.config,
          {
            ...payload,
            sourcePins: ["b".repeat(64)],
          },
          "test",
        )
      ).key,
      changed.key,
    );
    writeFileSync(
      changed.file,
      JSON.stringify({
        ...JSON.parse(readFileSync(changed.file, "utf8")),
        output: {
          vectors: [[0, 1]],
        },
      }),
    );
    await assert.rejects(() => runLocalWorker(f.config, payload, "test"), /checksum/);
  } finally {
    f.cleanup();
  }
});
test("missing installed engines/models report unavailable without downloading", async () => {
  const f = fixture();
  try {
    const config = {
      ...f.config,
      modelPath: path.join(f.root, "missing"),
    };
    assert.equal(probeLocalWorker(config).available, false);
    await assert.rejects(
      () =>
        runLocalWorker(
          config,
          {
            operation: "embed",
            texts: ["x"],
            sourcePins: [],
          },
          "test",
        ),
      /unavailable/,
    );
    assert.equal(existsSync(config.modelPath), false);
    const directory = path.join(f.root, "empty");
    mkdirSync(directory);
    assert.throws(() => localModelHash(directory), /empty/);
  } finally {
    f.cleanup();
  }
});
test("bad vector counts/norms, protocol replay and oversized output fail closed", async () => {
  const f = fixture();
  try {
    for (const mode of ["bad-vector", "missing-vector", "wrong-key", "extra-line", "overflow"]) {
      writeFileSync(f.modelPath, mode);
      await assert.rejects(() =>
        runLocalWorker(
          f.config,
          {
            operation: "embed",
            texts: ["x"],
            sourcePins: [],
          },
          "test",
        ),
      );
    }
  } finally {
    f.cleanup();
  }
});
test("timeout kills worker process group including its child", async () => {
  const f = fixture();
  try {
    writeFileSync(f.modelPath, "timeout");
    await assert.rejects(
      () =>
        runLocalWorker(
          {
            ...f.config,
            timeoutMs: 1000,
          },
          {
            operation: "embed",
            texts: ["x"],
            sourcePins: [],
          },
          "test",
        ),
      /timeout/,
    );
    assert.equal(existsSync(f.modelPath + ".pid"), true);
    const pid = Number(readFileSync(f.modelPath + ".pid", "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(pid, 0));
  } finally {
    f.cleanup();
  }
});
test("ASR evidence retains clock/protection and shares pinned model with semantic proposals", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const f = fixture();
  try {
    const sourceFile = path.join(f.root, "recording.wav");
    const generation = spawnSync(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", sourceFile],
      {
        encoding: "utf8",
      },
    );
    assert.equal(generation.status, 0, generation.stderr);
    const original = readFileSync(sourceFile);
    const config: LocalWorkerConfig = {
      ...f.config,
      engine: "whisper.cpp",
      engineExecutable: realpathSync(process.execPath),
      dimensions: undefined,
    };
    const result = await ingestLocalMedia({
      projectId: "test",
      sourceFile,
      config,
      options: {
        protectedSpans: [
          {
            startSec: 0.8,
            endSec: 1.5,
            reason: "caveat",
          },
        ],
      },
    });
    const index = readSourceIndex("test", result.file);
    assert.equal(index.localAnalysis!.reviewRequired, true);
    assert.equal(index.segments[0]!.evidence[0]!.kind, "local-asr");
    assert.equal(index.segments[0]!.startSec, 0.2);
    assert.equal(
      (
        await ingestLocalMedia({
          projectId: "test",
          sourceFile,
          config,
          options: {
            protectedSpans: [
              {
                startSec: 0.8,
                endSec: 1.5,
                reason: "caveat",
              },
            ],
          },
        })
      ).workerCacheHit,
      true,
    );
    const corpus = await embedSourceIndexes("test", [index], f.config),
      query = await embedLocalQuery("test", "conditions", f.config, corpus.pack.space);
    const hits = searchEmbeddings([index], corpus.pack, query.query);
    const proposal = proposeSelect(index, hits[0]! as unknown as SourceSelect, 0);
    assert.equal(proposal.endSec, 1.5);
    assert.equal(proposal.reviewRequired, true);
    assert.equal(hits[0]!.automaticSelection, false);
    await assert.rejects(
      () =>
        embedLocalQuery(
          "test",
          "conditions",
          {
            ...f.config,
            revision: "changed",
          },
          corpus.pack.space,
        ),
      /differs/,
    );
    assert.deepEqual(readFileSync(sourceFile), original);
    const corrupted = JSON.parse(readFileSync(result.file, "utf8"));
    corrupted.segments[0].text = "Guaranteed.";
    writeFileSync(result.file, JSON.stringify(corrupted));
    assert.throws(() => readSourceIndex("test", result.file), /immutable supplied evidence/);
  } finally {
    f.cleanup();
  }
});
test("ASR overlapping/out-of-source spans are rejected before index creation", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const f = fixture();
  try {
    const sourceFile = path.join(f.root, "recording.wav");
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=2", sourceFile]).status, 0);
    for (const mode of ["overlap", "out-of-bounds"]) {
      writeFileSync(f.modelPath, mode);
      await assert.rejects(
        () =>
          ingestLocalMedia({
            projectId: "test",
            sourceFile,
            config: {
              ...f.config,
              engine: "whisper.cpp",
              engineExecutable: realpathSync(process.execPath),
            },
          }),
        /overlap|exceed/,
      );
    }
  } finally {
    f.cleanup();
  }
});
test("actual decoded timestamp gaps cannot be collapsed into ASR seconds", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const f = fixture();
  try {
    const sourceFile = path.join(f.root, "gap.mkv");
    const result = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-af",
        "asetpts=PTS+gte(T\\,1)*0.2/TB",
        "-c:a",
        "pcm_s16le",
        sourceFile,
      ],
      {
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const { inspectLocalAudioClock } = await import("../src/lib/ingest/local-clock");
    assert.throws(() => inspectLocalAudioClock(sourceFile, 2.2), /discontinuous/);
    await assert.rejects(
      () =>
        ingestLocalMedia({
          projectId: "test",
          sourceFile,
          config: {
            ...f.config,
            engine: "whisper.cpp",
            engineExecutable: realpathSync(process.execPath),
          },
        }),
      /discontinuous/,
    );
    assert.equal(existsSync("public/projects/test/pipeline/source-index"), false);
  } finally {
    f.cleanup();
  }
});
test("installed runtime absence is explicit and evaluation reports supplied-reference error", async () => {
  const f = fixture();
  try {
    writeFileSync(f.modelPath, "runtime-missing");
    const probe = probeLocalWorker(f.config);
    assert.equal(probe.available, false);
    assert.match(probe.available ? "" : probe.reason, /runtime unavailable/);
    const { evaluateLocalAsr, evaluateLocalRetrieval } = await import("../src/lib/ingest/local-evaluation");
    const metrics = evaluateLocalAsr(
      [
        {
          text: "Only under conditions.",
          startSec: 0,
          endSec: 1,
        },
      ],
      [
        {
          text: "Always under conditions.",
          startSec: 0,
          endSec: 1,
        },
      ],
    );
    assert.equal(metrics.wordErrorRate, 1 / 3);
    assert.equal(metrics.maxMatchedBoundaryErrorSec, null);
    assert.equal(metrics.reviewRequired, true);
    assert.equal(
      evaluateLocalRetrieval([
        {
          expectedSegmentIds: ["caveat"],
          rankedSegmentIds: ["demo", "caveat"],
        },
      ]).meanReciprocalRank,
      0.5,
    );
  } finally {
    f.cleanup();
  }
});
test("trusted local CLI emits one JSON envelope and corpus/query reuse checked proposals", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const repo = path.resolve(import.meta.dirname, ".."),
    f = fixture();
  try {
    const source = path.join(f.root, "recording.wav");
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=2", source]).status, 0);
    const asrConfig = path.join(f.root, "asr.json"),
      embedConfig = path.join(f.root, "embed.json");
    writeFileSync(
      asrConfig,
      JSON.stringify({ ...f.config, engine: "whisper.cpp", engineExecutable: realpathSync(process.execPath) }),
    );
    writeFileSync(embedConfig, JSON.stringify(f.config));
    const cli = (args: string[]) => {
      const child = spawnSync(
        path.join(repo, "node_modules/.bin/tsx"),
        [path.join(repo, "scripts/media-local.ts"), ...args],
        {
          encoding: "utf8",
          timeout: 30000,
          env: { ...process.env, FAL_KEY: "sentinel-omit-in-worker", ELEVENLABS_API_KEY: "sentinel-omit-in-worker" },
        },
      );
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout.trim().split("\n").length, 1);
      const result = JSON.parse(child.stdout);
      assert.equal(result.ok, true);
      return result;
    };
    assert.equal(cli(["--action", "probe", "--config", asrConfig]).metadata.available, true);
    const asr = cli(["--action", "asr", "--config", asrConfig, "--project", "test", "--source", source]);
    assert.equal(asr.metadata.reviewRequired, true);
    const corpus = cli(["--action", "corpus", "--config", embedConfig, "--project", "test"]);
    assert.equal(existsSync(corpus.metadata.file), true);
    const result = cli([
      "--action",
      "query",
      "--config",
      embedConfig,
      "--project",
      "test",
      "--corpus",
      corpus.metadata.file,
      "--query",
      "conditions",
    ]);
    assert.equal(result.metadata.automaticSelection, false);
    assert.equal(result.metadata.hits[0].proposal.reviewRequired, true);
    writeFileSync(f.modelPath, "runtime-missing");
    assert.equal(cli(["--action", "probe", "--config", embedConfig]).metadata.available, false);
  } finally {
    f.cleanup();
  }
});
test("versioned ASR sentence grouping preserves dependent multiword chunks and legacy spans", async () => {
  const { importTranscript } = await import("../src/lib/ingest");
  const raw = {
    segments: [
      { text: "Результат зависит от качества", startSec: 0, endSec: 1 },
      { text: "исходной записи.", startSec: 1, endSec: 1.5 },
      { text: "Следующая мысль.", startSec: 2, endSec: 3 },
    ],
  };
  const legacy = importTranscript(raw, "fixture", "hash", 3, "local-asr");
  assert.equal(legacy.length, 3);
  const grouped = importTranscript(raw, "fixture", "hash", 3, "local-asr", true);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0]!.text, "Результат зависит от качества исходной записи.");
  assert.equal(grouped[0]!.endSec, 1.5);
  assert.equal(grouped[0]!.evidence[0]!.kind, "local-asr");
  assert.equal(
    importTranscript(raw, "fixture", "hash", 3).length,
    3,
    "Supplied multiword transcript shape stays unchanged",
  );
});
test("ASR grouping rejects uncertainty corruption and never drops negation or crosses long gaps", async () => {
  const { importTranscript } = await import("../src/lib/ingest");
  const parse = (segments: unknown[]) => importTranscript({ segments }, "fixture", "hash", 10, "local-asr", true);
  const negation = [
    { text: "Это не", startSec: 0, endSec: 0.5 },
    { text: "гарантия результата.", startSec: 0.5, endSec: 1 },
    { text: "Следующая тема", startSec: 3, endSec: 4 },
  ];
  const grouped = parse(negation);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0]!.text, "Это не гарантия результата.");
  assert.equal(grouped.map((row) => row.text).join(" "), negation.map((row) => row.text).join(" "));
  assert.equal(
    parse([
      { text: "Без точки", startSec: 0, endSec: 0.5 },
      { text: "другая тема", startSec: 2, endSec: 3 },
    ]).length,
    2,
    "Gap greater than one second stays separate",
  );
  assert.throws(() => parse([]), /nonempty/);
  assert.throws(() => parse([{ text: " ", startSec: 0, endSec: 1 }]), /nonempty/);
  assert.throws(
    () =>
      parse([
        { text: "Первое", startSec: 0, endSec: 1 },
        { text: "Второе", startSec: 0.5, endSec: 2 },
      ]),
    /nonoverlapping/,
  );
  assert.throws(
    () =>
      parse([
        { text: "Второе", startSec: 2, endSec: 3 },
        { text: "Первое", startSec: 0, endSec: 1 },
      ]),
    /monotonic/,
  );
  assert.throws(
    () =>
      parse([
        { text: "a".repeat(6000), startSec: 0, endSec: 1 },
        { text: "b".repeat(6000), startSec: 1, endSec: 2 },
      ]),
    /10000 characters/,
  );
});

test("shipped embedding tokenizer bounds effective preprocessing and rejects default prompts without inference", (t) => {
  const python = spawnSync("python3", ["--version"], { encoding: "utf8", timeout: 5000 });
  if (python.error || python.status !== 0) {
    t.skip("Installed Python required for hermetic shipped-worker guard tests");
    return;
  }
  const result = spawnSync("python3", [path.resolve(import.meta.dirname, "fixtures/local-worker-window.py")], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 2 tests/);
});
