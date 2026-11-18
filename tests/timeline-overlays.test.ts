import test from "node:test";
import assert from "node:assert/strict";
import { TimelineOverlaySchema, type TimelineIR } from "../src/types/timeline";
import { applyEdit } from "../src/lib/timeline-ir/commands";
import { compileTimelineIR, validateTimeline } from "../src/lib/timeline-ir/compiler";
import {
  assertOverlayBlocks,
  overlayRenders,
  rebaseOverlays,
  touchedOverlayIds,
} from "../src/lib/timeline-ir/overlays";
import { sliceTimeline } from "../src/lib/longform/slice";
import { compileShort, selectionHash } from "../src/lib/longform/plans";
import { readCatalogue } from "../src/lib/library/catalogue";

const f = (num: number, den = 1) => ({ num, den });
const base = (): TimelineIR => ({
  version: 1,
  projectId: "overlay-demo",
  timebase: f(30),
  tracks: [
    {
      id: "visual",
      kind: "visual",
      clips: [
        {
          id: "a",
          assetId: "talk.mp4",
          start: f(0),
          source: { start: f(0), end: f(150), timebase: f(30) },
          rate: f(1),
          transition: { kind: "cut" },
          captions: [],
        },
        {
          id: "b",
          assetId: "talk.mp4",
          start: f(150),
          source: { start: f(300), end: f(450), timebase: f(30) },
          rate: f(1),
          transition: { kind: "cut" },
          captions: [],
        },
      ],
    },
  ],
});
const hook = {
  id: "hook",
  block: "type-hero-word",
  props: { text: "Stop scrolling", ground: "transparent", groundBefore: "transparent" },
  start: f(0),
  end: f(60),
  layer: "above-captions" as const,
};
const withHook = () => applyEdit(base(), { type: "add-overlay", overlay: hook });
const catalogue = () => {
  const loaded = readCatalogue();
  assert.ok(loaded, "docs/library/catalogue.json exists");
  return loaded.items;
};

test("overlay schema is strict and the list is absent rather than empty", () => {
  assert.equal(TimelineOverlaySchema.safeParse({ ...hook, extra: 1 }).success, false);
  assert.equal(TimelineOverlaySchema.safeParse({ ...hook, block: "Type Hero" }).success, false);
  assert.equal(TimelineOverlaySchema.safeParse({ ...hook, layer: "middle" }).success, false);
  assert.throws(() => validateTimeline({ ...base(), overlays: [] }));
  assert.throws(() => validateTimeline({ ...base(), overlays: [hook, hook] }), /Duplicate overlay ID/);
  assert.throws(() => validateTimeline({ ...base(), overlays: [{ ...hook, end: f(0) }] }), /Invalid overlay interval/);
  assert.throws(
    () => validateTimeline({ ...base(), overlays: [{ ...hook, offset: f(0) }] }),
    /Invalid overlay interval/,
  );
});

test("a timeline without overlays serialises, edits, slices and compiles exactly as before", () => {
  const ir = base();
  const before = JSON.stringify(ir);
  assert.equal(JSON.stringify(validateTimeline(ir)), before);
  const moved = applyEdit(ir, { type: "transition", trackId: "visual", clipId: "a", transition: { kind: "cut" } });
  assert.equal(JSON.stringify(moved), before);
  assert.equal("overlays" in compileTimelineIR(ir), false);
  assert.equal("overlays" in sliceTimeline(ir, { start: f(30), end: f(120) }), false);
  const ranges = [
    { start: f(0), end: f(60) },
    { start: f(150), end: f(210) },
  ];
  const short = compileShort(ir, {
    version: 1,
    id: "s1",
    purpose: "test",
    approval: { approvedBy: "user", approvedAt: "2026-11-13T00:00:00Z", selectionHash: selectionHash(ranges) },
    ranges,
  });
  assert.equal("overlays" in short.timeline, false);
  assert.equal("overlays" in short.snapshot, false);
  const roundTrip = applyEdit(withHook(), { type: "remove-overlay", overlayId: "hook" });
  assert.equal(JSON.stringify(roundTrip), before);
});

test("overlay commands add, update, remove and refuse bad edits", () => {
  const ir = withHook();
  assert.deepEqual(ir.overlays, [hook]);
  assert.throws(() => applyEdit(ir, { type: "add-overlay", overlay: hook }), /already exists/);
  assert.throws(
    () => applyEdit(base(), { type: "add-overlay", overlay: { ...hook, end: f(301) } }),
    /ends after the timeline/,
  );
  assert.throws(() => applyEdit(ir, { type: "update-overlay", overlayId: "hook" }));
  assert.throws(
    () => applyEdit(ir, { type: "update-overlay", overlayId: "nope", layer: "below-captions" }),
    /Overlay not found/,
  );
  assert.throws(() => applyEdit(ir, { type: "add-overlay", overlay: { ...hook, offset: f(3) } }));
  const updated = applyEdit(ir, {
    type: "update-overlay",
    overlayId: "hook",
    start: f(15),
    end: f(90),
    layer: "below-captions",
    props: { text: "Wait" },
  });
  assert.deepEqual(updated.overlays?.[0], {
    ...hook,
    start: f(15),
    end: f(90),
    layer: "below-captions",
    props: { text: "Wait" },
  });
  const sliced = sliceTimeline(ir, { start: f(30), end: f(300) });
  assert.deepEqual(sliced.overlays?.[0]?.offset, f(30));
  const reblocked = applyEdit(sliced, {
    type: "update-overlay",
    overlayId: "hook",
    block: "type-sentence-build",
    props: {},
  });
  assert.equal(reblocked.overlays?.[0]?.offset, undefined);
  const rippled = applyEdit(ir, { type: "ripple", trackId: "visual", from: f(0), delta: f(10) });
  assert.deepEqual(rippled.overlays, ir.overlays);
  const batch = applyEdit(base(), {
    type: "batch",
    commands: [
      { type: "add-overlay", overlay: hook },
      { type: "add-overlay", overlay: { ...hook, id: "stat", start: f(200), end: f(260) } },
      { type: "remove-overlay", overlayId: "hook" },
    ],
  });
  assert.deepEqual(
    batch.overlays?.map((overlay) => overlay.id),
    ["stat"],
  );
});

