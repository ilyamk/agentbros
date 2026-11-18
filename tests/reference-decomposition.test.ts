import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addReference } from "../src/lib/reference/add";
import { analyseReference, parseLayers } from "../src/lib/reference/analyse";
import { compareReference, cutDistance, extractPalette, paletteDistance, pearson } from "../src/lib/reference/compare";
import { readLayer, validateReference } from "../src/lib/reference/library";
import { detectBoundaries, pickScorePeaks, shotsLayer } from "../src/lib/reference/shots";
import { buildSync, chanceRatio, hitRatio } from "../src/lib/reference/sync";
import { RgbImage } from "../src/lib/vision/image";
import { detectSceneChanges } from "../src/lib/ingest";
import { dropRepeatedWords, speechWordsFromRows } from "../src/lib/local-engines/speech-text";

const repo = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repo, "node_modules/tsx/dist/cli.mjs");
const gated = process.env.RUN_REFERENCE_UV === "1";

function workspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "reference-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

const CLICKS = "aevalsrc='0.9*exp(-mod(t\\,0.5)*200)*sin(2*PI*1000*t):s=44100:d=DURATION'";

/** Three textured sources: a hard cut at 2 s, a transition across 4-5 s and a hard cut at 7 s. Clicks every 0.5 s. */
function syntheticFilm(file: string, transition = "dissolve") {
  const source = (name: string, duration: number) => ["-f", "lavfi", "-i", `${name}=s=320x180:r=30:d=${duration}`];
  ffmpeg([
    ...source("testsrc2", 2),
    ...source("smptebars", 3),
    ...source("testsrc", 3),
    ...source("rgbtestsrc", 2),
    "-f",
    "lavfi",
    "-i",
    CLICKS.replace("DURATION", "9"),
    "-filter_complex",
    `[1:v][2:v]xfade=transition=${transition}:duration=1:offset=2[soft];[0:v][soft][3:v]concat=n=3:v=1:a=0,format=yuv420p[v]`,
    "-map",
    "[v]",
    "-map",
    "4:a",
    "-c:v",
    "libx264",
    "-qp",
    "12",
    "-g",
    "15",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
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
    env: {
      AGENTBROS_NO_DOTENV: "1",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.REFERENCE_UVX ? { REFERENCE_UVX: process.env.REFERENCE_UVX } : {}),
    },
  });
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

test("ref:add copies media, reads the sidecar and marks inbox files study-only", (t) => {
  const root = workspace(t);
  const inbox = path.join(root, "library", "inbox");
  mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, "My Film.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=64x36:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  writeFileSync(path.join(inbox, "My Film.md"), "Launch film notes.\n");
  const library = path.join(root, "library");
  const added = addReference({ file, libraryRoot: library });
  assert.equal(added.source.referenceId, "my-film");
  assert.equal(added.source.rights.status, "study-only");
  assert.equal(added.source.notes, "Launch film notes.");
  assert.equal(added.source.probe.hasAudio, false);
  assert.ok(existsSync(path.join(added.directory, added.source.mediaPath)));
  assert.equal(addReference({ file, libraryRoot: library }).reused, true);

  const other = path.join(root, "other.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc=s=64x36:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", other]);
  assert.equal(addReference({ file: other, libraryRoot: library }).source.rights.status, "unknown");
  assert.throws(
    () => addReference({ file: other, id: "my-film", libraryRoot: library }),
    /already holds different media/,
  );
  assert.throws(() => addReference({ file: other, id: "Bad/Id", libraryRoot: library }), /lower-case/);
});

