import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasGlyph, glyphRows, normaliseLabel } from "../src/lib/vision/bitmap-font";
import { RgbImage } from "../src/lib/vision/image";
import { decodeFrames, probeVideo } from "../src/lib/vision/media";
import { checkVisualReviews, hashRenderFile } from "../src/lib/vision/reviews";
import { buildShotSheet, formatTimecode, resolveWindow } from "../src/lib/vision/sheets";
import { nextTimelineCommands } from "../src/lib/vision/timeline-next";
import { projectTimelineContext } from "../src/lib/vision/project-context";

const repo = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repo, "node_modules/tsx/dist/cli.mjs");
const hash = (character: string) => character.repeat(64);

function workspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "motion-vision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** Every frame has its own grey level (rising by two levels per frame), so a decoded frame identifies itself. */
function lumaCodedVideo(file: string, audio = false) {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=64x36:r=30:d=4,format=gray,geq=lum='16+2*N'",
    ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=440:duration=4"] : []),
    "-c:v",
    "libx264",
    "-qp",
    "0",
    "-pix_fmt",
    "yuv444p",
    "-g",
    "12",
    ...(audio ? ["-c:a", "aac", "-shortest"] : []),
    file,
  ]);
}

function runCli(script: string, args: string[], cwd = repo) {
  const child = spawnSync(process.execPath, [tsx, path.join(repo, "scripts", script), ...args], {
    cwd,
    encoding: "utf8",
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
    maxBuffer: 16 * 1024 * 1024,
  });
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `stdout must be one JSON line: ${child.stdout} ${child.stderr}`);
  return { status: child.status, result: JSON.parse(lines[0]!) };
}

function readImage(file: string) {
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", file], {
    encoding: "utf8",
  });
  const { width, height } = JSON.parse(probe.stdout).streams[0];
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return new RgbImage(width, height, raw.stdout);
}

const pixel = (image: RgbImage, x: number, y: number) => [
  ...image.data.subarray((y * image.width + x) * 3, (y * image.width + x) * 3 + 3),
];
const meanGrey = (image: RgbImage) => image.data.reduce((sum, value) => sum + value, 0) / image.data.length;

test("window decoding is exact to the frame, with and without a step", (t) => {
  const file = path.join(workspace(t), "coded.mp4");
  lumaCodedVideo(file);
  const info = probeVideo(file);
  assert.deepEqual([info.width, info.height, info.fps, info.frameCount, info.hasAudio], [64, 36, 30, 120, false]);
  const levels = (options: { startFrame: number; count: number; step?: number }) =>
    decodeFrames(file, info, { ...options, width: 8, height: 4 }).map(meanGrey);
  const truth = levels({ startFrame: 0, count: 120 });
  assert.equal(truth.length, 120);
  assert.ok(truth[60]! > truth[40]! + 20, "the coded ramp must identify frames");
  assert.deepEqual(levels({ startFrame: 40, count: 3 }), truth.slice(40, 43), "seeking lands exactly on the frame");
  assert.deepEqual(levels({ startFrame: 41, count: 1 }), [truth[41]]);
  assert.deepEqual(levels({ startFrame: 40, count: 3, step: 5 }), [truth[40], truth[45], truth[50]]);
  assert.deepEqual(levels({ startFrame: 12, count: 1 }), [truth[12]], "a keyframe position is not off by one");
  const withAudio = `${file}.audio.mp4`;
  lumaCodedVideo(withAudio, true);
  const audioInfo = probeVideo(withAudio);
  assert.deepEqual(
    decodeFrames(withAudio, audioInfo, { startFrame: 40, count: 1, width: 8, height: 4 }).map(meanGrey),
    decodeFrames(withAudio, audioInfo, { startFrame: 0, count: 41, width: 8, height: 4 }).slice(40).map(meanGrey),
    "an audio stream does not shift the seek",
  );
  assert.equal(
    decodeFrames(file, info, { startFrame: 118, count: 10, width: 8, height: 4 }).length,
    2,
    "stops at end of file",
  );
});

