import test from "node:test";
import assert from "node:assert/strict";
import { breathPose, cameraBreathCues, cameraBreathDefaults } from "../src/motion/library/camera/CameraBreath";
import { rampBlur, speedRampCues, speedRampDefaults } from "../src/motion/library/camera/SpeedRamp";
import { chromaEdgeDefaults, chromaOffset } from "../src/motion/library/finish/ChromaEdge";
import { FILM_FINISH_DEFAULTS, finishPresets, resolveFinish } from "../src/motion/library/finish/presets";
import { scanBandAt, textureSeed } from "../src/motion/library/finish/TextureOverlay";
import { items as transitionItems } from "../src/motion/library/transitions";
import { demoCutCue } from "../src/motion/library/transitions/demo";
import { matchCutCues, matchCutDefaults, matchCutPose } from "../src/motion/library/transitions/MatchCut";
import {
  hierarchyRevealCues,
  hierarchyRevealDefaults,
  hierarchyRevealPlan,
} from "../src/motion/library/typography/HierarchyReveal";

test("FilmFinish with no preset and no props resolves to the grain-only defaults it always had", () => {
  assert.deepEqual(resolveFinish(), FILM_FINISH_DEFAULTS);
  assert.deepEqual(resolveFinish(undefined, {}), {
    grain: 0.04,
    vignette: 0,
    bloom: 0,
    bloomThreshold: 0.62,
    aberration: 0,
    lightLeak: 0,
    lightLeakColour: "#ffb36b",
    drift: 0,
    seed: "finish",
    texture: "none",
    textureOpacity: 0,
  });
  assert.deepEqual(
    resolveFinish(undefined, { grain: undefined }),
    FILM_FINISH_DEFAULTS,
    "undefined props do not override",
  );
});

test("finish presets set their look and explicit props win over them", () => {
  assert.equal(resolveFinish("clean").grain, 0.02);
  assert.equal(resolveFinish("clean").vignette, 0.08);
  assert.equal(resolveFinish("filmic").vignette, 0.18);
  assert.ok(resolveFinish("filmic").drift > 0 && resolveFinish("filmic").bloom > 0);
  assert.equal(resolveFinish("tactile").texture, "paper");
  assert.equal(resolveFinish("tactile").grain, 0.07);
  assert.equal(resolveFinish("tactile", { grain: 0.03 }).grain, 0.03);
  for (const preset of Object.values(finishPresets))
    assert.equal(preset.aberration ?? 0, 0, "no preset turns on colour fringes");
});

test("match cut: the new subject appears where and as big as the old one was on its last frame, then settles at rest", () => {
  const [width, height] = [1920, 1080];
  const unit = Math.min(width, height);
  const { seamFrame, from, to, settle } = matchCutDefaults;
  const last = matchCutPose(seamFrame - 1, matchCutDefaults, width, height);
  const first = matchCutPose(seamFrame, matchCutDefaults, width, height);
  assert.equal(last.side, "before");
  assert.equal(first.side, "after");
  const oldCentre = { x: last.x + from.x * width * last.scale, y: last.y + from.y * height * last.scale };
  const newCentre = { x: first.x + to.x * width * first.scale, y: first.y + to.y * height * first.scale };
  assert.ok(Math.abs(oldCentre.x - newCentre.x) < 1e-6 && Math.abs(oldCentre.y - newCentre.y) < 1e-6, "same place");
  assert.ok(Math.abs(from.size * unit * last.scale - to.size * unit * first.scale) < 1e-6, "same size");
  const rest = matchCutPose(seamFrame + settle, matchCutDefaults, width, height);
  assert.deepEqual([rest.scale, Math.abs(rest.x), Math.abs(rest.y)], [1, 0, 0]);
  for (let frame = 0; frame < 90; frame++)
    assert.ok(matchCutPose(frame, matchCutDefaults, width, height).scale >= 1, "never shows an edge");
  assert.deepEqual(matchCutCues(matchCutDefaults)[0], {
    frame: seamFrame,
    kind: "cut",
    sfx: "whoosh",
    weight: "hero",
    label: "match cut",
  });
});

test("transition cues sit on seamFrame when a film passes it, and on the preview seam otherwise", () => {
  assert.equal(demoCutCue(72, 9, 0.5, "whoosh", "whip", 130)[0]!.frame, 130);
  assert.equal(demoCutCue(72, 9, 0.5, "whoosh", "whip")[0]!.frame, 37);
  assert.equal(matchCutCues({ seamFrame: 12, settle: 18 })[0]!.frame, 12);
});

