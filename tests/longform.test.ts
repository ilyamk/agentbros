import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import type { TimelineIR } from "../src/types/timeline";
import { planChapters, payloadMediaPaths, compileShort, selectionHash } from "../src/lib/longform/plans";
import { sliceTimeline } from "../src/lib/longform/slice";
import { renderChapters, projectChapterPlan } from "../src/lib/longform/runner";
import { hashFile } from "../src/lib/assets/registry";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
const r = (num: number, den = 1) => ({ num, den });
const fixture = (): TimelineIR => ({
  version: 1,
  projectId: "three-minute",
  timebase: r(30),
  legacyProject: { hugeGlobalSceneList: "not-a-chapter-dependency" },
  tracks: [
    {
      id: "visual",
      kind: "visual",
      clips: [
        {
          id: "one",
          assetId: "scene:one",
          start: r(0),
          source: { start: r(0), end: r(2700), timebase: r(30) },
          rate: r(1),
          transition: { kind: "cut" },
          captions: [],
          payload: {
            scene: {
              id: "one",
              text: "One",
              visualType: "title",
              headline: "One",
            },
          },
        },
        {
          id: "two",
          assetId: "scene:two",
          start: r(2700),
          source: { start: r(0), end: r(2700), timebase: r(30) },
          rate: r(1),
          transition: { kind: "cut" },
          captions: [],
          payload: {
            scene: {
              id: "two",
              text: "Two",
              visualType: "title",
              headline: "Two",
            },
          },
        },
      ],
    },
  ],
});
const chapters = {
  version: 1,
  revision: 1,
  chapters: [
    { id: "one", title: "One", revision: 1, start: r(0), end: r(2700) },
    { id: "two", title: "Two", revision: 1, start: r(2700), end: r(5400) },
  ],
  protectedSpans: [],
};
test("three minute timeline yields exact two chapters; one edit invalidates only one fingerprint", () => {
  const ir = fixture(),
    first = planChapters(ir, chapters);
  assert.deepEqual(
    first.jobs.map((job) => job.snapshot.durationInFrames),
    [2700, 2700],
  );
  const cache = Object.fromEntries(
    first.jobs.map((job) => [job.chapterId, { fingerprint: job.fingerprint, output: "old.mp4", outputHash: "hash" }]),
  );
  const changed = structuredClone(ir);
  changed.tracks[0].clips[0].payload!.scene = { text: "Changed first chapter" };
  changed.legacyProject!.hugeGlobalSceneList = "changedglobalnotrendered";
  const next = planChapters(changed, chapters, { cache });
  assert.deepEqual(
    next.jobs.map((job) => job.action),
    ["render", "reuse"],
  );
});
test("slice uses exact source/rate conversions and prevents cutting a spoken word", () => {
  const ir = fixture();
  ir.tracks[0].clips[0].source.timebase = r(24);
  ir.tracks[0].clips[0].source.end = r(4320);
  ir.tracks[0].clips[0].rate = r(2); // Same 90 sec output.
  const slice = sliceTimeline(ir, { start: r(30), end: r(90) });
  assert.deepEqual(slice.tracks[0].clips[0].source.start, r(48));
  assert.deepEqual(slice.tracks[0].clips[0].source.end, r(144));
  ir.tracks[0].clips[0].captions = [{ id: "word", text: "not", start: r(40), end: r(60) }];
  assert.throws(() => sliceTimeline(ir, { start: r(30), end: r(90) }), /spoken word/);
});
test("approved shorts retain caveats/negation/context and bind approval to exact intervals", () => {
  const ir = fixture(),
    ranges = [{ start: r(0), end: r(900) }];
  const selection = {
    version: 1,
    id: "short",
    purpose: "supplied excerpt",
    approval: {
      approvedBy: "creator",
      approvedAt: "2026-10-11T00:00:00Z",
      selectionHash: selectionHash(ranges),
    },
    ranges,
  };
  const spans = [
    {
      id: "negation",
      start: r(0),
      end: r(300),
      reason: "negation" as const,
      note: "Never omit not",
      requires: ["caveat"],
    },
    {
      id: "caveat",
      start: r(300),
      end: r(900),
      reason: "caveat" as const,
      note: "Keep conditions",
      requires: [],
    },
  ];
  assert.equal(compileShort(ir, selection, spans).snapshot.durationInFrames, 900);
  const omitted = [{ start: r(0), end: r(300) }];
  assert.throws(
    () =>
      compileShort(
        ir,
        {
          ...selection,
          ranges: omitted,
          approval: {
            ...selection.approval,
            selectionHash: selectionHash(omitted),
          },
        },
        spans,
      ),
    /required context/,
  );
  assert.throws(() => compileShort(ir, { ...selection, ranges: omitted }, spans), /Approval/);
});
test("a short or a chapter moves the recut's measured caption placement and legibility to its own clock", () => {
  const ir: TimelineIR = {
    ...fixture(),
    captionStyle: {
      profile: "outline-pop",
      options: {
        size: 1,
        positions: [{ from: 12, to: 14, position: "upper" }],
        legibility: [
          { from: 1, to: 2, level: 2 },
          { from: 7, to: 8, level: 3 },
          { from: 25, to: 28, level: 1 },
        ],
      },
    },
  };
  const short = (ranges: { start: { num: number; den: number }; end: { num: number; den: number } }[]) =>
    compileShort(ir, {
      version: 1,
      id: "placed",
      purpose: "placed captions",
      approval: { approvedBy: "creator", approvedAt: "2026-11-13T00:00:00Z", selectionHash: selectionHash(ranges) },
      ranges,
    }).timeline.captionStyle!;
  const one = short([{ start: r(300), end: r(900) }]);
  assert.deepEqual(one.options!.positions, [{ from: 2, to: 4, position: "upper" }]);
  assert.deepEqual(one.options!.legibility, [{ from: 15, to: 18, level: 1 }]);
  assert.equal(one.options!.size, 1);
  const two = short([
    { start: r(0), end: r(150) },
    { start: r(360), end: r(900) },
  ]);
  assert.deepEqual(two.options!.positions, [{ from: 5, to: 7, position: "upper" }]);
  assert.deepEqual(two.options!.legibility, [
    { from: 1, to: 2, level: 2 },
    { from: 18, to: 21, level: 1 },
  ]);
  assert.deepEqual(ir.captionStyle!.options!.positions, [{ from: 12, to: 14, position: "upper" }]);
  const chapter = sliceTimeline(ir, { start: r(330), end: r(810) }).captionStyle!;
  assert.deepEqual(chapter.options!.positions, [{ from: 1, to: 3, position: "upper" }]);
  assert.deepEqual(chapter.options!.legibility, [{ from: 14, to: 16, level: 1 }]);
  const unplaced = { ...fixture(), captionStyle: { profile: "outline-pop" as const, options: { size: 1 } } };
  const ranges = [{ start: r(300), end: r(900) }];
  assert.deepEqual(
    compileShort(unplaced, {
      version: 1,
      id: "plain",
      purpose: "x",
      approval: { approvedBy: "c", approvedAt: "2026-11-13T00:00:00Z", selectionHash: selectionHash(ranges) },
      ranges,
    }).timeline.captionStyle,
    unplaced.captionStyle,
  );
});
test("real synthetic chapter outputs are measured and reused; cache isn't publication approval", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chapters-local-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "three-minute.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x64:r=30:d=90",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64:r=30:d=90",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    source,
  ]);
  const ir = fixture();
  ir.tracks[0].clips = [
    {
      ...ir.tracks[0].clips[0],
      assetId: "local-media",
      source: { start: r(0), end: r(5400), timebase: r(30) },
      payload: undefined,
    },
  ];
  const plan = planChapters(ir, chapters, {
    assetHashes: { "local-media": "synthetic-checksum" },
  });
  const expanded = {
    ...plan,
    cacheFile: path.join(root, "cache.json"),
    jobs: plan.jobs.map((job) => ({
      ...job,
      format: "landscape" as const,
      compositionId: "synthetic",
      durationInFrames: job.snapshot.durationInFrames,
      output: path.join(root, job.chapterId + ".mp4"),
      props: {} as never,
    })),
  };
  let renders = 0;
  const backend = async (job: { chapterId: string; timeline: TimelineIR }, output: string) => {
    renders++;
    const clip = job.timeline.tracks[0].clips[0];
    const startSec = clip.source.start.num / clip.source.start.den / 30;
    const endSec = clip.source.end.num / clip.source.end.den / 30;
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-ss",
      String(startSec),
      "-i",
      source,
      "-t",
      String(endSec - startSec),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      output,
    ]);
  };
  const dry = await renderChapters(expanded);
  assert.equal(dry.outputs.length, 0);
  assert.equal(renders, 0);
  const actual = await renderChapters(expanded, {
    dryRun: false,
    render: backend,
  });
  assert.equal(actual.outputs.length, 2);
  assert.equal(renders, 2);
  const firstPixel = (file: string) =>
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "scale=1:1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
  const red = firstPixel(actual.outputs[0]),
    blue = firstPixel(actual.outputs[1]);
  assert.ok(red[0] > 200 && red[2] < 30);
  assert.ok(blue[2] > 200 && blue[0] < 30);
  const cached = JSON.parse(readFileSync(expanded.cacheFile, "utf8"));
  assert.ok(cached.two.outputHash);
  const reused = {
    ...expanded,
    jobs: expanded.jobs.map((job) => ({
      ...job,
      action: "reuse",
      previousOutput: cached[job.chapterId].output,
      previousOutputHash: cached[job.chapterId].outputHash,
    })),
  };
  await renderChapters(reused, { dryRun: false, render: backend });
  assert.equal(renders, 2);
  writeFileSync(actual.outputs[0], "corrupted-output");
  await renderChapters(reused, { dryRun: false, render: backend });
  assert.equal(renders, 3);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(expanded.cacheFile, "utf8"))).sort(), ["one", "two"]);
});

