import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import path from "node:path";
import { shortsFixture, r, addSuppliedEducation } from "./workflow-shorts-series.fixture";
import {
  runShortsSeriesWorkflow,
  assertShortsSeriesReady,
  inspectShortsSeriesSource,
} from "../src/lib/workflows/shorts-series";
import { selectionHash } from "../src/lib/longform/plans";
import { hashFile } from "../src/lib/assets/registry";
import { planProjectRender } from "../src/lib/render-plan";

test("plan writes nothing; create produces three independent renderable projects with exact sources/captions and committed replay", (t) => {
  const f = shortsFixture(t),
    original = hashFile(f.video);
  const plan = runShortsSeriesWorkflow(f.request, {
    action: "plan",
    rootDir: f.root,
  });
  assert.deepEqual(plan.outputs, []);
  assert.equal(existsSync(path.join(f.root, "public/projects/technical-series")), false);
  const created = runShortsSeriesWorkflow(f.request, {
    action: "create",
    rootDir: f.root,
  });
  assert.equal(created.metadata.state, "committed");
  assert.equal(hashFile(f.video), original);
  for (const selection of f.request.episodes) {
    const id = `technical-series-${selection.selection.id}`,
      directory = path.join(f.root, "public/projects", id);
    assertShortsSeriesReady(directory, { rootDir: f.root, timeline: true });
    const planned = planProjectRender(id, undefined, f.root, {
      timeline: true,
    });
    assert.deepEqual(
      planned.jobs.map((job) => job.format),
      ["vertical", "square"],
    );
    assert.ok(planned.jobs.every((job) => job.props.timeline!.projectId === id));
  }
  const caveat = planProjectRender("technical-series-caveat", "vertical", f.root, { timeline: true }).jobs[0];
  assert.equal(caveat.durationInFrames, 60);
  const speech = caveat.props.timeline!.tracks.find((track) => track.kind === "voiceover")!.clips[0];
  assert.deepEqual(speech.start, r(0));
  assert.deepEqual(speech.source.start, r(30));
  assert.deepEqual(speech.source.end, r(90));
  assert.deepEqual(
    speech.captions.map((word) => word.text),
    ["Это", "не", "гарантия", "Зависит от условий"],
  );
  assert.equal(runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root }).metadata.idempotent, true);
  assert.throws(
    () => assertShortsSeriesReady(path.join(f.root, "public/projects/technical-series-caveat"), { rootDir: f.root }),
    /--timeline/,
  );
});
test("missing context, stale source review, overlapping ranges and out of bounds fail without projects", (t) => {
  const f = shortsFixture(t);
  const run = (request: unknown) => runShortsSeriesWorkflow(request, { action: "create", rootDir: f.root });
  const omitted = structuredClone(f.request);
  omitted.episodes[1].selection.ranges = [{ start: r(30), end: r(60) }];
  omitted.episodes[1].selection.approval.selectionHash = selectionHash(omitted.episodes[1].selection.ranges);
  assert.throws(() => run(omitted), /required context/);
  const stale = structuredClone(f.request);
  stale.episodes[0].approvedSourceHash = "0".repeat(64);
  assert.throws(() => run(stale), /reviewed source snapshot/);
  const overlap = structuredClone(f.request);
  overlap.episodes[0].selection.ranges = [
    { start: r(0), end: r(20) },
    { start: r(10), end: r(30) },
  ];
  overlap.episodes[0].selection.approval.selectionHash = selectionHash(overlap.episodes[0].selection.ranges);
  assert.throws(() => run(overlap), /non-overlapping/);
  const outside = structuredClone(f.request);
  outside.episodes[0].selection.ranges = [{ start: r(0), end: r(150) }];
  outside.episodes[0].selection.approval.selectionHash = selectionHash(outside.episodes[0].selection.ranges);
  assert.throws(() => run(outside), /within source/);
  assert.equal(existsSync(path.join(f.root, "public/projects/technical-series")), false);
});
test("ownership and source/copy tampering are explicit; occupied projects prevent partial publication", (t) => {
  const f = shortsFixture(t),
    projects = path.join(f.root, "public/projects");
  mkdirSync(path.join(projects, "technical-series-caveat"));
  assert.throws(() => runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root }), /overwrite existing/);
  assert.equal(existsSync(path.join(projects, "technical-series-hook")), false);
  const forged = structuredClone(f.request);
  forged.source.timelineRevision = 99;
  assert.throws(() => runShortsSeriesWorkflow(forged, { action: "plan", rootDir: f.root }), /Stale source/);
  assert.throws(
    () =>
      runShortsSeriesWorkflow(f.request, {
        action: "plan",
        rootDir: f.root,
        scopeRoot: path.join(f.root, "public/projects/source"),
      }),
    /escapes/,
  );
});
test("committed derivatives reject modified copied originals and uncommitted series residue", (t) => {
  const f = shortsFixture(t);
  runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root });
  const episode = path.join(f.root, "public/projects/technical-series-hook"),
    registry = JSON.parse(readFileSync(path.join(episode, "pipeline/asset-registry.json"), "utf8"));
  const original = path.join(f.root, "public", registry.assets[0].files.original);
  writeFileSync(original, "tampered");
  assert.throws(() => assertShortsSeriesReady(episode, { rootDir: f.root, timeline: true }), /artifact changed/);
});

