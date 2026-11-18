import test from "node:test";
import assert from "node:assert/strict";
import { ConceptSchema, CritiqueSchema, MotionPlanSchema, VisualReviewSchema } from "../src/types/creative";
import {
  JUDGED_REFERENCE_LAYERS,
  MEASURED_REFERENCE_LAYERS,
  REFERENCE_LAYERS,
  ReferenceBlueprintSchema,
  ReferenceStorySchema,
} from "../src/types/reference";

const hash = "a".repeat(64);
const candidate = (id: string) => ({ id, title: id, premise: "p", coreImage: "i", openingFrame: "f", whyWatch: "w" });
const productTruth = { sources: [], claims: [] };

test("a concept needs three candidates and a selected one among them", () => {
  const valid = {
    schemaVersion: 1,
    candidates: ["a", "b", "c"].map(candidate),
    selectedId: "a",
    rejected: [],
    productTruth,
  };
  assert.equal(ConceptSchema.safeParse(valid).success, true);
  assert.equal(ConceptSchema.safeParse({ ...valid, selectedId: "z" }).success, false);
  assert.equal(ConceptSchema.safeParse({ ...valid, candidates: valid.candidates.slice(0, 2) }).success, false);
});

test("a motion plan rejects an unknown production route and defaults the final frame to a hold", () => {
  const shot = {
    id: "s1",
    startFrame: 0,
    durationFrames: 30,
    intent: "i",
    subject: "s",
    framing: "f",
    camera: "c",
    composition: "c",
    entrance: "e",
    exit: "e",
    curve: "c",
    route: "remotion",
  };
  const plan = MotionPlanSchema.parse({ schemaVersion: 1, projectId: "p", fps: 30, shots: [shot] });
  assert.equal(plan.finalFrameIntent, "hold");
  assert.equal(
    MotionPlanSchema.safeParse({ schemaVersion: 1, projectId: "p", fps: 30, shots: [{ ...shot, route: "magic" }] })
      .success,
    false,
  );
});

test("reviews and critiques must cite frames", () => {
  const review = { schemaVersion: 1, step: "draft", renderSha256: hash, reviewer: "motion-engineer" };
  assert.equal(VisualReviewSchema.safeParse({ ...review, frames: [] }).success, false);
  assert.equal(VisualReviewSchema.safeParse({ ...review, frames: [{ path: "a.png", note: "ok" }] }).success, true);
  const score = { score: 3, note: "n", evidence: [] };
  const scores = Object.fromEntries(
    ["idea", "hook", "motion", "rhythm", "typography", "composition", "ending"].map((key) => [key, score]),
  );
  const critique = {
    schemaVersion: 1,
    round: 1,
    renderSha256: hash,
    framesReviewed: [{ path: "a.png", note: "n" }],
    scores,
    verdict: "revise",
  };
  assert.equal(CritiqueSchema.safeParse(critique).success, false);
});

test("reference layers separate measured from judged and judged claims state their basis", () => {
  assert.deepEqual(
    [...MEASURED_REFERENCE_LAYERS, ...JUDGED_REFERENCE_LAYERS].sort(),
    Object.keys(REFERENCE_LAYERS).sort(),
  );
  const claim = (value: unknown) => ({ value, basis: "observed", confidence: 0.8 });
  const story = {
    schemaVersion: 1,
    referenceId: "ref-1",
    idea: claim("idea"),
    audience: claim("audience"),
    hook: claim({ startSec: 0, endSec: 1, device: "d", description: "x" }),
    beats: [],
  };
  assert.equal(ReferenceStorySchema.safeParse(story).success, true);
  assert.equal(ReferenceStorySchema.safeParse({ ...story, idea: { value: "idea" } }).success, false);
});

test("a blueprint carries at least one slot and explicit transfer rules", () => {
  const blueprint = {
    schemaVersion: 1,
    referenceId: "ref-1",
    format: { width: 1080, height: 1920, fps: 30 },
    durationSec: 10,
    slots: [
      { id: "a", role: "hook", startSec: 0, durationSec: 2, visualRecipe: "v", motionRecipe: "m", soundRecipe: "s" },
    ],
    rhythm: { cutGrid: "every beat" },
    style: "s",
    transferRules: { keep: [], mustChange: ["branding"] },
  };
  assert.equal(ReferenceBlueprintSchema.safeParse(blueprint).success, true);
  assert.equal(ReferenceBlueprintSchema.safeParse({ ...blueprint, slots: [] }).success, false);
});
