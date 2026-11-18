import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gatherEvidence } from "../src/lib/film/evidence";
import { measureFilm } from "../src/lib/film/measure";
import { targetsFromEvidence } from "../src/lib/film/targets";
import { describePeaks, findPeaks, robust01, tensionCurve } from "../src/lib/film/tension";
import { addReference } from "../src/lib/reference/add";
import { dtw, emptyHistogram, pairShots, wasserstein, warpFromPath } from "../src/lib/reference/align";
import { analyseReference } from "../src/lib/reference/analyse";
import { compareReference } from "../src/lib/reference/compare";
import { activeBand, detectCrop } from "../src/lib/reference/crop";
import { compareCamera, compareShotColour, kindSimilarity, paceWords } from "../src/lib/reference/findings";
import { readAnalysisMedia, readLayer } from "../src/lib/reference/library";
import { probeVideo } from "../src/lib/vision/media";
import { FilmMeasureSchema } from "../src/types/film";
import { ReferenceMotionSchema, type ShotCamera } from "../src/types/reference";

const repo = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repo, "node_modules/tsx/dist/cli.mjs");
const gated = process.env.RUN_REFERENCE_UV === "1";
const needsUv = gated ? false : "set RUN_REFERENCE_UV=1 (needs uv and a first package download)";

function workspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "reference-measure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function withoutUv(t: test.TestContext) {
  const previous = process.env.REFERENCE_UVX;
  process.env.REFERENCE_UVX = "/nonexistent/uvx";
  t.after(() => {
    if (previous === undefined) delete process.env.REFERENCE_UVX;
    else process.env.REFERENCE_UVX = previous;
  });
}

function runCli(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [tsx, path.join(repo, "scripts", script), ...args], {
    encoding: "utf8",
    cwd: repo,
  });
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

