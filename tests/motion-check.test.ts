import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyAllow,
  mergeOccurrences,
  parseAllow,
  selectFrames,
  splitIntended,
  tally,
  type Occurrence,
} from "../src/lib/sensors/findings";
import { determinismSample } from "../src/lib/sensors/motion-check";
import type { MeasuredText } from "../src/lib/sensors/page-measure";
import {
  checkDeadFrames,
  checkFadedFinal,
  comparePixels,
  differsVisibly,
  measurePixels,
} from "../src/lib/sensors/pixels";
import {
  backdropBlurPx,
  centredShare,
  hasEmoji,
  inSlopBand,
  isCentred,
  isSlopGradient,
  parseColours,
  simultaneousEntries,
  slopFilmOccurrences,
  slopFrameOccurrences,
} from "../src/lib/sensors/slop-signatures";
import {
  checkText,
  dropTransits,
  fallbackRuns,
  findOverlap,
  recordPositions,
  type TextPositions,
} from "../src/lib/sensors/text-checks";

const repo = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repo, "node_modules/tsx/dist/cli.mjs");

const text = (name: string, x: number, y: number, extra: Partial<MeasuredText> = {}): MeasuredText => {
  const lines = [{ x, y, width: 100, height: 20 }];
  return {
    index: 0,
    text: name,
    lines,
    regionLines: lines,
    opacity: 1,
    family: "sans-serif",
    weight: "400",
    style: "normal",
    names: [],
    label: "div",
    elementId: Math.floor(x + y * 1000),
    ancestorIds: [],
    clipPath: false,
    align: "start",
    colour: "rgb(255, 255, 255)",
    block: `div|${name}`,
    fader: null,
    ...extra,
  };
};
const occurrence = (frame: number, extra: Partial<Occurrence> = {}): Occurrence => ({
  code: "TEXT_OVERLAP",
  frame,
  key: "a",
  message: "m",
  fix: "f",
  text: ["Hello"],
  elements: ["title"],
  ...extra,
});

test("frame selection covers a sample step with both ends, and ranges", () => {
  assert.deepEqual(selectFrames(undefined, 12), [0, 5, 10, 11]);
  assert.deepEqual(selectFrames("5", 11), [0, 5, 10]);
  assert.deepEqual(selectFrames("2-4", 10), [2, 3, 4]);
  assert.deepEqual(selectFrames("0-6:3", 10), [0, 3, 6]);
  assert.throws(() => selectFrames("0-10", 10), /within 0-9/);
  assert.throws(() => selectFrames("nope", 10), /range/);
});

test("the determinism sample skips the frame the page opens on and stays small", () => {
  assert.deepEqual(determinismSample([0]), []);
  assert.deepEqual(determinismSample([0, 5]), [5]);
  assert.equal(determinismSample(Array.from({ length: 100 }, (_, index) => index)).length, 3);
  assert.ok(!determinismSample(Array.from({ length: 100 }, (_, index) => index)).includes(0));
});

test("allow rules match by code, frames, text and element, and need a reason", () => {
  const rule = (extra: object) => parseAllow(JSON.stringify({ code: "TEXT_OVERLAP", reason: "by design", ...extra }));
  assert.equal(applyAllow([occurrence(5)], rule({})).kept.length, 0);
  assert.equal(applyAllow([occurrence(5)], rule({ frames: "6-9" })).kept.length, 1);
  assert.equal(applyAllow([occurrence(5)], rule({ frames: 5 })).kept.length, 0);
  assert.equal(applyAllow([occurrence(5)], rule({ text: "ell" })).kept.length, 0);
  assert.equal(applyAllow([occurrence(5)], rule({ text: "nope" })).unusedAllow.length, 1);
  assert.equal(applyAllow([occurrence(5)], rule({ element: "title" })).kept.length, 0);
  assert.throws(() => parseAllow('{"code":"TEXT_OVERLAP"}'), /--allow/);
  assert.throws(() => parseAllow('{"code":"NOPE","reason":"x"}'), /--allow/);
  assert.throws(() => parseAllow("missing-file.json"), /neither JSON nor a file/);
});

