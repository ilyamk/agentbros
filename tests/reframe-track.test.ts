import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  centreToPosition,
  cropSize,
  followFromTranscript,
  linkTracks,
  planCropPath,
  positionAt,
  retimeKeyframes,
  shotRanges,
  simplify,
  sliceKeyframes,
  smoothPath,
  type Detections,
} from "../src/lib/multicam/reframe";
import { applyEdit } from "../src/lib/timeline-ir/commands";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { modelRoot } from "../src/lib/multicam/models";
import { sha256File } from "../src/lib/multicam/media";
import { CropPathSchema } from "../src/types/multicam";

const repo = path.resolve(import.meta.dirname, "..");
const face = (cx: number, cy = 0.4, size = 0.1) => ({
  x: cx - size / 2,
  y: cy - size / 2,
  w: size,
  h: size * 1.3,
  score: 0.9,
});
/** 1920×1080 at 30 fps, one sample every 6 frames. */
function detections(
  frames: number,
  at: (frame: number) => { faces?: ReturnType<typeof face>[]; people?: ReturnType<typeof face>[] },
): Detections {
  const samples = [];
  for (let frame = 0; frame < frames; frame += 6)
    samples.push({ frame, faces: at(frame).faces ?? [], people: at(frame).people ?? [] });
  return { width: 1920, height: 1080, fps: 30, frameCount: frames, samples };
}

test("crop geometry and object-position conversion", () => {
  assert.deepEqual(cropSize(1920, 1080, "vertical"), { width: 9 / 16 / (16 / 9), height: 1, axis: "x" });
  assert.equal(cropSize(1920, 1080, "landscape").axis, null);
  assert.equal(cropSize(1080, 1920, "landscape").axis, "y");
  const w = cropSize(1920, 1080, "vertical").width;
  assert.equal(centreToPosition(w / 2, w), 0);
  assert.equal(centreToPosition(1 - w / 2, w), 1);
  assert.ok(Math.abs(centreToPosition(0.5, w) - 0.5) < 1e-12);
  assert.equal(centreToPosition(0.01, w), 0);
});

test("small subject motion inside the deadzone gives one stationary crop on the subject", () => {
  const plan = planCropPath({
    detections: detections(300, (frame) => ({ faces: [face(0.3 + 0.05 * Math.sin(frame / 20))] })),
    format: "vertical",
  });
  assert.equal(plan.shots.length, 1);
  assert.equal(plan.shots[0]!.mode, "stationary");
  assert.equal(plan.shots[0]!.subject, "face");
  assert.equal(plan.keyframes.length, 2);
  const expected = centreToPosition(0.3, plan.crop.width);
  assert.ok(Math.abs(plan.keyframes[0]!.x - expected) < 0.02, `${plan.keyframes[0]!.x} vs ${expected}`);
  assert.equal(plan.keyframes[0]!.y, 0.5);
});

test("a walk across the frame becomes a smooth pan that follows the subject", () => {
  const plan = planCropPath({
    detections: detections(300, (frame) => ({ faces: [face(0.15 + (0.7 * frame) / 299)] })),
    format: "vertical",
  });
  assert.equal(plan.shots[0]!.mode, "pan");
  const xs = Array.from({ length: 300 }, (_, frame) => positionAt(plan.keyframes, frame).x);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i]! >= xs[i - 1]! - 1e-6, "pan never reverses");
  for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i]! - xs[i - 1]!) < 0.02, "no jumps inside a shot");
  const centre = (frame: number) => xs[frame]! * (1 - plan.crop.width) + plan.crop.width / 2;
  assert.ok(Math.abs(centre(150) - (0.15 + (0.7 * 150) / 299)) < 0.06, "subject stays near the crop centre");
  assert.ok(plan.keyframes.length < 300, "keyframes are simplified");
});