test("scene media checksums participate only in chapters that reference them", () => {
  const ir = fixture();
  ir.tracks[0].clips[0].payload!.scene = {
    imageUrl: "projects/three-minute/assets/first.png",
  };
  const hashKey = "path:projects/three-minute/assets/first.png";
  const initial = planChapters(ir, chapters, {
    assetHashes: { [hashKey]: "before" },
  });
  const cache = Object.fromEntries(
    initial.jobs.map((job) => [
      job.chapterId,
      { fingerprint: job.fingerprint, output: "cached.mp4", outputHash: "old" },
    ]),
  );
  assert.deepEqual(
    planChapters(ir, chapters, {
      cache,
      assetHashes: { [hashKey]: "after" },
    }).jobs.map((job) => job.action),
    ["render", "reuse"],
  );
  assert.equal(planChapters(ir, chapters, { cache }).jobs[0].action, "render");
});

test("uncovered trailing gaps cannot silently shorten an approved selection", () => {
  const ir = fixture();
  ir.tracks[0].clips[1].start = r(3000);
  assert.throws(() => sliceTimeline(ir, { start: r(0), end: r(2800) }), /uncovered output gap/);
});

test("canonical project plan freezes chapter props and refuses whole-project master", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chapter-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "public/projects/three-minute");
  mkdirSync(path.join(projectDir, "pipeline"), { recursive: true });
  writeFileSync(
    path.join(projectDir, "project.json"),
    JSON.stringify({
      name: "Three minute fixture",
      productName: "Fixture",
      formats: ["landscape"],
      colors: {},
      musicVolume: 0,
      scenes: [
        {
          id: "one",
          text: "One",
          headline: "One",
          visualType: "title",
          durationInFrames: 5400,
        },
      ],
    }),
  );
  new TimelineEditStore(path.join(projectDir, "pipeline/timeline-edit.json")).initialize(fixture());
  const plan = projectChapterPlan("three-minute", chapters, { rootDir: root });
  assert.equal(plan.jobs[1].durationInFrames, 2700);
  assert.equal(plan.jobs[1].compositionId, "ProjectLandscape");
  assert.ok(Object.isFrozen(plan.jobs[1].props.timeline));
  assert.throws(
    () =>
      projectChapterPlan("three-minute", chapters, {
        rootDir: root,
        audioMaster: "master.json",
      }),
    /Whole-project audio masters/,
  );
});

