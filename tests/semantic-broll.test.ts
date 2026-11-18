import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hashFile } from "../src/lib/assets/registry";
import { digest } from "../src/lib/jobs/model-artifacts";
import { planBroll, applyBroll } from "../src/lib/ingest/broll";
import { segmentEmbeddingHash } from "../src/lib/ingest/embeddings";
import { importTranscript } from "../src/lib/ingest";
import { SourceIndexSchema } from "../src/types/source-index";
import { brollFixture } from "./helpers/semantic-broll";
test("B-roll reconstructs versioned local ASR statements and legacy chunks; changed negation blocks apply", () => {
  for (const grouped of [false, true]) {
    const f = brollFixture();
    try {
      // Declared unit evidence, not model execution; actual inference has its own opt-in suite.
      const raw = {
        segments: [
          { text: "Do not claim", startSec: 0, endSec: 0.25 },
          { text: "a guarantee.", startSec: 0.25, endSec: 0.5 },
        ],
      };
      const bytes = JSON.stringify(raw),
        transcriptHash = digest(bytes);
      const localAnalysis = SourceIndexSchema.shape.localAnalysis.parse({
        engine: "whisper.cpp",
        identityHash: "a".repeat(64),
        cacheKey: "b".repeat(64),
        model: "unit-declaration",
        revision: "1",
        modelHash: "c".repeat(64),
        reviewRequired: true,
        ...(grouped ? { segmentation: "sentence-boundaries-v1" } : {}),
      });
      const cacheKey = digest(
        JSON.stringify({
          version: 1,
          sourceHash: f.index.sourceHash,
          options: f.index.options,
          transcriptHash,
          localAnalysis,
        }),
      );
      const relative = `pipeline/source-index/${cacheKey}`,
        directory = path.join(f.project, relative),
        indexFile = path.join(directory, "index.json");
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "transcript.json"), bytes);
      const index = SourceIndexSchema.parse({
        ...f.index,
        cacheKey,
        localAnalysis,
        transcript: {
          hash: transcriptHash,
          source: "declared unit ASR",
          path: `projects/pilot/${relative}/transcript.json`,
        },
        segments: importTranscript(
          raw,
          "declared unit ASR",
          transcriptHash,
          f.index.source.durationSec,
          "local-asr",
          grouped,
        ),
      });
      assert.equal(index.segments.length, grouped ? 1 : 2);
      const originalIndex = JSON.stringify(index);
      writeFileSync(indexFile, originalIndex);
      const request = {
        ...f.request,
        indexFile: `${relative}/index.json`,
        retrieval: { method: "lexical" as const, query: "claim" },
      };
      const plan = planBroll(request, { rootDir: f.root });
      assert.equal(plan.selection.startSec, 0);
      assert.equal(plan.selection.endSec, 0.6, "Full protected caveat survives either index version");
      const before = readFileSync(f.store.file);
      applyBroll(plan, f.review(plan), { rootDir: f.root, dryRun: true });
      assert.deepEqual(readFileSync(f.store.file), before);
      index.segments[0]!.text = "Do claim";
      writeFileSync(indexFile, JSON.stringify(index));
      assert.throws(() => applyBroll(plan, f.review(plan), { rootDir: f.root }), /transcript evidence changed/);
      assert.deepEqual(readFileSync(f.store.file), before, "Corrupt transcript cannot mutate the timeline");
      writeFileSync(indexFile, originalIndex);
      const originals = f.store.read().timeline.tracks;
      const result = applyBroll(plan, f.review(plan), { rootDir: f.root });
      assert.deepEqual(result.timeline.tracks.slice(0, -1), originals);
      assert.deepEqual(f.store.undo(result.revision).timeline.tracks, originals);
    } finally {
      f.cleanup();
    }
  }
});
test("reviewed cutaway preserves negation/context and every original track, dry-run/undo/CAS are exact", () => {
  const f = brollFixture();
  try {
    const before = readFileSync(f.store.file),
      originals = f.store.read().timeline.tracks;
    const plan = planBroll(f.request, {
      rootDir: f.root,
    });
    assert.equal(plan.selection.endSec, 0.6);
    assert.deepEqual(plan.outputEnd, {
      num: 48,
      den: 1,
    });
    assert.equal(plan.sourceAudio, "muted-visual-track");
    assert.equal(plan.productionApproved, false);
    applyBroll(plan, f.review(plan), {
      rootDir: f.root,
      dryRun: true,
    });
    assert.deepEqual(readFileSync(f.store.file), before);
    const result = applyBroll(plan, f.review(plan), {
      rootDir: f.root,
    });
    assert.equal(result.revision, 1);
    assert.deepEqual(result.timeline.tracks.slice(0, -1), originals);
    assert.throws(
      () =>
        applyBroll(plan, f.review(plan), {
          rootDir: f.root,
        }),
      /revision/,
    );
    assert.deepEqual(f.store.undo(1).timeline.tracks, originals);
    assert.deepEqual(f.store.redo(2).timeline, result.timeline);
    assert.equal(hashFile(path.join(f.root, "public", f.cutaway.files.original)), f.cutaway.hash);
  } finally {
    f.cleanup();
  }
});
test("supplied semantic vectors bind corpus/query evidence without pretending model inference", () => {
  const f = brollFixture();
  try {
    const space = {
      model: "fixture",
      revision: "1",
      dimensions: 2,
      kind: "text",
    };
    const pack = {
      version: 1,
      space,
      generatedBy: "numeric fixture",
      evidence: "No inference",
      items: [
        {
          cacheKey: f.index.cacheKey,
          sourceHash: f.index.sourceHash,
          segmentId: "transcript-0",
          segmentHash: segmentEmbeddingHash(f.index, "transcript-0"),
          vector: [1, 0],
        },
      ],
    };
    // A normal corpus spans several project indexes; the selected source must not force a single-index pack.
    const otherOptions = {
      ...f.index.options,
      tags: ["second indexed view"],
    };
    const otherKey = digest(
      JSON.stringify({
        version: 1,
        sourceHash: f.cutaway.hash,
        options: otherOptions,
        transcriptHash: f.index.transcript!.hash,
      }),
    );
    const other = {
      ...f.index,
      options: otherOptions,
      cacheKey: otherKey,
    };
    const otherDirectory = path.join(f.project, "pipeline/source-index", otherKey);
    mkdirSync(otherDirectory, {
      recursive: true,
    });
    writeFileSync(path.join(otherDirectory, "index.json"), JSON.stringify(other));
    pack.items.push({
      cacheKey: otherKey,
      sourceHash: other.sourceHash,
      segmentId: "transcript-0",
      segmentHash: segmentEmbeddingHash(other, "transcript-0"),
      vector: [0, 1],
    });
    writeFileSync(path.join(f.project, "pipeline/pack.json"), JSON.stringify(pack));
    writeFileSync(
      path.join(f.project, "pipeline/query.json"),
      JSON.stringify({
        space,
        text: "guarantee",
        vector: [1, 0],
      }),
    );
    const request = {
      ...f.request,
      retrieval: {
        method: "supplied-embedding",
        packFile: "pipeline/pack.json",
        queryFile: "pipeline/query.json",
      },
    };
    const plan = planBroll(request, {
      rootDir: f.root,
    });
    assert.equal(plan.searchPins.length, 3);
    assert.equal(
      plan.selection.id,
      planBroll(f.request, {
        rootDir: f.root,
      }).selection.id,
    );
    writeFileSync(
      path.join(f.project, "pipeline/query.json"),
      JSON.stringify({
        space,
        text: "guarantee",
        vector: [0, 1],
      }),
    );
    assert.throws(
      () =>
        applyBroll(plan, f.review(plan), {
          rootDir: f.root,
        }),
      /pins changed/,
    );
    writeFileSync(
      path.join(f.project, "pipeline/query.json"),
      JSON.stringify({
        space: {
          ...space,
          revision: "2",
        },
        text: "guarantee",
        vector: [1, 0],
      }),
    );
    assert.throws(
      () =>
        planBroll(request, {
          rootDir: f.root,
        }),
      /same embedding/,
    );
  } finally {
    f.cleanup();
  }
});
test("exact 30000/1001 mapping stays rational and does not change source speed", () => {
  const f = brollFixture("30000/1001");
  try {
    const plan = planBroll(f.request, {
      rootDir: f.root,
    });
    assert.deepEqual(plan.command.track.clips[0]!.source.timebase, {
      num: 30000,
      den: 1001,
    });
    assert.deepEqual(plan.outputEnd, {
      num: 24009,
      den: 500,
    });
    assert.deepEqual(plan.command.track.clips[0]!.rate, {
      num: 1,
      den: 1,
    });
  } finally {
    f.cleanup();
  }
});
test("foreign, changed, missing review, ranges, unverified rights and ambiguous VFR fail before any mutation", () => {
  const f = brollFixture();
  try {
    const baseline = readFileSync(f.store.file),
      options = {
        rootDir: f.root,
      },
      plan = planBroll(f.request, options);
    assert.throws(
      () =>
        applyBroll(
          {
            ...plan,
            outputEnd: {
              num: 1,
              den: 1,
            },
          },
          f.review(plan),
          options,
        ),
      /pins changed/,
    );
    assert.throws(() => applyBroll(plan, {}, options));
    assert.throws(
      () =>
        planBroll(
          {
            ...f.request,
            outputStart: {
              num: 85,
              den: 1,
            },
          },
          options,
        ),
      /master/,
    );
    assert.throws(
      () =>
        planBroll(
          {
            ...f.request,
            outputStart: {
              num: -1,
              den: 1,
            },
          },
          options,
        ),
      /master/,
    );
    assert.throws(
      () =>
        planBroll(
          {
            ...f.request,
            trackId: "speech",
          },
          options,
        ),
      /already exists/,
    );
    assert.throws(() =>
      planBroll(
        {
          ...f.request,
          indexFile: "../other/index.json",
        },
        options,
      ),
    );
    symlinkSync(path.join(f.project, f.indexFile), path.join(f.project, "pipeline/alias.json"));
    assert.throws(
      () =>
        planBroll(
          {
            ...f.request,
            indexFile: "pipeline/alias.json",
          },
          options,
        ),
      /symlink/,
    );
    writeFileSync(
      path.join(f.project, f.indexFile),
      JSON.stringify({
        ...f.index,
        source: {
          ...f.index.source,
          variableFrameRate: true,
        },
      }),
    );
    assert.throws(() => planBroll(f.request, options), /CFR/);
    writeFileSync(
      path.join(f.project, f.indexFile),
      JSON.stringify({
        ...f.index,
        segments: f.index.segments.map((s) => ({
          ...s,
          text: "Claim a guarantee.",
        })),
      }),
    );
    assert.throws(() => planBroll(f.request, options), /transcript/);
    writeFileSync(path.join(f.project, f.indexFile), JSON.stringify(f.index));
    const registryFile = path.join(f.project, "pipeline/asset-registry.json"),
      registry = JSON.parse(readFileSync(registryFile, "utf8"));
    registry.assets.find((a: { id: string }) => a.id === f.cutaway.id).rights.licence = "unknown";
    writeFileSync(registryFile, JSON.stringify(registry));
    assert.throws(() => planBroll(f.request, options), /rights/);
    registry.assets.find((a: { id: string }) => a.id === f.cutaway.id).rights.licence = "Synthetic local fixture only";
    registry.assets.find((a: { id: string }) => a.id === f.cutaway.id).rights.commercialAllowed = false;
    writeFileSync(registryFile, JSON.stringify(registry));
    assert.throws(
      () =>
        planBroll(
          {
            ...f.request,
            usage: "advertising",
          },
          options,
        ),
      /rights/,
    );
    registry.assets.find((a: { id: string }) => a.id === f.cutaway.id).rights.commercialAllowed = true;
    writeFileSync(registryFile, JSON.stringify(registry));
    const originalFile = path.join(f.root, "public", f.cutaway.files.original),
      original = readFileSync(originalFile);
    writeFileSync(originalFile, Buffer.concat([original, Buffer.from("changed")]));
    assert.throws(() => applyBroll(plan, f.review(plan), options), /original\/evidence changed/);
    writeFileSync(originalFile, original);
    const timeline = JSON.parse(baseline.toString());
    timeline.timeline.tracks[0].clips[0].payload = {
      changed: true,
    };
    writeFileSync(f.store.file, JSON.stringify(timeline));
    assert.throws(() => applyBroll(plan, f.review(plan), options), /pins changed/);
    writeFileSync(f.store.file, baseline);
    assert.deepEqual(readFileSync(f.store.file), baseline);
  } finally {
    f.cleanup();
  }
});
test("CLI request is project-scoped and emits one local JSON line", () => {
  const f = brollFixture();
  try {
    const file = path.join(f.project, "pipeline/broll-request.json");
    writeFileSync(file, JSON.stringify(f.request));
    const stdout = execFileSync(
      process.execPath,
      [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        path.resolve("scripts/media-broll.ts"),
        "--project",
        "pilot",
        "--request",
        file,
      ],
      {
        cwd: f.root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
      },
    );
    assert.equal(stdout.trim().split("\n").length, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(
      result.metadata.planHash,
      planBroll(f.request, {
        rootDir: f.root,
      }).planHash,
    );
  } finally {
    f.cleanup();
  }
});