test("occurrences merge into one finding, and counters tell skipped from zero", () => {
  const merged = mergeOccurrences([occurrence(10), occurrence(5), occurrence(15)]);
  assert.equal(merged.length, 1);
  assert.deepEqual([merged[0]!.frame, merged[0]!.lastFrame, merged[0]!.occurrences], [5, 15, 3]);
  const counters = tally([occurrence(1), occurrence(2)], { loopSeam: "pass --loop-frames" });
  assert.equal(counters.textOverlap, 2);
  assert.equal(counters.textOffStage, 0);
  assert.equal(counters.loopSeam, null);
});

test("overlap ignores faint, related, masked and layered text", () => {
  assert.ok(findOverlap(text("a", 0, 0), text("b", 10, 5)));
  assert.equal(findOverlap(text("a", 0, 0), text("b", 500, 500)), undefined);
  assert.equal(findOverlap(text("a", 0, 0, { opacity: 0.5 }), text("b", 10, 5, { opacity: 0.5 })), undefined);
  assert.equal(
    findOverlap(text("a", 0, 0, { elementId: 1 }), text("b", 10, 5, { elementId: 2, ancestorIds: [1] })),
    undefined,
  );
  assert.equal(findOverlap(text("a", 0, 0, { clipPath: true }), text("b", 10, 5)), undefined);
  assert.equal(findOverlap(text("same", 0, 0), text("same", 0, 0)), undefined);
  assert.equal(findOverlap(text("a", 0, 0), text("b", 99.5, 0)), undefined);
});

test("text findings name the text, its box and the distance to move", () => {
  const stage = { width: 200, height: 100 };
  const [off] = checkText(3, [text("Wide headline", 150, 10)], stage);
  assert.equal(off!.code, "TEXT_OFF_STAGE");
  assert.match(off!.message, /"Wide headline".*x=150 y=10 w=100 h=20.*50px past the right/);
  assert.deepEqual(checkText(3, [text("Fits", 50, 10)], stage), []);
  assert.deepEqual(
    checkText(3, [text("Gone", 50, 10, { lines: [{ x: stage.width + 5, y: 0, width: 50, height: 10 }] })], stage),
    [],
    "wholly off stage cannot be seen",
  );
  const at = (x: number) => text("Mover", 150, 10, { lines: [{ x, y: 10, width: 150, height: 10 }] });
  const crossing = (second: number) => {
    const positions: TextPositions = new Map();
    recordPositions(positions, 0, [at(second)]);
    recordPositions(positions, 5, [at(stage.width - 100)]);
    return dropTransits(checkText(5, [at(stage.width - 100)], stage), positions, stage).length;
  };
  assert.equal(crossing(stage.width - 100), 1, "resting across the edge is a fault");
  assert.equal(crossing(-1000), 0, "passing the edge at speed is motion");
  const safe = checkText(3, [text("Fits", 50, 10)], stage, { top: 20, bottom: 0, sides: 0 });
  assert.equal(safe[0]!.code, "TEXT_OUTSIDE_SAFE_ZONE");
  assert.match(safe[0]!.message, /10px past the top/);
  const region = { name: "panel", rect: { x: 50, y: 10, width: 40, height: 40 } };
  assert.equal(checkText(3, [text("Fits", 50, 10, { region })], stage)[0]!.code, "TEXT_OUTSIDE_REGION");
});

test("a block's data-overflow on a frame reports its off-stage and safe-zone text as intended; the same text without it still fails", () => {
  const stage = { width: 200, height: 100 };
  const zone = { top: 20, bottom: 0, sides: 0 };
  const declared = (frame: number, x: number, y: number) =>
    checkText(
      frame,
      [text("Giant", x, y, { overflow: "giant-word-pull-out: starts wider than the frame" })],
      stage,
      zone,
    );
  const occurrences = [
    ...declared(0, 150, 30),
    ...declared(1, 140, 30),
    ...declared(2, 50, 10),
    ...checkText(9, [text("Giant", 150, 30)], stage, zone),
  ];
  const { kept, intended } = splitIntended(occurrences);
  assert.deepEqual(
    intended.map(({ code, frame, lastFrame, occurrences: count, reason }) => [code, frame, lastFrame, count, reason]),
    [
      ["TEXT_OFF_STAGE", 0, 1, 2, "giant-word-pull-out: starts wider than the frame"],
      ["TEXT_OUTSIDE_SAFE_ZONE", 2, 2, 1, "giant-word-pull-out: starts wider than the frame"],
    ],
  );
  assert.deepEqual(
    kept.map(({ code, frame }) => [code, frame]),
    [["TEXT_OFF_STAGE", 9]],
    "resting off stage without the declaration is a finding",
  );
  const region = { name: "panel", rect: { x: 50, y: 10, width: 40, height: 40 } };
  assert.equal(
    splitIntended(checkText(3, [text("Fits", 50, 30, { region, overflow: "by design" })], stage)).kept[0]!.code,
    "TEXT_OUTSIDE_REGION",
    "a region overflow is never excused",
  );
});

