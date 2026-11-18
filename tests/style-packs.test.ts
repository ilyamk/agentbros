import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { materializeRecipe } from "../src/lib/templates/materialize";
import { RECIPES } from "../src/lib/templates/recipes";
import { planProjectRender } from "../src/lib/render-plan";
import test from "node:test";
import assert from "node:assert/strict";
import { TemplateInstanceSchema, StyleProfileIdSchema } from "../src/types/templates";
import { TEMPLATE_REGISTRY } from "../src/lib/templates/registry";
import { STYLE_PROFILES } from "../src/lib/templates/styles";
import { displayedFontText } from "../src/lib/font-resources/render-context";
test("additive style packs retain old profiles, parse samples, and collect every displayed field", () => {
  for (const id of [
    "minimal-product",
    "ugc-direct",
    "educational-editorial",
    "documentary",
    "music-led",
    "education-worked-example",
    "product-walkthrough",
    "editorial-evidence",
  ]) {
    assert.ok(STYLE_PROFILES[StyleProfileIdSchema.parse(id)].optIn);
  }
  const added = TEMPLATE_REGISTRY.filter((e) =>
    ["scene.worked-example", "scene.product-walkthrough", "scene.editorial-evidence", "caption.bilingual"].includes(
      e.id,
    ),
  );
  assert.equal(added.length, 4);
  for (const entry of added) {
    const template = TemplateInstanceSchema.parse(entry.sample);
    const text = displayedFontText({
      scenes: [
        {
          template,
        },
      ],
      timeline: undefined,
    } as never);
    for (const [key, value] of Object.entries(template.props)) {
      if (typeof value === "string" && !["imageUrl", "sourceLanguage", "translationLanguage"].includes(key))
        assert.ok(text.includes(value), key);
    }
    if (template.id === "caption.bilingual") assert.ok(text.includes(template.props.cues[0].translation));
    if (template.id === "scene.worked-example") {
      assert.ok(text.includes(template.props.steps[0].detail));
      assert.ok(text.includes("1. 2."));
    }
    assert.equal(text.includes("projects/template-preview"), false);
  }
});
test("bilingual captions reject invalid or overlapping cues and require supplied translation", () => {
  const sample = structuredClone(TEMPLATE_REGISTRY.find((e) => e.id === "caption.bilingual")!.sample);
  assert.equal(sample.id, "caption.bilingual");
  if (sample.id !== "caption.bilingual") return;
  sample.props.cues.push({
    ...sample.props.cues[0],
    start: 1,
  });
  assert.equal(TemplateInstanceSchema.safeParse(sample).success, false);
  sample.props.cues = [
    {
      start: 0,
      end: 0.5,
      text: "Речь",
      translation: "Speech",
    },
  ];
  sample.props.sourceLanguage = sample.props.translationLanguage;
  assert.equal(TemplateInstanceSchema.safeParse(sample).success, false);
  sample.props.sourceLanguage = " RU ";
  sample.props.translationLanguage = "ru";
  assert.equal(TemplateInstanceSchema.safeParse(sample).success, false);
  sample.props.sourceLanguage = "invalid_tag";
  sample.props.translationLanguage = "en";
  assert.equal(TemplateInstanceSchema.safeParse(sample).success, false);
  sample.props.sourceLanguage = "ru";
  sample.props.cues[0].translation = "";
  assert.equal(TemplateInstanceSchema.safeParse(sample).success, false);
});
test("style pack copy budgets reject extreme runs instead of silently reducing typography", () => {
  for (const entry of TEMPLATE_REGISTRY.filter((e) =>
    ["scene.worked-example", "scene.product-walkthrough", "scene.editorial-evidence"].includes(e.id),
  )) {
    const input = structuredClone(entry.sample);
    if ("headline" in input.props) input.props.headline = "Ж".repeat(101);
    assert.equal(TemplateInstanceSchema.safeParse(input).success, false);
  }
});
test("new profiles and scene packs materialize editable drafts through the existing recipe path", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "style-drafts-"));
  t.after(() =>
    rmSync(root, {
      recursive: true,
      force: true,
    }),
  );
  const recipe = RECIPES.find((entry) => entry.id === "educational-explainer")!;
  const packs = [
    ["education-worked-example", "scene.worked-example"],
    ["product-walkthrough", "scene.product-walkthrough"],
    ["editorial-evidence", "scene.editorial-evidence"],
  ] as const;
  for (const [profile, id] of packs) {
    const projectId = `draft-${profile}`;
    const entry = TEMPLATE_REGISTRY.find((e) => e.id === id)!;
    const beats = recipe.beats.map((beat) => {
      const template = structuredClone(entry.sample);
      if ("imageUrl" in template.props) template.props.imageUrl = `projects/${projectId}/assets/animatic/${beat}.svg`;
      return {
        id: beat,
        template,
      };
    });
    const result = materializeRecipe(
      {
        projectId,
        recipeId: recipe.id,
        topic: "Локальный черновик",
        styleProfile: profile,
        beats,
      },
      root,
    );
    assert.equal(result.productionReady, false);
    assert.deepEqual(result.project.colors, STYLE_PROFILES[profile].colors);
    assert.ok(result.project.scenes.every((scene) => scene.template?.id === id));
    assert.equal(planProjectRender(projectId, undefined, root).jobs.length, 3);
  }
});
