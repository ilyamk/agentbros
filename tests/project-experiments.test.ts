import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { executeCampaignTask } from "../src/lib/campaigns/production/execute";
import { approveCampaignPackage, reviewPackage } from "../src/lib/campaigns/production/review";
import { initCampaign } from "../src/lib/campaigns/production/store";
import { fileHash } from "../src/lib/campaigns/production/files";
import { CameraRequestSchema, proposeTutorialCamera } from "../src/lib/experiments/camera";
import { compareProjects, freezeComparison, recordComparisonOutcome } from "../src/lib/experiments/compare";
import { DEFAULT_TUTORIAL_KIT } from "../src/lib/experiments/kit-schema";
import { experimentFile, readExperiments, selectExperiment, startExperiment } from "../src/lib/experiments/project";
import { assertTutorialKit, tutorialKitFile } from "../src/lib/experiments/series";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { timelineNext } from "../src/lib/pipeline/timeline-next";
import { withPlaybook } from "../src/lib/pipeline/route";
import { writeProjectPlaybook } from "../src/lib/playbooks/project";
import { materializeRecipe } from "../src/lib/templates/materialize";
import { buildRecipe } from "../src/lib/templates/recipes";
import { openFilmProject } from "../src/lib/film/state";
import { renderBrief } from "../src/lib/film/brief";
import { scaffoldFilmProject } from "../src/lib/film/project";
import type { RecipeRequest } from "../src/types/recipes";

function workspace(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "project-experiments-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = (id: string) => path.join(root, "public/projects", id);
  return { root, project };
}
const json = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });

test("the ordinary route is unchanged, while a camera selection reaches the appropriate step and leaf brief", (t) => {
  const { root, project } = workspace(t);
  const directory = project("lesson");
  mkdirSync(directory, { recursive: true });
  scaffoldFilmProject(directory, "lesson", [], { filmType: "ui-demo" });
  writeProjectPlaybook(directory, "product-tutorial", "user");
  assert.equal(withPlaybook(directory, [], "beat-sheet").experiments, undefined);
  assert.equal(existsSync(experimentFile(directory)), false);
  const film = openFilmProject(directory, { rootDir: root });
  assert.doesNotMatch(renderBrief(film, "beat-sheet").prompt, /tutorial-camera@1/);

  selectExperiment(directory, "tutorial-camera@1", true);
  assert.equal(withPlaybook(directory, [], "beat-sheet").experiments?.[0]?.id, "tutorial-camera@1");
  assert.equal(withPlaybook(directory, [], "script").experiments, undefined);
  assert.match(renderBrief(film, "beat-sheet").prompt, /pnpm experiment --action camera --project lesson/);
  assert.equal(readExperiments(directory)[0]?.started, false);
  selectExperiment(directory, "tutorial-camera@1", false);
  assert.deepEqual(readExperiments(directory), []);

  selectExperiment(directory, "tutorial-camera@1", true);
  assert.equal(startExperiment(directory, "tutorial-camera@1"), true);
  assert.throws(() => selectExperiment(directory, "tutorial-camera@1", false), /has started/);
});

