import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runSpeechReplacement } from "../src/lib/elevenlabs/speech-replacement";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import { digest } from "../src/lib/jobs/model-artifacts";
import { buildProjectAudioMix } from "../src/lib/audio/project-mix-plan";
import { buildAudioMix } from "../src/lib/audio/local-mix";
import type { ProjectVideoProps } from "../src/lib/project-props";
import { OperationStore } from "../src/lib/jobs/store";
import { importAsset } from "../src/lib/assets/registry";
import { USER_GRANT } from "./helpers/ceiling-grant";

const f = (num: number) => ({ num, den: 1 });
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
const sha = (file: string) => digest(readFileSync(file));
const ffmpeg = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-nostdin", ...args]);
const tone = (file: string, length: number, frequency = 440) =>
  ffmpeg("-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${length}`, file);
const decode = (file: string) => ffmpeg("-i", file, "-vn", "-ar", "48000", "-ac", "1", "-f", "s16le", "pipe:1");
function aligned(file: string, audio: string, ranges: [string, number, number][]) {
  json(file, {
    version: 1,
    source: { file: path.basename(audio), sha256: sha(audio), durationSec: null },
    engine: { provider: "local", timing: "native", model: "synthetic", verbatim: false, diarized: false },
    language: "en",
    speakers: [],
    sentences: [],
    words: ranges.map(([text, startSec, endSec], index) => ({
      id: `w${index + 1}`,
      text,
      startSec,
      endSec,
      kind: "word",
      speaker: null,
      channel: null,
      confidence: null,
    })),
  });
  return { file, sha256: sha(file) };
}

function fixture(t: test.TestContext, presenter = false) {
  const root = mkdtempSync(path.join(tmpdir(), "speech-edit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/demo");
  mkdirSync(dir, { recursive: true });
  json(path.join(dir, "project.json"), {});
  const source = path.join(dir, presenter ? "source.mp4" : "source.wav");
  if (presenter)
    ffmpeg(
      "-f",
      "lavfi",
      "-i",
      "color=red:s=128x96:r=30:d=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      source,
    );
  else tone(source, 3);
  const assetId = `projects/demo/${path.basename(source)}`;
  const journal = new TimelineEditStore(path.join(dir, "pipeline/timeline-edit.json"));
  const trackId = presenter ? "presenter" : "speech";
  const original = journal.initialize({
    version: 1,
    projectId: "demo",
    timebase: f(30),
    legacyProject: { talkingHead: { audioSource: presenter ? "embedded" : "voiceover" } },
    tracks: [
      {
        id: trackId,
        kind: presenter ? "presenter" : "voiceover",
        clips: [
          {
            id: "speaker",
            assetId,
            start: f(0),
            source: { start: f(0), end: f(90), timebase: f(30) },
            payload: { volume: 0.2 },
            captions: [
              { id: "w1", text: "Before", start: f(3), end: f(10) },
              { id: "w2", text: "Hello", start: f(33), end: f(43) },
              { id: "w3", text: "friend", start: f(45), end: f(51) },
              { id: "w4", text: "After", start: f(65), end: f(73) },
            ],
          },
        ],
      },
    ],
  });
  const sourceTranscript = aligned(path.join(dir, "source.json"), source, [
    ["Before", 0.1, 0.3],
    ["Hello", 1.1, 1.4],
    ["friend", 1.5, 1.7],
    ["After", 2.2, 2.4],
  ]);
  const request = {
    version: 1,
    projectId: "demo",
    revision: 0,
    trackId,
    clipId: "speaker",
    sourceSha256: sha(source),
    sourceTranscript,
    range: { startFrame: 30, endFrame: 60 },
    approvedText: "Hello friend.",
    language: "en",
    originalAudio: "isolated-dialogue",
    picture: { mode: presenter ? "unchanged-lips" : "offscreen" },
  };
  return { root, dir, source, original, journal, request, assetId };
}

test("Voice Changer sends only the selected source window, resumes once and applies reviewed timing atomically", async (t) => {
  const env = fixture(t);
  const store = new OperationStore("demo", {
    directory: path.join(env.dir, "pipeline"),
    responseCacheDirectory: path.join(env.root, ".cache/paid-responses"),
  });
  store.configure({ ceilingUsd: 10, maxJobUsd: 3, repairReserveFraction: 0 }, USER_GRANT);
  const fakeTake = path.join(env.root, "review.mp3");
  tone(fakeTake, 0.9, 660);
  const req = {
    ...env.request,
    method: "voice-change",
    maxCostUsd: 1,
    removeBackgroundNoise: true,
    voiceRef: { provider: "elevenlabs", model: "eleven_multilingual_sts_v2", language: "en", voiceId: "voice_b" },
  };
  let posts = 0;
  const opts = {
    rootDir: env.root,
    store,
    apiKey: "TEST",
    fetch: (async (url: string, init?: RequestInit) => {
      posts++;
      assert.match(url, /voice-changer\/voice_b$/);
      const form = init?.body as FormData;
      assert.equal(form.get("model_id"), "eleven_multilingual_sts_v2");
      assert.equal(form.get("remove_background_noise"), "true");
      const data = Buffer.from(await (form.get("audio") as File).arrayBuffer());
      const sourceWindow = path.join(env.root, "uploaded.wav");
      writeFileSync(sourceWindow, data);
      assert.equal(decode(sourceWindow).byteLength, 48_000 * 2);
      return new Response(readFileSync(fakeTake));
    }) as typeof fetch,
  };
  assert.equal((await runSpeechReplacement(req, opts)).metadata.state, "planned");
  await assert.rejects(runSpeechReplacement(req, { ...opts, action: "prepare" }), /dry-run=false/);
  assert.equal(posts, 0);
  const prepared = await runSpeechReplacement(req, { ...opts, action: "prepare", dryRun: false });
  await runSpeechReplacement(req, { ...opts, action: "prepare", dryRun: false });
  assert.equal(posts, 1);
  const output = prepared.outputs.find((file) => file.endsWith(".mp3"))!;
  const alignedFile = aligned(path.join(env.dir, "replacement.json"), output, [
    ["Hello", 0.1, 0.4],
    ["friend", 0.5, 0.7],
  ]);
  assert.equal((await runSpeechReplacement(req, { ...opts, action: "status" })).metadata.state, "pending-alignment");
  const status = await runSpeechReplacement(req, {
    ...opts,
    action: "status",
    alignment: alignedFile.file,
    preview: true,
  });
  const preview = decode(status.outputs.find((file) => file.endsWith(".preview.wav"))!);
  assert.equal(preview.byteLength, 76_800 * 2);
  for (const [startSec, expectedFrequency] of [
    [0.05, 440],
    [0.65, 660],
    [1.4, 440],
  ] as const) {
    const start = Math.round(startSec * 48_000) * 2;
    let crossings = 0;
    for (let byte = start; byte < start + 9_600; byte += 2) {
      if (preview.readInt16LE(byte) <= 0 && preview.readInt16LE(byte + 2) > 0) crossings++;
    }
    assert.ok(Math.abs(crossings * 10 - expectedFrequency) <= 10, `unexpected preview audio at ${startSec}s`);
  }
  const reviewSha256 = "reviewSha256" in status.metadata ? (status.metadata.reviewSha256 as string) : undefined;
  assert.ok(reviewSha256);
  const apply = {
    ...opts,
    action: "apply" as const,
    alignment: alignedFile.file,
    reviewSha256,
    answer: "I listened and approve",
  };
  await assert.rejects(runSpeechReplacement(req, { ...apply, reviewSha256: "0".repeat(64) }), /current take/);
  const result = await Promise.allSettled([runSpeechReplacement(req, apply), runSpeechReplacement(req, apply)]);
  assert.equal(
    result.filter((item) => item.status === "fulfilled").length,
    1,
    result
      .filter((item) => item.status === "rejected")
      .map((item) => String(item.reason))
      .join("\n"),
  );
  const clips = compileTimelineIR(env.journal.read().timeline).tracks[0]!.clips;
  assert.deepEqual(
    clips.map((clip) => [clip.start.num, clip.end.num]),
    [
      [0, 30],
      [30, 60],
      [60, 90],
    ],
  );
  assert.deepEqual(
    clips.flatMap((clip) => clip.captions.map((word) => word.text)),
    ["Before", "Hello", "friend", "After"],
  );
  assert.ok(clips.every((clip) => clip.payload?.volume === 0.2));
  const imported = (await import("../src/lib/assets/registry"))
    .readAssetRegistry("demo", env.root)
    .assets.find((item) => item.id === clips[1]!.assetId)!;
  const mix = buildProjectAudioMix(
    {
      timeline: env.journal.read().timeline,
      timelineAssets: {
        [env.assetId]: { source: env.assetId, kind: "audio" },
        [imported.id]: { source: imported.files.original, kind: "audio" },
      },
    } as ProjectVideoProps,
    90,
    env.root,
  );
  assert.doesNotThrow(() => buildAudioMix(mix));
  assert.deepEqual(
    mix.tracks.map((track) => track.volume),
    [0.2, 0.2, 0.2],
  );
  assert.deepEqual(env.journal.undo(1).timeline, env.original.timeline);
  assert.deepEqual(compileTimelineIR(env.journal.redo(2).timeline).tracks[0]!.clips, clips);
  assert.equal(sha(env.source), req.sourceSha256);
  env.journal.apply({ type: "move", trackId: "speech", clipId: clips[1]!.id, start: f(91) }, 3);
  assert.equal((await runSpeechReplacement(req, { ...opts, action: "status" })).metadata.state, "superseded");
});

test("v4 replacement rejects partial words and failed fits, then quotes and publishes an explicit retake", async (t) => {
  const env = fixture(t);
  const store = new OperationStore("demo", {
    directory: path.join(env.dir, "pipeline"),
    responseCacheDirectory: path.join(env.root, ".cache/paid-responses"),
  });
  store.configure({ ceilingUsd: 10, maxJobUsd: 3, repairReserveFraction: 0 }, USER_GRANT);
  const audio = path.join(env.root, "fixture.mp3");
  tone(audio, 1.1);
  const req = {
    ...env.request,
    range: { firstWordId: "w2", lastWordId: "w3" },
    method: "tts",
    approvedText: "Keep going.",
    directedText: "[steady] Keep going.",
    maxCostUsd: 1,
    voiceRef: { provider: "elevenlabs", voiceId: "fixture_voice", model: "eleven_v4", language: "en" },
  };
  let posts = 0;
  const opts = {
    rootDir: env.root,
    store,
    apiKey: "TEST",
    fetch: (async (url: string, init?: RequestInit) => {
      posts++;
      assert.match(url, /text-to-speech\/fixture_voice\/with-timestamps/);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model_id, "eleven_v4");
      assert.equal(body.text, "[steady] Keep going.");
      const characters = [...req.approvedText];
      const step = posts === 1 ? 0.08 : 0.04;
      return Response.json({
        audio_base64: readFileSync(audio).toString("base64"),
        alignment: {
          characters,
          character_start_times_seconds: characters.map((_, index) => index * step),
          character_end_times_seconds: characters.map((_, index) => (index + 1) * step),
        },
      });
    }) as typeof fetch,
  };
  const prepare = { ...opts, action: "prepare" as const, dryRun: false };
  await assert.rejects(
    runSpeechReplacement({ ...req, range: { startFrame: 36, endFrame: 60 } }, prepare),
    /cuts through/,
  );
  await assert.rejects(runSpeechReplacement({ ...req, sourceSha256: "0".repeat(64) }, prepare), /input changed/);
  await assert.rejects(runSpeechReplacement({ ...req, directedText: "Stop now." }, prepare), /approved words/);
  assert.equal(posts, 0);
  assert.deepEqual(env.journal.read(), env.original);
  const first = await runSpeechReplacement(req, prepare);
  await assert.rejects(runSpeechReplacement(req, { ...opts, action: "status" }), /does not fit/);
  const retake = { ...req, take: 2 };
  const second = await runSpeechReplacement(retake, prepare);
  assert.equal(posts, 2);
  assert.notDeepEqual(first.outputs, second.outputs);
  assert.ok(first.outputs.some((file) => readFileSync(file).length));
  const review = await runSpeechReplacement(retake, { ...opts, action: "status" });
  assert.equal(review.metadata.state, "ready-for-review");
  assert.equal(env.journal.read().revision, 0);
});

test("a changed line needs a reviewed picture and the project mix excludes the muted presenter window", async (t) => {
  const env = fixture(t, true);
  const take = path.join(env.root, "recorded.wav");
  tone(take, 1);
  const alignedFile = aligned(path.join(env.dir, "replacement.json"), take, [
    ["Keep", 0.1, 0.4],
    ["going", 0.5, 0.7],
  ]);
  const request = {
    ...env.request,
    approvedText: "Keep going.",
    method: "existing",
    performance: { file: take, sha256: sha(take) },
  };
  await assert.rejects(runSpeechReplacement(request, { rootDir: env.root }), /Different words/);
  const cutaway = path.join(env.root, "cutaway.mp4");
  ffmpeg("-f", "lavfi", "-i", "color=blue:s=128x96:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", cutaway);
  const picture = importAsset({
    rootDir: env.root,
    projectId: "demo",
    sourceFile: cutaway,
    provenance: { origin: "manual" },
  }).asset;
  const reviewed = { ...request, picture: { mode: "cutaway", assetId: picture.id } };
  const options = { rootDir: env.root, alignment: alignedFile.file };
  const status = await runSpeechReplacement(reviewed, { ...options, action: "status" });
  const reviewSha256 = "reviewSha256" in status.metadata ? (status.metadata.reviewSha256 as string) : undefined;
  await runSpeechReplacement(reviewed, { ...options, action: "apply", answer: "I approve this edit", reviewSha256 });
  const snapshot = env.journal.read().timeline;
  const clips = snapshot.tracks[0]!.clips;
  assert.equal(clips[1]!.assetId, picture.id);
  assert.equal(clips[1]!.payload?.speechMuted, true);
  const replacement = snapshot.tracks[1]!.clips[0]!;
  const mix = buildProjectAudioMix(
    {
      timeline: snapshot,
      talkingHead: { audioSource: "embedded" },
      timelineAssets: {
        [env.assetId]: { source: env.assetId, kind: "video" },
        [replacement.assetId]: { source: "projects/demo/new.wav", kind: "audio" },
      },
    } as ProjectVideoProps,
    90,
    env.root,
  );
  assert.deepEqual(
    mix.tracks.map((track) => [track.startSec, track.sourceEndSec]),
    [
      [0, 1],
      [2, 3],
      [1, 1],
    ],
  );
});
