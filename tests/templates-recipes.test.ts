import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TEMPLATE_REGISTRY, selectTemplates } from "../src/lib/templates/registry";
import { captionState } from "../src/lib/templates/caption-state";
import { TemplateInstanceSchema } from "../src/types/templates";
import { buildRecipe, RECIPES } from "../src/lib/templates/recipes";
import { materializeRecipe } from "../src/lib/templates/materialize";
import { planProjectRender } from "../src/lib/render-plan";
const code = (name: string) => (error: unknown) => (error as { code?: string }).code === name;

test("invalid recipe requests produce a caller validation error", () => {
  assert.throws(() => buildRecipe({ recipeId: "missing" } as never), code("VALIDATION"));
});

test("registry samples and components are usable in all three formats", () => {
  assert.equal(TEMPLATE_REGISTRY.length, 19);
  assert.equal(new Set(TEMPLATE_REGISTRY.map((e) => e.id)).size, 19);
  for (const entry of TEMPLATE_REGISTRY) {
    TemplateInstanceSchema.parse(entry.sample);
    assert.equal(existsSync(entry.component), true);
    assert.equal(entry.formats.length, 3);
    assert.equal(entry.recommendedFrames.exit, entry.id === "scene.visualisation" ? 0 : 9);
  }
  const selection = selectTemplates(["education", "proof"]);
  assert.ok(selection.length > 0);
  assert.match(selection[0].rationale, /Matches/);
  assert.throws(() =>
    TemplateInstanceSchema.parse({
      id: "text.word-reveal",
      version: 2,
      props: { text: "bad" },
    }),
  );
  assert.throws(() =>
    TemplateInstanceSchema.parse({
      id: "text.word-reveal",
      version: 1,
      props: { text: "bad", entrance: "slideUp" },
    }),
  );
});

test("caption frame states have exact boundaries, pauses and no phantom active words", () => {
  const words = [
    { text: "Первое", start: 0.2, end: 0.5 },
    { text: "слово", start: 0.6, end: 0.9, emphasis: true },
    { text: "дальше", start: 1, end: 1.3 },
  ];
  assert.equal(captionState(words, 0, 30).visible, false);
  assert.equal(captionState(words, 6, 30).activeIndex, 0);
  assert.equal(captionState(words, 15, 30).activeIndex, -1);
  assert.equal(captionState(words, 18, 30).activeIndex, 1);
  assert.equal(captionState(words, 39, 30).visible, false);
  assert.deepEqual(
    captionState(words, 31, 30, 2).group.map((w) => w.text),
    ["дальше"],
  );
  assert.throws(() => captionState([{ text: "bad", start: 1, end: 0.5 }], 1, 30));
});

test("every recipe produces stable canonical scenes with exact transition math", () => {
  for (const recipe of RECIPES) {
    const plan = buildRecipe({
      projectId: "recipe-test",
      recipeId: recipe.id,
      topic: "Объяснение достаточно длинного русского названия",
    });
    assert.equal(plan.durationInFrames, recipe.durationSec * 30);
    assert.deepEqual(
      plan.project.scenes.map((s) => s.id),
      [...recipe.beats],
    );
    assert.equal(plan.productionReady, false);
    assert.equal(plan.project.musicVolume, 0);
    assert.equal(plan.project.formats.length, 3);
  }
  assert.throws(
    () =>
      buildRecipe({
        projectId: "test",
        recipeId: "ad-direct",
        topic: "topic",
        beats: [{ id: "invented" }],
      }),
    code("VALIDATION"),
  );
});

test("local materialized animatic is renderable, isolated and never overwrites", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "recipe-local-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = {
    projectId: "lesson-draft",
    recipeId: "educational-explainer" as const,
    topic: "Gravity",
    durationSec: 10,
  };
  const result = materializeRecipe(request, root);
  assert.equal(result.productionReady, false);
  assert.equal(result.placeholders.length, 5);
  const jobs = planProjectRender("lesson-draft", undefined, root).jobs;
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].durationInFrames, 300);
  assert.ok(jobs[0].props.scenes[0].template);
  for (const output of result.outputs) assert.equal(existsSync(path.join(root, output)), true);
  assert.throws(() => materializeRecipe(request, root), code("FILE_EXISTS"));
  assert.match(readFileSync(path.join(root, result.outputs[2]), "utf8"), /Not production ready/);
});

test("recipe CLI dry-run writes nothing and template preview creates valid local assets", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "recipe-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "request.json");
  writeFileSync(
    input,
    JSON.stringify({
      projectId: "draft",
      recipeId: "social-hook",
      topic: "demo",
    }),
  );
  const runner = path.resolve("node_modules/tsx/dist/cli.mjs"),
    cli = path.resolve("scripts/video-recipe.ts");
  const planned = spawnSync(process.execPath, [runner, cli, "--action", "materialize", "--input", input, "--dry-run"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).metadata.dryRun, true);
  assert.equal(existsSync(path.join(root, "public")), false);
  const preview = spawnSync(
    process.execPath,
    [runner, cli, "--action", "template-preview", "--template", "scene.device-proof", "--project", "device-preview"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).ok, true);
  const job = planProjectRender("device-preview", "square", root).jobs[0];
  assert.equal(job.props.scenes[0].template?.id, "scene.device-proof");
  assert.equal(preview.stdout.trim().split("\n").length, 1);
});

test("new renderer templates contain no independent animation clocks", () => {
  for (const file of ["src/templates/registry/RegisteredTemplate.tsx", "src/templates/registry/PhraseCaption.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.equal(/@keyframes|requestAnimationFrame|setInterval|setTimeout|framer-motion|gsap/.test(source), false);
  }
});