test("ref:add reports a failed download and asks for a file", (t) => {
  const root = workspace(t);
  const fake = path.join(root, "uvx");
  writeFileSync(fake, "#!/bin/sh\necho 'ERROR: Sign in to confirm you are not a bot' >&2\nexit 1\n", { mode: 0o755 });
  const previous = process.env.REFERENCE_UVX;
  process.env.REFERENCE_UVX = fake;
  t.after(() => {
    if (previous === undefined) delete process.env.REFERENCE_UVX;
    else process.env.REFERENCE_UVX = previous;
  });
  assert.throws(
    () => addReference({ url: "https://example.com/watch/abc", libraryRoot: root }),
    /needs a login.*Ask the user for the video file/s,
  );
  process.env.REFERENCE_UVX = "/nonexistent/uvx";
  assert.throws(
    () => addReference({ url: "https://example.com/watch/abc", libraryRoot: root }),
    /uv is not available.*--file/s,
  );
  assert.throws(
    () => addReference({ url: "file:///etc/passwd", libraryRoot: root }),
    /Only public http and https links/,
  );
});

test("the ffmpeg fallback finds real cuts and picks a soft change the 0.3 threshold misses", (t) => {
  withoutUv(t);
  const root = workspace(t);
  const film = path.join(root, "film.mp4");
  syntheticFilm(film);
  const { boundaries, detector, status } = detectBoundaries(film);
  assert.equal(detector.name, "ffmpeg-scene-score");
  assert.ok(status.fix);
  const near = (time: number, reach: number) => boundaries.find((row) => Math.abs(row.timeSec - time) <= reach);
  assert.equal(near(2, 0.05)?.kind, "cut");
  assert.equal(near(7, 0.05)?.kind, "cut");
  assert.ok(near(4.5, 0.6), `soft change in ${JSON.stringify(boundaries)}`);
  const atThreshold = detectSceneChanges(film, 0.3);
  assert.ok(atThreshold.some((time) => Math.abs(time - 2) < 0.05));
  assert.ok(!atThreshold.some((time) => time > 3.5 && time < 5.5), "the old threshold sees nothing in the crossfade");
});

test("looped hallucinated words are dropped, ordinary repeats stay", () => {
  const texts = ["no", "no", "ḍ", "ḍ", "ḍ", "ḍ", "ḍ", "ḍ", "real", "words"];
  const rows = texts.map((text, index) => ({
    text: ` ${text}`,
    offsets: { from: index * 500, to: index * 500 + 400 },
  }));
  const words = speechWordsFromRows(
    {
      version: 1,
      method: "native-word-segments-v1",
      estimated: true,
      reviewRequired: true,
      status: "available",
      rawRows: rows,
    },
    10,
  );
  assert.deepEqual(
    dropRepeatedWords(words).kept.map((word) => word.text),
    ["no", "no", "real", "words"],
  );
  assert.equal(dropRepeatedWords(words).dropped, 6);
});

test("score peaks follow the film's own level", () => {
  const curve = Array.from({ length: 300 }, (_, index) => ({
    timeSec: index / 30,
    score: index === 90 ? 0.09 : index === 200 ? 0.8 : 0.002,
  }));
  const peaks = pickScorePeaks(curve);
  assert.deepEqual(
    peaks.map((row) => row.timeSec),
    [3, 200 / 30],
  );
  assert.ok(peaks.every((row) => row.kind === "cut"));
  assert.deepEqual(pickScorePeaks([]), []);
});

test("shots layer numbers shots, summarises and keeps transition spans", () => {
  const layer = shotsLayer(
    "demo",
    10,
    [
      { timeSec: 2, startSec: 2, endSec: 2, kind: "cut", confidence: 0.9 },
      { timeSec: 6, startSec: 5.5, endSec: 6.5, kind: "dissolve", confidence: 0.8 },
    ],
    { name: "test", params: {} },
  );
  assert.deepEqual(
    layer.shots.map((shot) => shot.id),
    ["s001", "s002", "s003"],
  );
  assert.equal(layer.shots[1]!.transitionStartSec, undefined);
  assert.equal(layer.shots[2]!.transitionStartSec, 5.5);
  assert.equal(layer.summary.count, 3);
  assert.equal(layer.summary.cutsPerMinute, 12);
});

