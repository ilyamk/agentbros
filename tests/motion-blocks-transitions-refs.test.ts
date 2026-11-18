import test from "node:test";
import assert from "node:assert/strict";
import { easeFamily, familyProgress } from "../src/motion/ease-family";
import {
  accelerateCues,
  accelerateIntoCutDefaults,
  accelerateRestFrame,
  accelerateSeamSpeed,
  accelerateState,
  accelerateTail,
} from "../src/motion/library/transitions/AccelerateIntoCut";
import { growShape } from "../src/motion/library/transitions/CausedMorph";
import {
  frameToObjectCues,
  frameToObjectDefaults,
  objectPhases,
  shrinkRect,
} from "../src/motion/library/transitions/FrameToObject";
import {
  reframeCues,
  reframeIndex,
  reframePose,
  uiPunchReframeDefaults,
} from "../src/motion/library/camera/UiPunchReframe";
import {
  dropFrames,
  populatePullOutCues,
  populatePullOutDefaults,
  pullOutPose,
  pullOutScale,
} from "../src/motion/library/camera/PopulatePullOut";

const W = 1920;
const H = 1080;

test("ease families start at 0, end at 1 and have their named shape", () => {
  for (const [name, ease] of Object.entries(easeFamily)) {
    assert.ok(Math.abs(ease(0)) < 1e-3, `${name}(0)`);
    assert.ok(Math.abs(ease(1) - 1) < 1e-3, `${name}(1)`);
  }
  // In-curves are below the diagonal at the middle, out-curves above, inOut on it.
  for (const name of ["sine.in", "power1.in", "power2.in", "circ.in", "expo.in"] as const)
    assert.ok(easeFamily[name](0.5) < 0.5, name);
  for (const name of ["sine.out", "power3.out", "circ.out", "expo.out"] as const)
    assert.ok(easeFamily[name](0.5) > 0.5, name);
  assert.ok(Math.abs(easeFamily["power2.inOut"](0.5) - 0.5) < 1e-9);
  assert.equal(familyProgress(-5, 0, 10, "circ.in"), 0);
  assert.equal(familyProgress(50, 0, 10, "circ.in"), 1);
});

test("accelerate-into-cut: the old shot accelerates into the seam and the new one halves its speed each frame", () => {
  const timing = accelerateIntoCutDefaults;
  const { seamFrame, approach, amount, decay } = timing;
  const before = Array.from({ length: approach }, (_, i) => accelerateState(seamFrame - approach + i, timing).speed);
  for (let i = 1; i < before.length; i++) assert.ok(before[i]! > before[i - 1]!, `speed rises before the cut (${i})`);
  // The last four old frames carry most of the travel: the acceleration is at the end.
  const lastFour = before.slice(-4).reduce((a, b) => a + b, 0);
  assert.ok(lastFour > 0.6 * amount, `last four frames travel ${lastFour}`);
  const last = accelerateState(seamFrame - 1, timing);
  assert.ok(Math.abs(last.travel - amount) < 1e-9, "the old shot reaches its full travel on its last frame");
  const v = accelerateSeamSpeed(timing);
  assert.ok(Math.abs(last.speed - v) < 1e-9, "the seam speed is the old shot's last speed");
  const cut = accelerateState(seamFrame, timing);
  assert.equal(cut.side, "after");
  assert.equal(cut.travel, 0);
  assert.ok(Math.abs(cut.speed - v) < 1e-9, "the cut frame carries the same speed");
  // Measured on the reference: 34, 17, 7.7 after the cut, about halving.
  for (let k = 1; k <= 4; k++) {
    const travelled = accelerateState(seamFrame + k, timing).travel - accelerateState(seamFrame + k - 1, timing).travel;
    assert.ok(Math.abs(travelled - v * decay ** (k - 1)) < 1e-9, `frame ${k} after the cut`);
    assert.ok(
      Math.abs(
        accelerateState(seamFrame + k, timing).speed / accelerateState(seamFrame + k - 1, timing).speed - decay,
      ) < 1e-9,
    );
  }
  assert.ok(
    Math.abs(accelerateState(seamFrame + 200, timing).travel - accelerateTail(timing)) < 1e-9,
    "comes to rest after speed / (1 - decay)",
  );
  assert.equal(
    accelerateRestFrame(timing),
    seamFrame + 5,
    "at 0.5 decay the speed is under 5% five frames after the cut",
  );
});

test("accelerate-into-cut cues: the cut on seamFrame, the rest after it", () => {
  const cues = accelerateCues({ ...accelerateIntoCutDefaults, seamFrame: 7 });
  assert.deepEqual(cues[0], { frame: 7, kind: "cut", sfx: "whoosh", weight: "hero", label: "cut at peak speed" });
  assert.equal(cues[1]!.frame, 12);
});