test("windows resolve seconds as half-open and frames as inclusive, and refuse mixes", () => {
  const info = { width: 64, height: 36, fps: 30, frameCount: 120, durationSec: 4, hasAudio: false };
  assert.deepEqual(resolveWindow(info, { startSec: 1, endSec: 2 }), { first: 30, last: 59 });
  assert.deepEqual(resolveWindow(info, { startFrame: 5, endFrame: 7 }), { first: 5, last: 7 });
  assert.deepEqual(resolveWindow(info, { endFrame: 999 }), { first: 0, last: 119 });
  assert.throws(() => resolveWindow(info, { startSec: 1, endFrame: 7 }), /not both/);
  assert.throws(() => resolveWindow(info, { startFrame: 200 }), /selects no frames/);
  assert.equal(formatTimecode(61.5), "01:01.50");
});

test("motion strip writes the expected grid, one JSON line, and reports frames", (t) => {
  const root = workspace(t);
  const input = path.join(root, "coded.mp4");
  const output = path.join(root, "nested", "strip.png");
  lumaCodedVideo(input);
  const { status, result } = runCli("motion-strip.ts", [
    "--input",
    input,
    "--output",
    output,
    "--start-frame",
    "10",
    "--end-frame",
    "17",
    "--step",
    "2",
    "--width",
    "64",
    "--columns",
    "2",
  ]);
  assert.equal(status, 0);
  assert.equal(result.outputs[0], output);
  assert.ok(result.outputs.includes(result.metadata.reviewPack));
  const review = JSON.parse(readFileSync(result.metadata.reviewPack, "utf8"));
  assert.equal(review.source.kind, "video");
  assert.deepEqual(
    review.frames.map((frame: { frame: number }) => frame.frame),
    [10, 12, 14, 16, 17],
  );
  assert.ok(review.pages.every((page: { width: number; height: number }) => Math.max(page.width, page.height) <= 2000));
  assert.deepEqual(
    result.metadata.frames.map((frame: { frame: number }) => frame.frame),
    [10, 12, 14, 16],
  );
  const sheet = readImage(output);
  assert.equal(sheet.width, 4 * 2 + 64 * 2 + 4);
  assert.equal(result.metadata.height, sheet.height);
  const tileGrey = (index: number) => pixel(sheet, 4 + 32 + (index % 2) * 68, 28 + 18)[0]!;
  assert.ok(tileGrey(1) > tileGrey(0), "later tiles of the luma ramp are brighter");
});

test("diff reports no change for a still video and real change for a moving one", (t) => {
  const root = workspace(t);
  const still = path.join(root, "still.mp4");
  const moving = path.join(root, "moving.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=64x36:r=30:d=1", "-c:v", "libx264", "-qp", "0", still]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=64x36:r=30:d=1,format=gray,geq=lum='if(lt(mod(X+N*8\\,32)\\,16)\\,235\\,16)'",
    "-c:v",
    "libx264",
    "-qp",
    "0",
    "-pix_fmt",
    "yuv444p",
    moving,
  ]);
  const diffs = (input: string, name: string) => {
    const { status, result } = runCli("motion-strip.ts", [
      "--input",
      input,
      "--output",
      path.join(root, name),
      "--start-frame",
      "0",
      "--end-frame",
      "5",
      "--diff",
    ]);
    assert.equal(status, 0, JSON.stringify(result));
    assert.equal(result.metadata.frames[0].diffMean, undefined);
    return result.metadata.frames.slice(1).map((frame: { diffMean: number }) => frame.diffMean);
  };
  assert.ok(diffs(still, "still.png").every((value: number) => value === 0));
  assert.ok(diffs(moving, "moving.png").every((value: number) => value > 0.5));
});

