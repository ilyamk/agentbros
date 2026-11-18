import test from "node:test";
import assert from "node:assert/strict";
import {
  arcGlyphs,
  arrivalTint,
  backspaceByChar,
  caseFlipCount,
  chipSlots,
  focalAt,
  glyphShapePhases,
  inkIn,
  joltOffset,
  markedGroups,
  marqueeCopies,
  marqueeTravel,
  mixHex,
  otherCase,
  pillGrow,
  pillState,
  retypeSlotState,
  rollupValue,
  scanReveal,
  scrapPlan,
  settleTrack,
  stampPose,
  wrapCentred,
} from "../src/motion/text-modes";
import { caretMarkAt, caretTextAt, caretTypingPlan, deleteSteps, retypeLinePlan } from "../src/motion/type-track";
import {
  caretTrackCues,
  caretTrackDefaults,
  caretTrackPlan,
  caretTrackRetypeCharPreset,
  caretTrackRetypeWordPreset,
  caretTrackSchema,
} from "../src/motion/library/typography/CaretTrack";
import { planCaptionFrame, presetLayout, contrastPairs, type Measure } from "../src/motion/library/captions/plan";
import { CAPTION_PRESETS, captionStyleSchema, cleanSentenceSwitchPreset } from "../src/motion/library/captions/style";
import { timedWords } from "../src/motion/library/captions/sample";

// --- A4 ---

test("backspaceByChar deletes 1-2 characters a frame down to the kept prefix", () => {
  const keys = backspaceByChar("Your headline", "", 10, 1.5);
  assert.equal(keys[0]!.frame, 10);
  for (let i = 1; i < keys.length; i++) {
    const removed = keys[i - 1]!.text.length - keys[i]!.text.length;
    assert.ok(removed >= 1 && removed <= 2, `frame ${keys[i]!.frame}: ${removed}`);
    assert.equal(keys[i]!.frame, keys[i - 1]!.frame + 1);
  }
  assert.equal(keys.at(-1)!.text, "");
  assert.ok(keys.length >= 8 && keys.length <= 10);
});

test("caretTypingPlan deletes by character, waits 6 empty frames, then retypes at 2 a frame", () => {
  const plan = caretTypingPlan({
    text: "Your headline",
    at: 0,
    framesPerChar: 1,
    backspaceAt: 20,
    backspaceUnit: "char",
    backspaceRate: 1.5,
    emptyFrames: 6,
    retype: "Payments that move",
    retypeFramesPerChar: 0.5,
  });
  assert.equal(caretTextAt(19, plan), "Your headline");
  assert.equal(caretTextAt(20, plan).length, 13 - 2);
  const lastDelete = plan.keys.filter((key) => key.kind === "delete").at(-1)!;
  assert.equal(lastDelete.text, "");
  assert.equal(plan.retypeAt, lastDelete.frame + 6);
  assert.equal(caretTextAt(plan.retypeAt - 1, plan), "");
  assert.equal(caretTextAt(plan.end, plan), "Payments that move");
  assert.ok(plan.end - plan.retypeAt <= 9, "18 characters in about 9 frames");
  // Defaults are untouched: word chunks.
  const word = caretTypingPlan({ text: "a bb ccc", at: 0, framesPerChar: 1, backspaceAt: 10 });
  assert.deepEqual(
    word.keys.filter((key) => key.kind === "delete").map((key) => key.text),
    ["a bb ", "a ", ""],
  );
});

// --- Delete a whole line and retype it (design-reference/techniques/delete-and-retype-line.md) ---