test("frame-to-object: the frame keeps its aspect ratio and lands at toScale on the named ease", () => {
  const timing = frameToObjectDefaults;
  const start = shrinkRect(timing.at - 1, timing, W, H);
  assert.deepEqual([start.x, start.y, start.width, start.height], [0, 0, W, H]);
  for (let f = timing.at; f <= timing.at + timing.frames; f++) {
    const rect = shrinkRect(f, timing, W, H);
    assert.ok(Math.abs(rect.width / rect.height - W / H) < 1e-9, `aspect at ${f}`);
  }
  const end = shrinkRect(timing.at + timing.frames, timing, W, H);
  assert.ok(Math.abs(end.width / W - timing.toScale) < 1e-9);
  assert.ok(Math.abs(end.x + end.width / 2 - W * timing.toX) < 1e-9);
  // power2.inOut: slow at both ends, so the first and last frames move less than the middle one.
  const step = (f: number) => shrinkRect(f, timing, W, H).width - shrinkRect(f + 1, timing, W, H).width;
  const mid = timing.at + Math.floor(timing.frames / 2);
  assert.ok(step(mid) > step(timing.at) && step(mid) > step(timing.at + timing.frames - 1));
  // Measured on the reference: 0.6 of the width 11 frames in (power2.inOut gives 0.6 within two frames of that).
  const at60 = Array.from({ length: timing.frames + 1 }, (_, i) => i).find(
    (i) => shrinkRect(timing.at + i, timing, W, H).scale <= 0.6,
  )!;
  assert.ok(Math.abs(at60 - 11) <= 2, `0.6 reached ${at60} frames in`);
  // The monitor variant: power3.out over 32 frames does 90% of its travel in about 14 (measured 0.46 s).
  const out = { ...timing, ease: "power3.out" as const, toScale: 0.47, frames: 32 };
  const at90 = Array.from({ length: 33 }, (_, i) => i).find((i) => shrinkRect(out.at + i, out, W, H).progress >= 0.9)!;
  assert.ok(Math.abs(at90 - 14) <= 2, `90% at ${at90}`);
});

test("frame-to-object cues: cut on seamFrame (or at), land when the shrink settles, continuation beats shifted with it", () => {
  const base = frameToObjectCues(frameToObjectDefaults);
  assert.equal(base[0]!.frame, frameToObjectDefaults.at);
  assert.equal(base[1]!.frame, frameToObjectDefaults.at + frameToObjectDefaults.frames);
  const seamed = frameToObjectCues({ ...frameToObjectDefaults, seamFrame: 7 });
  assert.deepEqual(seamed[0], {
    frame: 7,
    kind: "cut",
    sfx: "whoosh",
    weight: "hero",
    label: "frame detaches and shrinks",
  });
  const phases = objectPhases(frameToObjectDefaults, frameToObjectDefaults.label);
  assert.equal(seamed.find((cue) => cue.kind === "reveal")!.frame, phases.edgeOn + 7 - frameToObjectDefaults.at);
  assert.equal(frameToObjectCues({ ...frameToObjectDefaults, then: "hold" }).length, 2);
});

test("caused-morph orb covers every corner at the cut; pill puts its top edge on the frame's top", () => {
  const source = { x: W * 0.45, y: H * 0.5, width: W * 0.1, height: W * 0.1 };
  const start = growShape("orb", source, 0, "circ.in", W, H);
  assert.ok(Math.abs(start.width - source.width) < 1e-9);
  const end = growShape("orb", source, 1, "circ.in", W, H);
  for (const [x, y] of [
    [0, 0],
    [W, 0],
    [0, H],
    [W, H],
  ])
    assert.ok(Math.hypot(x! - end.cx, y! - end.cy) <= end.radius, `corner ${x},${y}`);
  // circ.in: slow start, so half-way through the time it has done well under half its growth.
  const half = growShape("orb", source, 0.5, "circ.in", W, H);
  assert.ok(half.width < Math.sqrt(start.width * end.width));
  const pillSource = { x: W * 0.3, y: H * 0.55, width: W * 0.4, height: W * 0.088 };
  const pill = growShape("pill", pillSource, 1, "sine.in", W, H);
  assert.ok(Math.abs(pill.cy - pill.height / 2) < 1e-6, "top edge on y = 0");
  assert.ok(pill.width >= W && pill.cy + pill.height / 2 >= H, "covers the frame");
  const p0 = growShape("pill", pillSource, 0, "sine.in", W, H);
  assert.ok(Math.abs(p0.width - pillSource.width) < 1e-9 && Math.abs(p0.height - pillSource.height) < 1e-9);
});

