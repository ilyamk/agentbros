import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ingestMedia, readSourceIndex, importTranscript } from "../src/lib/ingest";
import { searchSourceIndexes, proposeSelect, applySelect } from "../src/lib/ingest/selects";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "ingest evidence "));
  mkdirSync(path.join(directory, "public/projects/test"), { recursive: true });
  writeFileSync(path.join(directory, "public/projects/test/project.json"), "{}");
  const source = path.join(directory, "source recording.mp4"),
    transcript = path.join(directory, "words.json");
  const generated = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x120:r=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-t",
      "3",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-pix_fmt",
      "yuv420p",
      source,
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  writeFileSync(
    transcript,
    JSON.stringify({
      segments: [
        { startSec: 0.5, endSec: 1.5, text: "Battery performance improves.", tags: ["product"] },
        { startSec: 1.6, endSec: 2.5, text: "Under these conditions only.", tags: [] },
      ],
    }),
  );
  return { directory, source, transcript };
}
test("supplied word evidence groups complete punctuation/gap spans and rejects invalid bounds", () => {
  const rows = importTranscript(
    {
      words: [
        { text: "Never", start: 0, end: 0.2, type: "word" },
        { text: "delete", start: 0.2, end: 0.4, type: "word" },
        { text: "context.", start: 0.4, end: 0.8, type: "word" },
      ],
    },
    "fixture",
    "hash",
    1,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.text, "Never delete context.");
  assert.equal(rows[0]!.endSec, 0.8);
  assert.throws(() => importTranscript([{ text: "bad", start: 0, end: 2 }], "fixture", "hash", 1), /beyond/);
  assert.throws(() => importTranscript([{ text: "bad", start: 1, end: 0.5 }], "fixture", "hash", 1));
});
test("immutable local ingest, exact frame mapping, keyed cache and corruption guards", (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const f = fixture(),
    cwd = process.cwd();
  try {
    process.chdir(f.directory);
    const request = {
      projectId: "test",
      sourceFile: f.source,
      transcriptFile: f.transcript,
      options: { thumbnailEverySec: 1, proxyWidth: 80, tags: ["recording"] },
    };
    const preview = ingestMedia({ ...request, dryRun: true });
    assert.equal(preview.index, undefined);
    assert.equal(existsSync("public/projects/test/pipeline"), false);
    const first = ingestMedia(request),
      index = first.index!;
    assert.equal(index.source.timestamps.length, 90);
    assert.deepEqual(index.source.fps, { num: 30, den: 1 });
    assert.equal(index.source.variableFrameRate, false);
    assert.equal(index.thumbnails.length, 3);
    assert.deepEqual(
      index.thumbnails.map((row) => row.sourceFrame.num),
      [0, 30, 60],
    );
    assert.deepEqual(
      index.thumbnails.map((row) => row.timeSec),
      [0, 1, 2],
    );
    const again = ingestMedia(request);
    assert.equal(again.cacheHit, true);
    assert.equal(again.cacheKey, first.cacheKey);
    assert.deepEqual(readSourceIndex("test", first.file), index);
    assert.equal(index.ocr.executed, false);
    assert.notEqual(
      ingestMedia({ ...request, options: { ...request.options, proxyWidth: 96 }, dryRun: true }).cacheKey,
      first.cacheKey,
    );
    writeFileSync(
      f.transcript,
      JSON.stringify({ segments: [{ startSec: 0.5, endSec: 1.5, text: "Changed source evidence." }] }),
    );
    assert.notEqual(ingestMedia({ ...request, dryRun: true }).cacheKey, first.cacheKey);
    writeFileSync(path.resolve("public", index.proxy!.path), "corrupt");
    assert.throws(() => readSourceIndex("test", first.file), /checksum/);
  } finally {
    process.chdir(cwd);
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test("lexical selects expose evidence, preserve protected context and apply exact reversible trims", (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const f = fixture(),
    cwd = process.cwd();
  try {
    process.chdir(f.directory);
    const result = ingestMedia({
        projectId: "test",
        sourceFile: f.source,
        transcriptFile: f.transcript,
        options: {
          thumbnailEverySec: 2,
          protectedSpans: [{ startSec: 1.4, endSec: 2.5, reason: "qualifying conditions" }],
        },
      }),
      index = result.index!;
    const hits = searchSourceIndexes([index], "battery improves");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.scoreParts.transcriptCoverage, 1);
    assert.equal(hits[0]!.evidence[0]!.kind, "supplied-transcript");
    const proposal = proposeSelect(index, hits[0]!, 0);
    assert.equal(proposal.startSec, 0.5);
    assert.equal(proposal.endSec, 2.5);
    assert.equal(proposal.reviewRequired, true);
    const store = new TimelineEditStore(path.resolve("public/projects/test/pipeline/timeline-edit.json"));
    store.initialize({
      version: 1,
      projectId: "test",
      timebase: { num: 30, den: 1 },
      tracks: [
        {
          id: "presenter",
          kind: "presenter",
          clips: [
            {
              id: "take",
              assetId: index.assetId,
              start: { num: 0, den: 1 },
              source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
            },
          ],
        },
        { id: "music", kind: "music", clips: [] },
      ],
    });
    const before = readFileSync(store.file, "utf8"),
      revision = store.read().revision;
    const params = {
      projectId: "test",
      indexFile: result.file,
      proposal,
      trackId: "presenter",
      clipId: "take",
      expectedRevision: revision,
    };
    const planned = applySelect({ ...params, dryRun: true });
    assert.equal(readFileSync(store.file, "utf8"), before);
    assert.deepEqual(planned.timeline.tracks[0]!.clips[0]!.source.start, { num: 15, den: 1 });
    assert.throws(() => applySelect({ ...params, proposal: { ...proposal, endSec: 1.5 } }), /altered/);
    const applied = applySelect(params);
    assert.equal(applied.revision, revision + 1);
    assert.deepEqual(applied.timeline.tracks[1], store.read().undo[0]!.before.tracks[1]);
    assert.throws(() => applySelect(params), /revision/i);
    store.undo(applied.revision);
    assert.deepEqual(store.read().timeline.tracks[0]!.clips[0]!.source.end, { num: 90, den: 1 });
    const protectedResult = ingestMedia({
      projectId: "test",
      sourceFile: f.source,
      transcriptFile: f.transcript,
      options: {
        thumbnailEverySec: 2,
        protectedSpans: [{ startSec: 0.1, endSec: 0.2, reason: "mandatory disclosure" }],
      },
    });
    const protectedHit = searchSourceIndexes([protectedResult.index!], "battery")[0]!;
    const protectedProposal = proposeSelect(protectedResult.index!, protectedHit, 0);
    assert.throws(
      () =>
        applySelect({
          ...params,
          indexFile: protectedResult.file,
          proposal: protectedProposal,
          expectedRevision: store.read().revision,
        }),
      /protected context/,
    );
    const vfr = { ...index, source: { ...index.source, variableFrameRate: true } };
    writeFileSync(result.file, JSON.stringify(vfr));
    assert.throws(() => applySelect({ ...params, expectedRevision: store.read().revision }), /constant-frame/);
  } finally {
    process.chdir(cwd);
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test("optional OCR absence is reported without invented text", async () => {
  const { probeOcr } = await import("../src/lib/ingest");
  const old = process.env.PATH;
  try {
    process.env.PATH = "";
    const capability = probeOcr();
    assert.equal(capability.available, false);
    assert.equal(capability.executed, false);
    assert.match(capability.warning!, /unavailable/);
  } finally {
    process.env.PATH = old;
  }
});
test("scene discontinuities and child CLI queries carry local evidence without mutating originals", (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const f = fixture(),
    cwd = process.cwd(),
    repo = path.resolve(import.meta.dirname, "..");
  try {
    process.chdir(f.directory);
    const generated = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=160x120:r=30:d=1.5",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=160x120:r=30:d=1.5",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        f.source,
      ],
      { encoding: "utf8" },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const original = readFileSync(f.source);
    const result = ingestMedia({
      projectId: "test",
      sourceFile: f.source,
      transcriptFile: f.transcript,
      options: { thumbnailEverySec: 1, sceneThreshold: 0.1 },
    });
    assert.equal(result.index!.scenes.length, 2);
    assert.ok(Math.abs(result.index!.scenes[1]!.startSec - 1.5) < 0.001);
    assert.equal(result.index!.scenes[1]!.evidence.kind, "ffmpeg-scene-change");
    const env = { ...process.env };
    delete env.FAL_KEY;
    delete env.ELEVENLABS_API_KEY;
    const command = spawnSync(
      path.join(repo, "node_modules/.bin/tsx"),
      [path.join(repo, "scripts/media-selects.ts"), "--project", "test", "--query", "battery", "--context", "0"],
      { encoding: "utf8", env, timeout: 30000 },
    );
    assert.equal(command.status, 0, command.stderr);
    const envelope = JSON.parse(command.stdout);
    assert.equal(command.stdout.trim().split("\n").length, 1);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.metadata.method, "lexical-transcript-and-tags");
    assert.equal(envelope.metadata.hits[0].proposal.reviewRequired, true);
    assert.deepEqual(readFileSync(f.source), original);
    const index = result.index!;
    index.options.protectedSpans.push({ startSec: 2.8, endSec: 2.9, reason: "keep disclosure" });
    writeFileSync(result.file, JSON.stringify(index));
    assert.throws(() => readSourceIndex("test", result.file), /cache identity/);
  } finally {
    process.chdir(cwd);
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test("audio-only ingest produces a reusable low-bandwidth proxy with explicit no-OCR evidence", (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const f = fixture(),
    cwd = process.cwd();
  try {
    const audio = path.join(f.directory, "recorded voice.wav");
    assert.equal(
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", audio]).status,
      0,
    );
    process.chdir(f.directory);
    const request = { projectId: "test", sourceFile: audio, transcriptFile: f.transcript, options: { ocr: true } };
    const result = ingestMedia(request);
    assert.equal(result.index!.source.kind, "audio");
    assert.equal(result.index!.source.fps, undefined);
    assert.equal(result.index!.thumbnails.length, 0);
    assert.match(result.index!.proxy!.path, /\.mp3$/);
    assert.equal(result.index!.ocr.executed, false);
    assert.match(result.index!.ocr.warning!, /no video frames/);
    assert.equal(ingestMedia(request).cacheHit, true);
  } finally {
    process.chdir(cwd);
    rmSync(f.directory, { recursive: true, force: true });
  }
});