test("moves under minMove are ignored; smoothing is non-causal", () => {
  const held = smoothPath([0.5, 0.52, 0.48, 0.53, 0.5], 0.05, 0);
  assert.deepEqual(held, [0.5, 0.5, 0.5, 0.5, 0.5]);
  const step = smoothPath([...Array(30).fill(0.2), ...Array(30).fill(0.8)], 0.05, 5);
  assert.ok(step[25]! > 0.21, "the camera starts moving before the jump");
  assert.ok(step[34]! < 0.79, "and settles after it");
  assert.deepEqual(simplify([0, 1, 2, 3, 4], 0.01), [0, 4]);
});

test("the path resets at shot boundaries and each shot chooses its own mode", () => {
  const det = detections(300, (frame) =>
    frame < 150 ? { faces: [face(0.25)] } : { faces: [face(0.2 + (0.6 * (frame - 150)) / 149)] },
  );
  const plan = planCropPath({
    detections: det,
    format: "vertical",
    shots: [
      { startFrame: 0, endFrame: 150 },
      { startFrame: 150, endFrame: 300 },
    ],
  });
  assert.deepEqual(
    plan.shots.map((shot) => shot.mode),
    ["stationary", "pan"],
  );
  const before = positionAt(plan.keyframes, 149).x;
  const at = positionAt(plan.keyframes, 150).x;
  assert.ok(Math.abs(before - centreToPosition(0.25, plan.crop.width)) < 0.01);
  assert.ok(
    Math.abs(at - before) > 0.0 || plan.keyframes.some((key) => key.frame === 150),
    "a keyframe starts the second shot",
  );
  assert.ok(plan.keyframes.some((key) => key.frame === 149) && plan.keyframes.some((key) => key.frame === 150));
});

test("people stand in when no face is found; nothing found keeps the centre", () => {
  const people = planCropPath({
    detections: detections(120, () => ({ people: [face(0.7, 0.5, 0.15)] })),
    format: "vertical",
  });
  assert.equal(people.shots[0]!.subject, "person");
  assert.ok(people.keyframes[0]!.x > 0.7);
  const none = planCropPath({ detections: detections(120, () => ({})), format: "vertical" });
  assert.deepEqual(
    none.keyframes.map((key) => key.x),
    [0.5, 0.5],
  );
  assert.equal(none.shots[0]!.subject, "none");
  assert.equal(none.shots[0]!.coverage, 0);
});

test("two faces that fit stay framed together; a follow point picks the speaker", () => {
  const two = detections(120, () => ({ faces: [face(0.42), face(0.58)] }));
  const together = planCropPath({ detections: two, format: "vertical" });
  assert.ok(Math.abs(together.keyframes[0]!.x - 0.5) < 0.02);
  const apart = detections(120, () => ({ faces: [face(0.2), face(0.8)] }));
  const followed = planCropPath({
    detections: apart,
    format: "vertical",
    follow: [{ startFrame: 0, endFrame: 120, x: 0.75, y: 0.4 }],
  });
  assert.equal(followed.shots[0]!.subject, "speaker");
  assert.ok(Math.abs(followed.keyframes[0]!.x - centreToPosition(0.8, followed.crop.width)) < 0.02);
});

test("a stray detection never moves the crop; with two people apart the heaviest face is held for the whole shot", () => {
  const scene = detections(240, (frame) => ({
    faces: [face(0.28, 0.4, 0.06), face(0.72, 0.4, 0.075), ...(frame % 30 === 0 ? [face(0.78, 0.06, 0.03)] : [])],
  }));
  const tracks = linkTracks(scene.samples.map((sample) => ({ frame: sample.frame, boxes: sample.faces })));
  assert.ok(tracks.length >= 3);
  const plan = planCropPath({ detections: scene, format: "vertical" });
  assert.equal(plan.shots[0]!.mode, "stationary");
  const centre = (x: number) => x * (1 - plan.crop.width) + plan.crop.width / 2;
  for (const key of plan.keyframes) assert.ok(Math.abs(centre(key.x) - 0.72) < 0.02, `centre ${centre(key.x)}`);
});