test("over-limit strips and bad input fail with a usable error code", (t) => {
  const root = workspace(t);
  const input = path.join(root, "coded.mp4");
  lumaCodedVideo(input);
  const output = path.join(root, "x.png");
  const tooMany = runCli("motion-strip.ts", ["--input", input, "--output", output, "--diff"]);
  assert.equal(tooMany.status, 1);
  assert.equal(tooMany.result.error, "INVALID_INPUT");
  assert.match(tooMany.result.message, /limit is 120/);
  assert.match(tooMany.result.message, /--step to at least 2/);
  assert.equal(existsSync(output), false);
  const suggested = runCli("motion-strip.ts", [
    "--input",
    input,
    "--output",
    output,
    "--diff",
    "--step",
    "2",
    "--width",
    "16",
  ]);
  assert.equal(suggested.status, 0, "the suggested step must succeed");
  assert.equal(
    runCli("motion-strip.ts", ["--input", path.join(root, "absent.mp4"), "--output", output]).result.error,
    "FILE_NOT_FOUND",
  );
  assert.equal(
    runCli("motion-strip.ts", [
      "--input",
      input,
      "--output",
      path.join(root, "x.gif"),
      "--start-frame",
      "0",
      "--end-frame",
      "1",
    ]).result.error,
    "INVALID_INPUT",
  );
  const badShots = path.join(root, "bad-shots.json");
  writeFileSync(badShots, JSON.stringify({ shots: [{ start: 0 }] }));
  assert.equal(
    runCli("motion-strip.ts", ["--input", input, "--output", output, "--by-shots", badShots]).result.error,
    "VALIDATION",
  );
});

test("by-shots takes first, middle and last frame of each shot, and rejects shots outside the video", (t) => {
  const root = workspace(t);
  const input = path.join(root, "coded.mp4");
  lumaCodedVideo(input);
  const info = probeVideo(input);
  const { image, shots } = buildShotSheet(input, info, [
    { startSec: 0, endSec: 1 },
    { id: "b", startSec: 1, endSec: 2.01 },
    { startSec: 2, endSec: 2 + 1 / 30 },
  ]);
  assert.deepEqual(
    shots.map((shot) => shot.frames.map((frame) => frame.frame)),
    [
      [0, 14, 29],
      [30, 45, 60],
      [60, 60, 60],
    ],
  );
  assert.ok(image.width > 0);
  assert.throws(() => buildShotSheet(input, info, [{ startSec: 9, endSec: 10 }]), /selects no frames/);
  assert.throws(() => buildShotSheet(input, info, [{ startSec: 2, endSec: 1 }]), /selects no frames/);
  const file = path.join(root, "shots.json");
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      referenceId: "r",
      detector: { name: "x" },
      shots: [{ id: "s1", startSec: 0, endSec: 1, transitionIn: "cut", transitionConfidence: 1 }],
    }),
  );
  const { status } = runCli("motion-strip.ts", [
    "--input",
    input,
    "--output",
    path.join(root, "s.png"),
    "--by-shots",
    file,
  ]);
  assert.equal(status, 0, "a full reference shots file is accepted");
});

