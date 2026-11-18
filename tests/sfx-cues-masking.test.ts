import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeWav } from "../src/lib/audio/sfx-synth";
import { LocalAudioMixSchema } from "../src/types/audio-master";

const ROOT = path.resolve(import.meta.dirname, "..");
const RATE = 44100;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** Steady band noise 1–2.2 kHz: masks a 1.5 kHz tick. */
function bandNoise(seconds: number, amplitude: number): Float32Array {
  const partials = Array.from({ length: 40 }, (_, index) => ({ hz: 1000 * 2.2 ** (index / 39), phase: index * 2.399 }));
  return Float32Array.from(
    { length: Math.round(seconds * RATE) },
    (_, index) =>
      (amplitude / Math.sqrt(40)) *
      partials.reduce((sum, partial) => sum + Math.sin((2 * Math.PI * partial.hz * index) / RATE + partial.phase), 0),
  );
}
const tick = Float32Array.from(
  { length: Math.round(0.05 * RATE) },
  (_, index) => 0.05 * Math.sin((2 * Math.PI * 1500 * index) / RATE) * Math.exp(-index / (0.01 * RATE)),
);

const sfxCues = (dir: string, ...extra: string[]) =>
  spawnSync(
    path.join(ROOT, "node_modules/.bin/tsx"),
    [
      path.join(ROOT, "scripts/sfx-cues.ts"),
      "--placements",
      "placements.json",
      "--output",
      "cues.json",
      "--pack",
      "public/pack",
      "--no-library",
      "--no-fetch",
      "--fix-masking",
      ...extra,
    ],
    { cwd: dir, encoding: "utf8" },
  );

function workspace(musicStartSec: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "sfx-cues-masking-"));
  mkdirSync(path.join(dir, "public/pack"), { recursive: true });
  writeFileSync(path.join(dir, "public/pack/tick.wav"), encodeWav(tick, RATE));
  writeFileSync(
    path.join(dir, "public/pack/pack.json"),
    JSON.stringify({
      schemaVersion: 1,
      licence: "test",
      generator: "test",
      entries: [
        {
          kind: "tick",
          file: "tick.wav",
          seed: 1,
          rootHz: 55,
          alignSec: 0,
          durationSec: 0.05,
          peakDb: -26,
          rmsDb: -36,
          centroidHz: 1500,
          sha256: "0".repeat(64),
        },
      ],
    }),
  );
  writeFileSync(path.join(dir, "music.wav"), encodeWav(bandNoise(3, 0.8), RATE));
  writeFileSync(
    path.join(dir, "placements.json"),
    JSON.stringify({
      fps: 30,
      durationInFrames: 120,
      blocks: [
        {
          id: "probe",
          startFrame: 0,
          cues: [{ frame: 75, kind: "click", sfx: "tick", weight: "support", label: "buried tick" }],
        },
      ],
    }),
  );
  writeFileSync(
    path.join(dir, "plan.json"),
    JSON.stringify({
      version: 1,
      durationSec: 4,
      tracks: [{ source: "music.wav", role: "music", startSec: musicStartSec, volume: 0.8, keyframes: [] }],
    }),
  );
  const run = spawnSync(
    path.join(ROOT, "node_modules/.bin/tsx"),
    [
      path.join(ROOT, "scripts/sfx-cues.ts"),
      "--placements",
      "placements.json",
      "--output",
      "cues.json",
      "--pack",
      "public/pack",
      "--no-library",
      "--no-fetch",
      "--fix-masking",
      "--merge",
      "plan.json",
      "--plan-output",
      "plan-out.json",
    ],
    { cwd: dir, encoding: "utf8" },
  );
  return { dir, run };
}