test("a fallback is a run outside the first family, except emoji and generic stacks", () => {
  const custom = { familyName: "Inter", isCustomFont: true, glyphCount: 5 };
  const system = { familyName: "Helvetica", isCustomFont: false, glyphCount: 5 };
  assert.deepEqual(fallbackRuns("Inter, sans-serif", [custom], ["Inter"]), []);
  assert.deepEqual(fallbackRuns("Inter, sans-serif", [custom, system], ["Inter"]), [system]);
  assert.deepEqual(fallbackRuns("sans-serif", [system], []), []);
  assert.deepEqual(
    fallbackRuns("Inter", [{ familyName: "Apple Color Emoji", isCustomFont: false, glyphCount: 1 }], ["Inter"]),
    [],
  );
  assert.deepEqual(
    fallbackRuns('"My Alias"', [{ familyName: "Inter Regular", isCustomFont: true, glyphCount: 5 }], ["My Alias"]),
    [],
  );
  const second = { familyName: "Noto Sans", isCustomFont: true, glyphCount: 5 };
  assert.deepEqual(fallbackRuns('Inter, "Noto Sans"', [second], ["Inter", "Noto Sans"]), [second]);
  assert.deepEqual(fallbackRuns("Arial", [{ familyName: "Arial", isCustomFont: false, glyphCount: 5 }], []), []);
});

test("pixel measures find dead frames, fades and where frames differ", () => {
  const solid = (value: number) => Buffer.alloc(30, value);
  const dead = measurePixels(0, solid(0));
  assert.ok(dead.nearBlack);
  assert.equal(checkDeadFrames([dead])[0]!.code, "DEAD_FRAME");
  assert.equal(measurePixels(0, solid(200)).singleColour, "#c8c8c8");
  const mixed = solid(200);
  mixed[9] = 0;
  assert.deepEqual(checkDeadFrames([measurePixels(1, mixed)]), []);
  const flat = (frame: number) => measurePixels(frame, solid(200));
  const alive = (frame: number) => measurePixels(frame, mixed);
  assert.deepEqual(checkDeadFrames([alive(0), flat(5), alive(10), alive(15)]), [], "a flat beat inside a transition");
  assert.deepEqual(
    checkDeadFrames([alive(0), flat(5), flat(10), alive(15)]).map((item) => item.frame),
    [5, 10],
    "a run a viewer notices",
  );
  assert.deepEqual(
    checkDeadFrames([flat(0), alive(5), flat(10)]).map((item) => item.frame),
    [0, 10],
    "the poster and last frames",
  );
  assert.deepEqual(
    checkDeadFrames([alive(0), measurePixels(5, solid(0)), alive(10)]).map((item) => item.frame),
    [5],
    "a black flash",
  );
  assert.equal(checkFadedFinal(measurePixels(29, solid(20)), measurePixels(14, solid(200)))[0]!.code, "FADED_FINAL");
  assert.deepEqual(checkFadedFinal(measurePixels(29, solid(190)), measurePixels(14, solid(200))), []);
  assert.deepEqual(checkFadedFinal(measurePixels(29, solid(5)), measurePixels(14, solid(15))), []);
  assert.match(comparePixels(mixed, solid(200), 5), /10\.0% of pixels differ, within x=3 y=0 w=1 h=1/);
  assert.equal(comparePixels(solid(1), solid(1), 5), "no pixels differ");
  assert.equal(differsVisibly(solid(100), solid(102)), false, "raster noise on a text edge");
  assert.equal(differsVisibly(solid(100), solid(120)), true);
});

