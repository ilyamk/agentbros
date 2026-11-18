import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { eventFixture } from "./viz-events.fixture";
import { vizElementState } from "../src/motion/viz/state";
import { VizEvents } from "../src/motion/viz/VizEvents";
test("all named events have deterministic before, partial and reading-hold semantics", async () => {
  const plan = await eventFixture(),
    a = plan.primitives.find((p) => p.id === "a")!,
    b = plan.primitives.find((p) => p.id === "b")!,
    edge = plan.primitives.find((p) => p.id === "edge")!;
  assert.equal(vizElementState(plan, a, 0).opacity, 0);
  assert.equal(vizElementState(plan, a, 10).opacity, 0.5);
  assert.equal(vizElementState(plan, a, 20).opacity, 1);
  assert.equal(vizElementState(plan, edge, 19).progress, 0);
  assert.equal(vizElementState(plan, edge, 20).progress, 0);
  assert.equal(vizElementState(plan, edge, 30).progress, 0.5);
  assert.equal(vizElementState(plan, edge, 40).progress, 1);
  assert.equal(vizElementState(plan, a, 60).fill, "#65aaff");
  assert.equal(vizElementState(plan, a, 70).fill, plan.spec.theme.accent);
  assert.equal(vizElementState(plan, b, 100).opacity, 0.65);
  assert.deepEqual(vizElementState(plan, a, 121), vizElementState(plan, a, 149));
  const markup = (frame: number) =>
    renderToStaticMarkup(React.createElement("svg", {}, React.createElement(VizEvents, { plan, frame })));
  assert.doesNotMatch(markup(99), /width="300"/);
  assert.match(markup(105), /width="300"/);
  assert.doesNotMatch(markup(115), /width="300"/);
  assert.notEqual(markup(40), markup(50));
  for (const frame of [149, 0, 105, 30, 70, 10]) assert.equal(markup(frame), markup(frame));
});