test("review sheet draws a waveform and cut marks, and works without audio", (t) => {
  const root = workspace(t);
  const withAudio = path.join(root, "audio.mp4");
  const silent = path.join(root, "silent.mp4");
  lumaCodedVideo(withAudio, true);
  lumaCodedVideo(silent);
  const marks = path.join(root, "marks.json");
  writeFileSync(marks, JSON.stringify([2, 99]));
  const captions = path.join(root, "captions.json");
  writeFileSync(captions, JSON.stringify(["Первый кадр", "second"]));
  const output = path.join(root, "sheet.png");
  const { status, result } = runCli("review-sheet.ts", [
    "--input",
    withAudio,
    "--output",
    output,
    "--times",
    "0,3",
    "--marks",
    marks,
    "--captions",
    captions,
    "--width",
    "64",
  ]);
  assert.equal(status, 0, JSON.stringify(result));
  assert.deepEqual(result.metadata.frames, [
    { frame: 0, timeSec: 0, caption: "Первый кадр" },
    { frame: 90, timeSec: 3, caption: "second" },
  ]);
  assert.deepEqual(result.metadata.marks, [2]);
  assert.deepEqual(result.metadata.ignoredMarks, [99]);
  const sheet = readImage(output);
  const waveMiddle = sheet.height - 4 - 24 - 60;
  const greenAt = (x: number) => {
    const [r, g] = pixel(sheet, x, waveMiddle);
    return g! > 150 && g! > r!;
  };
  assert.ok(greenAt(Math.floor(sheet.width * 0.25)), "a loud tone draws a waveform through the band's centre");
  const markX = Math.round((2 / result.metadata.video.durationSec) * (sheet.width - 1));
  const [red, green] = pixel(sheet, markX, waveMiddle);
  assert.ok(red! > 200 && green! < 120, "the cut mark crosses the waveform at its time");

  const silentOutput = path.join(root, "silent.png");
  const silentRun = runCli("review-sheet.ts", ["--input", silent, "--output", silentOutput, "--count", "4"]);
  assert.equal(silentRun.status, 0, JSON.stringify(silentRun.result));
  assert.equal(silentRun.result.metadata.hasAudio, false);
  assert.deepEqual(
    silentRun.result.metadata.frames.map((frame: { frame: number }) => frame.frame),
    [15, 45, 75, 105],
  );
  assert.equal(runCli("review-sheet.ts", ["--output", silentOutput]).result.error, "INVALID_INPUT");
  assert.equal(
    runCli("review-sheet.ts", ["--input", silent, "--output", silentOutput, "--times", "99"]).result.error,
    "INVALID_INPUT",
  );
});

test("project context takes cut marks and labels from a legacy project in a temporary workspace", (t) => {
  const root = workspace(t);
  const project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    path.join(project, "project.json"),
    JSON.stringify({
      name: "demo",
      productName: "Demo",
      tagline: "",
      formats: ["vertical"],
      colors: { accent: "#fff", background: "#000", text: "#fff" },
      voice: "rachel",
      musicPrompt: "",
      musicVolume: 0.1,
      scenes: [
        { id: "hook", headline: "Hello", text: "", visualType: "title", durationInFrames: 60 },
        { id: "cta", text: "Spoken", visualType: "title", durationInFrames: 30 },
      ],
    }),
  );
  const context = projectTimelineContext("demo", root);
  assert.equal(context.captions[0]!.text, "Hello");
  assert.equal(context.captions[0]!.startSec, 0);
  assert.equal(context.marks.length, 1);
  assert.ok(context.marks[0]! > 0);
});

test("labels cover Latin, Cyrillic and timecode characters with valid glyphs", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;!?-+=/()[]'\"%&_#*<>АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
  for (const character of alphabet) {
    assert.ok(hasGlyph(character), character);
    for (const row of glyphRows(character)) assert.ok(Number.isInteger(row) && row >= 0 && row < 32, character);
  }
  assert.equal(normaliseLabel("Чаос — фокус…"), "ЧАОС — ФОКУС...");
  assert.equal(hasGlyph("語"), false);
});

