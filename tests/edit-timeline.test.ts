import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  applyEdit,
  compileTimelineIR,
  TimelineEditStore,
  RevisionConflict,
  adaptLegacyProject,
  migrateTimeline,
  sourceToOutput,
  outputToSource,
} from "../src/lib/timeline-ir";
import type { TimelineIR, TimelineClip } from "../src/types/timeline";
const r = (num: number, den = 1) => ({ num, den });
const clip = (id: string, start: number): TimelineClip => ({
  id,
  assetId: `asset:${id}`,
  start: r(start),
  source: { start: r(0), end: r(100), timebase: r(30) },
  rate: r(1),
  transition: { kind: "cut" },
  captions: [{ id: "word", text: "test", start: r(20), end: r(40) }],
});
const fixture = (): TimelineIR => ({
  version: 1,
  projectId: "test",
  timebase: r(30),
  tracks: [
    { id: "visual", kind: "visual", clips: [clip("a", 0), clip("b", 100)] },
    { id: "audio", kind: "voiceover", clips: [clip("speech", 0)] },
  ],
  customExtension: { keep: true },
});
test("trim and playback rate map captions exactly; untouched tracks survive", () => {
  const before = fixture();
  const edited = applyEdit(before, {
    type: "batch",
    commands: [
      { type: "trim", trackId: "visual", clipId: "a", start: r(30), end: r(90) },
      { type: "rate", trackId: "visual", clipId: "a", rate: r(3, 2) },
    ],
  });
  const snapshot = compileTimelineIR(edited),
    a = snapshot.tracks[0].clips[0];
  assert.deepEqual(a.duration, r(40));
  assert.deepEqual(a.captions[0].start, r(0));
  assert.deepEqual(a.captions[0].end, r(20, 3));
  assert.deepEqual(edited.tracks[1], before.tracks[1]);
  assert.deepEqual(before, fixture());
  assert.deepEqual(edited.customExtension, { keep: true });
  assert.deepEqual(
    outputToSource(
      edited.tracks[0].clips[0],
      sourceToOutput(edited.tracks[0].clips[0], r(50), edited.timebase),
      edited.timebase,
    ),
    r(50),
  );
});
test("split preserves source coverage and exact caption mapping at noninteger source frames", () => {
  const edited = applyEdit(fixture(), {
    type: "batch",
    commands: [
      { type: "rate", trackId: "visual", clipId: "a", rate: r(3, 2) },
      { type: "split", trackId: "visual", clipId: "a", at: r(15), newClipId: "right" },
    ],
  });
  const a = edited.tracks[0].clips.find((c) => c.id === "a")!,
    b = edited.tracks[0].clips.find((c) => c.id === "right")!;
  assert.deepEqual(a.source.end, r(45, 2));
  assert.deepEqual(b.source.start, r(45, 2));
  assert.deepEqual(b.start, r(15));
  const snapshot = compileTimelineIR(edited);
  const captions = snapshot.tracks[0].clips.flatMap((c) => c.captions);
  assert.deepEqual(captions.find((c) => c.start.num === 15)?.end, r(80, 3));
});
test("ripple is explicit and targets only one track", () => {
  const before = fixture();
  const after = applyEdit(before, { type: "ripple", trackId: "visual", from: r(100), delta: r(30) });
  assert.deepEqual(after.tracks[0].clips[1].start, r(130));
  assert.deepEqual(after.tracks[1], before.tracks[1]);
  assert.throws(() => applyEdit(before, { type: "move", trackId: "visual", clipId: "b", start: r(50) }), /Overlapping/);
});
test("fade is bounded to adjacent visual clips and cannot crossfade speech", () => {
  const fade = applyEdit(fixture(), {
    type: "transition",
    trackId: "visual",
    clipId: "a",
    transition: { kind: "fade", duration: r(12) },
  });
  assert.equal(compileTimelineIR(fade).durationInFrames, 200);
  assert.throws(
    () => applyEdit(fade, { type: "trim", trackId: "visual", clipId: "a", start: r(0), end: r(5) }),
    /Invalid transition/,
  );
  assert.throws(() =>
    applyEdit(fixture(), {
      type: "transition",
      trackId: "audio",
      clipId: "speech",
      transition: { kind: "fade", duration: r(12) },
    }),
  );
  assert.throws(() =>
    applyEdit(fixture(), {
      type: "transition",
      trackId: "visual",
      clipId: "b",
      transition: { kind: "fade", duration: r(12) },
    }),
  );
});
test("invalid bindings, rates, caption patches and unknown commands fail without mutation", () => {
  const before = fixture();
  assert.throws(() => applyEdit(before, { type: "rate", trackId: "missing", clipId: "a", rate: r(1) }));
  assert.throws(() => applyEdit(before, { type: "rate", trackId: "visual", clipId: "missing", rate: r(1) }));
  assert.throws(() => applyEdit(before, { type: "rate", trackId: "visual", clipId: "a", rate: r(0) }));
  assert.throws(() =>
    applyEdit(before, {
      type: "captions",
      trackId: "visual",
      clipId: "a",
      captions: [{ id: "bad", text: "bad", start: r(5), end: r(2) }],
    }),
  );
  assert.throws(() => applyEdit(before, { type: "delete-all" }));
  assert.deepEqual(before, fixture());
  const replaced = applyEdit(before, {
    type: "replace",
    trackId: "visual",
    clipId: "a",
    assetId: "sha256:new",
    source: clip("new", 0).source,
  });
  assert.equal(replaced.tracks[0].clips[0].assetId, "sha256:new");
  assert.deepEqual(replaced.tracks[0].clips[0].captions, []);
});
test("atomic journal: dry-run, exact undo/redo, stale revisions and locking", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "timeline-journal-"));
  try {
    const file = path.join(dir, "nested", "timeline.json"),
      store = new TimelineEditStore(file),
      other = new TimelineEditStore(file);
    store.initialize(fixture());
    const bytes = readFileSync(file, "utf8");
    const command = { type: "move", trackId: "visual", clipId: "b", start: r(150) };
    store.dryRun(command, 0);
    assert.equal(readFileSync(file, "utf8"), bytes);
    const result = store.apply(command, 0);
    assert.equal(result.revision, 1);
    assert.throws(() => other.apply(command, 0), RevisionConflict);
    const undo = store.undo(1);
    assert.deepEqual(undo.timeline, fixture());
    assert.equal(undo.revision, 2);
    const redo = store.redo(2);
    assert.deepEqual(redo.timeline, result.timeline);
    assert.equal(redo.revision, 3);
    assert.deepEqual(applyEdit(result.undo[0].before, result.undo[0].command), result.undo[0].after);
    writeFileSync(file + ".lock", "external editor");
    assert.throws(() => store.undo(3), /locked/);
    assert.equal(store.read().revision, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("legacy import preserves extension fields and daily-practice source windows; future versions fail", () => {
  const raw = JSON.parse(
    readFileSync(new URL("./fixtures/legacy/daily-practice/project.json", import.meta.url), "utf8"),
  );
  raw.extension = { future: true };
  raw.scenes[0].futureSceneField = "keep";
  const ir = adaptLegacyProject(raw, "daily-practice"),
    snapshot = compileTimelineIR(ir);
  assert.deepEqual(ir.legacyProject, raw);
  assert.equal((ir.tracks[0].clips[0].payload!.scene as Record<string, unknown>).futureSceneField, "keep");
  assert.equal(snapshot.durationInFrames, 450);
  assert.equal(
    ir.tracks.some((t) => t.kind === "voiceover"),
    false,
  );
  assert.deepEqual(migrateTimeline(ir), ir);
  assert.throws(() => migrateTimeline({ ...ir, version: 2 }), /Unsupported/);
});
test("compiled snapshots cannot mutate the authored IR", () => {
  const ir = fixture(),
    snapshot = compileTimelineIR(ir);
  assert.equal(Object.isFrozen(snapshot.tracks[0].clips[0]), true);
  assert.throws(() => {
    snapshot.tracks[0].clips[0].start.num = 500;
  });
  assert.deepEqual(ir, fixture());
});