test("deleteSteps: cumulative rounding keeps the mean rate, on ones or twos, down to empty", () => {
  // cashfree: 19 characters at 2.1 a frame go in 9 frames.
  const chars = deleteSteps("A strategic website", "char", 614, 2.1);
  assert.equal(chars.length, 9);
  assert.equal(chars[0]!.frame, 614);
  assert.equal(chars.at(-1)!.frame, 622);
  assert.equal(chars.at(-1)!.text, "");
  // abdulah: 8 words at 0.67 a frame on twos go in 6 steps, 10 frames, never on an odd frame.
  const words = deleteSteps("one two three four five six seven eight", "word", 114, 0.67, 2);
  assert.equal(words.length, 6);
  assert.deepEqual(
    words.map((key) => key.frame),
    [114, 116, 118, 120, 122, 124],
  );
  assert.equal(words.at(-1)!.text, "");
  for (let i = 1; i < words.length; i++) assert.ok(words[i]!.text.length < words[i - 1]!.text.length);
  assert.deepEqual(deleteSteps("any line", "select-all", 30, 1), [{ frame: 30, text: "", kind: "delete" }]);
  assert.deepEqual(deleteSteps("any line", "cut", 30, 1), [{ frame: 30, text: "", kind: "delete" }]);
});

test("retypeLinePlan: hold after the last key, mark, delete, 6 empty frames, second line", () => {
  const plan = retypeLinePlan({
    lines: ["ab cd ef", "gh ij"],
    at: 0,
    framesPerChar: 5,
    unit: "word",
    hold: 40,
    deleteMode: "char",
    deleteRate: 2.1,
    emptyFrames: 6,
    retypeUnit: "word",
    retypeFramesPerUnit: 3,
  });
  assert.equal(plan.typedEnd, 10);
  assert.equal(caretTextAt(49, plan), "ab cd ef");
  assert.equal(caretTextAt(50, plan), "ab cd ");
  const lastDelete = plan.keys.filter((key) => key.kind === "delete").at(-1)!;
  assert.equal(lastDelete.text, "");
  assert.equal(plan.retypeAt, lastDelete.frame + 6);
  assert.equal(caretTextAt(plan.retypeAt, plan), "gh ");
  assert.equal(caretTextAt(plan.end, plan), "gh ij");
  assert.equal(plan.end, plan.retypeAt + 3);
  // Word mode greys the last word for markFrames, then deletes.
  const dim = retypeLinePlan({
    lines: ["one two three", "four"],
    at: 0,
    framesPerChar: 1,
    hold: 16,
    deleteMode: "word",
    deleteRate: 0.67,
    deleteStep: 2,
    markFrames: 2,
    emptyFrames: 6,
  });
  const markAt = dim.typedEnd + 16;
  assert.deepEqual(caretMarkAt(markAt, dim), { from: markAt, to: markAt + 2, start: 8, end: 13, style: "dim" });
  assert.equal(caretMarkAt(markAt + 2, dim), null);
  assert.equal(dim.keys.find((key) => key.kind === "delete")!.frame, markAt + 2);
  // Select-all shows the line selected, then removes it on one key; cut removes it at once.
  const select = retypeLinePlan({
    lines: ["one two", "three"],
    at: 0,
    framesPerChar: 1,
    hold: 10,
    deleteMode: "select-all",
    deleteRate: 1,
    emptyFrames: 6,
  });
  const mark = select.marks![0]!;
  assert.deepEqual([mark.start, mark.end, mark.style, mark.to - mark.from], [0, 7, "select", 8]);
  assert.equal(select.keys.filter((key) => key.kind === "delete").length, 1);
  assert.equal(caretTextAt(mark.to, select), "");
  const cut = retypeLinePlan({
    lines: ["one two", "three"],
    at: 0,
    framesPerChar: 1,
    hold: 10,
    deleteMode: "cut",
    deleteRate: 1,
    markFrames: 5,
    emptyFrames: 6,
  });
  assert.equal(cut.marks!.length, 0);
  assert.equal(caretTextAt(cut.typedEnd + 10, cut), "");
});

