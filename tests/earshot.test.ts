import { spawnSync } from "node:child_process";
import { boundAudioReview } from "../src/lib/audio/review-evidence";
import { digest } from "../src/lib/jobs/model-artifacts";
import { regularInput } from "../src/lib/elevenlabs/files";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EarshotRequestSchema } from "../src/types/earshot";
import { earshotEnvironment, earshotStatus, prepareEarshot } from "../src/lib/audio/earshot-runtime";
import { earshot, earshotLibrarySounds, decodeEarshotInput } from "../src/lib/audio/earshot";
import { encodeWav } from "../src/lib/audio/sfx-synth";
import { planCueSounds } from "../src/lib/audio/cue-sounds";

test("Earshot requests refuse recipes, arbitrary parameters and invalid segment ranges", () => {
  for (const value of [
    { action: "render", sound: "../../evil" },
    { action: "render", sound: { recipe: "os" } },
    { action: "render", sound: "click/soft", code: "exec()" },
    { action: "find", input: "a.wav", query: "x", start: 5, end: 1 },
    { action: "find", input: "a.wav", query: "x", top: 100 },
  ])
    assert.equal(EarshotRequestSchema.safeParse(value).success, false);
});

test("runtime strips provider keys and Earshot overrides; preparation dry-run never writes", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "earshot-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = earshotEnvironment(root);
  assert.equal(env.EARSHOT_OFFLINE, "1");
  assert.equal(env.EARSHOT_BANK, undefined);
  assert.equal(env.ELEVENLABS_API_KEY, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(earshotStatus(root).available, false);
  const result = prepareEarshot({ root, semantic: true, dryRun: true });
  assert.equal(result.available, false);
  assert.equal(existsSync(path.join(root, "earshot")), false);
});

const actual = process.env.RUN_EARSHOT_TESTS === "1";
test(
  "prepared Earshot renders deterministic takes and feeds existing cue budgets/alignment",
  { skip: !actual, timeout: 120_000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "earshot-bank-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, "public/projects/demo");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "project.json"), "{}");
    const request = {
      action: "render",
      sound: "whoosh_fast/crisp",
      seed: 19,
      duration: 0.8,
      apex: 0.32,
      cueKind: "whoosh",
      alignTo: "peak",
    };
    await earshot(request, { rootDir: root, projectId: "demo", output: "public/projects/demo/first.wav" });
    await earshot(request, { rootDir: root, projectId: "demo", output: "public/projects/demo/second.wav" });
    assert.deepEqual(readFileSync(path.join(project, "first.wav")), readFileSync(path.join(project, "second.wav")));
    const take = JSON.parse(readFileSync(path.join(project, "first.wav.take.json"), "utf8"));
    assert.ok(Math.abs(take.peakSec - 0.32) <= 0.005);
    assert.equal(take.generatorLicence, "MIT");
    const library = earshotLibrarySounds(["public/projects/demo/first.wav.take.json"], "demo", root);
    const planned = planCueSounds(
      [
        {
          blockId: "fixture",
          startFrame: 0,
          cues: [
            { frame: 30, kind: "hit", sfx: "whoosh", weight: "hero" },
            { frame: 45, kind: "cut", silent: { reason: "Intentional silence" } },
          ],
        },
      ],
      {
        fps: 30,
        durationInFrames: 90,
        pack: [{ kind: "whoosh", file: "fallback.wav", alignSec: 0, durationSec: 0.8 }],
        library,
      },
    );
    assert.equal(planned.events.length, 1);
    assert.equal(planned.silences.length, 1);
    assert.equal(planned.events[0]!.file, take.src);
    assert.equal(planned.events[0]!.startFrame, 30 - Math.round(take.alignSec * 30));
    const audit = await earshot({ action: "check", input: "public/projects/demo/first.wav" }, { rootDir: root });
    assert.ok("advisory" in audit.metadata);
    assert.equal(audit.metadata.advisory, true);
    assert.ok("independentMeasurements" in audit.metadata);
  },
);

test(
  "prepared semantic search finds known attacks and returns original source seconds for a subrange",
  { skip: !actual, timeout: 180_000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "earshot-find-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const rate = 48000,
      samples = new Float32Array(rate * 12);
    let seed = 19;
    for (const start of [2, 5, 9])
      for (let index = 0; index < rate * 0.15; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        samples[start * rate + index] = ((seed / 4294967296) * 2 - 1) * Math.exp(-index / rate / 0.01) * 0.3;
      }
    const source = path.join(root, "clicks.wav");
    writeFileSync(source, encodeWav(samples, rate));
    const result = await earshot(
      { action: "find", input: source, query: "a single short click", top: 3, kind: "event" },
      { rootDir: root },
    );
    assert.ok("segments" in result.metadata);
    const segments = result.metadata.segments!;
    assert.equal(segments.length, 3);
    for (const start of [2, 5, 9]) assert.ok(segments.some((segment) => Math.abs(segment.start - start) < 1 / 30));
    const subset = await earshot(
      { action: "find", input: source, query: "a single short click", top: 1, kind: "event", start: 4, end: 6 },
      { rootDir: root },
    );
    assert.ok("segments" in subset.metadata);
    assert.ok(Math.abs(subset.metadata.segments![0]!.start - 5) < 1 / 30);
    assert.deepEqual(readFileSync(source), encodeWav(samples, rate));
  },
);

test("safe decoding preserves delayed audio on the container clock, including subranges", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "earshot-clock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "delayed.mkv");
  const make = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "color=size=16x16:rate=1:duration=5",
    "-itsoffset",
    "2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:v",
    "ffv1",
    "-c:a",
    "pcm_s16le",
    source,
  ]);
  assert.equal(make.status, 0, make.stderr.toString());
  const decoded = decodeEarshotInput(regularInput(root, source), root, 1, 4);
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", decoded.file, "-f", "f32le", "-ac", "1", "pipe:1"], {
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(raw.status, 0);
  const values = new Float32Array(raw.stdout.buffer, raw.stdout.byteOffset, raw.stdout.byteLength / 4);
  const first = values.findIndex((value) => Math.abs(value) > 0.01) / 48000;
  assert.ok(Math.abs(first - 1) < 0.01, `Source onset 2s must map to 1s within the range, got ${first}`);
});

test("critic evidence rejects changed or unrelated audio and accepts exact selected bytes", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "earshot-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "sound.wav"),
    selected = path.join(root, "selected.wav"),
    report = path.join(root, "report.json");
  const bytes = encodeWav(new Float32Array(4800), 48000);
  writeFileSync(source, bytes);
  writeFileSync(selected, bytes);
  writeFileSync(
    report,
    JSON.stringify({ engine: "earshot", advisory: true, source: { file: "sound.wav", sha256: digest(bytes) } }),
  );
  assert.equal(boundAudioReview(report, [selected], root).advisory, true);
  writeFileSync(selected, "unrelated");
  assert.throws(() => boundAudioReview(report, [selected], root), /unrelated/);
  writeFileSync(source, "changed");
  assert.throws(() => boundAudioReview(report, [source], root), /changed/);
});

test("analysis rejects local playlists before following external segments or caching another file under a playlist hash", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "earshot-playlist-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const outside = path.join(root, "outside.mp3");
  const encoded = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=1", outside]);
  assert.equal(encoded.status, 0);
  const playlist = path.join(workspace, "source.m3u8");
  writeFileSync(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${outside}\n#EXT-X-ENDLIST\n`);
  assert.throws(() => decodeEarshotInput(regularInput(workspace, playlist), workspace), /self-contained|playlists/);
  assert.equal(existsSync(path.join(workspace, "cache/studio-analysis")), false);
});