test("the subject's face stays inside the crop with a margin even when the deadzone holds the crop still", () => {
  const scene = detections(120, (frame) => ({ faces: [face(frame < 60 ? 0.12 : 0.25, 0.4, 0.08)] }));
  const plan = planCropPath({ detections: scene, format: "vertical", rules: { deadzone: 1 } });
  const left = plan.keyframes[0]!.x * (1 - plan.crop.width);
  for (const cx of [0.12, 0.25]) {
    assert.ok(
      cx - 0.04 >= left + 0.02 - 1e-6 && cx + 0.04 <= left + plan.crop.width - 0.02 + 1e-6,
      `face ${cx} outside crop from ${left}`,
    );
  }
});

test("wide shots (small faces) damp pans harder than close-ups", () => {
  const move = (size: number) =>
    detections(300, (frame) => ({
      faces: [face(0.3 + 0.4 * Math.min(1, frame / 150) + (frame % 12 === 0 ? 0.03 : 0), 0.4, size)],
    }));
  const speed = (plan: ReturnType<typeof planCropPath>) =>
    Math.max(
      ...plan.keyframes
        .slice(1)
        .map((key, i) => Math.abs(key.x - plan.keyframes[i]!.x) / (key.frame - plan.keyframes[i]!.frame)),
    );
  const close = planCropPath({ detections: move(0.12), format: "vertical" });
  const wide = planCropPath({ detections: move(0.04), format: "vertical" });
  assert.equal(close.shots[0]!.mode, "pan");
  assert.equal(wide.shots[0]!.mode, "pan");
  assert.ok(speed(wide) < speed(close) * 0.75, `wide ${speed(wide)} close ${speed(close)}`);
});

test("followFromTranscript turns diarised words into speaker turns, folding short interjections into the turn around them", () => {
  const word = (i: number, speaker: string, startSec: number, endSec: number, kind: "word" | "event" = "word") => ({
    id: `w${i}`,
    text: "x",
    kind,
    startSec,
    endSec,
    speaker,
    channel: null,
    confidence: null,
  });
  const transcript = {
    version: 1 as const,
    source: { file: "a.wav", sha256: "0".repeat(64), durationSec: 20 },
    engine: {
      provider: "elevenlabs" as const,
      model: "scribe_v3",
      verbatim: true,
      diarized: true,
      timing: "native" as const,
    },
    language: "en",
    speakers: [{ id: "speaker_0" }, { id: "speaker_1" }],
    words: [
      word(0, "speaker_0", 0, 2),
      word(1, "speaker_0", 2.1, 4),
      word(2, "speaker_1", 4.2, 4.6),
      word(3, "speaker_0", 4.8, 6),
      word(4, "speaker_1", 6.1, 6.4, "event"),
      word(5, "speaker_1", 7, 9),
      word(6, "speaker_1", 9.1, 12),
    ],
    sentences: [],
  };
  const follow = followFromTranscript(transcript, { speaker_0: 0.28, speaker_1: 0.72 }, 25);
  assert.deepEqual(
    follow.map((turn) => [turn.startFrame, turn.endFrame, turn.x]),
    [
      [0, 175, 0.28],
      [175, 300, 0.72],
    ],
  );
  const plan = planCropPath({
    detections: detections(360, () => ({ faces: [face(0.28), face(0.72)] })),
    format: "vertical",
    follow: followFromTranscript(transcript, { speaker_0: 0.28, speaker_1: 0.72 }, 30),
  });
  assert.equal(plan.shots[0]!.subject, "speaker");
  const centre = (x: number) => x * (1 - plan.crop.width) + plan.crop.width / 2;
  assert.ok(centre(plan.keyframes[0]!.x) < 0.4);
  assert.ok(centre(plan.keyframes.at(-1)!.x) > 0.6);
});