test("campaign preparation pins the same series kit for different episodes and refuses a stale kit", async (t) => {
  const { root, project } = workspace(t);
  const campaign = project("series");
  const plan = initCampaign(
    {
      version: 1,
      revision: 1,
      id: "series",
      scenario: "content-series",
      brief: "A synthetic series of unrelated actions in one product.",
      members: ["first", "second"].map((id) => ({
        id,
        projectId: id,
        language: "en",
        formats: ["landscape"],
        variants: ["captioned"],
        adapter: { kind: "film", playbook: "product-tutorial", filmType: "ui-demo" },
      })),
    },
    root,
  );
  selectExperiment(campaign, "tutorial-series-kit@1", true, undefined, DEFAULT_TUTORIAL_KIT);
  const { pack } = reviewPackage(root, plan, "creative-plan");
  await approveCampaignPackage(root, plan, pack, pack.packageHash, "Approve this synthetic test plan", "test fixture");
  const first = project("first");
  const second = project("second");
  for (const task of plan.tasks.filter(({ kind }) => kind === "prepare")) {
    const result = await executeCampaignTask(task, { plan, root, inputHash: "a".repeat(64), paid: false });
    assert.equal(result.blocked, undefined, result.message ?? "Preparation succeeded");
  }
  for (const directory of [first, second]) assertTutorialKit(directory);
  assert.equal(fileHash(tutorialKitFile(first)), fileHash(tutorialKitFile(second)));
  assert.throws(() => selectExperiment(campaign, "tutorial-series-kit@1", false), /has started/);
  assert.match(
    withPlaybook(first, [], "build").experiments?.[0]?.instruction ?? "",
    /public\/projects\/first\/pipeline/,
  );
  const kitFile = tutorialKitFile(second);
  const changed = JSON.parse(readFileSync(kitFile, "utf8"));
  changed.kit.title.accent = "#FFFFFF";
  json(kitFile, changed);
  assert.throws(() => assertTutorialKit(second), /no longer matches/);
});

test("camera lands at mapped capture frames in both aspects and flags an unmapped target", () => {
  const capture = {
    fps: 30,
    frames: 150,
    width: 1280,
    height: 720,
    scale: 2,
    events: [
      { frame: 30, action: "click", x: 1230, y: 600 },
      { frame: 100, action: "click", x: 200, y: 300 },
    ],
  };
  const words = {
    words: [
      { text: "Export", start: 1 },
      { text: "Save", start: 2 },
    ],
  };
  const request = CameraRequestSchema.parse({
    capture: "capture.json",
    words: "words.json",
    actions: [
      { event: 0, word: 0, target: { x: 1140, y: 570, width: 120, height: 60 } },
      { event: 1, word: 1 },
    ],
  });
  const result = proposeTutorialCamera(capture, words, request);
  assert.equal(result.stops.length, 2);
  assert.equal(result.cursor[0]?.x, 2460);
  for (const [ratio, stops] of [
    [16 / 9, result.stops],
    [9 / 16, result.portraitStops],
  ] as const) {
    const [first, detail] = stops;
    assert.equal(first!.hold + detail!.move, 30);
    assert.equal(detail!.hold, 120);
    const width = Math.max(capture.width, capture.height * ratio) / detail!.zoom;
    assert.ok(detail!.cx * capture.width - width / 2 <= 1140);
    assert.ok(detail!.cx * capture.width + width / 2 >= 1260);
  }
  assert.match(result.findings[0]?.reason ?? "", /Timing review/);
  assert.match(result.findings[1]?.reason ?? "", /Frame this action manually/);
  const fast = proposeTutorialCamera(
    {
      ...capture,
      fps: 60,
      frames: capture.frames * 2,
      events: capture.events.map((event) => ({ ...event, frame: event.frame * 2 })),
    },
    words,
    request,
  );
  assert.equal(fast.fps, 30);
  assert.equal(fast.durationInFrames, result.durationInFrames);
  assert.deepEqual(fast.stops, result.stops);
  assert.equal(fast.cursor[0]?.captureFrame, 60);
  assert.equal(fast.cursor[0]?.frame, 30);
});

test("opt-in proof scenes carry a source through preview and materialisation", (t) => {
  const { root, project } = workspace(t);
  const ordinary: RecipeRequest = { projectId: "proof", recipeId: "educational-explainer", topic: "Rate of repair" };
  assert.equal(buildRecipe(ordinary).proofs, undefined);
  const input: RecipeRequest = {
    ...ordinary,
    experiment: "proof-scenes@1",
    beats: [
      {
        id: "example",
        proofSource: "Synthetic benchmark fixture",
        template: { id: "scene.metric", version: 1, props: { headline: "Common repairs", to: 12 } },
      },
    ],
  };
  const planned = buildRecipe(input);
  assert.equal(planned.project.scenes.find(({ id }) => id === "example")?.template?.id, "scene.metric");
  assert.equal(planned.proofs?.[0]?.source, "Synthetic benchmark fixture");
  assert.throws(() => buildRecipe({ ...input, experiment: undefined }), /needs proof-scenes/);
  assert.equal(existsSync(project("proof")), false);
  materializeRecipe(input, root);
  assert.equal(readExperiments(project("proof"))[0]?.id, "proof-scenes@1");
  const next = timelineNext("proof", root);
  assert.equal(next.step, "render");
  assert.equal(next.experiments?.[0]?.id, "proof-scenes@1");
  assert.match(
    readFileSync(path.join(project("proof"), "pipeline/recipe.json"), "utf8"),
    /Synthetic benchmark fixture/,
  );
});

