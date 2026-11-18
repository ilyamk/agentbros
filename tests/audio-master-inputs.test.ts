import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureAudioMasterInputs, assertAudioMasterInputs } from "../src/lib/audio/master-inputs";
import { validateTimeline } from "../src/lib/timeline-ir/compiler";
const r = (num: number, den = 1) => ({ num, den });
test("project inputs pin effective mix/source bytes/exact audio rationals, exclude visual/captions and relocate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "master-inputs-")),
    moved = mkdtempSync(path.join(tmpdir(), "master-moved-"));
  mkdirSync(path.join(root, "public/projects/demo"), { recursive: true });
  const source = path.join(root, "public/projects/demo/tone.wav");
  writeFileSync(source, "fingerprint fixture bytes, not decoded audio");
  const timeline = validateTimeline({
    version: 1,
    projectId: "demo",
    timebase: r(30000, 1001),
    tracks: [
      {
        id: "music",
        kind: "music",
        clips: [
          {
            id: "music",
            assetId: "projects/demo/tone.wav",
            start: r(0),
            source: { start: r(17), end: r(137), timebase: r(24) },
            rate: r(3, 2),
          },
        ],
      },
      { id: "visual", kind: "visual", clips: [] },
      { id: "captions", kind: "captions", clips: [] },
    ],
  });
  const plan = {
    version: 1,
    durationSec: 4,
    tracks: [{ source, role: "music", volume: 0.5, keyframes: [{ atSec: 1, volume: 0.25 }] }],
  };
  try {
    const original = captureAudioMasterInputs("demo", plan, timeline, root);
    assertAudioMasterInputs(original, captureAudioMasterInputs("demo", plan, timeline, root));
    for (const patch of [
      { volume: 0.4 },
      { loop: true },
      { rate: 2 },
      { sourceStartSec: 0.5 },
      { keyframes: [{ atSec: 1, volume: 0.1 }] },
    ])
      assert.throws(
        () =>
          assertAudioMasterInputs(
            original,
            captureAudioMasterInputs("demo", { ...plan, tracks: [{ ...plan.tracks[0], ...patch }] }, timeline, root),
          ),
        /inputs changed/,
      );
    const edited = structuredClone(timeline);
    edited.tracks[0].clips[0].start = r(1, 3);
    assert.throws(
      () => assertAudioMasterInputs(original, captureAudioMasterInputs("demo", plan, edited, root)),
      /inputs changed/,
    );
    const visual = structuredClone(timeline);
    visual.tracks[1].clips = [{ ...timeline.tracks[0].clips[0], id: "other", payload: { headline: "Changed visual" } }];
    visual.tracks[2].clips = [
      {
        ...timeline.tracks[0].clips[0],
        id: "words",
        captions: [{ id: "w", text: "New text", start: r(17), end: r(20) }],
      },
    ];
    assertAudioMasterInputs(original, captureAudioMasterInputs("demo", plan, visual, root));
    cpSync(path.join(root, "public"), path.join(moved, "public"), { recursive: true });
    assertAudioMasterInputs(
      original,
      captureAudioMasterInputs(
        "demo",
        { ...plan, tracks: [{ ...plan.tracks[0], source: path.join(moved, "public/projects/demo/tone.wav") }] },
        timeline,
        moved,
      ),
    );
    writeFileSync(source, "changed bytes, same supplied duration");
    assert.throws(
      () => assertAudioMasterInputs(original, captureAudioMasterInputs("demo", plan, timeline, root)),
      /inputs changed/,
    );
    assert.throws(() => captureAudioMasterInputs("other", plan, timeline, root), /binding/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});