test("a speaker change inside a wide shot pans fully to the new speaker; a turn under a second at a shot start is skipped", () => {
  const scene = detections(450, () => ({ faces: [face(0.276, 0.4, 0.04), face(0.734, 0.4, 0.045)] }));
  const follow = [
    { startFrame: 0, endFrame: 15, x: 0.276, y: 0.3 },
    { startFrame: 15, endFrame: 150, x: 0.734, y: 0.3 },
    { startFrame: 150, endFrame: 330, x: 0.276, y: 0.3 },
    { startFrame: 330, endFrame: 450, x: 0.734, y: 0.3 },
  ];
  const plan = planCropPath({ detections: scene, format: "vertical", follow });
  const centre = (frame: number) => positionAt(plan.keyframes, frame).x * (1 - plan.crop.width) + plan.crop.width / 2;
  assert.ok(Math.abs(centre(0) - 0.734) < 0.01, `start ${centre(0)}`);
  assert.ok(Math.abs(centre(100) - 0.734) < 0.01);
  for (const frame of [170, 240, 320])
    assert.ok(Math.abs(centre(frame) - 0.276) < 0.01, `frame ${frame}: ${centre(frame)}`);
  assert.ok(Math.abs(centre(360) - 0.734) < 0.01);
});

/** A minimal valid FootageShotsSchema document (package D's shots.json). */
function footageShots(fps: number, ranges: [number, number][]) {
  const frames = ranges.at(-1)![1] + 1;
  return {
    schemaVersion: 1,
    source: { path: "in.mp4", analysedPath: "in.mp4", width: 1920, height: 1080, variableFrameRate: false },
    fps,
    frames,
    durationSec: frames / fps,
    detector: {
      engine: "reference",
      version: "test",
      fadeDetector: "none",
      refinement: "none",
      params: {},
      candidates: 0,
    },
    cuts: ranges.slice(1).map(([start]) => ({
      frame: start,
      type: "cut",
      startFrame: start,
      endFrame: start,
      confidence: 1,
      timeSec: start / fps,
      timecode: "00:00:00.000",
    })),
    shots: ranges.map(([startFrame, endFrame], i) => ({
      id: `s${String(i + 1).padStart(3, "0")}`,
      startFrame,
      endFrame,
      startSec: startFrame / fps,
      endSec: (endFrame + 1) / fps,
      durationFrames: endFrame - startFrame + 1,
      cleanStartFrame: startFrame,
      cleanEndFrame: endFrame,
      transitionIn: i ? "cut" : "start",
      timecode: "00:00:00.000",
    })),
    storyboard: [],
  };
}

const PORTRAIT = {
  url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Abraham_Lincoln_O-77_matte_collodion_print.jpg",
  sha256: "f5e79a35f74b54e0435dfc87f5956d6917725e2f5b8c17932ecf5bad704e29b2",
};
const modelGate = {
  skip:
    process.env.RUN_REFRAME_MODEL_TESTS === "1"
      ? false
      : "set RUN_REFRAME_MODEL_TESTS=1 (downloads YuNet and a public-domain portrait)",
  timeout: 900000,
} as const;

