import { assertProductionReferences } from "../src/lib/campaigns/production/guard";
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FilmStyleCardSchema } from "../src/types/film-styles";
import {
  bindFilmStyle,
  filmStyleFile,
  filmStyleForStep,
  readFilmStyle,
  writeFilmStyle,
} from "../src/lib/film-styles/binding";
import { filmStyleKey, readFilmStyles, selectFilmStyle } from "../src/lib/film-styles/catalogue";
import { renderBrief } from "../src/lib/film/brief";
import { scaffoldFilmProject } from "../src/lib/film/project";
import { deriveChain, openFilmProject } from "../src/lib/film/state";
import { timelineNext } from "../src/lib/pipeline/timeline-next";
import { withPlaybook } from "../src/lib/pipeline/route";
import type { RecipeRequest } from "../src/types/recipes";
import { buildRecipe } from "../src/lib/templates/recipes";
import { materializeRecipe } from "../src/lib/templates/materialize";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { approveCampaignPackage, reviewPackage } from "../src/lib/campaigns/production/review";
import { initCampaign } from "../src/lib/campaigns/production/store";
import { executeCampaignTask } from "../src/lib/campaigns/production/execute";
import { unitTrayCount, unitTrayDefaults, unitTrayEndFrame } from "../src/motion/library/data/unit-tray-plan";
import { getStyle } from "../src/motion/library/styles";

const fixture = FilmStyleCardSchema.parse({
  id: "test-style",
  revision: 1,
  title: "Test style",
  summary: "A small fictional style for the integration tests.",
  playbooks: ["explainer"],
  preset: "paper-signal",
  blocks: ["ui-camera-read"],
  engines: ["remotion", "capture-app"],
  stages: {
    look: ["Put the first priority item on a light ground."],
    "beat-sheet": ["Hold while the viewer reads the source label."],
    build: ["Review the reading camera in both formats."],
    sound: ["Give the sound of the material room after the cut."],
    critic: ["Compare the hierarchy and transition to the approved look."],
  },
  choices: "Choose the subject, camera moves and ending for this brief.",
});

function workspace(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "film-styles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/draft");
  const catalogue = path.join(root, "design-reference/style-cards/catalogue.json");
  mkdirSync(path.dirname(catalogue), { recursive: true });
  writeFileSync(catalogue, JSON.stringify([fixture, { ...fixture, revision: 2 }]));
  return { root, directory: dir, catalogue };
}

test("film styles can be selected by exact revision and bound without losing the pinned revision after an update", (t) => {
  const { root, directory, catalogue } = workspace(t);
  mkdirSync(path.join(directory, "pipeline"), { recursive: true });
  assert.equal(filmStyleKey(selectFilmStyle("test-style", root)), "test-style@2");
  const selected = bindFilmStyle(directory, selectFilmStyle("test-style@1", root));
  writeFileSync(catalogue, JSON.stringify([{ ...fixture, revision: 2 }]));
  assert.equal(readFilmStyle(directory)?.sha256, selected.sha256);
  assert.equal(filmStyleForStep(directory, "beat-sheet")?.key, "test-style@1");
  writeFileSync(path.join(directory, "pipeline/design.json"), "{}");
  assert.throws(() => bindFilmStyle(directory, selectFilmStyle("test-style", root)), /before look starts/);
  assert.equal(bindFilmStyle(directory, selected.style).sha256, selected.sha256);
  const modified = JSON.parse(readFileSync(filmStyleFile(directory), "utf8"));
  modified.style.choices = "Rewrite the agreed restrictions";
  writeFileSync(filmStyleFile(directory), JSON.stringify(modified));
  assert.throws(() => readFilmStyle(directory), /pinned film style has changed/);
});

test("look is bound to the style file and leaf briefs carry only the rules their phase needs", (t) => {
  const { root, directory } = workspace(t);
  mkdirSync(directory, { recursive: true });
  scaffoldFilmProject(directory, "draft", [], { filmType: "explainer" });
  const film = openFilmProject(directory, { rootDir: root });
  const script = renderBrief(film, "script").prompt;
  assert.equal(withPlaybook(directory, [], "look").filmStyle, undefined);
  bindFilmStyle(directory, fixture);
  assert.equal(renderBrief(film, "script").prompt, script);
  assert.equal(withPlaybook(directory, [], "look").filmStyle?.key, "test-style@1");
  assert.equal(withPlaybook(directory, [], "script").filmStyle, undefined);
  const owner = renderBrief(film, "look").prompt.split("## Film style · test-style@1")[1] ?? "";
  assert.match(owner, /light ground/);
  assert.match(owner, /Choose the subject/);
  assert.doesNotMatch(owner, /material room|source label/);
  assert.ok(Buffer.byteLength(owner) < 800);
  const critic = renderBrief(film, "look", { role: "critic" }).prompt.split("## Film style · test-style@1")[1] ?? "";
  assert.match(critic, /Compare the hierarchy/);
  assert.doesNotMatch(critic, /Choose the subject|Suggested blocks/);
  assert.ok(
    Object.keys(deriveChain(film).steps.find(({ id }) => id === "look")!.inputs).some((input) =>
      input.endsWith("/film-style.json"),
    ),
  );
});

