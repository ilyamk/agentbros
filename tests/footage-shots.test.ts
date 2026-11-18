import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CFR_FILTER,
  frameRateIsVariable,
  originalStreamFrame,
  frameTimecode,
  normaliseToCfr,
  probeFrameRates,
  shotsFromCuts,
  toReferenceBoundaries,
  TRANSNET_DEVICE,
  workerArgs,
} from "../src/lib/footage/shots";
import { FootageShotsSchema, type FootageCut, type FootageShots } from "../src/types/footage-shots";
import { decodeFrames, probeVideo } from "../src/lib/vision/media";
import {
  makeLateStartFixture,
  makeShotsFixture,
  makeVariableRateFixture,
  SHOTS_FIXTURE,
} from "./fixtures/footage-shots-video";

const repo = path.resolve(import.meta.dirname, "..");
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
const hasUv = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;
const media = { skip: hasFfmpeg ? false : "needs ffmpeg", timeout: 120000 } as const;
const worker = { skip: hasUv && hasFfmpeg ? false : "needs uv and ffmpeg", timeout: 900000 } as const;
const model = {
  skip:
    process.env.RUN_SHOTS_MODEL_TESTS === "1" && hasUv && hasFfmpeg
      ? false
      : "set RUN_SHOTS_MODEL_TESTS=1 (downloads torch and transnetv2-pytorch, about 110 MB)",
  timeout: 1800000,
} as const;

