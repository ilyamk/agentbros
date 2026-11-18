import { vizSceneDefaults } from "../viz/example-plan";
import { TemplateInstanceSchema, type TemplateId, type TemplateInstance } from "../../types/templates";
export type TemplateEntry = {
  id: TemplateId;
  version: 1;
  level: "primitive" | "block" | "scene";
  component: string;
  purpose: string;
  tags: string[];
  formats: readonly ["vertical", "square", "landscape"];
  motion: string;
  recommendedFrames: { entrance: number; hold: number; exit: 0 | 9 };
  syncPoints: string[];
  audioCueSlots: string[];
  safeZone: "design-tokens";
  captionPolicy: string;
  provenance: {
    origin: "local-project";
    licence: "project licence unspecified";
  };
  compatibility: "Remotion4/React19";
  sample: TemplateInstance;
  preview: { composition: "ProjectVertical"; sampleSceneId: string };
};
function entry(
  id: TemplateId,
  component: string,
  purpose: string,
  tags: string[],
  props: unknown,
  entrance = 12,
): TemplateEntry {
  return {
    id,
    version: 1,
    level: id.startsWith("scene.") ? "scene" : id.startsWith("caption.") ? "block" : "primitive",
    component,
    purpose,
    tags,
    formats: ["vertical", "square", "landscape"],
    motion: id.includes("scale")
      ? "frame-driven scale spring; default damping200; scale0.85→1; soft opt-in"
      : id.includes("clip")
        ? "frame-driven clip mask; no translated text"
        : id.includes("caption")
          ? "timestamp-derived opacity and emphasis; no independent clock"
          : "frame-driven fade/spring; no CSS animation",
    recommendedFrames: { entrance, hold: 60, exit: id === "scene.visualisation" ? 0 : 9 },
    syncPoints: ["scene-start", "accent-word", "scene-exit"],
    audioCueSlots: ["optional accent cue"],
    safeZone: "design-tokens",
    captionPolicy: "phrase boundaries and ordered source timestamps",
    provenance: {
      origin: "local-project",
      licence: "project licence unspecified",
    },
    compatibility: "Remotion4/React19",
    sample: TemplateInstanceSchema.parse({ id, version: 1, props }),
    preview: {
      composition: "ProjectVertical",
      sampleSceneId: id.replace(/\./g, "-"),
    },
  };
}
const words = [
  { text: "Make", start: 0, end: 0.3 },
  { text: "ideas", start: 0.3, end: 0.7, emphasis: true },
  { text: "clear", start: 0.7, end: 1.1 },
];
export const TEMPLATE_REGISTRY: readonly TemplateEntry[] = [
  entry(
    "scene.visualisation",
    "src/motion/viz/VizScene.tsx",
    "A prepared chart or diagram pinned to its data revision",
    ["chart", "diagram", "nodes"],
    vizSceneDefaults,
  ),
  entry(
    "scene.worked-example",
    "src/templates/registry/StylePackScene.tsx",
    "Walk through a worked example, then hold its result",
    ["education", "worked-example", "reasoning"],
    {
      headline: "Как сравнить два варианта?",
      steps: [
        { label: "Наблюдение / Observe", detail: "Зафиксируйте исходные условия" },
        { label: "Проверка / Test", detail: "Меняйте только один параметр" },
      ],
      result: "Вывод / Result: сравнивайте одинаковые условия",
    },
    24,
  ),
  entry(
    "scene.product-walkthrough",
    "src/templates/registry/StylePackScene.tsx",
    "Hold supplied product evidence alongside the user action and observable outcome",
    ["product", "demo", "walkthrough", "proof"],
    {
      headline: "Покажите действие, затем результат",
      imageUrl: "projects/template-preview/assets/animatic/evidence.svg",
      action: "Действие / Action: выберите нужный фрагмент",
      outcome: "Результат / Outcome: фрагмент появляется в таймлайне",
    },
    12,
  ),
  entry(
    "scene.editorial-evidence",
    "src/templates/registry/StylePackScene.tsx",
    "Separate supplied evidence from editorial interpretation with a readable source",
    ["editorial", "documentary", "source", "proof"],
    {
      headline: "Что подтверждает источник?",
      statement: "Цитата или наблюдение из предоставленного материала",
      sourceLabel: "Источник / Source: supplied evidence — verification required",
      interpretation: "Интерпретация / Interpretation: отдельно от факта",
    },
    12,
  ),
  entry(
    "caption.bilingual",
    "src/templates/registry/BilingualCaption.tsx",
    "Hold aligned original and supplied translation phrases without inventing translated speech timing",
    ["caption", "bilingual", "education", "localization"],
    {
      sourceLanguage: "ru",
      translationLanguage: "en",
      cues: [
        {
          start: 0.2,
          end: 3.5,
          text: "Сначала объясните причину, затем проверьте результат",
          translation: "Explain the cause first, then test the result",
        },
      ],
    },
    6,
  ),
  entry(
    "scene.hook",
    "src/components/TitleScene.tsx",
    "State a precise curiosity gap or audience problem",
    ["hook", "social", "product"],
    {
      headline: "Why does this matter?",
      subtext: "Give the audience a reason to watch",
    },
  ),
  entry(
    "scene.definition",
    "src/templates/text/LineByLine.tsx",
    "Explain a concept in visible logical steps",
    ["education", "definition"],
    { lines: ["Observe the pattern", "Explain the cause", "Test an example"] },
  ),
  entry(
    "scene.metric",
    "src/templates/text/CountUp.tsx",
    "Present one sourced numeric proof",
    ["proof", "data"],
    { headline: "Verified improvement", to: 42, suffix: "%" },
    45,
  ),
  entry(
    "scene.image-proof",
    "src/components/StockPhotoScene.tsx",
    "Use a real image to demonstrate the claim",
    ["proof", "documentary", "product"],
    {
      headline: "Show the evidence",
      imageUrl: "projects/template-preview/assets/animatic/evidence.svg",
    },
  ),
  entry(
    "scene.device-proof",
    "src/components/PhoneShowcaseScene.tsx",
    "Demonstrate a UI interaction at readable scale",
    ["product", "demo", "device"],
    {
      headline: "Show the actual workflow",
      imageUrl: "projects/template-preview/assets/animatic/evidence.svg",
    },
  ),
  entry(
    "scene.chart-proof",
    "src/templates/leftpanel/AnimatedLineChart.tsx",
    "Read a comparison with units and a decisive callout",
    ["data", "education", "proof"],
    {
      title: "Illustrative example",
      yUnit: "%",
      data: [
        { label: "Before", value: 10 },
        { label: "After", value: 20 },
      ],
      callout: {
        value: "+10pp",
        label: "Illustrative, replace with sourced values",
      },
    },
    45,
  ),
  entry(
    "text.word-reveal",
    "src/templates/text/WordByWord.tsx",
    "Reveal an argument in spoken order",
    ["hook", "typography", "spoken"],
    { text: "One clear idea", accentWordIndex: 1 },
  ),
  entry(
    "text.line-reveal",
    "src/templates/text/LineByLine.tsx",
    "Reveal two or three explanatory steps",
    ["education", "steps", "comparison"],
    { lines: ["Observe", "Explain", "Apply"], accentLineIndex: 1 },
  ),
  entry(
    "text.scale-emphasis",
    "src/templates/text/ScaleWord.tsx",
    "Land a short hook or payoff",
    ["hook", "cta", "impact"],
    { text: "Start creating" },
  ),
  entry(
    "text.clip-reveal",
    "src/templates/text/ClipReveal.tsx",
    "Editorial reveal without moving text",
    ["editorial", "definition"],
    { text: "A better question" },
  ),
  entry(
    "text.count-up",
    "src/templates/text/CountUp.tsx",
    "Communicate a verified numeric change",
    ["proof", "metric", "product"],
    { to: 42, suffix: "%" },
    45,
  ),
  entry(
    "caption.karaoke",
    "src/templates/talkinghead/KaraokeCaptions.tsx",
    "Track each spoken word",
    ["caption", "ugc", "spoken"],
    { words },
  ),
  entry(
    "caption.phrase",
    "src/templates/registry/PhraseCaption.tsx",
    "Hold a complete phrase for reading",
    ["caption", "education", "documentary"],
    { words, maxWords: 6 },
  ),
  entry(
    "caption.keyword",
    "src/templates/registry/PhraseCaption.tsx",
    "Emphasize chosen terms without changing speech timing",
    ["caption", "hook", "keyword"],
    { words },
  ),
];
export function findTemplate(id: TemplateId): TemplateEntry {
  const result = TEMPLATE_REGISTRY.find((e) => e.id === id);
  if (!result) throw new Error(`Unknown template: ${id}`);
  return result;
}
export function selectTemplates(tags: string[]) {
  return TEMPLATE_REGISTRY.map((template) => ({
    template,
    matchedTags: tags.filter((tag) => template.tags.includes(tag)),
  }))
    .filter((r) => r.matchedTags.length > 0)
    .sort((a, b) => b.matchedTags.length - a.matchedTags.length)
    .map((r) => ({
      ...r,
      rationale: `Matches ${r.matchedTags.join(", ")}: ${r.template.purpose}`,
    }));
}