test("disjoint approved ranges preserve source trims and rebase captions without hidden context or rate changes", (t) => {
  const f = shortsFixture(t);
  const request = structuredClone(f.request);
  const ranges = [
    { start: r(0), end: r(30) },
    { start: r(90), end: r(120) },
  ];
  request.episodes[0].selection.ranges = ranges;
  request.episodes[0].selection.approval.selectionHash = selectionHash(ranges);
  runShortsSeriesWorkflow(request, { action: "create", rootDir: f.root });
  const file = path.join(f.root, "public/projects/technical-series-hook/pipeline/timeline-edit.json");
  const timeline = JSON.parse(readFileSync(file, "utf8")).timeline;
  const speech = timeline.tracks.find((track: { kind: string }) => track.kind === "voiceover");
  assert.equal(speech.clips.length, 2);
  assert.deepEqual(
    speech.clips.map((clip: any) => [clip.start.num, clip.source.start.num, clip.source.end.num, clip.rate.num]),
    [
      [0, 0, 30, 1],
      [30, 90, 120, 1],
    ],
  );
  assert.equal(speech.clips[1].captions[0].text, "Проверьте источник");
});

test("missing commit marker rejects crash residue; original changed after approval and cut through word fail before create", (t) => {
  const f = shortsFixture(t);
  const cut = structuredClone(f.request);
  cut.episodes[0].selection.ranges = [{ start: r(5), end: r(30) }];
  cut.episodes[0].selection.approval.selectionHash = selectionHash(cut.episodes[0].selection.ranges);
  assert.throws(() => runShortsSeriesWorkflow(cut, { action: "create", rootDir: f.root }), /word|caption/i);
  runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root });
  const marker = path.join(f.root, "public/projects/technical-series/series-commit.json");
  const original = readFileSync(marker);
  rmSync(marker);
  assert.throws(
    () =>
      assertShortsSeriesReady(path.join(f.root, "public/projects/technical-series-hook"), {
        rootDir: f.root,
        timeline: true,
      }),
    /uncommitted/,
  );
  writeFileSync(marker, original);
  writeFileSync(f.video, Buffer.from("modified source"));
  assert.throws(
    () => runShortsSeriesWorkflow(f.request, { action: "plan", rootDir: f.root }),
    /probe|asset|media|invalid|failed|stale/i,
  );
});

test("malformed mandatory parent workflow evidence fails rather than silently losing claims", (t) => {
  const f = shortsFixture(t);
  writeFileSync(path.join(f.directory, "pipeline/education.json"), "{}");
  assert.throws(
    () => runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root }),
    /request|Required|invalid/i,
  );
  assert.equal(existsSync(path.join(f.root, "public/projects/technical-series")), false);
});

test("rewriting receipt file hashes cannot authorize modified authored episode content", (t) => {
  const f = shortsFixture(t);
  runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root });
  const directory = path.join(f.root, "public/projects/technical-series-hook");
  const projectFile = path.join(directory, "project.json");
  const project = JSON.parse(readFileSync(projectFile, "utf8"));
  project.name = "Unreviewed replacement";
  writeFileSync(projectFile, JSON.stringify(project));
  const markerFile = path.join(f.root, "public/projects/technical-series/series-commit.json");
  const marker = JSON.parse(readFileSync(markerFile, "utf8"));
  marker.episodes.find((e: { projectId: string }) => e.projectId === "technical-series-hook").files["project.json"] =
    hashFile(projectFile);
  writeFileSync(markerFile, JSON.stringify(marker));
  assert.throws(
    () => assertShortsSeriesReady(directory, { rootDir: f.root, timeline: true }),
    /immutable episode content/,
  );
});

