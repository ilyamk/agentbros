import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EditCommandSchema, type TimelineIR } from "../src/types/timeline";
import { applyEdit } from "../src/lib/timeline-ir/commands";
import { validateTimeline, compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { startReviewServer } from "../src/lib/review-ui/server";
import { audioClipTiming, mediaTiming } from "../src/lib/timeline-ir/render";
import { clipAudioGain, attenuateAudio } from "../src/lib/audio/clip-gain";
const r = (num: number, den = 1) => ({ num, den });
export function audioTimeline(): TimelineIR {
  return {
    version: 1,
    projectId: "demo",
    timebase: r(30),
    tracks: ["visual", "presenter", "voiceover", "captions", "music", "sfx"].map((kind) => ({
      id: kind,
      kind: kind as TimelineIR["tracks"][number]["kind"],
      clips: [
        {
          id: "clip",
          assetId: "original:" + kind,
          start: r(0),
          source: { start: r(0), end: r(90), timebase: r(30) },
          rate: r(1),
          transition: { kind: "cut" },
          captions: [{ id: "word", text: "Original speech", start: r(5), end: r(25) }],
          payload: { volume: 0.4, loop: true, custom: { keep: true } },
        },
      ],
    })),
    legacyProject: { custom: "preserve" },
  };
}
function setup(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "review-mix-")),
    project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
  store.initialize(audioTimeline());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, store };
}
test("strict gain/loop commands preserve all protected tracks and source mappings; reset removes only owned fields", () => {
  const before = audioTimeline();
  const after = applyEdit(before, {
    type: "batch",
    commands: [
      { type: "audio-gain", trackId: "music", clipId: "clip", gain: 0 },
      { type: "audio-loop", trackId: "sfx", clipId: "clip", loop: false },
    ],
  });
  assert.equal(after.tracks[4].clips[0].payload!.audioGain, 0);
  assert.equal(after.tracks[5].clips[0].payload!.loop, false);
  assert.deepEqual(after.tracks.slice(0, 4), before.tracks.slice(0, 4));
  assert.deepEqual(before, audioTimeline());
  for (let i = 4; i < 6; i++) {
    const a = after.tracks[i].clips[0],
      b = before.tracks[i].clips[0];
    assert.deepEqual({ ...a, payload: b.payload }, b);
  }
  assert.deepEqual(
    compileTimelineIR(after).tracks.map((t) => t.clips.map((c) => c.captions)),
    compileTimelineIR(before).tracks.map((t) => t.clips.map((c) => c.captions)),
  );
  const reset = applyEdit(after, {
    type: "batch",
    commands: [
      { type: "audio-gain", trackId: "music", clipId: "clip", gain: null },
      { type: "audio-loop", trackId: "sfx", clipId: "clip", loop: null },
    ],
  });
  assert.equal("audioGain" in reset.tracks[4].clips[0].payload!, false);
  assert.equal("loop" in reset.tracks[5].clips[0].payload!, false);
  assert.deepEqual(reset.tracks[4], before.tracks[4]);
  assert.deepEqual(reset.legacyProject, before.legacyProject);
});
test("nonfinite/out-of-range/arbitrary patches and cross-kind edits fail atomically", () => {
  const before = audioTimeline();
  for (const gain of [-1, 1.001, NaN, Infinity, "0", undefined])
    assert.equal(
      EditCommandSchema.safeParse({ type: "audio-gain", trackId: "music", clipId: "clip", gain }).success,
      false,
    );
  for (const loop of [0, "true", undefined])
    assert.equal(
      EditCommandSchema.safeParse({ type: "audio-loop", trackId: "sfx", clipId: "clip", loop }).success,
      false,
    );
  assert.equal(
    EditCommandSchema.safeParse({
      type: "audio-gain",
      trackId: "music",
      clipId: "clip",
      gain: 0.5,
      payload: { allowSpeechTrim: true },
    }).success,
    false,
  );
  for (const trackId of ["visual", "presenter", "voiceover", "captions"])
    for (const command of [
      { type: "audio-gain", gain: 0 },
      { type: "audio-loop", loop: true },
    ])
      assert.throws(() => applyEdit(before, { ...command, trackId, clipId: "clip" }), /music\/SFX/);
  assert.throws(() =>
    applyEdit(before, {
      type: "batch",
      commands: [
        { type: "audio-gain", trackId: "music", clipId: "clip", gain: 0 },
        { type: "audio-loop", trackId: "voiceover", clipId: "clip", loop: true },
      ],
    }),
  );
  assert.deepEqual(before, audioTimeline());
  for (const gain of [Infinity, -1, "0"]) {
    const corrupt = audioTimeline();
    corrupt.tracks[4].clips[0].payload!.audioGain = gain;
    assert.throws(() => validateTimeline(corrupt), /gain/);
  }
  const speech = audioTimeline();
  speech.tracks[2].clips[0].payload!.audioGain = 0;
  assert.throws(() => validateTimeline(speech), /music\/SFX/);
});
test("journal dry run, restart, CAS, undo/redo and legacy absent gain preserve exact originals", (t) => {
  const { store } = setup(t),
    original = store.read(),
    bytes = readFileSync(store.file);
  const command = { type: "audio-gain", trackId: "music", clipId: "clip", gain: 0.25 };
  store.dryRun(command, 0);
  assert.deepEqual(readFileSync(store.file), bytes);
  const changed = store.apply(command, 0);
  const restarted = new TimelineEditStore(store.file);
  assert.deepEqual(restarted.read(), changed);
  assert.throws(() => restarted.apply(command, 0), /revision conflict/);
  assert.deepEqual(restarted.undo(1).timeline, original.timeline);
  assert.deepEqual(restarted.redo(2).timeline, changed.timeline);
  assert.equal(clipAudioGain(original.timeline.tracks[4].clips[0].payload), 1);
  assert.equal(attenuateAudio(original.timeline.tracks[4].clips[0].payload, 0.4), 0.4);
  assert.equal(attenuateAudio(changed.timeline.tracks[4].clips[0].payload, 0.4), 0.1);
});
test("authenticated HTTP music/SFX edits and stale/conflicting/invalid requests preserve protected tracks", async (t) => {
  const { root, store } = setup(t),
    app = await startReviewServer({ projectId: "demo", rootDir: root });
  t.after(() => app.close());
  const send = (route: string, body: unknown, token = app.token) =>
    fetch(app.origin + route, {
      method: "POST",
      headers: { "x-review-token": token, origin: app.origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const original = store.read(),
    command = { type: "audio-gain", trackId: "music", clipId: "clip", gain: 0 };
  assert.equal((await send("/api/mutate", { action: "edit", expectedRevision: 0, command }, "wrong")).status, 403);
  assert.equal((await send("/api/dry-run", { expectedRevision: 0, command })).status, 200);
  assert.deepEqual(store.read(), original);
  const response = await send("/api/mutate", { action: "edit", expectedRevision: 0, command });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tracks[4].clips[0].payload.audioGain, 0);
  assert.equal((await send("/api/mutate", { action: "edit", expectedRevision: 0, command })).status, 409);
  assert.equal(
    (await send("/api/mutate", { action: "edit", expectedRevision: 1, command: { ...command, trackId: "voiceover" } }))
      .status,
    400,
  );
  assert.equal((await send("/api/dry-run", { expectedRevision: 1, command: { ...command, gain: 2 } })).status, 400);
  assert.deepEqual(store.read().timeline.tracks.slice(0, 4), original.timeline.tracks.slice(0, 4));
  assert.equal((await send("/api/mutate", { action: "undo", expectedRevision: 1 })).status, 200);
  assert.deepEqual(store.read().timeline, original.timeline);
});

test("new loop edits reject unsupported nonzero source origin; legacy origins remain readable and zero-origin cycle keeps exact rate/span", () => {
  const ir = audioTimeline();
  ir.tracks[4].clips[0].source.start = r(15);
  assert.deepEqual(validateTimeline(ir), ir);
  assert.throws(
    () => applyEdit(ir, { type: "audio-loop", trackId: "music", clipId: "clip", loop: true }),
    /zero source origin/,
  );
  assert.equal(
    applyEdit(ir, { type: "audio-loop", trackId: "music", clipId: "clip", loop: false }).tracks[4].clips[0].payload!
      .loop,
    false,
  );
  const source = { start: r(0), end: r(180), timebase: r(30000, 1001) };
  assert.deepEqual(audioClipTiming(source, r(3, 2), 30, true), {
    trimBefore: 0,
    trimAfter: undefined,
    playbackRate: 1.5,
  });
  assert.deepEqual(
    audioClipTiming({ ...source, start: r(15) }, r(3, 2), 30, true),
    mediaTiming({ ...source, start: r(15) }, r(3, 2), 30),
  );
  assert.deepEqual(audioClipTiming(source, r(3, 2), 30, false), mediaTiming(source, r(3, 2), 30));
});