test("sync reports hits next to what chance would give", () => {
  assert.equal(hitRatio([1, 2.2], [1, 2], 0.08), 0.5);
  assert.equal(hitRatio([], [1], 0.08), undefined);
  assert.equal(chanceRatio([1, 2, 3, 4], 0.1, 4), 0.175);
  const shots = shotsLayer(
    "demo",
    10,
    [
      { timeSec: 2, startSec: 2, endSec: 2, kind: "cut", confidence: 0.9 },
      { timeSec: 3.3, startSec: 3.3, endSec: 3.3, kind: "cut", confidence: 0.9 },
    ],
    { name: "test", params: {} },
  );
  const sync = buildSync({
    referenceId: "demo",
    durationSec: 10,
    shots,
    audio: {
      schemaVersion: 1,
      referenceId: "demo",
      hasAudio: true,
      tempo: { bpm: 120, confidence: 1, beatsSec: Array.from({ length: 20 }, (_, i) => i / 2), downbeatsSec: [] },
      onsetsSec: [2],
      sections: [],
      silence: [],
    },
    speechText: {
      schemaVersion: 1,
      referenceId: "demo",
      speech: {
        available: true,
        words: [
          { text: "a", startSec: 1, endSec: 1.2 },
          { text: "b", startSec: 1.3, endSec: 1.4 },
          { text: "c", startSec: 3, endSec: 3.2 },
        ],
      },
      screenText: {
        available: true,
        items: [
          { text: "x", startSec: 2.8, endSec: 4, onsetSec: 3 },
          { text: "y", startSec: 3.1, endSec: 4, onsetSec: 3.27 },
        ],
      },
    },
  });
  assert.equal(sync.metrics.cutsOnBeatRatio, 0.5);
  assert.equal(sync.metrics.cutsOnBeatChance, 0.312);
  assert.equal(sync.metrics.cutsOnOnsetRatio, 0.5);
  assert.equal(sync.metrics.textOnBeatRatio, 0.5);
  assert.equal(sync.textToleranceSec, 0.08);
  assert.deepEqual(sync.events.find((event) => event.timeSec === 2)!.kinds.sort(), ["beat", "cut", "onset"]);
  assert.equal(sync.events.filter((event) => event.kinds.includes("speech-start")).length, 2);
  assert.equal(buildSync({ referenceId: "demo", durationSec: 10 }).status?.available, false);
});

test("compare metrics measure real distances", () => {
  assert.deepEqual(cutDistance([1, 2], [1.05, 5]), {
    referenceCount: 2,
    renderCount: 2,
    meanNearestSec: 1.012,
    toleranceSec: 0.1,
    referenceMatched: 0.5,
    renderMatched: 0.5,
  });
  assert.equal(pearson([1, 2, 3], [2, 4, 6]), 1);
  assert.equal(pearson([1, 2], [1, 2]), undefined);
  const red = RgbImage.filled(8, 8, [220, 30, 30]);
  const blue = RgbImage.filled(8, 8, [30, 30, 220]);
  assert.ok(paletteDistance(extractPalette(red), extractPalette(red)) < 0.01);
  assert.ok(paletteDistance(extractPalette(red), extractPalette(blue)) > 50);
});