test("caret-track retypeLine presets carry each reference's measured timing", () => {
  for (const preset of [caretTrackRetypeWordPreset, caretTrackRetypeCharPreset])
    assert.ok(caretTrackSchema.safeParse(preset).success);
  // abdulah: no caret, last word greyed 2 frames 16 after the line, deletion on twos in about 10 frames, 6 empty.
  const word = caretTrackPlan(caretTrackRetypeWordPreset);
  const wordDeletes = word.keys.filter((key) => key.kind === "delete");
  assert.equal(caretTrackRetypeWordPreset.caret, "none");
  assert.equal(word.marks![0]!.from, word.typedEnd + 16);
  assert.equal(wordDeletes[0]!.frame, word.typedEnd + 18);
  assert.ok(wordDeletes.every((key) => (key.frame - wordDeletes[0]!.frame) % 2 === 0));
  assert.ok(wordDeletes.at(-1)!.frame - wordDeletes[0]!.frame <= 12);
  assert.equal(word.retypeAt, wordDeletes.at(-1)!.frame + 6);
  // cashfree: hold 40, about 2.1 characters a frame, 6 empty, a word every 3.4 frames.
  const char = caretTrackPlan(caretTrackRetypeCharPreset);
  const charDeletes = char.keys.filter((key) => key.kind === "delete");
  assert.equal(charDeletes[0]!.frame, char.typedEnd + 40);
  assert.equal(charDeletes.length, Math.ceil("Placeholder headline here".length / 2.1));
  assert.equal(char.retypeAt, charDeletes.at(-1)!.frame + 6);
  const words = "Send invoices and get paid in days".split(" ").length;
  assert.ok(Math.abs((char.end - char.retypeAt) / (words - 1) - 3.4) < 0.3);
});

test("caret-track retypeLine cues: a tick on every word deleted, one on a character backspace, clicks on both lines", () => {
  const word = caretTrackCues(caretTrackRetypeWordPreset);
  const wordPlan = caretTrackPlan(caretTrackRetypeWordPreset);
  assert.equal(
    word.filter((cue) => cue.sfx === "tick").length,
    wordPlan.keys.filter((key) => key.kind === "delete").length,
  );
  assert.ok(word.some((cue) => cue.label === "retype" && cue.frame === wordPlan.retypeAt));
  assert.equal(word.at(-1)!.kind, "land");
  const char = caretTrackCues(caretTrackRetypeCharPreset);
  assert.equal(char.filter((cue) => cue.sfx === "tick").length, 1);
  assert.equal(char.filter((cue) => cue.sfx === "click").length, 3 + 7);
  const select = caretTrackCues({
    ...caretTrackRetypeCharPreset,
    retypeLine: { ...caretTrackRetypeCharPreset.retypeLine!, deleteMode: "select-all" },
  });
  assert.ok(
    select.some((cue) => cue.label === "line selected") && select.some((cue) => cue.label === "selection deleted"),
  );
  // Without retypeLine the block is unchanged.
  assert.equal(caretTrackDefaults.retypeLine, undefined);
});

test("chipSlots: a chip rides the caret until it parks, then stays in the line", () => {
  const chips = [{ at: 1, park: 5 }, { at: 5 }];
  assert.deepEqual(chipSlots(0, chips), [null, null]);
  assert.deepEqual(chipSlots(3, chips), [{ riding: true }, null]);
  assert.deepEqual(chipSlots(5, chips), [{ riding: false, after: 5 }, { riding: true }]);
  assert.deepEqual(chipSlots(9, chips), [{ riding: false, after: 5 }, { riding: true }]);
});

// --- A6 ---

const measure: Measure = { width: (text: string) => text.length * 0.6, ascent: () => 0.95, descent: () => 0.25 };

test("clean-sentence switch fill: each word takes the accent on its frame and keeps it; the default still brightens", () => {
  const words = timedWords(
    [
      ["Every", 0.3],
      ["phase", 0.3],
      ["of", 0.2],
      ["the", 0.2],
      ["moon", 0.4],
    ],
    0,
  );
  const p = captionStyleSchema.parse({ ...cleanSentenceSwitchPreset, words });
  const layout = presetLayout(p, 1080, 1920);
  const second = Math.ceil(words[1]!.start * 30);
  const before = planCaptionFrame(p, layout, measure, second - 1, 30, 1920)!;
  const at = planCaptionFrame(p, layout, measure, second, 30, 1920)!;
  assert.equal(before.words[1]!.colour, p.textColor);
  assert.equal(before.words[1]!.opacity, 1, "upcoming words sit in full white");
  assert.equal(at.words[1]!.colour, p.accent, "switches in one frame");
  assert.equal(at.words[0]!.colour, p.accent, "spoken words keep the accent");
  assert.ok(contrastPairs(p).some((pair) => pair.label === "accent"));
  const plain = captionStyleSchema.parse({ ...CAPTION_PRESETS["clean-sentence"], words });
  const brighten = planCaptionFrame(plain, presetLayout(plain, 1080, 1920), measure, second, 30, 1920)!;
  assert.equal(brighten.words[0]!.colour, plain.textColor);
  assert.ok(brighten.words[4]!.opacity < 1);
});