/** Three shots of distinct test patterns, cuts at 2 s and 4 s, with a 1 kHz tone. */
function threeShots(file: string, options: { lead?: number } = {}) {
  const lead = options.lead ?? 0;
  const inputs = ["testsrc2", "smptebars", "testsrc"].flatMap((name) => [
    "-f",
    "lavfi",
    "-i",
    `${name}=s=320x180:r=30:d=2`,
  ]);
  const leadInput = lead ? ["-f", "lavfi", "-i", `color=c=0x203040:s=320x180:r=30:d=${lead}`] : [];
  const count = lead ? 4 : 3;
  const order = lead ? "[3:v][0:v][1:v][2:v]" : "[0:v][1:v][2:v]";
  ffmpeg([
    ...inputs,
    ...leadInput,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=1000:duration=${6 + lead}`,
    "-filter_complex",
    `${order}concat=n=${count}:v=1:a=0,format=yuv420p[v]`,
    "-map",
    "[v]",
    "-map",
    `${count}:a`,
    "-c:v",
    "libx264",
    "-qp",
    "14",
    "-g",
    "15",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
}

test("letterbox and static phone-UI bands are found and cropped, a full frame is left alone", (t) => {
  const root = workspace(t);
  const letterbox = path.join(root, "letterbox.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=3",
    "-vf",
    "pad=320:400:0:110:black,format=yuv420p",
    "-c:v",
    "libx264",
    "-qp",
    "14",
    letterbox,
  ]);
  const crop = detectCrop(letterbox, probeVideo(letterbox));
  assert.equal(crop?.method, "letterbox");
  assert.ok(Math.abs(crop!.y - 110) <= 4 && Math.abs(crop!.height - 180) <= 6, JSON.stringify(crop));
  assert.ok(crop!.width >= 316, JSON.stringify(crop));

  // Busy phone-UI bands up to 15% of the height each are cropped.
  const phone = path.join(root, "phone.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "smptehdbars=s=180x320:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=180x240:r=30:d=4",
    "-filter_complex",
    "[1:v]noise=alls=80:allf=t[n];[0:v][n]overlay=0:40,format=yuv420p[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-qp",
    "14",
    phone,
  ]);
  const band = detectCrop(phone, probeVideo(phone));
  assert.equal(band?.method, "static-bands");
  assert.ok(
    Math.abs(band!.y - 40) <= 8 && Math.abs(band!.height - 240) <= 12 && band!.width === 180,
    JSON.stringify(band),
  );

  // Wider bands are cropped only when they are plain: a uniform grey UI ground, not busy picture.
  const wide = path.join(root, "wide.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x606060:s=180x320:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=180x140:r=30:d=4",
    "-filter_complex",
    "[1:v]noise=alls=80:allf=t[n];[0:v][n]overlay=0:90,format=yuv420p[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-qp",
    "14",
    wide,
  ]);
  assert.equal(detectCrop(wide, probeVideo(wide))?.method, "static-bands");
  const busy = path.join(root, "busy.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "smptehdbars=s=180x320:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=180x140:r=30:d=4",
    "-filter_complex",
    "[1:v]noise=alls=80:allf=t[n];[0:v][n]overlay=0:90,format=yuv420p[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-qp",
    "14",
    busy,
  ]);
  assert.equal(detectCrop(busy, probeVideo(busy)), undefined, "busy still bands of 28% each are picture, not UI");

  // A full-frame film on a white ground: motion stays right of a quarter of the width, a small logo sits top left, and
  // the picture now and then crosses the left quarter. The still left quarter is the film's own ground, not a band.
  const ground = path.join(root, "ground.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=white:s=320x180:r=30:d=6",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=120x70:r=30:d=6",
    "-filter_complex",
    "[0:v]drawbox=x=6:y=6:w=26:h=8:color=0x909090:t=fill[g];[g][1:v]overlay=x='if(lt(mod(t,3),2.7),110+70*sin(t*2),-40)':y='50+40*sin(t*3)',format=yuv420p[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-qp",
    "14",
    ground,
  ]);
  assert.equal(
    detectCrop(ground, probeVideo(ground)),
    undefined,
    "a corner logo on the film's own ground is not a band",
  );
  const still = path.join(root, "still-ground.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=white:s=320x180:r=30:d=6",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=120x70:r=30:d=6",
    "-filter_complex",
    "[0:v]drawbox=x=6:y=6:w=26:h=8:color=0x909090:t=fill[g];[g][1:v]overlay=x='110+70*sin(t*2)':y='50+40*sin(t*3)',format=yuv420p[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-qp",
    "14",
    still,
  ]);
  assert.equal(
    detectCrop(still, probeVideo(still)),
    undefined,
    "a ground the picture never crosses still runs on into it: no edge, no crop",
  );

  const plain = path.join(root, "plain.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=3",
    "-c:v",
    "libx264",
    "-qp",
    "14",
    "-pix_fmt",
    "yuv420p",
    plain,
  ]);
  assert.equal(detectCrop(plain, probeVideo(plain)), undefined);
  assert.equal(activeBand([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]), undefined, "an evenly busy frame keeps every row");

  const library = path.join(root, "library");
  const { directory, source } = addReference({ file: phone, id: "phone", libraryRoot: library });
  assert.equal(source.crop?.method, "static-bands");
  const { analysisMedia } = readAnalysisMedia(directory);
  assert.notEqual(analysisMedia, path.join(directory, source.mediaPath));
  const cropped = probeVideo(analysisMedia);
  assert.deepEqual([cropped.width, cropped.height], [source.crop!.width, source.crop!.height]);
  assert.ok(Math.abs(cropped.durationSec - 4) < 0.1, "the cropped copy keeps the clock");
  assert.equal(addReference({ file: plain, id: "plain", libraryRoot: library, crop: "none" }).source.crop, null);
  assert.equal(
    addReference({ file: plain, id: "manual", libraryRoot: library, crop: "200:100:10:20" }).source.crop?.method,
    "manual",
  );
  assert.equal(
    runCli("ref-add.ts", ["--file", plain, "--id", "bad", "--library-root", library, "--crop", "999:999:0:0"]).error,
    "INVALID_INPUT",
  );

  // A record from before crops existed: reading it detects the crop but leaves source.json byte-identical.
  const sourceFile = path.join(directory, "source.json");
  const { crop: _crop, ...older } = JSON.parse(readFileSync(sourceFile, "utf8")) as Record<string, unknown>;
  writeFileSync(sourceFile, `${JSON.stringify(older, null, 2)}\n`);
  const before = readFileSync(sourceFile);
  assert.equal(readAnalysisMedia(directory).source.crop?.method, "static-bands");
  assert.equal(readAnalysisMedia(directory).source.crop?.method, "static-bands", "the cached detection is reused");
  assert.ok(readFileSync(sourceFile).equals(before), "a read never writes source.json");
  assert.ok(existsSync(path.join(directory, "media/detected-crop.json")));
  readAnalysisMedia(directory, { persist: true });
  assert.equal(JSON.parse(readFileSync(sourceFile, "utf8")).crop.method, "static-bands", "ref:analyze persists it");

  // A crop fault: ref:add --id ID --crop none re-evaluates the existing reference and keeps the old crop in cropHistory.
  const recrop = runCli("ref-add.ts", [
    "--id",
    "phone",
    "--crop",
    "none",
    "--crop-note",
    "The bands are picture.",
    "--library-root",
    library,
  ]);
  assert.equal(recrop.ok, true, JSON.stringify(recrop));
  assert.equal(recrop.metadata.recropped, true);
  assert.match(recrop.metadata.next, /rerun pnpm ref:analyze --id phone/);
  const recropped = JSON.parse(readFileSync(sourceFile, "utf8"));
  assert.equal(recropped.crop, null);
  assert.equal(recropped.cropHistory[0].crop.method, "static-bands");
  assert.equal(recropped.cropHistory[0].note, "The bands are picture.");
  assert.ok(!existsSync(path.join(directory, "media/detected-crop.json")), "the cached detection is dropped");
  assert.equal(
    readAnalysisMedia(directory).analysisMedia,
    path.join(directory, source.mediaPath),
    "picture layers read the whole frame again",
  );
  assert.equal(
    addReference({ id: "phone", crop: "auto", libraryRoot: library }).source.crop?.method,
    "static-bands",
    "auto detects again",
  );
  assert.equal(
    runCli("ref-add.ts", ["--id", "phone", "--library-root", library]).error,
    "INVALID_INPUT",
    "--id alone does nothing",
  );
});

test("DTW recovers a delay and a stretch, and pairs shots through the warp", () => {
  const signal = (time: number) => [Math.sin(time * 1.3), Math.cos(time * 0.7), time > 3 ? 1 : 0];
  const referenceTimes = Array.from({ length: 40 }, (_, index) => index * 0.25);
  // The recreation starts 1 s late and runs 20% slower.
  const renderTimes = Array.from({ length: 53 }, (_, index) => index * 0.25);
  const reference = referenceTimes.map(signal);
  const render = renderTimes.map((time) => signal(Math.max(0, (time - 1) / 1.2)));
  const { path: route, cost } = dtw(reference, render);
  assert.ok(Number.isFinite(cost));
  assert.deepEqual(route[0], [0, 0]);
  assert.deepEqual(route.at(-1), [reference.length - 1, render.length - 1]);
  const warp = warpFromPath(route, referenceTimes, renderTimes);
  for (const time of [3, 5, 8])
    assert.ok(Math.abs(warp.toRender(time) - (1 + 1.2 * time)) < 0.45, `${time} s maps to ${warp.toRender(time)}`);
  assert.ok(Math.abs(warp.toReference(warp.toRender(5)) - 5) < 0.4);
  const pairs = pairShots(
    [
      { id: "s1", startSec: 0, endSec: 4.6 },
      { id: "s2", startSec: 4.6, endSec: 13 },
    ],
    [
      { id: "r1", startSec: 0, endSec: 3 },
      { id: "r2", startSec: 3, endSec: 10 },
    ],
    warp,
  );
  assert.deepEqual(
    pairs.map((pair) => pair.reference?.id),
    ["r1", "r2"],
  );
});

test("Lab histograms compare by Wasserstein distance in channel units, and findings say it in words", () => {
  const dark = emptyHistogram();
  const light = emptyHistogram();
  dark[0][10] = 100;
  light[0][12] = 100;
  for (const histogram of [dark, light]) {
    histogram[1][16] = 100;
    histogram[2][16] = 100;
  }
  assert.deepEqual(wasserstein(dark, dark), [0, 0, 0]);
  assert.equal(wasserstein(dark, light)[0], 6.25, "two L bins of 100/32 apart");
  const lighter = emptyHistogram();
  lighter[0][20] = 100;
  lighter[1][16] = 100;
  lighter[2][22] = 100;
  const colour = compareShotColour("s3 vs ref s004", dark, lighter, { renderSec: 4, referenceSec: 3 });
  assert.ok(colour.numbers.emdL > 30);
  assert.ok(
    colour.findings.some((finding) =>
      /^s3 vs ref s004: brighter than the reference \(mean L \d+ against \d+, EMD [\d.]+\)$/.test(finding.text),
    ),
    JSON.stringify(colour.findings),
  );
  assert.ok(colour.findings.some((finding) => finding.text.includes("warmer")));

  assert.equal(paceWords(1.38), "38% slower");
  assert.equal(paceWords(0.7), "30% faster");
  const push = (seconds: number, amount: number, gsap: string, progress: number[]): ShotCamera => ({
    kind: ["push_in"],
    amount: { x: 0, y: 0, z: amount, r: 0 },
    moves: 1,
    axis: "z",
    snap: false,
    durationSec: seconds,
    span90Sec: seconds * 0.9,
    progress,
    ease: {
      gsap,
      gsapRmse: 0.01,
      cubicBezier: [0.16, 1, 0.3, 1],
      css: "cubic-bezier(0.16, 1, 0.3, 1)",
      bezierRmse: 0.01,
      spring: { omega: 8, zeta: 0.9, settleSec: 0.6, remotion: { mass: 1, stiffness: 64, damping: 14.4 } },
      springRmse: 0.02,
      best: "gsap",
      pick: "gsap",
      overshoot: 0,
    },
  });
  const linear = Array.from({ length: 21 }, (_, index) => index / 20);
  const out = linear.map((value) => 1 - (1 - value) ** 3);
  const camera = compareCamera("s3 vs ref s004", push(1, 0.2, "power3.out", out), push(1.38, 0.2, "none", linear), {
    renderSec: 4,
    referenceSec: 3,
  });
  assert.equal(camera.numbers.durationRatio, 1.38);
  assert.ok(
    camera.findings.some(
      (finding) => finding.text === "s3 vs ref s004: the push takes 1.24 s against 0.90 s (38% slower)",
    ),
    JSON.stringify(camera.findings),
  );
  assert.ok(camera.findings.some((finding) => finding.text.includes("use cubic-bezier(0.16, 1, 0.3, 1)")));
  const still: ShotCamera = { kind: ["static"], amount: { x: 0, y: 0, z: 0, r: 0 }, moves: 0 };
  assert.equal(kindSimilarity(still, still), 1);
  assert.ok(
    compareCamera("s1 vs ref s001", push(1, 0.2, "power3.out", out), still, {
      renderSec: 0,
      referenceSec: 0,
    }).findings.some((finding) => finding.text.includes("pushes in (+22%); this one holds still")),
  );
});

test("ref:compare aligns a late recreation, pairs its shots and keeps the old fields", async (t) => {
  withoutUv(t);
  const root = workspace(t);
  const film = path.join(root, "film.mp4");
  threeShots(film);
  const library = path.join(root, "library");
  addReference({ file: film, id: "film", libraryRoot: library });
  await analyseReference({ libraryRoot: library, id: "film", layers: ["shots"] });
  const render = path.join(root, "late.mp4");
  threeShots(render, { lead: 1 });
  const { result } = compareReference({ libraryRoot: library, id: "film", render });
  assert.equal(result.durationSec.difference, 1);
  assert.ok(typeof result.palette.meanDistance === "number" && "correlation" in result.motion, "the old fields stay");
  assert.ok(
    result.cuts.aligned.referenceMatched > result.cuts.referenceMatched,
    `aligned ${result.cuts.aligned.referenceMatched}, clock ${result.cuts.referenceMatched}`,
  );
  assert.ok(Math.abs(result.alignment.medianOffsetSec - 1) <= 0.35, `offset ${result.alignment.medianOffsetSec}`);
  const byStart = (start: number) => result.shots.find((shot) => Math.abs(shot.startSec - start) < 0.15);
  assert.equal(byStart(3)?.referenceShot, "s002", JSON.stringify(result.shots));
  assert.equal(byStart(5)?.referenceShot, "s003");
  assert.ok(
    result.shots.filter((shot) => shot.startSec > 0.5).every((shot) => "colour" in shot && shot.colour!.emdL < 10),
    JSON.stringify(result.shots),
  );
  assert.ok(
    result.findings.some((finding) => finding.component === "alignment" && /behind/.test(finding.text)),
    JSON.stringify(result.findings),
  );
  assert.match(result.cameraNote ?? "", /not compared/);
});

test("motion:strip --vs puts reference rows over ours and refuses a black reference", (t) => {
  const root = workspace(t);
  const ours = path.join(root, "ours.mp4");
  const reference = path.join(root, "reference.mp4");
  const black = path.join(root, "black.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", ours]);
  ffmpeg(["-f", "lavfi", "-i", "smptebars=s=320x180:r=25:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", reference]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=160x90:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", black]);
  const output = path.join(root, "vs.png");
  const result = runCli("motion-strip.ts", [
    "--input",
    ours,
    "--output",
    output,
    "--start-sec",
    "0.5",
    "--end-sec",
    "1",
    "--width",
    "80",
    "--columns",
    "5",
    "--vs",
    reference,
    "--vs-range",
    "1:2",
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(existsSync(output));
  assert.equal(result.metadata.frames.length, 15);
  assert.equal(result.metadata.frames[0].referenceSec, 1);
  assert.ok(Math.abs(result.metadata.frames.at(-1).referenceSec - 1.92) < 0.05);
  assert.equal(result.metadata.height > 6 * 45, true, "three reference rows and three of ours");
  assert.equal(
    runCli("motion-strip.ts", [
      "--input",
      ours,
      "--output",
      output,
      "--start-sec",
      "0",
      "--end-sec",
      "0.5",
      "--vs",
      black,
    ]).error,
    "VALIDATION",
  );
  assert.equal(
    runCli("motion-strip.ts", ["--input", ours, "--output", output, "--vs-range", "1:2"]).error,
    "INVALID_INPUT",
  );
  assert.equal(
    runCli("motion-strip.ts", ["--input", ours, "--output", output, "--vs", reference, "--vs-range", "2:1"]).error,
    "INVALID_INPUT",
  );
});

test("the tension curve finds a held breath and a one-frame hit, with JND floors", () => {
  assert.deepEqual(
    robust01([0.001, 0.002, 0.0015, 0.001], 0.02).map((value) => value < 0.06),
    [true, true, true, true],
    "a wobble under the JND stays near 0",
  );
  const hz = 30;
  const values = Array.from({ length: 12 * hz }, (_, index) => {
    const time = index / hz;
    if (time < 6) return 0.1 + (0.5 * time) / 6;
    if (time < 7) return 0.15;
    if (time < 8) return 1;
    return 0.3;
  });
  assert.equal(findPeaks(values, 0.12, 120).length, 1);
  const [peak] = describePeaks(values, hz, 30);
  assert.ok(peak);
  assert.equal(peak.timeSec, 7);
  assert.ok(Math.abs(peak.breathDepth - 0.45) < 0.02, `depth ${peak.breathDepth}`);
  assert.ok(Math.abs(peak.breathSec - 1) < 0.05, `breath ${peak.breathSec}`);
  assert.equal(peak.riseFrames, 1);
  assert.ok(Math.abs(peak.holdSec - 1) < 0.05);
  assert.ok(peak.buildSlope > 0.05);
  const still = tensionCurve(
    {
      sampleHz: 30,
      diff: new Array(300).fill(0.001).map((value, index) => value + (index % 7) * 1e-4),
      luma: new Array(300).fill(0.5),
    },
    [],
  );
  assert.ok(Math.max(...still.values) < 0.05, "noise in a still film is not a climax");
  assert.deepEqual(still.used, ["diff", "cuts", "flash"]);
});

test("film:targets measures the reference climax and film:measure judges it as advice only", (t) => {
  const root = workspace(t);
  const hit = path.join(root, "hit.mp4");
  // Busy picture and tone that build, a held breath at 4.4-5 s, then a white flash and a loud burst at 5 s.
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=30:d=8",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=8",
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=d=8:a=0.9:seed=4",
    "-filter_complex",
    "[0:v]drawbox=c=black:t=fill:enable='between(t\\,4.4\\,5)',drawbox=c=white:t=fill:enable='between(t\\,5\\,5.3)',format=yuv420p[v];[1:a]volume='if(lt(t\\,4.4)\\,0.05+0.1*t\\,0.0)':eval=frame[tone];[2:a]volume='if(between(t\\,5\\,5.6)\\,1\\,0)':eval=frame[burst];[tone][burst]amix=inputs=2:normalize=0[a]",
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-qp",
    "16",
    "-c:a",
    "aac",
    hit,
  ]);
  const evidence = gatherEvidence(hit);
  assert.ok(evidence.tension, "tension measured");
  assert.deepEqual(evidence.tension.features.sort(), ["cuts", "diff", "flash", "loudness"]);
  const targets = targetsFromEvidence({ evidence, referenceId: "hit" });
  assert.ok(Math.abs(targets.measuredFrom.climaxTimeSec! - 5) < 0.2, `climax at ${targets.measuredFrom.climaxTimeSec}`);
  assert.ok(targets.measuredFrom.climaxBreathDepth! > 0.1);
  assert.ok(targets.climax?.riseFrames.max !== undefined && targets.climax.breathDepth.min !== undefined);
  const own = measureFilm({ evidence, targets }).legs.find((leg) => leg.id === "climax-shape");
  assert.equal(own?.status, "pass", JSON.stringify(own));

  const flat = path.join(root, "flat.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=30:d=8",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=8",
    "-c:v",
    "libx264",
    "-qp",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    flat,
  ]);
  const measure = FilmMeasureSchema.parse(measureFilm({ evidence: gatherEvidence(flat), targets }));
  const leg = measure.legs.find((row) => row.id === "climax-shape")!;
  assert.equal(leg.status, "warn", JSON.stringify(leg));
  assert.ok(leg.fix);
  assert.ok(!measure.legs.some((row) => row.id === "climax-shape" && row.status === "fail"));
  assert.equal(measureFilm({ evidence }).legs.find((row) => row.id === "climax-shape")?.status, "skipped");
});

/** A still frame pushed in 25% over 2 s with power3.out, then held for 1 s. */
function easedPush(root: string, name: string, frames: number) {
  const still = path.join(root, "still.png");
  if (!existsSync(still)) ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=2560x1440:r=30:d=1", "-frames:v", "1", still]);
  const file = path.join(root, name);
  ffmpeg([
    "-loop",
    "1",
    "-i",
    still,
    "-vf",
    `zoompan=z='1+0.25*(1-pow(1-min(1\\,on/${frames})\\,3))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=640x360:fps=30`,
    "-frames:v",
    String(frames + 30),
    "-c:v",
    "libx264",
    "-qp",
    "12",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  return file;
}

test("the motion layer fits a push's ease, length and amount", { skip: needsUv }, async (t) => {
  const root = workspace(t);
  const film = easedPush(root, "push.mp4", 60);
  const library = path.join(root, "library");
  const { directory } = addReference({ file: film, id: "push", libraryRoot: library });
  await analyseReference({ libraryRoot: library, id: "push", layers: ["motion"] });
  const motion = ReferenceMotionSchema.parse(readLayer(directory, "motion.json"));
  const camera = motion.shots[0]!.camera!;
  assert.deepEqual(camera.kind, ["push_in"]);
  assert.equal(camera.axis, "z");
  assert.ok(Math.abs(camera.amount.z - Math.log(1.25)) < 0.035, `push ${camera.amount.z}`);
  assert.ok(camera.durationSec! > 1.5 && camera.durationSec! < 2.5, `length ${camera.durationSec}`);
  assert.ok(camera.startSec! < 0.1);
  assert.match(camera.ease!.gsap, /\.out$/);
  assert.match(camera.ease!.css, /^cubic-bezier\(/);
  assert.ok(camera.ease!.spring.remotion.stiffness > 0);
  assert.equal(camera.progress!.length, 21);
  assert.ok(
    motion.cadence && (motion.cadence.label === undefined || motion.cadence.label === "on ones"),
    JSON.stringify(motion.cadence),
  );
});

test("cadence reads animation on twos, and a logo over two shots is masked", { skip: needsUv }, async (t) => {
  const root = workspace(t);
  const twos = path.join(root, "twos.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=15:d=3",
    "-vf",
    "fps=30,format=yuv420p",
    "-c:v",
    "libx264",
    "-qp",
    "12",
    twos,
  ]);
  const library = path.join(root, "library");
  const { directory } = addReference({ file: twos, id: "twos", libraryRoot: library, crop: "none" });
  await analyseReference({ libraryRoot: library, id: "twos", layers: ["motion"] });
  const motion = readLayer(directory, "motion.json")!;
  assert.equal(motion.cadence?.label, "on twos", JSON.stringify(motion.cadence));
  assert.ok(Math.abs(motion.cadence!.framesPerDrawing! - 2) < 0.3);

  const logo = path.join(root, "logo.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "mandelbrot=s=320x180:r=30",
    "-filter_complex",
    "[1:v]trim=duration=2,setpts=PTS-STARTPTS[m];[0:v][m]concat=n=2:v=1[c];[c]drawbox=x=250:y=10:w=60:h=40:c=white:t=fill,drawbox=x=262:y=20:w=36:h=20:c=red:t=fill,format=yuv420p[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-qp",
    "12",
    logo,
  ]);
  const added = addReference({ file: logo, id: "logo", libraryRoot: library, crop: "none" });
  await analyseReference({ libraryRoot: library, id: "logo", layers: ["shots", "motion"] });
  const logoMotion = readLayer(added.directory, "motion.json")!;
  assert.ok((logoMotion.staticOverlayShare ?? 0) > 0.02, `overlay ${logoMotion.staticOverlayShare}`);
});

test("ref:compare names a faster push in words", { skip: needsUv }, async (t) => {
  const root = workspace(t);
  const reference = easedPush(root, "slow.mp4", 60);
  const render = easedPush(root, "fast.mp4", 30);
  const library = path.join(root, "library");
  addReference({ file: reference, id: "slow", libraryRoot: library });
  await analyseReference({ libraryRoot: library, id: "slow", layers: ["shots", "motion"] });
  const { result } = compareReference({ libraryRoot: library, id: "slow", render });
  const camera = result.findings.filter((finding) => finding.component === "camera");
  assert.ok(
    camera.some((finding) => /the push takes [\d.]+ s against [\d.]+ s \(\d+% faster\)/.test(finding.text)),
    JSON.stringify(result.findings),
  );
  const first = result.shots[0]!;
  assert.ok("camera" in first && first.camera!.durationRatio! < 0.8, JSON.stringify(first));
  assert.ok(JSON.parse(readFileSync(path.join(library, "slow/compare/compare.json"), "utf8")).findings.length > 0);
});