test("ui-punch-reframe: scale jumps at each cut, never in between, and the settle ends within 16 frames", () => {
  const { shots, settleFrames, settleShare } = uiPunchReframeDefaults;
  const opts = { settleFrames, settleShare, drift: 0 };
  for (let i = 1; i < shots.length; i++) {
    const at = shots[i]!.at;
    assert.equal(reframeIndex(at - 1, shots), i - 1);
    assert.equal(reframeIndex(at, shots), i);
    const before = reframePose(at - 1, shots, W, H, opts).scale;
    const after = reframePose(at, shots, W, H, opts).scale;
    assert.ok(
      Math.abs(after - shots[i]!.scale) <= shots[i]!.scale * settleShare + 1e-9,
      "the cut lands within the settle share",
    );
    assert.ok(Math.abs(after - before) > 0.3, `jump at ${at}`);
    // Within a hold the scale moves by at most the settle share in total.
    const end = reframePose(at + settleFrames, shots, W, H, opts).scale;
    assert.ok(Math.abs(end - shots[i]!.scale) < 1e-9, `settled ${settleFrames} frames after ${at}`);
    // Punch-ins keep moving in, pull-outs keep moving out.
    const direction = Math.sign(shots[i]!.scale - shots[i - 1]!.scale);
    assert.ok(direction * (reframePose(at + 3, shots, W, H, opts).scale - after) > 0);
  }
  // No edge shows: the stage always covers the frame.
  for (let f = 0; f < 104; f++) {
    const pose = reframePose(f, shots, W, H, { ...opts, drift: 0.05 });
    assert.ok(
      pose.x <= 0 && pose.y <= 0 && pose.x + W * pose.scale >= W - 1e-6 && pose.y + H * pose.scale >= H - 1e-6,
      `frame ${f}`,
    );
  }
  const cues = reframeCues(shots);
  assert.deepEqual(
    cues.map((cue) => cue.frame),
    [18, 50, 76],
  );
  assert.equal(cues.at(-1)!.weight, "hero");
  assert.ok(cues.every((cue) => cue.kind === "cut"));
});

test("populate-pull-out: linear drift, then expo.out from about 1.2x to 1x in 15 frames; the two-stage variant settles on circ.out", () => {
  const plan = populatePullOutDefaults;
  const s = (f: number) => pullOutScale(f, plan).scale;
  assert.ok(Math.abs(s(0) - plan.closeScale) < 1e-9);
  // Constant drift speed before the pull.
  assert.ok(Math.abs(s(20) - s(10) - (s(60) - s(50))) < 1e-9);
  assert.ok(s(plan.pullAt - 1) > plan.closeScale);
  // Fastest in its first frames, settled by pullFrames.
  const step = (f: number) => s(f) - s(f + 1);
  assert.ok(step(plan.pullAt) > step(plan.pullAt + 5) && step(plan.pullAt + 5) > step(plan.pullAt + 10));
  assert.ok(Math.abs(s(plan.pullAt + plan.pullFrames) - 1) < 1e-9);
  const pose = pullOutPose(plan.pullAt + plan.pullFrames, plan, W, H);
  assert.ok(Math.abs(pose.x) < 1e-6 && Math.abs(pose.y) < 1e-6, "ends on the whole, centred stage");
  for (let f = 0; f < 110; f++) {
    const p = pullOutPose(f, plan, W, H);
    assert.ok(
      p.x <= 1e-9 && p.y <= 1e-9 && p.x + W * p.scale >= W - 1e-6 && p.y + H * p.scale >= H - 1e-6,
      `no edge at ${f}`,
    );
  }
  const two = { ...plan, variant: "two-stage" as const };
  const t = (f: number) => pullOutScale(f, two).scale;
  assert.ok(Math.abs(t(two.secondAt - 1) - two.midScale) < 1e-9, "first stage lands on midScale");
  assert.ok(
    t(two.secondAt) - t(two.secondAt + 1) > t(two.secondAt + 10) - t(two.secondAt + 11),
    "second stage jumps first",
  );
  assert.ok(Math.abs(t(two.secondAt + two.secondFrames) - 1) < 1e-9);
});

test("populate-pull-out drops never land together and come before the pull", () => {
  const drops = dropFrames(12, 8, 5, 1, 72);
  for (let i = 1; i < drops.length; i++) assert.ok(drops[i]! - drops[i - 1]! >= 4 && drops[i]! - drops[i - 1]! <= 6);
  assert.ok(drops.every((frame) => frame < 72));
  assert.deepEqual(drops, dropFrames(12, 8, 5, 1, 72), "seeded");
  const cues = populatePullOutCues(populatePullOutDefaults, drops);
  assert.equal(cues.filter((cue) => cue.weight === "hero").length, 1);
  assert.equal(cues.find((cue) => cue.kind === "reveal")!.frame, populatePullOutDefaults.pullAt);
});