test("visual review findings distinguish missing, stale, malformed and current receipts", (t) => {
  const root = workspace(t);
  const directory = path.join(root, "pipeline/reviews");
  const write = (name: string, step: string, renderSha256: string) =>
    writeFileSync(
      path.join(directory, name),
      JSON.stringify({
        schemaVersion: 1,
        step,
        renderSha256,
        reviewer: "agent",
        frames: [{ path: "a.png", note: "seen" }],
      }),
    );
  const codes = (current: string) =>
    checkVisualReviews(root, current).map((finding) => [finding.code, finding.severity, finding.ref?.file]);

  assert.deepEqual(codes(hash("a")), [["VISUAL_REVIEW_MISSING", "error", "pipeline/reviews"]]);
  mkdirSync(directory, { recursive: true });
  assert.equal(checkVisualReviews(root, hash("a"))[0]!.code, "VISUAL_REVIEW_MISSING");

  write("motion.json", "motion", hash("b"));
  assert.deepEqual(codes(hash("a")), [["REVIEW_STALE", "error", "pipeline/reviews/motion.json"]]);
  assert.deepEqual(checkVisualReviews(root, hash("b")), []);

  write("motion-2.json", "motion", hash("a"));
  assert.deepEqual(
    checkVisualReviews(root, hash("a")),
    [],
    "an older receipt is not stale once its step has a fresh one",
  );

  write("whole.json", "whole", hash("b"));
  assert.deepEqual(
    codes(hash("a")),
    [["REVIEW_STALE", "warning", "pipeline/reviews/whole.json"]],
    "another step is still stale, as a warning",
  );

  writeFileSync(path.join(directory, "broken.json"), "{ not json");
  writeFileSync(
    path.join(directory, "empty.json"),
    JSON.stringify({ schemaVersion: 1, step: "x", renderSha256: hash("a"), reviewer: "a", frames: [] }),
  );
  const found = checkVisualReviews(root, hash("c"));
  assert.deepEqual(
    found.filter((finding) => finding.code === "VISUAL_REVIEW_MISSING").map((finding) => finding.ref?.file),
    ["pipeline/reviews/broken.json", "pipeline/reviews/empty.json"],
  );
  assert.ok(found.every((finding) => finding.severity === "error" && finding.stage === "qa"));

  const render = path.join(root, "render.bin");
  writeFileSync(render, "render");
  assert.equal(hashRenderFile(render), createHash("sha256").update("render").digest("hex"));
});

test("the next timeline command is exact when clips are named, and shows placeholders when not", (t) => {
  const root = workspace(t);
  const pipeline = path.join(root, "public/projects/demo/pipeline");
  mkdirSync(pipeline, { recursive: true });
  const options = {
    projectId: "demo",
    rootDir: root,
    assetId: "sha256:abc",
    fps: 30,
    frameCount: 300,
    fullComposition: true,
  };
  const absent = nextTimelineCommands(options);
  assert.equal(absent.commands[0], "pnpm timeline:edit --project demo --init");
  assert.equal(absent.resolved, false);

  const source = (start: number, end: number) => ({
    start: { num: start, den: 1 },
    end: { num: end, den: 1 },
    timebase: { num: 30, den: 1 },
  });
  writeFileSync(
    path.join(pipeline, "timeline-edit.json"),
    JSON.stringify({
      revision: 7,
      timeline: {
        tracks: [
          {
            id: "visual",
            kind: "visual",
            clips: [
              { id: "a", source: source(0, 90) },
              { id: "b", source: source(90, 300) },
            ],
          },
          { id: "music", kind: "music", clips: [] },
        ],
      },
    }),
  );

  const single = nextTimelineCommands({ ...options, clipIds: ["b"] });
  assert.equal(single.resolved, true);
  assert.equal(single.commands.length, 1);
  assert.match(single.commands[0]!, /^pnpm timeline:edit --project demo --revision 7 --command '.*' --dry-run$/);
  assert.deepEqual(JSON.parse(/--command '(.*)' --dry-run/.exec(single.commands[0]!)![1]!), {
    type: "replace",
    trackId: "visual",
    clipId: "b",
    assetId: "sha256:abc",
    source: source(90, 300),
  });

  const batch = JSON.parse(
    /--command '(.*)' --dry-run/.exec(nextTimelineCommands({ ...options, clipIds: ["a", "b"] }).commands[0]!)![1]!,
  );
  assert.equal(batch.type, "batch");
  assert.deepEqual(
    batch.commands.map((command: { clipId: string }) => command.clipId),
    ["a", "b"],
  );

  const partial = JSON.parse(
    /--command '(.*)' --dry-run/.exec(
      nextTimelineCommands({ ...options, frameCount: 26, fullComposition: false, clipIds: ["b"] }).commands[0]!,
    )![1]!,
  );
  assert.deepEqual(partial.source, source(0, 26), "a partial render is bound from its own first frame");
  assert.deepEqual(
    nextTimelineCommands({ ...options, frameCount: 26, fullComposition: false, clipIds: ["b"] }).durationChanges,
    [{ clipId: "b", fromFrames: 210, toFrames: 26 }],
    "a shortened clip is called out",
  );
  assert.deepEqual(single.durationChanges, [], "a whole-composition render keeps the span");

  const unnamed = nextTimelineCommands(options);
  assert.equal(unnamed.resolved, false);
  assert.deepEqual(unnamed.visualClips, [
    { trackId: "visual", clipId: "a" },
    { trackId: "visual", clipId: "b" },
  ]);
  assert.deepEqual(nextTimelineCommands({ ...options, clipIds: ["ghost"] }).missingClips, ["ghost"]);
});