test("the public style command can select and inspect a card under an enforcing film lease", (t) => {
  const { root, directory } = workspace(t);
  mkdirSync(directory, { recursive: true });
  scaffoldFilmProject(directory, "draft", [], { filmType: "explainer" });
  const repo = path.resolve(import.meta.dirname, "..");
  const cli = (script: string, ...args: string[]) => {
    const result = execFileSync(
      process.execPath,
      [
        path.join(repo, "node_modules/tsx/dist/cli.mjs"),
        path.join(repo, "scripts", script),
        "--project",
        "draft",
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          AGENTBROS_PLAYBOOKS_ROOT: root,
          AGENTBROS_STEP_GUARD: "enforce",
          AGENTBROS_STEP_ADMITTED: "",
          AGENTBROS_NO_DOTENV: "1",
        },
      },
    );
    return JSON.parse(result.trim());
  };
  assert.equal(cli("film-next.ts").ok, true);
  assert.equal(cli("film-style.ts", "--action", "use", "--style", "test-style@2").ok, true);
  assert.equal(cli("film-style.ts", "--action", "status").metadata.selection.style.revision, 2);
});

test("film:init pins the selected style and rejects an unknown card before scaffolding", (t) => {
  const { root, directory } = workspace(t);
  const repo = path.resolve(import.meta.dirname, "..");
  const initialise = (style: string) =>
    spawnSync(
      process.execPath,
      [
        path.join(repo, "node_modules/tsx/dist/cli.mjs"),
        path.join(repo, "scripts/film-init.ts"),
        "--project",
        "draft",
        "--type",
        "explainer",
        "--style",
        style,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, AGENTBROS_PLAYBOOKS_ROOT: root, AGENTBROS_NO_DOTENV: "1" },
      },
    );
  assert.equal(initialise("nonexistent").status, 1);
  assert.equal(existsSync(directory), false);
  const known = initialise("test-style");
  assert.equal(known.status, 0, known.stdout + known.stderr);
  assert.equal(readFilmStyle(directory)?.style.revision, 2);
});

test("recipe selection pins a revision and applies colour while preserving authored scenes and timing", (t) => {
  const { root, directory } = workspace(t);
  const prior = process.env.AGENTBROS_PLAYBOOKS_ROOT;
  process.env.AGENTBROS_PLAYBOOKS_ROOT = root;
  t.after(() => {
    if (prior === undefined) delete process.env.AGENTBROS_PLAYBOOKS_ROOT;
    else process.env.AGENTBROS_PLAYBOOKS_ROOT = prior;
  });
  const input = { projectId: "draft", recipeId: "educational-explainer", topic: "Why transit stops bunch up" } as const;
  const control = buildRecipe(input);
  const candidate = buildRecipe({ ...input, styleCard: "test-style@1" });
  assert.equal(control.filmStyle, undefined);
  assert.deepEqual(candidate.project.scenes, control.project.scenes);
  assert.equal(candidate.durationInFrames, control.durationInFrames);
  assert.equal(candidate.project.colors.accent, getStyle("paper-signal").palette.accent);
  materializeRecipe({ ...input, styleCard: "test-style" }, root);
  assert.equal(readFilmStyle(directory)?.style.revision, 2);
  const next = timelineNext("draft", root);
  assert.equal(next.step, "render");
  assert.equal(next.filmStyle?.key, "test-style@2");
  assert.deepEqual(next.filmStyle?.rules, fixture.stages.build);
  assert.deepEqual(filmStyleForStep(directory, "qa")?.rules, fixture.stages.critic);
  const identity = captureRenderIdentity("draft", "landscape", { rootDir: root });
  assert.ok(identity.sources.some(({ path }) => path.endsWith("/film-style.json")));
  const out = path.join(root, "out/draft");
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "landscape.mp4"), "Renderer output fixture");
  writeFileSync(path.join(out, "landscape.mp4.receipt.json"), JSON.stringify({ sources: identity.sources }));
  assert.equal(timelineNext("draft", root).state.renders.landscape, "fresh");
  writeFilmStyle(directory, fixture);
  assert.equal(timelineNext("draft", root).state.renders.landscape, "stale");
  rmSync(filmStyleFile(directory));
  assert.equal(timelineNext("draft", root).state.renders.landscape, "stale");
});

test("available film styles use known design presets, blocks and playbooks", () => {
  const catalogue = JSON.parse(readFileSync("docs/library/catalogue.json", "utf8"));
  const library = new Set(catalogue.items.map(({ id }: { id: string }) => id));
  const cards = readFilmStyles();
  assert.equal(new Set(cards.map(({ id }) => id)).size, 12);
  for (const card of cards) {
    assert.doesNotThrow(() => getStyle(card.preset));
    for (const block of card.blocks) assert.ok(library.has(block), `${card.id}: ${block}`);
    for (const playbook of card.playbooks)
      assert.doesNotThrow(() => readFileSync(`playbooks/${playbook}/playbook.json`, "utf8"));
  }
});