test(
  "real detector: YuNet tracks a moving public-domain portrait into a stationary then panning crop path",
  modelGate,
  async () => {
    const cache = path.join(modelRoot(), "reframe");
    mkdirSync(cache, { recursive: true });
    const portrait = path.join(cache, "portrait-lincoln-o77.jpg");
    if (!existsSync(portrait)) {
      const response = await fetch(PORTRAIT.url, { headers: { "user-agent": "ai-video-creator-tests/1.0" } });
      assert.ok(response.ok, `portrait download HTTP ${response.status}`);
      writeFileSync(portrait, Buffer.from(await response.arrayBuffer()));
    }
    assert.equal(sha256File(portrait), PORTRAIT.sha256);
    const dir = mkdtempSync(path.join(tmpdir(), "reframe-track-"));
    try {
      const video = path.join(dir, "walk.mp4");
      const overlayX = "if(lt(t,4),260+20*sin(t*3),260+(t-4)*330)";
      const ffmpeg = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=0x404850:s=1920x1080:r=30:d=8",
          "-i",
          portrait,
          "-filter_complex",
          `[1:v]scale=-2:420[p];[0:v][p]overlay=x='${overlayX}':y=300`,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          video,
        ],
        { encoding: "utf8" },
      );
      assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
      const shots = path.join(dir, "shots.json");
      writeFileSync(
        shots,
        JSON.stringify(
          footageShots(30, [
            [0, 119],
            [120, 239],
          ]),
        ),
      );
      const output = path.join(dir, "crop.json");
      const result = spawnSync(
        process.execPath,
        [
          path.join(repo, "node_modules/tsx/dist/cli.mjs"),
          path.join(repo, "scripts/reframe-track.ts"),
          "--input",
          video,
          "--format",
          "vertical",
          "--shots",
          shots,
          "--output",
          output,
          "--command-output",
          path.join(dir, "cmd.json"),
          "--clip-id",
          "walk",
        ],
        { encoding: "utf8", timeout: 900000, cwd: repo },
      );
      const envelope = JSON.parse(result.stdout.trim()) as { ok: boolean };
      assert.equal(envelope.ok, true, result.stdout + result.stderr);
      const crop = CropPathSchema.parse(JSON.parse(readFileSync(output, "utf8")));
      assert.deepEqual(
        crop.shots.map((shot) => shot.mode),
        ["stationary", "pan"],
      );
      assert.ok(
        crop.shots.every((shot) => shot.subject === "face" && shot.coverage > 0.8),
        JSON.stringify(crop.shots),
      );
      const portraitWidth = (420 * 2200) / 2835;
      const centreAt = (frame: number) => {
        const p = positionAt(crop.keyframes, frame).x;
        return p * (1 - crop.crop.width) + crop.crop.width / 2;
      };
      const truth = (frame: number) => {
        const t = frame / 30;
        return (t < 4 ? 260 + 20 * Math.sin(t * 3) : 260 + (t - 4) * 330) / 1920 + portraitWidth / 2 / 1920;
      };
      for (const frame of [60, 180, 230])
        assert.ok(
          Math.abs(centreAt(frame) - truth(frame)) < 0.08,
          `frame ${frame}: ${centreAt(frame)} vs ${truth(frame)}`,
        );
      const command = JSON.parse(readFileSync(path.join(dir, "cmd.json"), "utf8")) as {
        type: string;
        position: { keyframes: unknown[] };
      };
      assert.equal(command.type, "reframe-visual");
      assert.equal(command.position.keyframes.length, crop.keyframes.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("footage:shots from a late-starting stream map back to original-stream frames", () => {
  const late = footageShots(30, [
    [0, 41],
    [42, 161],
    [162, 311],
  ]);
  (late.source as Record<string, unknown>).startOffsetSec = 0.4;
  assert.deepEqual(shotRanges(late, 30), [
    { startFrame: 0, endFrame: 30 },
    { startFrame: 30, endFrame: 150 },
    { startFrame: 150, endFrame: 300 },
  ]);
  assert.deepEqual(shotRanges(late, 15), [
    { startFrame: 0, endFrame: 15 },
    { startFrame: 15, endFrame: 75 },
    { startFrame: 75, endFrame: 150 },
  ]);
  const padOnly = footageShots(30, [
    [0, 11],
    [12, 311],
  ]);
  (padOnly.source as Record<string, unknown>).startOffsetSec = 0.4;
  assert.deepEqual(shotRanges(padOnly, 30), [{ startFrame: 0, endFrame: 300 }], "a shot inside the padding disappears");
});

test("footage:shots ranges are inclusive and rescaled; plain lists are end-exclusive", () => {
  assert.deepEqual(
    shotRanges(
      footageShots(25, [
        [0, 49],
        [50, 74],
      ]),
      50,
    ),
    [
      { startFrame: 0, endFrame: 100 },
      { startFrame: 100, endFrame: 150 },
    ],
  );
  assert.deepEqual(shotRanges({ shots: [{ startFrame: 10, endFrame: 20 }] }, 30), [{ startFrame: 10, endFrame: 20 }]);
});

/** recording-edit's masterToDecodedFrame for a CFR source: master frame m shows the last decoded frame starting at or before it. */
function masterToDecoded(fps: number, decodedFrames: number): number[] {
  const masterFrames = Array.from({ length: decodedFrames }, (_, i) => Math.round((i / fps) * 30));
  const count = Math.ceil((decodedFrames / fps) * 30 - 1e-9);
  let decoded = 0;
  return Array.from({ length: count }, (_, master) => {
    while (decoded + 1 < decodedFrames && masterFrames[decoded + 1]! <= master) decoded++;
    return decoded;
  });
}

test("crop paths are re-keyed from 25 fps original frames to a recut's 30 fps master frames", () => {
  const keyframes = [
    { frame: 0, x: 0.2, y: 0.5 },
    { frame: 99, x: 0.2, y: 0.5 },
    { frame: 100, x: 0.8, y: 0.5 },
    { frame: 249, x: 0.4, y: 0.5 },
  ];
  const mapping = masterToDecoded(25, 250);
  const master = retimeKeyframes(keyframes, mapping);
  for (let m = 0; m < mapping.length; m++) {
    const expected = positionAt(keyframes, mapping[m]!).x;
    assert.ok(Math.abs(positionAt(master, m).x - expected) < 0.002, `master ${m}`);
  }
  assert.equal(positionAt(master, 119).x, 0.2);
  assert.equal(positionAt(master, 120).x, 0.8, "the shot step lands on master frame 120 (original frame 100)");
});

test(
  "reframe:track --recording-edit writes master-frame keyframes and refuses another file's recut",
  { skip: spawnSync("ffmpeg", ["-version"]).status === 0 ? false : "needs ffmpeg", timeout: 120000 },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reframe-recut-"));
    try {
      const video = path.join(dir, "talk.mp4");
      assert.equal(
        spawnSync("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=320x180:r=25:d=10",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          video,
        ]).status,
        0,
      );
      const det = detections(250, (frame) => ({ faces: [face(frame < 100 ? 0.2 : 0.8)] }));
      det.fps = 25;
      writeFileSync(path.join(dir, "det.json"), JSON.stringify(det));
      writeFileSync(
        path.join(dir, "shots.json"),
        JSON.stringify({
          shots: [
            { startFrame: 0, endFrame: 100 },
            { startFrame: 100, endFrame: 250 },
          ],
        }),
      );
      const edit = (sha256: string) =>
        JSON.stringify({
          request: { source: { sha256 } },
          normalization: { masterToDecodedFrame: masterToDecoded(25, 250) },
        });
      writeFileSync(path.join(dir, "recording-edit.json"), edit(sha256File(video)));
      writeFileSync(path.join(dir, "other.json"), edit("0".repeat(64)));
      const run = (recording: string) => {
        const result = spawnSync(
          process.execPath,
          [
            path.join(repo, "node_modules/tsx/dist/cli.mjs"),
            path.join(repo, "scripts/reframe-track.ts"),
            "--input",
            video,
            "--detections",
            path.join(dir, "det.json"),
            "--shots",
            path.join(dir, "shots.json"),
            "--output",
            path.join(dir, "crop.json"),
            "--command-output",
            path.join(dir, "cmd.json"),
            "--clip-id",
            "keep-1",
            "--recording-edit",
            path.join(dir, recording),
          ],
          { encoding: "utf8", cwd: repo, timeout: 120000 },
        );
        return JSON.parse(result.stdout.trim()) as { ok: boolean; message?: string };
      };
      assert.equal(run("recording-edit.json").ok, true);
      const command = JSON.parse(readFileSync(path.join(dir, "cmd.json"), "utf8")) as {
        position: { keyframes: { frame: number; x: number; y: number }[] };
      };
      const crop = CropPathSchema.parse(JSON.parse(readFileSync(path.join(dir, "crop.json"), "utf8")));
      assert.ok(Math.abs(positionAt(crop.keyframes, 100).x - positionAt(command.position.keyframes, 120).x) < 1e-3);
      assert.ok(Math.abs(positionAt(crop.keyframes, 99).x - positionAt(command.position.keyframes, 119).x) < 1e-3);
      assert.ok(
        Math.abs(positionAt(command.position.keyframes, 119).x - positionAt(command.position.keyframes, 120).x) > 0.5,
      );
      assert.match(run("other.json").message ?? "", /different file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("per-clip slices hold exactly the full path's values over each clip's source span", () => {
  const keyframes = [
    { frame: 0, x: 0.1, y: 0.5 },
    { frame: 50, x: 0.9, y: 0.5 },
    { frame: 99, x: 0.9, y: 0.5 },
    { frame: 100, x: 0.2, y: 0.5 },
    { frame: 300, x: 0.6, y: 0.5 },
  ];
  for (const [start, end] of [
    [20, 80],
    [90, 130],
    [100, 101],
    [250, 400],
  ] as const) {
    const slice = sliceKeyframes(keyframes, start, end);
    assert.ok(slice.length <= keyframes.length + 2);
    for (let frame = start; frame < end; frame++)
      assert.ok(
        Math.abs(positionAt(slice, frame).x - positionAt(keyframes, frame).x) < 1e-12,
        `${start}-${end} @${frame}`,
      );
  }
});

test(
  "reframe:track --timeline --clip-id all writes one sliced command per clip of this video",
  { skip: spawnSync("ffmpeg", ["-version"]).status === 0 ? false : "needs ffmpeg", timeout: 120000 },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reframe-clips-"));
    try {
      const video = path.join(dir, "wide.mp4");
      assert.equal(
        spawnSync("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=320x180:r=30:d=10",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          video,
        ]).status,
        0,
      );
      writeFileSync(
        path.join(dir, "det.json"),
        JSON.stringify(detections(300, (frame) => ({ faces: [face(0.15 + (0.7 * frame) / 299)] }))),
      );
      const own = `sha256:${sha256File(video)}`;
      const clip = (id: string, assetId: string, start: number, from: number, to: number) => ({
        id,
        assetId,
        start: { num: start, den: 1 },
        source: { start: { num: from, den: 1 }, end: { num: to, den: 1 }, timebase: { num: 30, den: 1 } },
        rate: { num: 1, den: 1 },
        transition: { kind: "cut" },
        captions: [],
      });
      const timeline = {
        version: 1,
        projectId: "demo",
        timebase: { num: 30, den: 1 },
        tracks: [
          {
            id: "multicam",
            kind: "visual",
            clips: [
              clip("m1", own, 0, 0, 90),
              clip("m2", "sha256:" + "e".repeat(64), 90, 90, 150),
              clip("m3", own, 150, 150, 300),
            ],
          },
        ],
      };
      const store = new TimelineEditStore(path.join(dir, "timeline-edit.json"));
      store.initialize(timeline as never);
      const result = spawnSync(
        process.execPath,
        [
          path.join(repo, "node_modules/tsx/dist/cli.mjs"),
          path.join(repo, "scripts/reframe-track.ts"),
          "--input",
          video,
          "--detections",
          path.join(dir, "det.json"),
          "--output",
          path.join(dir, "crop.json"),
          "--command-output",
          path.join(dir, "cmd.json"),
          "--track-id",
          "multicam",
          "--clip-id",
          "all",
          "--timeline",
          path.join(dir, "timeline-edit.json"),
        ],
        { encoding: "utf8", cwd: repo, timeout: 120000 },
      );
      assert.equal((JSON.parse(result.stdout.trim()) as { ok: boolean }).ok, true, result.stdout);
      const command = JSON.parse(readFileSync(path.join(dir, "cmd.json"), "utf8")) as {
        type: string;
        commands: { clipId: string; position: { keyframes: { frame: number; x: number; y: number }[] } }[];
      };
      assert.equal(command.type, "batch");
      assert.deepEqual(
        command.commands.map((item) => item.clipId),
        ["m1", "m3"],
      );
      const crop = CropPathSchema.parse(JSON.parse(readFileSync(path.join(dir, "crop.json"), "utf8")));
      for (const [item, from, to] of [
        [command.commands[0]!, 0, 90],
        [command.commands[1]!, 150, 300],
      ] as const) {
        assert.ok(item.position.keyframes.every((key) => key.frame >= from && key.frame < to));
        for (let frame = from; frame < to; frame++)
          assert.ok(
            Math.abs(positionAt(item.position.keyframes, frame).x - positionAt(crop.keyframes, frame).x) < 1e-9,
          );
      }
      const applied = applyEdit(store.read().timeline, command);
      assert.ok(applied.tracks[0]!.clips.find((item) => item.id === "m3")!.payload?.reframe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "--clip-id all with --recording-edit takes only clips cut from this video",
  { skip: spawnSync("ffmpeg", ["-version"]).status === 0 ? false : "needs ffmpeg", timeout: 120000 },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reframe-recut-all-"));
    try {
      const video = path.join(dir, "talk.mp4");
      assert.equal(
        spawnSync("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=320x180:r=25:d=10",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          video,
        ]).status,
        0,
      );
      const sha = sha256File(video);
      const det = detections(250, (frame) => ({ faces: [face(frame < 100 ? 0.2 : 0.8)] }));
      det.fps = 25;
      writeFileSync(path.join(dir, "det.json"), JSON.stringify(det));
      writeFileSync(
        path.join(dir, "recording-edit.json"),
        JSON.stringify({
          request: { source: { sha256: sha } },
          normalization: { masterToDecodedFrame: masterToDecoded(25, 250) },
        }),
      );
      const clip = (id: string, start: number, from: number, to: number, sourceHash: string) => ({
        id,
        assetId: "sha256:" + "d".repeat(64),
        start: { num: start, den: 1 },
        source: { start: { num: from, den: 1 }, end: { num: to, den: 1 }, timebase: { num: 30, den: 1 } },
        rate: { num: 1, den: 1 },
        transition: { kind: "cut" },
        captions: [],
        payload: { volume: 1, sourceHash, editHash: "e".repeat(64) },
      });
      const timeline = {
        version: 1,
        projectId: "demo",
        timebase: { num: 30, den: 1 },
        tracks: [
          {
            id: "recording-picture",
            kind: "visual",
            clips: [clip("k1", 0, 0, 100, sha), clip("k2", 100, 0, 60, "f".repeat(64)), clip("k3", 160, 150, 300, sha)],
          },
        ],
      };
      const store = new TimelineEditStore(path.join(dir, "timeline-edit.json"));
      store.initialize(timeline as never);
      const result = spawnSync(
        process.execPath,
        [
          path.join(repo, "node_modules/tsx/dist/cli.mjs"),
          path.join(repo, "scripts/reframe-track.ts"),
          "--input",
          video,
          "--detections",
          path.join(dir, "det.json"),
          "--output",
          path.join(dir, "crop.json"),
          "--command-output",
          path.join(dir, "cmd.json"),
          "--track-id",
          "recording-picture",
          "--clip-id",
          "all",
          "--timeline",
          path.join(dir, "timeline-edit.json"),
          "--recording-edit",
          path.join(dir, "recording-edit.json"),
        ],
        { encoding: "utf8", cwd: repo, timeout: 120000 },
      );
      assert.equal((JSON.parse(result.stdout.trim()) as { ok: boolean }).ok, true, result.stdout);
      const command = JSON.parse(readFileSync(path.join(dir, "cmd.json"), "utf8")) as {
        commands: { clipId: string }[];
      };
      assert.deepEqual(
        command.commands.map((item) => item.clipId),
        ["k1", "k3"],
      );
      applyEdit(store.read().timeline, command);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