test("slop signatures: emoji, the purple-blue band, gradients and glass", () => {
  assert.ok(hasEmoji("Launch 🚀"));
  assert.ok(hasEmoji("Love ❤️"));
  assert.ok(hasEmoji("🇬🇧"));
  for (const plain of ["© 2026 Acme™", "Swipe → next", "★ 4.9", "50% off", "Привет"])
    assert.equal(hasEmoji(plain), false, plain);
  assert.ok(inSlopBand({ r: 99, g: 102, b: 241, a: 1 }), "indigo-500");
  assert.ok(inSlopBand({ r: 139, g: 92, b: 246, a: 1 }), "violet-500");
  assert.equal(inSlopBand({ r: 236, g: 72, b: 153, a: 1 }), false, "pink is outside the band");
  assert.equal(inSlopBand({ r: 120, g: 120, b: 130, a: 1 }), false, "grey has no hue");
  assert.equal(inSlopBand({ r: 10, g: 8, b: 30, a: 1 }), false, "near black");
  assert.ok(isSlopGradient("linear-gradient(135deg, rgb(99, 102, 241) 0%, rgb(139, 92, 246) 100%)"));
  assert.ok(isSlopGradient("radial-gradient(#6366f1, #8b5cf6)"));
  assert.equal(
    isSlopGradient("linear-gradient(rgb(99, 102, 241), rgb(236, 72, 153))"),
    false,
    "violet to pink crosses families",
  );
  assert.equal(isSlopGradient("linear-gradient(rgb(99, 102, 241), rgba(0, 0, 0, 0))"), false, "one visible stop");
  assert.equal(
    isSlopGradient("linear-gradient(oklch(0.6 0.2 280), oklch(0.5 0.2 300))"),
    false,
    "unparsed colours are skipped, not guessed",
  );
  assert.deepEqual(parseColours("rgba(1, 2, 3, 0.5) #fff"), [
    { r: 1, g: 2, b: 3, a: 0.5 },
    { r: 255, g: 255, b: 255, a: 1 },
  ]);
  assert.equal(backdropBlurPx("blur(12px) saturate(1.4)"), 12);
  assert.equal(backdropBlurPx("none"), 0);
  const found = slopFrameOccurrences(3, {
    texts: [text("Ship it 🚀", 0, 0)],
    gradients: [{ label: "div#bg", value: "linear-gradient(rgb(99, 102, 241), rgb(139, 92, 246))" }],
    backdrops: [
      { label: "div#card", value: "blur(16px)" },
      { label: "div#soft", value: "blur(2px)" },
    ],
  });
  assert.deepEqual(
    found.map((item) => item.code),
    ["EMOJI_TEXT", "SLOP_PALETTE", "SLOP_PALETTE"],
  );
  assert.ok(found.every((item) => item.fix.length > 20));
});

test("centred share needs enough text frames and every block on the centre line", () => {
  const box = (x: number) => ({ x, y: 0, width: 200, height: 40 });
  assert.equal(isCentred(box(440), 1080), true);
  assert.equal(isCentred(box(100), 1080), false);
  assert.equal(centredShare([[box(440)], [box(440)], [box(440)]], 1080).share, null, "too few frames");
  assert.equal(centredShare([[box(440)], [box(440)], [box(440), box(100)], [box(440)], []], 1080).share, 0.75);
  const samples = (x: number) =>
    [0, 5, 10, 15, 20].map((frame) => ({ frame, texts: [text("Title", x, 100, { align: "center" })] }));
  assert.deepEqual(
    slopFilmOccurrences(samples(540 - 50), { width: 1080 }).map((item) => item.code),
    ["TEXT_CENTRED_ALWAYS"],
  );
  assert.deepEqual(slopFilmOccurrences(samples(40), { width: 1080 }), []);
});