// --- A8 ---

test("case flip: one glyph a step in reading order, other case, no random glyphs", () => {
  assert.equal(otherCase("s"), "S");
  assert.equal(otherCase("S"), "s");
  assert.equal(otherCase("7"), "7");
  assert.equal(caseFlipCount(9, 10, 1, 6), 0);
  assert.equal(caseFlipCount(10, 10, 1, 6), 1);
  assert.equal(caseFlipCount(15, 10, 1, 6), 6);
  assert.equal(caseFlipCount(40, 10, 1, 6), 6);
  // gojiberry: the word flips in about 0.15 s, so about 5 frames at 30 fps for 6 letters.
  const span = (6 - 1) * 1;
  assert.ok(span / 30 <= 0.2);
});

// --- A11 ---

test("rollupValue: whole units every frame on the chosen curve", () => {
  const gauge = (f: number) => rollupValue(f, { from: 2000, to: 100000, at: 0, frames: 20, curve: "power3.out" });
  // polymarket: 61% of the way by the 5th of 20 frames.
  const share = (gauge(4) - 2000) / 98000;
  assert.ok(share > 0.55 && share < 0.75, `${share}`);
  assert.equal(gauge(20), 100000);
  assert.ok(Number.isInteger(gauge(7)));
  const running = (f: number) => rollupValue(f, { from: 0, to: 30000, at: 0, frames: 30, curve: "linear" });
  assert.equal(running(10) - running(9), 1000);
  assert.equal(rollupValue(3, { from: 0, to: 1, at: 0, frames: 10, curve: "linear", decimals: 1 }), 0.3);
  for (let f = 1; f <= 20; f++) assert.ok(gauge(f) >= gauge(f - 1), "never runs backwards");
});

test("pillGrow: a dot first, then the stretch", () => {
  assert.deepEqual(pillGrow(9, 10, 4, 4), { dot: 0, stretch: 0 });
  assert.equal(pillGrow(14, 10, 4, 4).dot, 1);
  assert.equal(pillGrow(14, 10, 4, 4).stretch, 0);
  assert.equal(pillGrow(18, 10, 4, 4).stretch, 1);
});

// --- A5 ---

test("arrivalTint: a tint a frame, then a settle to ink", () => {
  const tints = ["#B873B3", "#B73A69", "#0A7F6F"];
  assert.equal(arrivalTint(9, 10, tints, "#030303", 5), "#030303");
  assert.equal(arrivalTint(10, 10, tints, "#030303", 5), "#B873B3");
  assert.equal(arrivalTint(11, 10, tints, "#030303", 5), "#B73A69");
  assert.equal(arrivalTint(12, 10, tints, "#030303", 5).toLowerCase(), "#0a7f6f");
  assert.equal(arrivalTint(15, 10, tints, "#030303", 5), "#030303");
  // ugc-app: yellow cools to white in 9 frames.
  assert.equal(arrivalTint(0, 0, ["#FFD84A"], "#FFFFFF", 9).toLowerCase(), "#ffd84a");
  const mid = arrivalTint(4, 0, ["#FFD84A"], "#FFFFFF", 9);
  assert.notEqual(mid.toLowerCase(), "#ffffff");
  assert.equal(arrivalTint(9, 0, ["#FFD84A"], "#FFFFFF", 9), "#FFFFFF");
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
});

