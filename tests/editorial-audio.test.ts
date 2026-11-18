import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { synthesizeSfx, attachSfxCues } from "../src/lib/audio/procedural";
import { analyzeRhythm } from "../src/lib/audio/rhythm";
import { adaptLegacyProject, compileTimelineIR } from "../src/lib/timeline-ir";
import { forecastToFinish } from "../src/lib/editorial/finish-plan";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { OperationStore } from "../src/lib/jobs/store";
import { USER_GRANT } from "./helpers/ceiling-grant";
const fixture = (t: test.TestContext) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sound-cues-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
test("five procedural sounds are deterministic decodable unclipped and cannot overwrite original takes", (t) => {
  const dir = fixture(t);
  for (const kind of ["click", "pop", "whoosh", "impact", "chime"] as const) {
    const first = path.join(dir, `${kind}.wav`),
      second = path.join(dir, `${kind}-same.wav`),
      spec = { kind, seed: 42, durationSec: 0.4 };
    const report = synthesizeSfx(first, spec);
    synthesizeSfx(second, spec);
    assert.deepEqual(readFileSync(first), readFileSync(second));
    assert.equal(report.measurement.present, true);
    assert.ok(report.samplePeak < 0.8);
    assert.ok(report.rms > 0);
    assert.equal(report.samples, 19200);
    assert.throws(() => synthesizeSfx(first, spec), /exists/);
  }
});
test("silence and steady tones fall back while regular impulses and reviewed overrides are evidenced", (t) => {
  const dir = fixture(t),
    silence = path.join(dir, "silence.wav"),
    pulse = path.join(dir, "pulse.wav");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "5", silence]);
  const quiet = analyzeRhythm(silence);
  assert.equal(quiet.tempoBpm, null);
  assert.deepEqual(quiet.beatCandidatesSec, []);
  assert.equal(quiet.fallback, "speech-story-rhythm");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='if(lt(mod(t,0.5),0.04),0.4*sin(2*PI*880*t),0)':s=16000:d=5",
    pulse,
  ]);
  const beats = analyzeRhythm(pulse);
  assert.ok(beats.confidence >= 0.65, JSON.stringify(beats));
  assert.ok(Math.abs(beats.tempoBpm! - 120) < 4);
  assert.equal(beats.automaticCuts, false);
  const override = analyzeRhythm(silence, {
    beatsSec: [0.3, 0.7],
    note: "speech emphasis",
    reviewedBy: "editor",
  });
  assert.deepEqual(override.beatCandidatesSec, [0.3, 0.7]);
  assert.throws(
    () =>
      analyzeRhythm(silence, {
        beatsSec: [5],
        note: "bad",
        reviewedBy: "editor",
      }),
    /inside audio/,
  );
});
test("semantic SFX cues follow clip source/output ownership and preserve speech tracks", () => {
  const ir = adaptLegacyProject(
      {
        name: "cue",
        productName: "cue",
        colors: {},
        musicVolume: 0,
        scenes: [{ id: "hook", text: "", visualType: "title", durationInFrames: 90 }],
      },
      "cue",
    ),
    before = structuredClone(ir);
  const visual = ir.tracks.find((track) => track.kind === "visual")!;
  const next = attachSfxCues(ir, [
    {
      id: "impact",
      event: "proof-reveal",
      trackId: visual.id,
      clipId: "hook",
      anchor: "start",
      offsetFrames: 30,
      assetId: "asset:impact",
      durationSec: 0.4,
    },
  ]);
  assert.deepEqual(ir, before);
  const clip = compileTimelineIR(next).tracks.find((track) => track.id === "cue:impact")!.clips[0];
  assert.deepEqual(clip.start, { num: 30, den: 1 });
  assert.deepEqual(clip.duration, { num: 12, den: 1 });
  assert.throws(
    () =>
      attachSfxCues(ir, [
        {
          id: "tail",
          event: "end",
          trackId: visual.id,
          clipId: "hook",
          anchor: "end",
          assetId: "asset:x",
          durationSec: 0.4,
        },
      ]),
    /outside delivery/,
  );
});
test("finish forecasts protect repair reserve, unknown prices and attempts without mutations", (t) => {
  const dir = fixture(t),
    store = new OperationStore("finish", { directory: dir });
  store.configure(
    {
      ceilingUsd: 10,
      maxJobUsd: 10,
      repairReserveFraction: 0.2,
    },
    USER_GRANT,
  );
  const quote = {
    currency: "USD" as const,
    lowUsd: 8.5,
    expectedUsd: 8.5,
    highUsd: 8.5,
    bounded: true as const,
    source: "explicit-user-bound",
    asOf: "2026-10-11",
    confidence: "user-bound" as const,
  };
  const before = readFileSync(store.file),
    report = forecastToFinish(store.snapshot(), [
      { id: "new", assetId: "shot", reason: "replace invalid shot", quote },
    ]);
  assert.equal(report.readyToPlan, false);
  assert.match(report.candidates[0].reasons.join(" "), /repair reserve/);
  assert.deepEqual(readFileSync(store.file), before);
  assert.equal(
    forecastToFinish(store.snapshot(), [{ id: "repair", assetId: "shot", reason: "repair", repair: true, quote }])
      .readyToPlan,
    true,
  );
  assert.equal(
    forecastToFinish(store.snapshot(), [{ id: "unknown", assetId: "shot", reason: "price pending", quote: null }])
      .estimatedRemainingHighUsd,
    null,
  );
});

test("event cue batch applies with revision ownership and undo restores speech untouched", (t) => {
  const dir = fixture(t),
    ir = adaptLegacyProject(
      {
        name: "cue",
        productName: "cue",
        colors: {},
        musicVolume: 0,
        scenes: [
          {
            id: "hook",
            text: "Do not trim.",
            visualType: "title",
            durationInFrames: 90,
          },
        ],
      },
      "cue",
    );
  const store = new TimelineEditStore(path.join(dir, "edit.json"));
  store.initialize(ir);
  const owner = ir.tracks.find((track) => track.kind === "visual")!;
  const planned = attachSfxCues(ir, [
    {
      id: "click",
      event: "feature",
      trackId: owner.id,
      clipId: "hook",
      anchor: "start",
      offsetFrames: 30,
      assetId: "asset:click",
      durationSec: 0.2,
    },
  ]);
  const command = {
    type: "batch",
    commands: planned.tracks.slice(ir.tracks.length).map((track) => ({ type: "add-track", track })),
  };
  const edited = store.apply(command, 0);
  assert.equal(edited.timeline.tracks.length, ir.tracks.length + 1);
  assert.throws(() => store.apply(command, 0), /revision conflict/);
  assert.deepEqual(store.undo(1).timeline, ir);
  assert.deepEqual(store.redo(2).timeline, planned);
});