test("whole educational claim scene inherits verified evidence; unrelated short has no copied claims", (t) => {
  const f = shortsFixture(t);
  const supplied = addSuppliedEducation(f);
  runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root });
  const directory = path.join(f.root, "public/projects/technical-series-caveat");
  const artifact = JSON.parse(readFileSync(path.join(directory, "pipeline/workflow-claims.json"), "utf8"));
  assert.equal(artifact.projectId, "technical-series-caveat");
  assert.equal(artifact.claims.length, 1);
  assert.equal(artifact.claims[0].sceneId, "caveat-0-caveat");
  assert.equal(artifact.claims[0].text, supplied.excerpt);
  const project = JSON.parse(readFileSync(path.join(directory, "project.json"), "utf8"));
  assert.equal(project.scenes[0].text, "Это не гарантия Зависит от условий");
  const original = path.join(f.root, "public", artifact.claims[0].evidence[0].path);
  assert.equal(hashFile(original), supplied.sha256);
  assert.equal(
    existsSync(path.join(f.root, "public/projects/technical-series-hook/pipeline/workflow-claims.json")),
    false,
  );
  assertShortsSeriesReady(directory, { rootDir: f.root, timeline: true });
  writeFileSync(original, "tampered supplied evidence");
  assert.throws(() => assertShortsSeriesReady(directory, { rootDir: f.root, timeline: true }), /artifact changed/);
});

test("partial claim scene, missing source review and changed supplied evidence reject before publication", (t) => {
  const f = shortsFixture(t);
  const supplied = addSuppliedEducation(f);
  const partial = structuredClone(f.request);
  partial.episodes[1].selection.ranges = [{ start: r(60), end: r(90) }];
  partial.episodes[1].selection.approval.selectionHash = selectionHash(partial.episodes[1].selection.ranges);
  assert.throws(() => runShortsSeriesWorkflow(partial, { action: "create", rootDir: f.root }), /protected/);
  const noReview = structuredClone(f.request);
  noReview.episodes[1].approvedSourceHash = "0".repeat(64);
  assert.throws(() => runShortsSeriesWorkflow(noReview, { action: "create", rootDir: f.root }), /reviewed source/);
  writeFileSync(supplied.evidenceFile, supplied.excerpt + " changed evidence");
  assert.throws(
    () => runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root }),
    /source changed|excerpt/i,
  );
  assert.equal(existsSync(path.join(f.root, "public/projects/technical-series")), false);
});

test("actual render planner rejects missing series commit, episode binding and inherited evidence original", (t) => {
  const f = shortsFixture(t);
  addSuppliedEducation(f);
  runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root });
  const id = "technical-series-caveat";
  const directory = path.join(f.root, "public/projects", id);
  assert.equal(planProjectRender(id, "vertical", f.root, { timeline: true }).jobs.length, 1);
  const markerFile = path.join(f.root, "public/projects/technical-series/series-commit.json");
  const marker = readFileSync(markerFile);
  rmSync(markerFile);
  assert.throws(() => planProjectRender(id, "vertical", f.root, { timeline: true }), /uncommitted/);
  writeFileSync(markerFile, marker);
  const bindingFile = path.join(directory, "pipeline/shorts-series-binding.json");
  const binding = readFileSync(bindingFile);
  rmSync(bindingFile);
  assert.throws(
    () => planProjectRender(id, "vertical", f.root, { timeline: true }),
    /evidence is missing|binding missing/i,
  );
  writeFileSync(bindingFile, binding);
  const claims = JSON.parse(readFileSync(path.join(directory, "pipeline/workflow-claims.json"), "utf8"));
  rmSync(path.join(f.root, "public", claims.claims[0].evidence[0].path));
  assert.throws(
    () => planProjectRender(id, "vertical", f.root, { timeline: true }),
    /artifact changed|source changed|absent/i,
  );
});
