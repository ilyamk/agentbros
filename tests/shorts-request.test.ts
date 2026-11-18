import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { shortsFixture, r } from "./workflow-shorts-series.fixture";
import { TimelineIRSchema } from "../src/types/timeline";
import { ShortsSeriesRequestSchema } from "../src/types/workflow-shorts-series";
import { selectionHash, stableHash } from "../src/lib/longform/plans";
import { approvedSelections, chaptersFromRecordingEdit } from "../src/lib/shorts/request";
import { DEFAULT_WEIGHTS } from "../src/lib/shorts/rank";
import { COMMANDS } from "../src/mcp/catalog";

const HASH = "a".repeat(64);
const recordingEdit = (protectedSpans: { startFrame: number; endFrame: number; kind: string }[]) => ({
  version: 1,
  request: {
    version: 1,
    workflow: "recording-edit",
    projectId: "talk-recut",
    name: "Synthetic recut",
    profile: "recording-only",
    formats: ["vertical"],
    source: { file: "talk.mp4", sha256: HASH, version: "sha256:aaaa", fps: { num: 30, den: 1 } },
    transcript: {
      version: "synthetic",
      language: "en",
      words: [{ id: "w1", text: "Not", startFrame: 30, endFrame: 40 }],
    },
    keepSpans: [
      { id: "k1", startFrame: 0, endFrame: 40, reason: "speech" },
      { id: "k2", startFrame: 60, endFrame: 300, reason: "speech" },
    ],
    cuts: [{ startFrame: 40, endFrame: 60, reason: "pause" }],
    protectedSpans: protectedSpans.map((s) => ({ ...s, reason: `synthetic ${s.kind}` })),
    revision: 1,
  },
});

test("chapters from a recut: one whole chapter, protected spans mapped through kept clips, a span cut away entirely dropped", () => {
  const ir = TimelineIRSchema.parse({
    version: 1,
    projectId: "talk-recut",
    timebase: r(30),
    tracks: [
      {
        id: "picture",
        kind: "visual",
        clips: [
          {
            id: "k1",
            assetId: `sha256:${"c".repeat(64)}`,
            start: r(0),
            source: { start: r(0), end: r(40), timebase: r(30) },
            payload: { sourceHash: HASH },
          },
          {
            id: "k2",
            assetId: `sha256:${"c".repeat(64)}`,
            start: r(40),
            source: { start: r(60), end: r(300), timebase: r(30) },
            payload: { sourceHash: HASH },
          },
        ],
      },
    ],
  });
  const { manifest, dropped } = chaptersFromRecordingEdit(
    ir,
    recordingEdit([
      { startFrame: 30, endFrame: 50, kind: "negation" },
      { startFrame: 42, endFrame: 58, kind: "caveat" },
      { startFrame: 100, endFrame: 130, kind: "attribution" },
    ]),
    "/nonexistent/public/projects/talk-recut",
  );
  assert.deepEqual(manifest.chapters, [
    { id: "whole", title: "Whole recording", revision: 1, start: r(0), end: r(280) },
  ]);
  assert.equal(dropped, 1);
  assert.deepEqual(
    manifest.protectedSpans.map((s) => [s.id, s.reason, s.start.num, s.end.num]),
    [
      ["p1", "negation", 30, 40],
      ["p3", "claim-context", 80, 110],
    ],
  );
  const plain = chaptersFromRecordingEdit(ir, null, "/nonexistent/public/projects/talk-recut");
  assert.deepEqual(plain.manifest.protectedSpans, []);
});

const proposalsFor = (projectId: string, ranges: [number, number][]) => ({
  version: 1,
  preparedSha256: HASH,
  candidatesSha256: HASH,
  sourceSha256: HASH,
  weights: DEFAULT_WEIGHTS,
  weightsHash: stableHash(DEFAULT_WEIGHTS),
  threshold: 0,
  thresholdSource: "flag",
  proposals: ranges.map(([start, end], i) => {
    const range = [{ start: r(start), end: r(end) }];
    return {
      id: `c${i + 1}`,
      title: `Clip ${i + 1}`,
      score: 80 - i,
      axes: {},
      firstSentence: 1,
      lastSentence: 2,
      hookSentence: 1,
      startSec: start / 30,
      endSec: end / 30,
      durationSec: (end - start) / 30,
      text: "x",
      warnings: [],
      rank: i + 1,
      selection: {
        version: 1,
        id: `c${i + 1}`,
        purpose: `Clip ${i + 1}`,
        ranges: range,
        selectionHash: selectionHash(range),
      },
    };
  }),
  others: [],
  droppedOverlaps: [],
  rejected: [],
  timeline: { projectId, trackId: "visual", assetId: "projects/source/original.mp4" },
});