test("the native physical data scene counts the same discrete units throughout a comparison", () => {
  const increasing = { ...unitTrayDefaults, from: 4, to: 9, firstFrame: 12, stepFrames: 4 };
  assert.deepEqual(
    [0, 11, 12, 16, 20, 24, 28, 60].map((frame) => unitTrayCount(frame, increasing)),
    [4, 4, 5, 6, 7, 8, 9, 9],
  );
  assert.equal(unitTrayEndFrame(increasing), 31);
  const decreasing = { ...increasing, from: 9, to: 4 };
  assert.deepEqual(
    [0, 12, 16, 20, 24, 28, 60].map((frame) => unitTrayCount(frame, decreasing)),
    [9, 8, 7, 6, 5, 4, 4],
  );
  assert.equal(unitTrayCount(40, { ...increasing, from: 0, to: 0 }), 0);
  const { ground: _ground, accent: _accent, text: _text, ...props } = increasing;
  const input = {
    projectId: "count-draft",
    recipeId: "educational-explainer",
    topic: "A unit of evidence",
    styleCard: "physical-data@1",
    beats: [{ id: "example", durationSec: 3, template: { id: "scene.physical-data", version: 1, props } }],
  } satisfies RecipeRequest;
  const recipe = buildRecipe(input);
  assert.equal(recipe.project.scenes.find(({ id }) => id === "example")?.template?.id, "scene.physical-data");
  assert.throws(
    () => buildRecipe({ ...input, beats: [{ ...input.beats[0]!, durationSec: 1 }] }),
    /settles before the transition/,
  );
});

test("campaign preparation keeps the explicit member style with its production project", async (t) => {
  const { root } = workspace(t);
  const request = {
    version: 1,
    id: "style-series",
    revision: 1,
    scenario: "content-series",
    brief: "A synthetic series for style pin validation.",
    members: [
      {
        id: "lesson",
        projectId: "paper-lesson",
        language: "en",
        formats: ["landscape"],
        variants: ["captioned"],
        adapter: { kind: "film", filmType: "explainer", playbook: "explainer", styleCard: "paper-signal@1" },
      },
    ],
  } as const;
  const { CampaignProductionRequestSchema } = await import("../src/types/campaign-production");
  const validated = CampaignProductionRequestSchema.parse(request);
  assert.throws(
    () =>
      initCampaign(
        CampaignProductionRequestSchema.parse({
          ...request,
          members: [{ ...request.members[0], adapter: { ...request.members[0].adapter, styleCard: "paper-signal" } }],
        }),
        root,
      ),
    /exact film style revision/,
  );
  const plan = initCampaign(validated, root);
  const { pack } = reviewPackage(root, plan, "creative-plan");
  await approveCampaignPackage(root, plan, pack, pack.packageHash, "Approve this synthetic style plan", "test fixture");
  const task = plan.tasks.find((row) => row.kind === "prepare");
  assert.ok(task);
  const result = await executeCampaignTask(task, { plan, root, inputHash: "a".repeat(64), paid: false });
  assert.equal(result.blocked, undefined, result.message ?? "Campaign fixture prepared");
  const child = path.join(root, "public/projects/paper-lesson");
  assert.equal(readFilmStyle(child)?.style.id, "paper-signal");
  assert.doesNotThrow(() => assertProductionReferences(child));
  const other = selectFilmStyle("warm-editorial@1");
  assert.throws(() => bindFilmStyle(child, other), /campaign plan/);
  writeFilmStyle(child, other);
  assert.throws(() => assertProductionReferences(child), /style differs from the approved plan/);
  await assert.rejects(
    () => executeCampaignTask(task, { plan, root, inputHash: "a".repeat(64), paid: false }),
    /Stale campaign input/,
  );
});

test("self-contained signal type keeps the authored signal without adding a draft photo", (t) => {
  const { root } = workspace(t);
  const input = {
    projectId: "signal",
    recipeId: "educational-explainer",
    topic: "Read the signal",
    styleCard: "paper-signal@1",
    beats: [
      {
        id: "question",
        selfContained: true,
        template: { id: "text.word-reveal", version: 1, props: { text: "Read the signal", accentWordIndex: 2 } },
      },
    ],
  } satisfies RecipeRequest;
  const plan = materializeRecipe(input, root);
  assert.equal(plan.project.scenes[0]?.visualType, "title");
  assert.equal(plan.project.scenes[0]?.imageUrl, undefined);
  assert.equal(
    plan.placeholders.some((file) => file.endsWith("/question.svg")),
    false,
  );
  assert.throws(
    () =>
      buildRecipe({
        ...input,
        beats: [
          {
            ...input.beats[0]!,
            template: { id: "text.word-reveal", version: 1, props: { text: "Read it", accentWordIndex: 9 } },
          },
        ],
      }),
    /accentWordIndex/,
  );
});
