import test from "node:test";
import assert from "node:assert/strict";
import { FEEDBACK_OPEN, FEEDBACK_STEPS, FILM_CHAIN, stepById, stepOwnerKind } from "../src/lib/film/chain";
import { IDEA_AXES, SCRIPT_AXES } from "../src/lib/film/creative-rubric";
import { FILM_TYPES, stepEnabled } from "../src/lib/film/routes";
import { ASPECT_ROUTES, aspectAxis, routeAspect } from "../src/lib/feedback/route";
import { ASPECTS, FeedbackInputSchema, FeedbackSchema } from "../src/types/feedback";

const record = (change: (value: Record<string, any>) => void = () => {}) => {
  const value: Record<string, any> = {
    schemaVersion: 1,
    id: "fb-001",
    route: "film",
    watched: { path: "out/film/film.mp4", sha256: "a".repeat(64) },
    source: { kind: "user", at: "2026-11-16T10:00:00.000Z" },
    verdict: "revise",
    items: [
      {
        id: "i1",
        quote: "the music is too cheerful",
        aspect: "music",
        severity: "must",
        routedTo: "music",
        status: "open",
      },
    ],
  };
  change(value);
  return value;
};

test("feedback schema: the user's words, the exact render, no proxy", () => {
  assert.ok(FeedbackSchema.safeParse(record()).success);
  assert.equal(
    FeedbackSchema.safeParse(record((value) => delete value["items"][0].quote)).success,
    false,
    "an item without a quote",
  );
  assert.equal(
    FeedbackSchema.safeParse(record((value) => (value["items"][0].quote = " x "))).success,
    false,
    "a quote of one character",
  );
  assert.equal(
    FeedbackSchema.safeParse(record((value) => (value["source"] = { kind: "proxy", at: "now" }))).success,
    false,
    "a proxy source",
  );
  assert.equal(
    FeedbackSchema.safeParse(record((value) => (value["source"] = { kind: "critic", at: "now" }))).success,
    false,
    "a critic source",
  );
  assert.equal(
    FeedbackSchema.safeParse(record((value) => delete value["watched"].sha256)).success,
    false,
    "no hash of the watched render",
  );
  assert.equal(
    FeedbackSchema.safeParse(record((value) => (value["items"][0].aspect = "vibes"))).success,
    false,
    "an unknown aspect",
  );
  assert.equal(FeedbackSchema.safeParse(record((value) => (value["items"] = []))).success, false, "no items");
  assert.equal(
    FeedbackInputSchema.safeParse({ source: { kind: "proxy" }, items: [{ quote: "too loud", aspect: "sfx-mix" }] })
      .success,
    false,
  );
  assert.equal(
    FeedbackInputSchema.parse({ items: [{ quote: "too loud", aspect: "sfx-mix" }] }).items[0]!.severity,
    "must",
  );
});

test("feedback table: every aspect of every film type goes to a step that type runs and an owner can redo, or to ask", () => {
  for (const id of FEEDBACK_STEPS) {
    const step = stepById(id);
    assert.ok(step, id);
    assert.ok(
      step.inputs.some((input) => input.path === FEEDBACK_OPEN(id) && input.optional),
      `${id} tracks its open feedback`,
    );
    assert.equal(
      stepOwnerKind(step),
      "agent",
      `${id} is redone by an agent, not a script that would write the same result`,
    );
    assert.ok(!step.selfSealing && !step.critic?.review, `${id} is not a judge`);
    if (step.fanOut)
      assert.ok(
        FILM_CHAIN.some((judge) => judge.critic?.review === step.fanOut!.kind && judge.critic.fixBy === id),
        `${id} is fan-out only as the authors of a blind pool, which feedback reopens for a new round`,
      );
  }
  for (const step of FILM_CHAIN)
    if (!FEEDBACK_STEPS.includes(step.id))
      assert.ok(!step.inputs.some((input) => input.path.includes("feedback/open")), `${step.id} takes no feedback`);
  for (const [aspect, route] of Object.entries(ASPECT_ROUTES))
    for (const candidate of route.film) assert.ok(FEEDBACK_STEPS.includes(candidate), `${aspect} -> ${candidate}`);
  assert.deepEqual(Object.keys(ASPECT_ROUTES).sort(), [...ASPECTS].sort());
  for (const type of FILM_TYPES) {
    for (const silence of [false, true]) {
      for (const aspect of ASPECTS) {
        const routed = routeAspect(aspect, { type, silence });
        if (routed.step === "ask") {
          assert.ok("why" in routed && routed.why.length > 0, `${type} ${aspect}: ask says why`);
          continue;
        }
        assert.ok(stepEnabled(routed.step, type), `${type} ${aspect} -> ${routed.step}, which this type runs`);
      }
    }
  }
  assert.equal(routeAspect("unclear", { type: "motion-graphics" }).step, "ask");
  assert.equal(routeAspect("music", { type: "motion-graphics" }).step, "music");
  assert.equal(routeAspect("material", { type: "motion-graphics" }).step, "build", "no material step in this type");
  assert.equal(routeAspect("material", { type: "ai-video" }).step, "material");
  assert.equal(routeAspect("pacing", { type: "replica" }).step, "replica-spec");
  assert.equal(routeAspect("concept", { type: "motion-graphics" }).step, "ideas", "a new pool of ideas");
  for (const aspect of ["hook-line", "words", "ending-cta"] as const) {
    assert.equal(routeAspect(aspect, { type: "motion-graphics" }).step, "script-variants", `${aspect}: new variants`);
    assert.equal(routeAspect(aspect, { type: "replica" }).step, "replica-spec", `${aspect}: a replica's words`);
  }
});

test("feedback axes are the frozen rubric's", () => {
  const axes = new Set<string>([...IDEA_AXES, ...SCRIPT_AXES]);
  for (const aspect of ASPECTS) {
    const axis = aspectAxis(aspect);
    if (axis) assert.ok(axes.has(axis), `${aspect}: ${axis}`);
  }
});