test("speed ramp: no blur at real time, cues on the surge and the return", () => {
  assert.equal(rampBlur(1), 0);
  assert.equal(rampBlur(0.25), 0);
  assert.equal(rampBlur(4, 3, 18), 9);
  assert.equal(rampBlur(40, 3, 18), 18);
  const cues = speedRampCues(speedRampDefaults);
  assert.deepEqual(
    cues.map((cue) => [cue.frame, cue.kind]),
    [
      [30, "peak"],
      [78, "land"],
    ],
  );
});

test("camera breath is seeded, small at rest and punches only after a hit", () => {
  const settings = { ...cameraBreathDefaults };
  assert.deepEqual(breathPose(40, 30, 1, settings), breathPose(40, 30, 1, settings));
  for (let frame = 0; frame < 120; frame += 7) {
    const pose = breathPose(frame, 30, 1, { ...settings, hits: [] });
    assert.ok(Math.abs(pose.x) <= settings.amplitude && Math.abs(pose.y) <= settings.amplitude);
    assert.ok(pose.scale >= 1 && pose.scale <= 1 + settings.scaleAmplitude * 1.5 + 1e-9);
  }
  const hit = settings.hits[0]!;
  const before =
    breathPose(hit - 1, 30, 1, settings).scale - breathPose(hit - 1, 30, 1, { ...settings, hits: [] }).scale;
  const peak = breathPose(hit + 3, 30, 1, settings).scale - breathPose(hit + 3, 30, 1, { ...settings, hits: [] }).scale;
  const after =
    breathPose(hit + settings.punchFrames + 1, 30, 1, settings).scale -
    breathPose(hit + settings.punchFrames + 1, 30, 1, { ...settings, hits: [] }).scale;
  assert.equal(before, 0);
  assert.ok(Math.abs(peak - settings.punch) < 1e-9);
  assert.ok(Math.abs(after) < 1e-9);
  assert.equal(cameraBreathCues(settings).length, settings.hits.length);
  assert.notDeepEqual(breathPose(40, 30, 1, settings), breathPose(40, 30, 1, { ...settings, seed: "other" }));
});

test("texture and chroma helpers are pure functions of the frame", () => {
  assert.equal(textureSeed("t", 5, 0), textureSeed("t", 500, 0), "still paper keeps one state");
  assert.equal(textureSeed("t", 4, 2), textureSeed("t", 5, 2));
  assert.notEqual(textureSeed("t", 4, 2), textureSeed("t", 6, 2));
  assert.equal(scanBandAt(40, 1080), scanBandAt(40, 1080));
  assert.equal(chromaOffset(0, chromaEdgeDefaults), 0, "clean at rest");
  assert.equal(chromaOffset(chromaEdgeDefaults.hits[0]!, chromaEdgeDefaults), chromaEdgeDefaults.peak);
  assert.ok(chromaOffset(5, { ...chromaEdgeDefaults, velocity: 100 }) > 0, "speed alone splits");
});

test("hierarchy reveal lands the headline before the sub and the details", () => {
  const plan = hierarchyRevealPlan(hierarchyRevealDefaults);
  assert.ok(plan.hero.at(-1)! < plan.support[0]! && plan.support[0]! < plan.detail[0]!);
  const cues = hierarchyRevealCues(hierarchyRevealDefaults);
  assert.equal(cues[0]!.weight, "hero");
  assert.equal(cues.filter((cue) => cue.label === "detail").length, hierarchyRevealDefaults.details.length);
});

test("every transition block that takes seamFrame puts its cut cue there", () => {
  const seamed = transitionItems.filter(
    (item) =>
      item.schema.safeParse({ ...item.defaultProps, seamFrame: 7 }).success &&
      "shape" in item.schema &&
      "seamFrame" in (item.schema as unknown as { shape: Record<string, unknown> }).shape,
  );
  assert.ok(seamed.length >= 8, `transitions with seamFrame: ${seamed.map((item) => item.id).join(", ")}`);
  for (const item of seamed) {
    const cues = item.cues!({ ...item.defaultProps, seamFrame: 7 });
    assert.ok(
      cues.some((cue) => cue.kind === "cut" && cue.frame === 7),
      `${item.id}: cut cue on seamFrame`,
    );
  }
});