test(
  "compare pins inputs, checks renderer outputs and builds a blind full-video review package",
  {
    skip: spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0,
  },
  (t) => {
    const { root, project } = workspace(t);
    git(root, "init", "-q");
    writeFileSync(path.join(root, ".gitignore"), "public/projects/\nout/\n");
    git(root, "add", ".gitignore");
    git(root, "-c", "user.email=", "-c", "user.name=Test", "commit", "-qm", "Base");
    const fixture = path.join(project("inputs"), "brief.txt");
    json(fixture, { request: "Show export", input: "fixture" });
    for (const id of ["control", "variant"]) {
      materializeRecipe(
        {
          projectId: id,
          recipeId: "educational-explainer",
          topic: "Show export",
          formats: ["landscape"],
          ...(id === "variant" ? { experiment: "proof-scenes@1" } : {}),
        },
        root,
      );
      freezeComparison(root, id, {
        experiment: "proof-scenes@1",
        model: "fixture-model",
        limits: { maxCostUsd: 0, timeLimitSec: 60 },
        inputs: Object.fromEntries(["brief", "concept", "script", "sources"].map((role) => [role, fixture])),
        subjects: [{ slot: "lesson", project: id, format: "landscape" }],
      });
      recordComparisonOutcome(root, id, { manualCorrections: 0, corrections: [] });
      const output = path.join(root, "out", id, "landscape.mp4");
      mkdirSync(path.dirname(output), { recursive: true });
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=red:s=32x32:d=0.12",
          "-metadata",
          `title=${id}`,
          "-c:v",
          "libx264",
          output,
        ],
        { stdio: "pipe" },
      );
      const identity = captureRenderIdentity(id, "landscape", { rootDir: root });
      json(output + ".receipt.json", {
        version: 1,
        sourceSnapshotHash: identity.sourceSnapshotHash,
        propsHash: identity.propsHash,
        outputSha256: fileHash(output),
        format: "landscape",
        captions: "on",
        createdAt: "2026-11-20T00:00:00.000Z",
        sources: identity.sources,
      });
    }
    const result = compareProjects(root, "control", "variant");
    assert.deepEqual(readdirSync(result.review).sort(), ["pair-1-1.mp4", "pair-1-2.mp4", "ratings.json"]);
    assert.doesNotMatch(readFileSync(path.join(result.review, "ratings.json"), "utf8"), /control|variant/);
    const tags = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format_tags=title", path.join(result.review, "pair-1-1.mp4")],
      { encoding: "utf8" },
    );
    assert.doesNotMatch(tags, /title=/);
    assert.match(readFileSync(result.privateKey, "utf8"), /control/);
    const creative = path.join(project("variant"), "pipeline/design.json");
    json(creative, { changed: true });
    assert.throws(() => compareProjects(root, "control", "variant"), /Stale or misbound renderer receipt/);
    rmSync(creative);
    for (const ext of [".mp4", ".mp4.receipt.json"])
      copyFileSync(
        path.join(root, "out/control", "landscape" + ext),
        path.join(root, "out/variant", "landscape" + ext),
      );
    assert.throws(() => compareProjects(root, "control", "variant"), /Stale or misbound renderer receipt/);
    json(fixture, { changed: true });
    assert.throws(() => compareProjects(root, "control", "variant"), /Stale campaign input/);
  },
);