test("approval is recorded only from --approved-by and --ids, and only for proposals ranked against this project", () => {
  const raw = proposalsFor("source", [
    [0, 30],
    [90, 120],
  ]);
  assert.throws(() => approvedSelections(raw, "source"), /not approved/);
  assert.throws(
    () => approvedSelections(raw, "other", { approvedBy: "user", approvedAt: "2026-11-13T00:00:00Z", ids: ["c1"] }),
    /ranked against source/,
  );
  assert.throws(
    () => approvedSelections(raw, "source", { approvedBy: "user", approvedAt: "2026-11-13T00:00:00Z", ids: ["c9"] }),
    /No proposed selection draft/,
  );
  const edited = structuredClone(raw);
  edited.proposals[0]!.selection.ranges[0]!.end = r(31);
  assert.throws(
    () => approvedSelections(edited, "source", { approvedBy: "user", approvedAt: "2026-11-13T00:00:00Z", ids: ["c1"] }),
    /edited after shorts:rank/,
  );
  const [one] = approvedSelections(raw, "source", {
    approvedBy: "user",
    approvedAt: "2026-11-13T00:00:00Z",
    ids: ["c1"],
  });
  assert.equal(one!.approval.selectionHash, selectionHash(one!.ranges));
});

test("shorts:request writes the shorts-series request with the inspected source pin, checked by the workflow plan", (t) => {
  const f = shortsFixture(t);
  const runner = path.resolve("node_modules/tsx/dist/cli.mjs");
  const cli = (args: string[]) => {
    const result = spawnSync(process.execPath, [runner, path.resolve("scripts/shorts-request.ts"), ...args], {
      cwd: f.root,
      encoding: "utf8",
      timeout: 60000,
    });
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1, result.stderr);
    return JSON.parse(lines[0]!);
  };
  writeFileSync(
    path.join(f.root, "proposals.json"),
    JSON.stringify(
      proposalsFor("source", [
        [0, 30],
        [90, 120],
      ]),
    ),
  );
  const base = ["--project", "source", "--selections", "proposals.json"];
  assert.equal(cli([...base, "--chapters", "keep"]).error, "VALIDATION", "unapproved proposals are refused");
  assert.equal(cli([...base, "--ids", "c1,c2"]).error, "INVALID_INPUT", "--ids needs --approved-by");
  const approval = [
    "--ids",
    "c1,c2",
    "--approved-by",
    "synthetic test declaration, not a human approval",
    "--approved-at",
    "2026-11-13T00:00:00Z",
  ];
  const kept = cli([...base, ...approval, "--chapters", "keep", "--formats", "vertical,square"]);
  assert.equal(kept.ok, true, JSON.stringify(kept));
  const request = ShortsSeriesRequestSchema.parse(
    JSON.parse(readFileSync(path.join(f.root, "public/projects/source/pipeline/shorts-series-request.json"), "utf8")),
  );
  assert.equal(request.seriesId, "source-shorts");
  assert.deepEqual(
    request.episodes.map((e) => [e.selection.id, e.formats]),
    [
      ["c1", ["vertical", "square"]],
      ["c2", ["vertical", "square"]],
    ],
  );
  assert.equal(request.source.chapterFile, "pipeline/chapters.json");
  assert.match(kept.metadata.next, /video:workflow --scenario shorts-series --action create --request/);
  assert.equal(
    cli([...base, ...approval]).error,
    "FILE_EXISTS",
    "auto chapters never silently replace a different manifest",
  );
  const auto = cli([...base, ...approval, "--force"]);
  assert.equal(auto.ok, true, JSON.stringify(auto));
  assert.deepEqual(
    [auto.metadata.chapters, auto.metadata.protectedSpans, auto.metadata.recordingEdit],
    ["written", 0, false],
  );
  const overlapping = proposalsFor("source", [
    [0, 30],
    [20, 60],
  ]);
  writeFileSync(path.join(f.root, "proposals.json"), JSON.stringify(overlapping));
  assert.equal(
    cli([...base, ...approval, "--chapters", "keep"]).ok,
    true,
    "separate episodes may overlap; each is its own project",
  );
});

test("over MCP shorts_request writes chapters only: no selections, ids or approval fields; the CLI chapters-only run makes no request", (t) => {
  const tool = COMMANDS.find((c) => c.name === "shorts_request")!;
  assert.equal(tool.schema.safeParse({ project: "source" }).success, true);
  for (const field of [
    { "approved-by": "user" },
    { "approved-at": "2026-11-13T00:00:00Z" },
    { ids: "c1,c2" },
    { selections: "proposals.json" },
    { output: "r.json" },
    { chapters: "keep" },
  ])
    assert.equal(tool.schema.safeParse({ project: "source", ...field }).success, false, JSON.stringify(field));
  assert.match(tool.description, /user approves .* CLI/);
  const f = shortsFixture(t);
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/shorts-request.ts"),
      "--project",
      "source",
      "--force",
    ],
    { cwd: f.root, encoding: "utf8", timeout: 60000 },
  );
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.ok, true, result.stdout);
  assert.equal(out.metadata.request, null);
  assert.deepEqual(out.outputs, ["public/projects/source/pipeline/chapters.json"]);
  assert.match(out.metadata.approval, /never records it/);
});
