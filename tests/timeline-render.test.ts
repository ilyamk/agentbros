import { importAsset } from "../src/lib/assets/registry";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { planProjectRender } from "../src/lib/render-plan";
import { TimelineEditStore, adaptLegacyProject } from "../src/lib/timeline-ir";
import { renderBoundary, mediaTiming } from "../src/lib/timeline-ir/render";
const r = (num: number, den = 1) => ({ num, den });
const project = () => ({
  name: "edit-render",
  productName: "edit-render",
  colors: {},
  formats: ["vertical", "square", "landscape"],
  musicVolume: 0,
  voiceoverEnabled: false,
  scenes: [
    {
      id: "a",
      text: "A",
      headline: "A",
      visualType: "title",
      durationInFrames: 60,
      transitionToNext: "cut",
    },
    {
      id: "b",
      text: "B",
      headline: "B",
      visualType: "title",
      durationInFrames: 60,
    },
  ],
});
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "timeline-render-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/edit-render");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "project.json"), JSON.stringify(project()));
  const store = new TimelineEditStore(path.join(dir, "pipeline/timeline-edit.json"));
  store.initialize(adaptLegacyProject(project(), "edit-render"));
  return { root, dir, store };
}
test("render opt-in reads exact edited journal while legacy remains canonical", (t) => {
  const { root, store } = fixture(t);
  const original = planProjectRender("edit-render", undefined, root);
  store.apply(
    {
      type: "batch",
      commands: [
        {
          type: "trim",
          trackId: "visual",
          clipId: "a",
          start: r(0),
          end: r(30),
        },
        { type: "ripple", trackId: "visual", from: r(60), delta: r(-30) },
      ],
    },
    0,
  );
  const edited = planProjectRender("edit-render", undefined, root, {
    timeline: true,
  });
  assert.deepEqual(
    edited.jobs.map((job) => job.durationInFrames),
    [90, 90, 90],
  );
  assert.ok(edited.jobs.every((job) => job.props.timeline));
  assert.deepEqual(planProjectRender("edit-render", undefined, root).jobs, original.jobs);
  store.undo(1);
  assert.deepEqual(
    planProjectRender("edit-render", undefined, root, {
      timeline: true,
    }).jobs.map((job) => job.durationInFrames),
    [120, 120, 120],
  );
});
test("replacement resolves public source; missing hash bindings and transforms fail before browser", (t) => {
  const { root, dir, store } = fixture(t);
  writeFileSync(path.join(dir, "blue.png"), "fake-image-for-plan-only");
  store.apply(
    {
      type: "replace",
      trackId: "visual",
      clipId: "a",
      assetId: "projects/edit-render/blue.png",
      source: { start: r(0), end: r(60), timebase: r(30) },
    },
    0,
  );
  const plan = planProjectRender("edit-render", "square", root, {
    timeline: true,
  });
  assert.equal(plan.jobs[0].props.timelineAssets?.["projects/edit-render/blue.png"].kind, "image");
  store.apply(
    {
      type: "replace",
      trackId: "visual",
      clipId: "a",
      assetId: `sha256:${"a".repeat(64)}`,
      source: { start: r(0), end: r(60), timebase: r(30) },
    },
    1,
  );
  assert.throws(() => planProjectRender("edit-render", "square", root, { timeline: true }), /Unregistered/);
});
test("fractional output boundaries are shared and source fps conversion is independent of playback rate", () => {
  assert.equal(renderBoundary(r(1, 2), r(24), 30), 1);
  assert.equal(renderBoundary(r(3, 2), r(24), 30), 2);
  assert.deepEqual(mediaTiming({ start: r(48), end: r(96), timebase: r(24) }, r(3, 2), 30), {
    trimBefore: 60,
    trimAfter: 120,
    playbackRate: 1.5,
  });
  assert.deepEqual(mediaTiming({ start: r(1, 2), end: r(121, 2), timebase: r(30) }, r(2), 30), {
    trimBefore: 1,
    trimAfter: 61,
    playbackRate: 2,
  });
});
test("timeline mode cannot render another project's journal", (t) => {
  const { root, store } = fixture(t);
  const doc = store.read();
  doc.timeline.projectId = "other";
  writeFileSync(store.file, JSON.stringify(doc));
  assert.throws(() => planProjectRender("edit-render", "vertical", root, { timeline: true }), /binding/);
});

test("NTSC frame boundaries do not acquire floating point extra frames", () => {
  assert.equal(renderBoundary(r(30000), r(30000, 1001), 30), 30030);
});

test("registered media with changed original bytes cannot render under the old immutable ID", (t) => {
  const { root, dir, store } = fixture(t);
  const source = path.join(root, "original.png");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=40x40", "-frames:v", "1", source]);
  const asset = importAsset({
    rootDir: root,
    projectId: "edit-render",
    sourceFile: source,
    provenance: { origin: "agent-harness" },
  }).asset;
  store.apply(
    {
      type: "replace",
      trackId: "visual",
      clipId: "a",
      assetId: asset.id,
      source: { start: r(0), end: r(60), timebase: r(30) },
    },
    0,
  );
  assert.equal(planProjectRender("edit-render", "square", root, { timeline: true }).jobs.length, 1);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=40x40",
    "-frames:v",
    "1",
    path.join(root, "public", asset.files.original),
  ]);
  assert.throws(() => planProjectRender("edit-render", "square", root, { timeline: true }), /checksum mismatch/);
});