test("dependency discovery ignores filename-like teaching text but preserves transitive media", () => {
  const paths = payloadMediaPaths({
    scene: {
      headline: "package.json",
      subtext: "Render lesson.mp4",
      text: "Open config.json",
      template: { props: { imageUrl: "assets/proof.png" } },
      leftPanel: { kind: "aiImage", imageUrl: "projects/source/picture.jpg" },
    },
  });
  assert.deepEqual(paths, ["assets/proof.png", "projects/source/picture.jpg"]);
  const ir = fixture();
  ir.tracks.push({
    id: "captions",
    kind: "captions",
    clips: [
      {
        ...ir.tracks[0].clips[0],
        id: "caption-line",
        assetId: "inline-caption",
      },
    ],
  });
  const result = planChapters(ir, chapters, {
    assetHashes: { "source.mp4": "hash", "speech.wav": "hash" },
  });
  assert.equal(Object.keys(result.jobs[0].dependencies).includes("inline-caption"), false);
});

test("configured renderer identity and cache project confinement are enforced", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chapter-integrity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/lesson");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  const scene = {
    id: "hook",
    text: "",
    headline: "package.json",
    visualType: "title",
    durationInFrames: 60,
  };
  writeFileSync(
    path.join(project, "project.json"),
    JSON.stringify({
      name: "lesson",
      productName: "lesson",
      formats: ["landscape"],
      colors: {},
      musicVolume: 0,
      scenes: [scene],
    }),
  );
  new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json")).initialize({
    version: 1,
    projectId: "lesson",
    timebase: r(30),
    tracks: [
      {
        id: "visual",
        kind: "visual",
        clips: [
          {
            id: "hook",
            assetId: "scene:hook",
            start: r(0),
            source: { start: r(0), end: r(60), timebase: r(30) },
            rate: r(1),
            transition: { kind: "cut" },
            captions: [],
            payload: { scene },
          },
        ],
      },
    ],
  });
  const codeDir = path.join(root, "configured-code");
  mkdirSync(path.join(codeDir, "src"), { recursive: true });
  writeFileSync(path.join(codeDir, "src/index.ts"), "// renderer source A");
  writeFileSync(path.join(codeDir, "package.json"), "{}");
  const manifest = {
    version: 1,
    revision: 1,
    chapters: [{ id: "one", title: "Chapter", revision: 1, start: r(0), end: r(60) }],
  };
  const first = projectChapterPlan("lesson", manifest, {
    rootDir: root,
    codeDir,
  });
  writeFileSync(path.join(codeDir, "src/index.ts"), "// renderer source B");
  const second = projectChapterPlan("lesson", manifest, {
    rootDir: root,
    codeDir,
  });
  assert.notEqual(first.jobs[0].fingerprint, second.jobs[0].fingerprint);
  const foreign = path.join(root, "other-project.mp4");
  writeFileSync(foreign, "unrelated artifact");
  mkdirSync(path.dirname(second.cacheFile), { recursive: true });
  writeFileSync(
    second.cacheFile,
    JSON.stringify({
      one: {
        fingerprint: second.jobs[0].fingerprint,
        output: foreign,
        outputHash: hashFile(foreign),
      },
    }),
  );
  assert.equal(projectChapterPlan("lesson", manifest, { rootDir: root, codeDir }).jobs[0].action, "render");
  rmSync(second.cacheFile);
  symlinkSync(foreign, second.cacheFile);
  assert.throws(() => projectChapterPlan("lesson", manifest, { rootDir: root, codeDir }), /symlink/);
});
