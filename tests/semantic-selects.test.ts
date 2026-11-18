import test from "node:test";
import assert from "node:assert/strict";
import { SourceIndexSchema } from "../src/types/source-index";
import { segmentEmbeddingHash, searchEmbeddings } from "../src/lib/ingest/embeddings";
import { proposeSelect, type SourceSelect } from "../src/lib/ingest/selects";
const index = SourceIndexSchema.parse({
  schemaVersion: 1,
  projectId: "semantic",
  assetId: `sha256:${"a".repeat(64)}`,
  sourceHash: "a".repeat(64),
  cacheKey: "b".repeat(64),
  createdAt: "2026-10-11",
  source: {
    path: "immutable.mp4",
    kind: "video",
    durationSec: 20,
    fps: { num: 30, den: 1 },
    variableFrameRate: false,
    timestamps: [0],
  },
  options: {
    protectedSpans: [{ startSec: 0, endSec: 3, reason: "Preserve caveat" }],
  },
  thumbnails: [],
  scenes: [],
  segments: [
    {
      id: "caveat",
      startSec: 0,
      endSec: 3,
      text: "Do not claim a guarantee.",
      tags: ["risk"],
      evidence: [{ kind: "supplied-transcript", source: "creator" }],
    },
    {
      id: "demo",
      startSec: 5,
      endSec: 8,
      text: "Interface walkthrough",
      tags: ["screen"],
      evidence: [{ kind: "manual-tag", source: "creator" }],
    },
  ],
  ocr: { available: false, executed: false },
});
const space = {
  model: "fixture-vector-math",
  revision: "1",
  dimensions: 2,
  kind: "text" as const,
};
const pack = {
  version: 1,
  space,
  generatedBy: "local test fixture",
  evidence: "Numeric vectors test search mathematics; no semantic model inference claimed.",
  items: index.segments.map((segment, i) => ({
    cacheKey: index.cacheKey,
    sourceHash: index.sourceHash,
    segmentId: segment.id,
    segmentHash: segmentEmbeddingHash(index, segment.id),
    vector: i ? [1, 0] : [0, 1],
  })),
};
test("supplied vector search ranks exact source segments and preserves context proposals", () => {
  const hits = searchEmbeddings([index], pack, {
    space,
    text: "interface evidence",
    vector: [4, 0],
  });
  assert.equal(hits[0].segmentId, "demo");
  assert.equal(hits[0].cosine, 1);
  assert.equal(hits[0].method, "supplied-embedding-cosine");
  assert.equal(hits[0].automaticSelection, false);
  const caveat = searchEmbeddings([index], pack, {
    space,
    text: "caveat",
    vector: [0, 2],
  })[0];
  const proposal = proposeSelect(index, caveat as unknown as SourceSelect, 0);
  assert.equal(proposal.startSec, 0);
  assert.equal(proposal.endSec, 3);
  assert.equal(proposal.reviewRequired, true);
});
test("vectors from mismatched models, stale transcript, duplicated or invalid input are rejected", () => {
  assert.throws(
    () =>
      searchEmbeddings([index], pack, {
        space: { ...space, revision: "2" },
        text: "x",
        vector: [1, 0],
      }),
    /same embedding/,
  );
  assert.throws(() => searchEmbeddings([index], pack, { space, text: "x", vector: [0, 0] }), /nonzero norm/);
  assert.throws(() => searchEmbeddings([index], pack, { space, text: "x", vector: [1] }), /dimension/);
  const stale = structuredClone(index);
  stale.segments[0].text = "It is guaranteed.";
  assert.throws(() => searchEmbeddings([stale], pack, { space, text: "x", vector: [1, 0] }), /stale/);
  assert.throws(
    () =>
      searchEmbeddings(
        [index],
        { ...pack, items: [pack.items[0], pack.items[0]] },
        { space, text: "x", vector: [1, 0] },
      ),
    /Duplicate/,
  );
});