test("settleTrack eases to each new target from wherever it was", () => {
  const steps = [
    { frame: 0, value: 100 },
    { frame: 10, value: 200 },
    { frame: 20, value: 300 },
  ];
  assert.equal(settleTrack(5, steps, 5), 100);
  assert.ok(settleTrack(11, steps, 5) > 100 && settleTrack(11, steps, 5) < 200);
  assert.equal(settleTrack(15, steps, 5), 200);
  assert.equal(settleTrack(40, steps, 5), 300);
});

// --- A7 ---

test("arcGlyphs: ends rise and tilt outward; zero bend is straight", () => {
  const widths = [60, 60, 60, 60, 60];
  assert.ok(arcGlyphs(widths, 0).every((g) => g.dx === 0 && g.dy === 0 && g.rotate === 0));
  const bent = arcGlyphs(widths, 1.2);
  assert.ok(Math.abs(bent[2]!.dy) < 1e-9 && Math.abs(bent[2]!.rotate) < 1e-9, "centre stays");
  assert.ok(bent[0]!.dy < 0 && bent[4]!.dy < 0, "ends rise");
  assert.ok(bent[0]!.rotate > 0 && bent[4]!.rotate < 0, "ends tilt up");
  assert.ok(Math.abs(bent[0]!.dy - bent[4]!.dy) < 1e-9, "symmetric");
});

// --- A9 ---

test("snap pill: groups from marked runs, opens empty then jumps in one frame", () => {
  assert.deepEqual(markedGroups([false, true, true, false, true]), [
    { from: 1, to: 2 },
    { from: 4, to: 4 },
  ]);
  assert.deepEqual(pillState(9, 10, 20, 2, 5), { group: -1, open: 0 });
  assert.equal(pillState(10, 10, 20, 2, 5).open, 0);
  assert.equal(pillState(15, 10, 20, 2, 5).open, 1);
  assert.deepEqual(pillState(29, 10, 20, 2, 5).group, 0);
  assert.deepEqual(pillState(30, 10, 20, 2, 5), { group: 1, open: 1 });
  const wrap = wrapCentred([100, 100, 100], 10, 250);
  assert.deepEqual(
    wrap.map((w) => w.line),
    [0, 0, 1],
  );
  assert.equal(wrap[0]!.x, (250 - 210) / 2);
  assert.equal(wrap[2]!.x, 75);
});

// --- A10 ---

test("retype slot: selected before the swap, cleared on it, a letter a frame after", () => {
  const o = { at: 10, hold: 55, words: ["Plan", "Schedule"], selectFrames: 15, lettersPerFrame: 1 };
  assert.deepEqual(retypeSlotState(30, o), { index: 0, text: "Plan", selected: false, typing: false });
  assert.equal(retypeSlotState(50, o).selected, true);
  assert.equal(retypeSlotState(64, o).selected, true);
  assert.deepEqual(retypeSlotState(65, o), { index: 1, text: "", selected: false, typing: true });
  assert.equal(retypeSlotState(68, o).text, "Sch");
  assert.equal(retypeSlotState(73, o).text, "Schedule");
  assert.equal(retypeSlotState(73, o).typing, false);
});

// --- A1 ---

test("scanReveal rises at an even rate on twos and completes in its frames", () => {
  assert.equal(scanReveal(-1, 0, 32), 0);
  assert.equal(scanReveal(0, 0, 32), 2 / 32);
  assert.equal(scanReveal(1, 0, 32), scanReveal(0, 0, 32), "held on twos");
  assert.equal(scanReveal(2, 0, 32), 4 / 32);
  assert.equal(scanReveal(30, 0, 32), 1);
  const distinct = new Set(Array.from({ length: 32 }, (_, f) => scanReveal(f, 0, 32)));
  assert.equal(distinct.size, 16, "steps(16)");
});