test("scripts answer --help offline with one JSON line", () => {
  for (const script of ["motion-still.ts", "motion-strip.ts", "motion-render.ts", "review-sheet.ts"]) {
    const { status, result } = runCli(script, ["--help"]);
    assert.equal(status, 0, script);
    assert.equal(result.ok, true, script);
  }
});

test(
  "stills and renders come from a real composition, and a render imports with a bindable command",
  { skip: process.env.RUN_RENDER_TESTS !== "1", timeout: 240000 },
  (t) => {
    const root = workspace(t);
    const entry = path.join(repo, "tests/fixtures/motion-vision/index.tsx");
    const project = path.join(root, "public/projects/demo");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "project.json"), "{}");
    const shared = ["--entry", entry, "--composition", "Fade", "--public-dir", path.join(root, "public")];

    const still = runCli(
      "motion-still.ts",
      [...shared, "--frames", "0,29", "--output", path.join(root, "stills")],
      root,
    );
    assert.equal(still.status, 0, JSON.stringify(still.result));
    assert.deepEqual(
      still.result.outputs,
      [path.join(root, "stills/frame-000000.png"), path.join(root, "stills/frame-000029.png")].map((file) =>
        path.resolve(file),
      ),
    );
    assert.ok(meanGrey(readImage(still.result.outputs[0])) < 5);
    assert.ok(meanGrey(readImage(still.result.outputs[1])) > 250);

    assert.equal(
      runCli("motion-still.ts", [...shared, "--frames", "30", "--output", path.join(root, "stills")], root).result
        .error,
      "INVALID_INPUT",
    );
    assert.equal(
      runCli(
        "motion-still.ts",
        [
          "--entry",
          entry,
          "--composition",
          "Nope",
          "--public-dir",
          path.join(root, "public"),
          "--frames",
          "0",
          "--output",
          path.join(root, "stills"),
        ],
        root,
      ).result.error,
      "INVALID_INPUT",
    );

    const output = path.join(root, "clip.mp4");
    const render = runCli(
      "motion-render.ts",
      [
        ...shared,
        "--frames",
        "10-19",
        "--crf",
        "20",
        "--output",
        output,
        "--project",
        "demo",
        "--import",
        "--track",
        "visual",
        "--clip",
        "hook",
      ],
      root,
    );
    assert.equal(render.status, 0, JSON.stringify(render.result));
    assert.equal(render.result.metadata.composition.frameCount, 10);
    assert.equal(probeVideo(output).frameCount, 10);
    const asset = render.result.metadata.asset;
    assert.equal(asset.sha256, hashRenderFile(output));
    assert.equal(asset.id, `sha256:${asset.sha256}`);
    assert.equal(readFileSync(path.join(root, asset.path)).equals(readFileSync(output)), true);
    assert.match(render.result.metadata.timeline.commands.at(-1), new RegExp(`"assetId":"sha256:${asset.sha256}"`));
    assert.equal(render.result.metadata.timeline.resolved, true);
    assert.ok(asset.path.startsWith("public/projects/demo/assets/imported/"));
  },
);