test("without uv, analysis still produces every layer through fallbacks, with fixes", async (t) => {
  withoutUv(t);
  const root = workspace(t);
  const film = path.join(root, "film.mp4");
  syntheticFilm(film);
  const library = path.join(root, "library");
  const { directory } = addReference({ file: film, id: "film", libraryRoot: library });
  const result = await analyseReference({
    libraryRoot: library,
    id: "film",
    layers: parseLayers(undefined),
    engineDir: path.join(root, "no-engines"),
  });

  const shots = readLayer(directory, "shots.json")!;
  assert.equal(shots.detector.name, "ffmpeg-scene-score");
  assert.ok(shots.shots.some((shot) => Math.abs(shot.startSec - 2) < 0.05));
  assert.ok(shots.shots.every((shot) => shot.stripPath && existsSync(path.join(directory, shot.stripPath))));

  const speech = readLayer(directory, "speech-text.json")!;
  assert.equal(speech.speech.available, false);
  assert.match(speech.speech.fix!, /media-prepare/);

  const audio = readLayer(directory, "audio.json")!;
  assert.ok(audio.status?.fix);
  assert.ok(audio.tempo, "the existing RMS kernel handles a clean click track");
  assert.ok(Math.abs(audio.tempo!.bpm - 120) < 3, `bpm ${audio.tempo!.bpm}`);
  assert.ok(audio.loudness?.integratedLufs !== undefined);

  const motion = readLayer(directory, "motion.json")!;
  assert.equal(motion.method, "ffmpeg-frame-difference");
  assert.equal(motion.shots.length, shots.shots.length);
  assert.ok(motion.energyCurve.length > 50);

  const sync = readLayer(directory, "sync.json")!;
  assert.equal(sync.metrics.cutCount, shots.shots.length - 1);
  assert.ok(sync.metrics.cutsOnBeatRatio! > sync.metrics.cutsOnBeatChance!, "the 2 s and 7 s cuts land on clicks");

  assert.ok(existsSync(path.join(directory, "visuals/edit-map.png")));
  assert.ok(existsSync(path.join(directory, "visuals/contact-sheet-01.jpg")));
  assert.ok(existsSync(path.join(directory, "visuals/boundaries-01.jpg")));
  assert.deepEqual(result.layers.visuals, { available: true });

  const report = validateReference(directory);
  assert.deepEqual(report.invalid, []);
  assert.deepEqual(report.missingMeasured, []);
  assert.equal(report.missingJudged.length, 5);
  assert.ok(report.unavailable.some((row) => row.file === "speech-text.json"));

  writeFileSync(path.join(directory, "story.json"), JSON.stringify({ schemaVersion: 1 }));
  assert.equal(validateReference(directory).invalid[0]?.file, "story.json");

  const render = path.join(root, "render.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    render,
  ]);
  const compared = compareReference({ libraryRoot: library, id: "film", render });
  assert.ok(compared.outputs.every((file) => existsSync(file)));
  assert.equal(compared.result.durationSec.difference, -5);
  assert.ok(typeof compared.result.palette.meanDistance === "number");
  const written = JSON.parse(readFileSync(path.join(directory, "compare/compare.json"), "utf8"));
  assert.equal(written.referenceId, "film");
});

test("a film without audio reports it instead of failing", async (t) => {
  withoutUv(t);
  const root = workspace(t);
  const film = path.join(root, "silent.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", film]);
  const library = path.join(root, "library");
  const { directory } = addReference({ file: film, id: "silent", libraryRoot: library });
  await analyseReference({ libraryRoot: library, id: "silent", layers: ["audio", "visuals"] }).catch((error) =>
    assert.fail(error),
  );
  const audio = readLayer(directory, "audio.json")!;
  assert.equal(audio.hasAudio, false);
  assert.equal(audio.status?.available, false);
});

test("the scripts follow the JSON contract", (t) => {
  const root = workspace(t);
  const missing = runCli("ref-validate.ts", ["--id", "nothing", "--library-root", root]);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "FILE_NOT_FOUND");
  assert.equal(runCli("ref-add.ts", ["--library-root", root]).error, "INVALID_INPUT");
  assert.equal(
    runCli("ref-analyze.ts", ["--id", "x", "--library-root", root, "--layers", "nope"]).error,
    "INVALID_INPUT",
  );
});

test(
  "the worker separates cuts and classifies gradual transitions",
  { skip: gated ? false : "set RUN_REFERENCE_UV=1 (needs uv and a first package download)" },
  async (t) => {
    const root = workspace(t);
    for (const [transition, expected] of [
      ["dissolve", "dissolve"],
      ["fadeblack", "fade"],
      ["wipeleft", "wipe"],
    ] as const) {
      const film = path.join(root, `${transition}.mp4`);
      syntheticFilm(film, transition);
      const { boundaries, detector } = detectBoundaries(film);
      assert.match(detector.name, /pyscenedetect/);
      const cuts = boundaries.filter((row) => row.kind === "cut" || row.kind === "match");
      assert.ok(
        cuts.some((row) => Math.abs(row.timeSec - 2) <= 0.05),
        `${transition}: cut at 2 s in ${JSON.stringify(boundaries)}`,
      );
      assert.ok(
        cuts.some((row) => Math.abs(row.timeSec - 7) <= 0.05),
        `${transition}: cut at 7 s in ${JSON.stringify(boundaries)}`,
      );
      const soft = boundaries.filter((row) => row.timeSec > 3.5 && row.timeSec < 5.5);
      assert.equal(soft.length, 1, `${transition}: one transition in ${JSON.stringify(boundaries)}`);
      assert.equal(soft[0]!.kind, expected, JSON.stringify(soft[0]));
      assert.ok(Math.abs(soft[0]!.timeSec - 4.5) <= 0.4, `${transition}: centre ${soft[0]!.timeSec}`);
      assert.ok(soft[0]!.endSec > soft[0]!.startSec);
    }
  },
);