test(
  "sfx:cues --fix-masking reads the music from the merged plan, raises the buried tick and ducks the music track in the plan",
  { skip: hasFfmpeg ? false : "ffmpeg not installed" },
  () => {
    const { dir, run } = workspace(0.5);
    try {
      const result = JSON.parse(
        run.stdout.trim().split("\n").at(-1) || JSON.stringify({ ok: false, stderr: run.stderr.slice(-800) }),
      );
      assert.equal(result.ok, true, run.stderr || run.stdout);
      assert.equal(result.metadata.masking.masked, 1);
      assert.equal(result.metadata.maskingAssumed.from, "plan");
      assert.equal(result.metadata.maskingAssumed.musicStartSec, "plan");
      const cues = JSON.parse(readFileSync(path.join(dir, "cues.json"), "utf8"));
      assert.ok(cues.events[0].gain > 0.08 && cues.events[0].gain <= 0.2, `gain ${cues.events[0].gain}`);
      const plan = LocalAudioMixSchema.parse(JSON.parse(readFileSync(path.join(dir, "plan-out.json"), "utf8")));
      const music = plan.tracks.find((track) => track.role === "music")!;
      assert.ok(music.keyframes.length >= 4, "the duck reaches the plan as keyframes");
      const ducked = music.keyframes.filter((frame) => frame.volume < 0.8 - 1e-6);
      assert.ok(
        ducked.length >= 2 && ducked.every((frame) => frame.atSec >= 2.3 && frame.atSec <= 2.65),
        JSON.stringify(music.keyframes),
      );
      assert.ok(Math.min(...ducked.map((frame) => frame.volume)) < 0.8 * 10 ** (-1 / 20));
      assert.equal(music.keyframes[0]!.volume, 0.8);
      assert.equal(music.keyframes.at(-1)!.volume, 0.8);
      assert.ok(plan.tracks.some((track) => track.role === "sfx"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "the plan's startSec is honoured: music that starts after the cue masks nothing and nothing is ducked",
  { skip: hasFfmpeg ? false : "ffmpeg not installed" },
  () => {
    const { dir, run } = workspace(3);
    try {
      const result = JSON.parse(
        run.stdout.trim().split("\n").at(-1) || JSON.stringify({ ok: false, stderr: run.stderr.slice(-800) }),
      );
      assert.equal(result.ok, true, run.stderr || run.stdout);
      assert.equal(result.metadata.masking.masked, 0);
      const plan = LocalAudioMixSchema.parse(JSON.parse(readFileSync(path.join(dir, "plan-out.json"), "utf8")));
      assert.deepEqual(plan.tracks.find((track) => track.role === "music")!.keyframes, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a rerun in place gives the same plan: last run's ducks and sfx tracks are replaced, the track's own keyframes kept",
  { skip: hasFfmpeg ? false : "ffmpeg not installed" },
  () => {
    const { dir } = workspace(0.5);
    try {
      const own = [
        { atSec: 2.5, volume: 0.7 },
        { atSec: 3.5, volume: 0.6 },
      ];
      writeFileSync(
        path.join(dir, "plan.json"),
        JSON.stringify({
          version: 1,
          durationSec: 4,
          tracks: [{ source: "music.wav", role: "music", startSec: 0.5, volume: 0.8, keyframes: own }],
        }),
      );
      const runs = [1, 2, 3].map(() => {
        const run = sfxCues(dir, "--merge", "plan.json", "--plan-output", "plan.json");
        assert.equal(run.status, 0, run.stderr || run.stdout);
        return readFileSync(path.join(dir, "plan.json"), "utf8");
      });
      assert.equal(runs[1], runs[0]);
      assert.equal(runs[2], runs[0]);
      const plan = LocalAudioMixSchema.parse(JSON.parse(runs[0]!));
      assert.equal(plan.tracks.filter((track) => track.role === "sfx").length, 1);
      const music = plan.tracks.find((track) => track.role === "music")!;
      assert.ok(
        music.keyframes.some((frame) => frame.source === "fix-masking"),
        "the duck is tagged",
      );
      const scaled = music.keyframes.find((frame) => frame.atSec === 2.5)!;
      assert.equal(scaled.baseVolume, 0.7, "the track's own keyframe inside the duck keeps its original volume");
      assert.ok(scaled.volume < 0.7);
      assert.deepEqual(
        music.keyframes.find((frame) => frame.atSec === 3.5),
        { atSec: 3.5, volume: 0.6 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// --- Decisions: with a motion plan or cue sheet, every cut is a sound or a silence with its reason ---

function decisionWorkspace(cues: Record<string, unknown>[]) {
  const { dir } = workspace(0.5);
  const shot = (id: string, startFrame: number) => ({
    id,
    startFrame,
    durationFrames: 40,
    intent: "x",
    subject: "x",
    framing: "x",
    camera: "x",
    composition: "x",
    entrance: "x",
    exit: "x",
    curve: "x",
    route: "remotion",
  });
  writeFileSync(
    path.join(dir, "motion-plan.json"),
    JSON.stringify({ schemaVersion: 1, projectId: "p", fps: 30, shots: [shot("a", 0), shot("b", 40), shot("c", 80)] }),
  );
  writeFileSync(
    path.join(dir, "cue-sheet.json"),
    JSON.stringify({
      schemaVersion: 1,
      fps: 30,
      audioMapPath: "x",
      musicOffsetSec: 0,
      cues: cues.map((cue) => ({
        intentSec: (cue.frame as number) / 30,
        snap: "none",
        snappedSec: (cue.frame as number) / 30,
        deltaSec: 0,
        kind: "cut",
        ...cue,
      })),
    }),
  );
  writeFileSync(
    path.join(dir, "placements.json"),
    JSON.stringify({
      fps: 30,
      durationInFrames: 120,
      blocks: [{ id: "probe", startFrame: 0, cues: [{ frame: 40, kind: "cut", sfx: "tick", weight: "hero" }] }],
    }),
  );
  const run = spawnSync(
    path.join(ROOT, "node_modules/.bin/tsx"),
    [
      path.join(ROOT, "scripts/sfx-cues.ts"),
      "--placements",
      "placements.json",
      "--output",
      "cues.json",
      "--pack",
      "public/pack",
      "--no-library",
      "--no-fetch",
      "--motion-plan",
      "motion-plan.json",
      "--cue-sheet",
      "cue-sheet.json",
    ],
    { cwd: dir, encoding: "utf8" },
  );
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, run.stdout + run.stderr);
  return { dir, run, json: JSON.parse(lines[0]!) };
}

test("sfx:cues blocks an undecided cut, naming its frame and shot", () => {
  const { dir, run, json } = decisionWorkspace([{ id: "to-b", frame: 40, shotId: "b", sfx: "tick" }]);
  try {
    assert.equal(run.status, 1);
    assert.equal(json.error, "VALIDATION");
    assert.match(json.message, /cut @80 \(c\)/);
    assert.match(json.message, /silent/);
    assert.equal(json.details.undecided.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sfx:cues places decided sounds, records a deliberate silence, and the silence mutes the block's own sound there", () => {
  const { dir, run, json } = decisionWorkspace([
    { id: "to-b", frame: 40, shotId: "b", silent: { reason: "the beat drops out; the cut lands dry" } },
    { id: "to-c", frame: 80, shotId: "c", sfx: "tick" },
  ]);
  try {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(json.metadata.decided.silent, 1);
    const sheet = JSON.parse(readFileSync(path.join(dir, "cues.json"), "utf8"));
    assert.deepEqual(
      sheet.events.map((event: { cueFrame: number; sfx: string }) => [event.cueFrame, event.sfx]),
      [[80, "tick"]],
    );
    assert.deepEqual(
      sheet.silences.map((item: { cueFrame: number }) => item.cueFrame),
      [40],
    );
    assert.deepEqual(
      sheet.decisions.map((event: { frame: number; state: string }) => [event.frame, event.state]),
      [
        [40, "silent"],
        [80, "sound"],
      ],
    );
    assert.ok(
      sheet.dropped.some(
        (item: { cueFrame: number; reason: string }) => item.cueFrame === 40 && /decided silent/.test(item.reason),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