test("simultaneous entry: three blocks rising together the same way, not staggered, not cut in, not one fader", () => {
  const at = (opacity: number, y: number, mover: number | null = null) => ({
    opacity,
    box: { x: 0, y, width: 100, height: 20 },
    mover,
  });
  const track = (entries: [number, ReturnType<typeof at>][]) => new Map(entries);
  const frames = [0, 5, 10, 15];
  const together = new Map([
    [
      "a",
      track([
        [5, at(0.3, 110, 1)],
        [10, at(0.8, 100, 1)],
        [15, at(1, 100, 1)],
      ]),
    ],
    [
      "b",
      track([
        [5, at(0.3, 210, 2)],
        [10, at(0.8, 200, 2)],
        [15, at(1, 200, 2)],
      ]),
    ],
    [
      "c",
      track([
        [5, at(0.3, 310, 3)],
        [10, at(0.8, 300, 3)],
        [15, at(1, 300, 3)],
      ]),
    ],
  ]);
  assert.deepEqual(simultaneousEntries(together, frames), [{ frame: 5, keys: ["a", "b", "c"] }]);
  const staggered = new Map(together);
  staggered.set(
    "c",
    track([
      [5, at(0.1, 320, 3)],
      [10, at(0.5, 305, 3)],
      [15, at(1, 300, 3)],
    ]),
  );
  assert.deepEqual(
    simultaneousEntries(staggered, frames),
    [],
    "a later start shows as a different opacity on the shared sample",
  );
  const oneFader = new Map(
    [...together].map(([key, value]) => [
      key,
      new Map([...value].map(([frame, sample]) => [frame, { ...sample, mover: 9 }])),
    ]),
  );
  assert.deepEqual(simultaneousEntries(oneFader, frames), [], "one parent fading three lines is one element");
  const cutIn = new Map(
    [...together].map(([key]) => [
      key,
      track([
        [5, at(1, 100)],
        [10, at(1, 100)],
      ]),
    ]),
  );
  assert.deepEqual(simultaneousEntries(cutIn, frames), [], "a hard cut into a layout is not an entrance");
  const present = new Map(
    [...together].map(([key]) => [
      key,
      track([
        [0, at(0.3, 110)],
        [5, at(0.8, 100)],
      ]),
    ]),
  );
  assert.deepEqual(simultaneousEntries(present, frames), [], "visible on the first frame");
  const film = slopFilmOccurrences(
    frames.map((frame) => ({
      frame,
      texts: ["One", "Two", "Three"]
        .map((name, index) =>
          text(name, 40, 100 * (index + 1) + (frame === 5 ? 10 : 0), {
            opacity: frame === 0 ? 0 : frame === 5 ? 0.3 : 1,
            fader: index + 1,
          }),
        )
        .filter((item) => item.opacity > 0),
    })),
    { width: 1080 },
  );
  assert.deepEqual(
    film.map((item) => item.code),
    ["SIMULTANEOUS_ENTRY"],
  );
  assert.match(film[0]!.message, /3 elements start entering on frame 5/);
});

test("--help answers offline, and --phone draws tiles at phone width", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "motion-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = (script: string, args: string[]) => {
    const child = spawnSync(process.execPath, [tsx, path.join(repo, "scripts", script), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
    });
    return JSON.parse(child.stdout.trim());
  };
  assert.equal(cli("motion-check.ts", ["--help"]).ok, true);
  const video = path.join(root, "v.mp4");
  assert.equal(
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=1080x1920:r=30:d=1",
      "-pix_fmt",
      "yuv420p",
      video,
    ]).status,
    0,
  );
  const strip = cli("motion-strip.ts", [
    "--input",
    video,
    "--output",
    path.join(root, "s.png"),
    "--start-frame",
    "0",
    "--end-frame",
    "0",
    "--columns",
    "1",
    "--phone",
  ]);
  assert.equal(strip.metadata.width, 398, JSON.stringify(strip));
  assert.equal(strip.metadata.phone, true);
  const sheet = cli("review-sheet.ts", ["--input", video, "--output", path.join(root, "r.png"), "--phone"]);
  assert.equal(sheet.metadata.frames.length, 6, JSON.stringify(sheet));
  assert.equal(
    cli("motion-strip.ts", ["--input", video, "--output", path.join(root, "x.png"), "--phone", "--width", "200"]).error,
    "INVALID_INPUT",
  );
});

test("compareDeterminism captures a mismatch again and reports it only if it persists", async () => {
  const { compareDeterminism } = await import("../src/lib/sensors/motion-check");
  const width = 4;
  const frame = (value: number) => Buffer.alloc(width * 4 * 3, value);
  const same = frame(100);
  const off = frame(160);
  const queue =
    (...items: Buffer[]) =>
    async () =>
      items.shift()!;

  assert.equal((await compareDeterminism(same, queue(same), queue(), width)).verdict, "same");

  const flaky = await compareDeterminism(same, queue(off, same), queue(same), width);
  assert.equal(flaky.verdict, "flaky");
  assert.match(flaky.first, /pixels differ/);
  assert.equal(flaky.retry, undefined);

  const differs = await compareDeterminism(same, queue(off, off), queue(same), width);
  assert.equal(differs.verdict, "differs");
  assert.match(differs.retry ?? "", /pixels differ/);
});