test("stampPose: 2x faint to 1x solid in 4 frames; the jolt decays and is seeded", () => {
  assert.deepEqual(stampPose(4, 0, 4), { scale: 1, opacity: 1, visible: true });
  const first = stampPose(0, 0, 4);
  assert.equal(first.scale, 2);
  assert.ok(Math.abs(first.opacity - 0.3) < 1e-9);
  assert.equal(stampPose(-1, 0, 4).visible, false);
  assert.deepEqual(joltOffset(10, 10, 4, 12, "a"), joltOffset(10, 10, 4, 12, "a"));
  assert.deepEqual(joltOffset(14, 10, 4, 12), { x: 0, y: 0 });
  assert.ok(Math.abs(joltOffset(13, 10, 4, 12).x) <= 3 + 1e-9);
});

test("scrapPlan: one scrap per glyph, seeded, 2-3 frames apart, spaces skipped", () => {
  const glyphs = [..."NEW ROOM"];
  const a = scrapPlan(glyphs, { at: 4, step: 2.5, faces: 3, colours: 4, tilt: 8, seed: "s" });
  assert.deepEqual(a, scrapPlan(glyphs, { at: 4, step: 2.5, faces: 3, colours: 4, tilt: 8, seed: "s" }));
  assert.equal(a[3], null);
  const lands = a.filter((s) => s !== null).map((s) => s!.land);
  assert.equal(lands[0], 4);
  for (let i = 1; i < lands.length; i++) assert.ok(lands[i]! - lands[i - 1]! >= 2 && lands[i]! - lands[i - 1]! <= 3);
  assert.ok(a.every((s) => s === null || (Math.abs(s.rotate) <= 8 && s.clip.startsWith("polygon("))));
});

test("inkIn: faint, then full in one frame under a decaying flicker", () => {
  assert.deepEqual(inkIn(9, 10, 0.15, 12), { ink: 0.15, flicker: 0 });
  assert.equal(inkIn(10, 10, 0.15, 12).ink, 1);
  assert.ok(Math.abs(inkIn(10, 10, 0.15, 12).flicker) > 0.3);
  assert.deepEqual(inkIn(22, 10, 0.15, 12), { ink: 1, flicker: 0 });
});

// --- A2 ---

test("marqueeTravel brakes to a near hold; copies cover the span", () => {
  const o = { at: 0, frames: 25, distance: 600, curve: "expo.out" as const, drift: 0.5 };
  const speed = (f: number) => marqueeTravel(f + 1, o) - marqueeTravel(f, o);
  assert.ok(speed(0) > 10 * speed(20), "decelerates");
  assert.equal(marqueeTravel(25, o), 600);
  assert.equal(marqueeTravel(35, o), 605);
  assert.equal(marqueeTravel(10, { ...o, frames: 0, drift: 3 }), 30, "constant marquee");
  const copies = marqueeCopies(-130, 400, 1080);
  assert.ok(copies[0]!.x <= 0 && copies.at(-1)!.x + 400 >= 1080);
  for (let i = 1; i < copies.length; i++) assert.equal(copies[i]!.x - copies[i - 1]!.x, 400);
});

test("focalAt: full scale at centre, none past the radius, blur growing outward", () => {
  const o = { scale: 1.3, blur: 10, radius: 0.5 };
  assert.deepEqual(focalAt(0, o), { scale: 1.3, blur: 0 });
  assert.deepEqual(focalAt(0.5, o), { scale: 1, blur: 10 });
  assert.ok(focalAt(0.25, o).scale > 1 && focalAt(0.25, o).scale < 1.3);
});

// --- A3 ---

test("glyphShapePhases follow nowakdesign: hold 5, scatter 4, fade 3, grow 6, turn 6", () => {
  const t = { at: 0, hold: 5, scatter: 4, fade: 3, grow: 6, turn: 6 };
  const at = (f: number) => glyphShapePhases(f, t);
  assert.equal(at(4).scatter, 0);
  assert.equal(at(9).scatter, 1);
  assert.equal(at(9).fade, 0);
  assert.equal(at(12).fade, 1);
  assert.equal(at(18).grow, 1);
  assert.equal(at(18).turn, 0);
  assert.equal(at(24).turn, 1);
  assert.equal(at(0).seam, 24);
  // power2.out: the turn's steps shrink frame to frame.
  assert.ok(at(19).turn - at(18).turn > at(23).turn - at(22).turn);
});