test("overlay blocks are checked against the catalogue's props schema", () => {
  const items = catalogue();
  assertOverlayBlocks(withHook(), items);
  const bad = (overlay: { block?: string; props?: Record<string, unknown> }): TimelineIR => ({
    ...withHook(),
    overlays: [{ ...hook, ...overlay }],
  });
  assert.throws(() => assertOverlayBlocks(bad({ props: { text: 3 } }), items), /prop text of type-hero-word/);
  assert.throws(() => assertOverlayBlocks(bad({ props: { colour: "red" } }), items), /type-hero-word/);
  assert.throws(() => assertOverlayBlocks(bad({ block: "no-such-block" }), items), /unknown library block/);
  assert.throws(
    () => assertOverlayBlocks(bad({ block: "caption-outline-pop", props: {} }), items),
    /cannot stand over a picture/,
  );
  assertOverlayBlocks(bad({ props: { text: 3 } }), items, ["other"]);
  assert.throws(
    () => assertOverlayBlocks(bad({ props: { text: "Wait" } }), items),
    /paints its default ground and groundBefore over the picture; set ground: "transparent", groundBefore: "transparent"/,
  );
  assert.throws(() => assertOverlayBlocks(bad({ block: "ui-touch-hotspot", props: {} }), items), /backdrop: "none"/);
  assertOverlayBlocks(bad({ props: { text: "Title card", ground: "#101010", groundBefore: "transparent" } }), items);
  assert.deepEqual(
    touchedOverlayIds({
      type: "batch",
      commands: [
        { type: "add-overlay", overlay: hook },
        { type: "update-overlay", overlayId: "x", layer: "above-captions" },
        { type: "remove-overlay", overlayId: "y" },
      ],
    }),
    ["hook", "x"],
  );
});

test("render selection splits layers, maps rational time to output frames and honours offsets", () => {
  const overlays = [
    { ...hook, id: "late", start: f(100), end: f(130), layer: "below-captions" as const },
    { ...hook, offset: f(15) },
    { ...hook, id: "tiny", start: f(1, 1000), end: f(2, 1000) },
  ];
  assert.deepEqual(overlayRenders(overlays, "below-captions", f(30), 30), [
    { id: "late", block: hook.block, props: hook.props, from: 100, durationInFrames: 30, offsetFrames: 0 },
  ]);
  assert.deepEqual(
    overlayRenders(overlays, "above-captions", f(30), 30).map((item) => [
      item.id,
      item.from,
      item.durationInFrames,
      item.offsetFrames,
    ]),
    [["hook", 0, 60, 15]],
  );
  assert.deepEqual(
    overlayRenders([{ ...hook, start: f(30), end: f(60) }], "above-captions", f(60), 30).map((item) => [
      item.from,
      item.durationInFrames,
    ]),
    [[15, 15]],
  );
  assert.deepEqual(overlayRenders(undefined, "above-captions", f(30), 30), []);
});

test("chapters and shorts keep overlays on their own clock", () => {
  const ir = applyEdit(withHook(), {
    type: "add-overlay",
    overlay: { ...hook, id: "stat", start: f(140), end: f(200), layer: "below-captions" },
  });
  const chapter = sliceTimeline(ir, { start: f(30), end: f(160) });
  assert.deepEqual(chapter.overlays, [
    { ...hook, start: f(0), end: f(30), offset: f(30) },
    { ...hook, id: "stat", start: f(110), end: f(130), layer: "below-captions" },
  ]);
  assert.equal(sliceTimeline(ir, { start: f(60), end: f(140) }).overlays, undefined);
  assert.deepEqual(rebaseOverlays([{ ...hook, offset: f(10) }], [{ start: f(20), end: f(40), at: f(5) }]), [
    { ...hook, start: f(5), end: f(25), offset: f(30) },
  ]);
  const ranges = [
    { start: f(0), end: f(150) },
    { start: f(150), end: f(240) },
  ];
  const short = compileShort(ir, {
    version: 1,
    id: "s1",
    purpose: "test",
    approval: { approvedBy: "user", approvedAt: "2026-11-13T00:00:00Z", selectionHash: selectionHash(ranges) },
    ranges,
  });
  assert.deepEqual(
    short.timeline.overlays?.map((overlay) => [overlay.id, overlay.start, overlay.end, overlay.offset]),
    [
      ["s1-0-hook", f(0), f(60), undefined],
      ["s1-0-stat", f(140), f(150), undefined],
      ["s1-1-stat", f(150), f(200), f(10)],
    ],
  );
  assert.equal(short.snapshot.overlays?.length, 3);
  const longId = "x".repeat(200);
  const long = applyEdit(base(), { type: "add-overlay", overlay: { ...hook, id: longId } });
  const longShort = compileShort(long, {
    version: 1,
    id: "a-long-short-id",
    purpose: "test",
    approval: { approvedBy: "user", approvedAt: "2026-11-13T00:00:00Z", selectionHash: selectionHash(ranges) },
    ranges,
  });
  assert.equal(
    longShort.timeline.overlays?.[0]?.id,
    `a-long-short-id-0-${longId}`,
    "a renamed overlay id may pass 200 characters",
  );
});