function scratch(t: { after: (fn: () => void) => void }): string {
  const directory = mkdtempSync(path.join(tmpdir(), "footage-shots-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(
    path.join(repo, "node_modules/.bin/tsx"),
    [path.join(repo, "scripts/footage-shots.ts"), ...args],
    { cwd: repo, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024, timeout: 1800000 },
  );
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  return { status: result.status, json: JSON.parse(line), stderr: result.stderr };
}

const cut = (frame: number, type: FootageCut["type"] = "cut", startFrame = frame, endFrame = frame): FootageCut => ({
  frame,
  type,
  startFrame,
  endFrame,
  confidence: 0.9,
  timeSec: frame / 30,
  timecode: frameTimecode(frame, 30),
});

test("TransNetV2 is pinned and always runs on CPU, because MPS gives different boundaries", () => {
  assert.equal(TRANSNET_DEVICE, "cpu");
  const args = workerArgs("transnetv2", "/x.mp4");
  assert.equal(args.at(-1), "cpu");
  assert.deepEqual(args.slice(-3), ["/x.mp4", "transnetv2", "cpu"]);
  assert.equal(args[args.indexOf("--group") + 1], "transnet");
  assert.ok(args.includes("--locked"));
  assert.equal(workerArgs("reference", "/x.mp4").at(-1), "cpu");
  const source = readFileSync(path.join(repo, "scripts/workers/footage-shots.py"), "utf8");
  assert.match(source, /TransNetV2\(device=device\)/);
  assert.doesNotMatch(source, /device=["']auto|device=["']mps/);
});

test("a stream whose average rate differs from its base rate is variable", () => {
  assert.equal(frameRateIsVariable({ avg_frame_rate: "30/1", r_frame_rate: "30/1" }), false);
  assert.equal(frameRateIsVariable({ avg_frame_rate: "30000/1001", r_frame_rate: "30000/1001" }), false);
  assert.equal(frameRateIsVariable({ avg_frame_rate: "2997/100", r_frame_rate: "30/1" }), true);
  assert.equal(frameRateIsVariable({ avg_frame_rate: "0/0", r_frame_rate: "30/1" }), true);
});

test("timecodes are hours, minutes, seconds and milliseconds of the frame's start", () => {
  assert.equal(frameTimecode(0, 30), "00:00:00.000");
  assert.equal(frameTimecode(45, 30), "00:00:01.500");
  assert.equal(frameTimecode(30 * 3725 + 1, 30), "01:02:05.033");
});

test("shots run between boundary frames and leave transition frames out of the clean span", () => {
  const cuts = [cut(45), cut(126, "dissolve", 121, 131), cut(161, "fade", 157, 179), cut(216)];
  const shots = shotsFromCuts(cuts, 261, 30);
  assert.deepEqual(
    shots.map((shot) => [
      shot.id,
      shot.startFrame,
      shot.endFrame,
      shot.cleanStartFrame,
      shot.cleanEndFrame,
      shot.transitionIn,
    ]),
    [
      ["s001", 0, 44, 0, 44, "start"],
      ["s002", 45, 125, 45, 120, "cut"],
      ["s003", 126, 160, 132, 156, "dissolve"],
      ["s004", 161, 215, 180, 215, "fade"],
      ["s005", 216, 260, 216, 260, "cut"],
    ],
  );
  assert.equal(shots[1]!.startSec, 1.5);
  assert.equal(shots[1]!.endSec, 4.2);
  assert.equal(shots.at(-1)!.endSec, 8.7);
  assert.equal(shotsFromCuts([], 10, 30).length, 1);
});

test("the result converts to reference boundaries for shotsLayer", () => {
  const cuts = [cut(45), cut(126, "dissolve", 121, 131)];
  const result = { fps: 30, cuts } as unknown as FootageShots;
  assert.deepEqual(
    toReferenceBoundaries(result).map((row) => [row.timeSec, row.startSec, row.endSec, row.kind]),
    [
      [1.5, 1.5, 1.5, "cut"],
      [4.2, 4.033, 4.4, "dissolve"],
    ],
  );
});

test("variable frame rate input becomes constant with recording-edit's filter", media, (t) => {
  const directory = scratch(t);
  const input = makeVariableRateFixture(directory);
  assert.equal(frameRateIsVariable(probeFrameRates(input)), true);
  const output = path.join(directory, "cfr.mp4");
  normaliseToCfr(input, output, 30);
  assert.equal(frameRateIsVariable(probeFrameRates(output)), false);
  const counted = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "csv=p=0",
      output,
    ],
    { encoding: "utf8" },
  );
  const frames = Number(counted.stdout.trim());
  assert.ok(
    frames === 89 || frames === 90,
    `${frames} frames: 3 s at 30 fps, less the last source frame's hold on some ffmpeg versions`,
  );
  assert.equal(CFR_FILTER(30), "fps=fps=30:start_time=0:round=near");
});

test("a late-starting stream is padded when normalised, and startOffsetSec maps analysed frames back", media, (t) => {
  const directory = scratch(t);
  const input = makeLateStartFixture(directory);
  const startOffsetSec = Number(probeFrameRates(input).start_time);
  assert.equal(startOffsetSec, 0.4);
  const output = path.join(directory, "cfr.mp4");
  normaliseToCfr(input, output, 30);
  const info = probeVideo(output);
  const frames = decodeFrames(output, info, { startFrame: 0, count: info.frameCount, width: 4, height: 2 });
  const blue = frames.findIndex((image) => image.data[2]! > 128 && image.data[0]! < 128);
  assert.equal(blue, 42, "the cut sits 12 padded frames later in the analysed file");
  const result = { fps: 30, source: { startOffsetSec } } as unknown as FootageShots;
  assert.equal(originalStreamFrame(result, blue), 30);
  assert.equal(originalStreamFrame({ fps: 30, source: {} } as unknown as FootageShots, 30), 30);
  assert.equal(FootageShotsSchema.shape.source.shape.startOffsetSec.safeParse(undefined).success, true);
});

function assertFixture(result: FootageShots, options: { dissolve: boolean }) {
  assert.equal(result.frames, SHOTS_FIXTURE.frames);
  assert.equal(result.fps, SHOTS_FIXTURE.fps);
  const cuts = result.cuts.filter((row) => row.type === "cut");
  assert.deepEqual(
    cuts.map((row) => row.frame),
    [...SHOTS_FIXTURE.cuts],
    "hard cuts land on the first frame of the new shot exactly",
  );
  const fades = result.cuts.filter((row) => row.type === "fade");
  assert.equal(fades.length, 1);
  assert.ok(
    Math.abs(fades[0]!.startFrame - SHOTS_FIXTURE.fade.startFrame) <= 1,
    `fade starts at ${fades[0]!.startFrame}`,
  );
  assert.ok(Math.abs(fades[0]!.endFrame - SHOTS_FIXTURE.fade.endFrame) <= 1, `fade ends at ${fades[0]!.endFrame}`);
  const dissolves = result.cuts.filter((row) => row.type === "dissolve");
  if (options.dissolve) {
    assert.equal(dissolves.length, 1);
    assert.ok(
      Math.abs(dissolves[0]!.startFrame - SHOTS_FIXTURE.dissolve.startFrame) <= 1,
      `dissolve starts at ${dissolves[0]!.startFrame}`,
    );
    assert.ok(
      Math.abs(dissolves[0]!.endFrame - SHOTS_FIXTURE.dissolve.endFrame) <= 1,
      `dissolve ends at ${dissolves[0]!.endFrame}`,
    );
  }
  assert.equal(result.shots.length, result.cuts.length + 1);
  assert.equal(result.shots[0]!.startFrame, 0);
  assert.equal(result.shots.at(-1)!.endFrame, SHOTS_FIXTURE.frames - 1);
}

test("without TransNetV2 the reference detector runs, says so, and still places cuts and the fade", worker, (t) => {
  const directory = scratch(t);
  const input = makeShotsFixture(directory);
  const fake = path.join(directory, "uvx");
  writeFileSync(fake, `#!/bin/sh\ncase "$*" in *transnet*) echo "no network" >&2; exit 1;; esac\nexec uv "$@"\n`);
  chmodSync(fake, 0o755);
  const output = path.join(directory, "out");
  const run = runCli(["--input", input, "--output-dir", output], { ...process.env, FOOTAGE_UVX: fake });
  assert.equal(run.status, 0, `${JSON.stringify(run.json)}\n${run.stderr.slice(-800)}`);
  assert.equal(run.json.metadata.engine, "reference");
  assert.match(run.json.metadata.fallback.reason, /TransNetV2 was unavailable/);
  const result = FootageShotsSchema.parse(JSON.parse(readFileSync(path.join(output, "shots.json"), "utf8")));
  assert.equal(result.detector.fallback?.fix.length ? true : false, true);
  // The reference detector does not see this 12-frame dissolve between two moving shots; TransNetV2 does.
  assertFixture(result, { dissolve: false });
  assert.ok(existsSync(path.join(output, "storyboard-01.jpg")));
});

test("TransNetV2 on CPU finds frame-exact cuts, the dissolve and the fade", model, (t) => {
  const directory = scratch(t);
  const input = makeShotsFixture(directory);
  const output = path.join(directory, "out");
  const run = runCli(["--input", input, "--output-dir", output, "--engine", "transnetv2", "--strips"]);
  assert.equal(run.status, 0, run.stderr.slice(-800));
  const result = FootageShotsSchema.parse(JSON.parse(readFileSync(path.join(output, "shots.json"), "utf8")));
  assert.equal(result.detector.engine, "transnetv2");
  assert.equal(result.detector.device, "cpu");
  assert.equal(result.detector.fallback, undefined);
  assertFixture(result, { dissolve: true });
  assert.deepEqual(result.storyboard, ["storyboard-01.jpg"]);
  assert.equal(Object.keys(result.strips ?? {}).length, result.shots.length);
  for (const file of [...result.storyboard, ...Object.values(result.strips ?? {})])
    assert.ok(existsSync(path.join(output, file)), file);
  t.diagnostic(
    JSON.stringify(result.cuts.map((row) => [row.type, row.frame, row.startFrame, row.endFrame, row.confidence])),
  );
});