test(
  "the uv layers measure tempo and motion on known media",
  { skip: gated ? false : "set RUN_REFERENCE_UV=1 (needs uv and a first package download)" },
  async (t) => {
    const root = workspace(t);
    const film = path.join(root, "film.mp4");
    syntheticFilm(film);
    const library = path.join(root, "library");
    const { directory } = addReference({ file: film, id: "film", libraryRoot: library });
    await analyseReference({ libraryRoot: library, id: "film", layers: ["shots", "audio", "motion", "sync"] });
    const audio = readLayer(directory, "audio.json")!;
    assert.match(audio.status!.engine!, /librosa/);
    assert.ok(Math.abs(audio.tempo!.bpm - 120) < 1, `bpm ${audio.tempo!.bpm}`);
    const beats = audio.tempo!.beatsSec;
    assert.ok(beats.length >= 14);
    assert.ok(
      beats.every((beat) => Math.abs(beat - Math.round(beat * 2) / 2) < 0.06),
      "beats sit on the clicks",
    );
    assert.ok(audio.onsetsSec.length >= 14);
    const motion = readLayer(directory, "motion.json")!;
    assert.match(motion.method, /farneback/);
    assert.equal(motion.shots.length, readLayer(directory, "shots.json")!.shots.length);
    assert.ok(motion.shots.some((shot) => shot.peakEnergy > 0));
    assert.ok(
      motion.shots.find((shot) => shot.shotId === "s002")!.meanEnergy < motion.shots[0]!.meanEnergy,
      "bars hold still; testsrc2 moves",
    );
  },
);

test(
  "camera estimates name known moves",
  { skip: gated ? false : "set RUN_REFERENCE_UV=1 (needs uv and a first package download)" },
  async (t) => {
    const root = workspace(t);
    const cases = [
      [
        "static",
        "testsrc2=s=640x360:r=30:d=3,drawbox=c=black:t=fill:x=0:y=0:w=0:h=0,select='lt(n\\,1)',loop=loop=89:size=1:start=0,setpts=N/30/TB",
      ],
      ["pan", "mandelbrot=s=1280x360:r=30,trim=duration=3,crop=640:360:'t*100':0"],
      ["tilt", "mandelbrot=s=640x720:r=30,trim=duration=3,crop=640:360:0:'t*100'"],
      [
        "zoom",
        "testsrc2=s=1280x720:r=30:d=3,select='lt(n\\,1)',loop=loop=89:size=1:start=0,setpts=N/30/TB,scale=w='2*trunc((960+n*4)/2)':h='2*trunc((540+n*2.25)/2)':eval=frame:flags=bicubic,crop=640:360",
      ],
    ] as const;
    for (const [expected, filter] of cases) {
      const film = path.join(root, `${expected}.mp4`);
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        filter,
        "-frames:v",
        "90",
        "-c:v",
        "libx264",
        "-qp",
        "12",
        "-pix_fmt",
        "yuv420p",
        film,
      ]);
      const library = path.join(root, `library-${expected}`);
      const { directory } = addReference({ file: film, id: "film", libraryRoot: library });
      await analyseReference({ libraryRoot: library, id: "film", layers: ["motion"] });
      assert.equal(readLayer(directory, "motion.json")!.shots[0]!.cameraEstimate, expected);
    }
  },
);
