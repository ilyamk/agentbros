import { RecipeRequestSchema, type RecipeRequest } from "../../types/recipes";
import { ProjectConfigSchema, type ProjectConfig, type Scene } from "../../types/video";
import { TemplateInstanceSchema } from "../../types/templates";
import type { StyleProfileId } from "../../types/templates";
import { STYLE_PROFILES } from "./styles";
import { compileTimeline } from "../timeline";
import { CliErrorObject } from "../cli";
export const RECIPES = [
  {
    id: "social-hook",
    title: "Social curiosity → payoff",
    durationSec: 20,
    style: "ugc-direct",
    beats: ["hook", "setup", "demonstration", "payoff", "loop"],
    purposes: [
      "Make a precise promise",
      "Give needed context",
      "Show the mechanism",
      "Deliver the promised insight",
      "Resolve or return to opening",
    ],
  },
  {
    id: "ad-direct",
    title: "Direct-response creative",
    durationSec: 30,
    style: "ugc-direct",
    beats: ["hook", "problem", "demo", "proof", "cta"],
    purposes: [
      "Audience-specific friction",
      "Show the lived problem",
      "Demonstrate the solution",
      "Verified outcome, no invented metric",
      "One explicit next action",
    ],
  },
  {
    id: "product-demo",
    title: "Readable product demonstration",
    durationSec: 30,
    style: "minimal-product",
    beats: ["hook", "context", "workflow", "benefit", "cta"],
    purposes: [
      "State a concrete job",
      "Show the starting state",
      "One real interaction",
      "Connect evidence to benefit",
      "One next action",
    ],
  },
  {
    id: "educational-explainer",
    title: "Concept → worked example → recap",
    durationSec: 180,
    style: "educational-editorial",
    beats: ["question", "definition", "example", "application", "recap"],
    purposes: [
      "Ask a useful question",
      "Explain prerequisite concept",
      "Work a concrete sourced example",
      "Let the viewer apply it",
      "Recap causal chain",
    ],
  },
  {
    id: "youtube-chapter",
    title: "YouTube chapter",
    durationSec: 180,
    style: "educational-editorial",
    beats: ["promise", "context", "explanation", "evidence", "recap"],
    purposes: [
      "State chapter outcome",
      "Connect to prior knowledge",
      "Develop one argument",
      "Prove or qualify the argument",
      "Recap and bridge",
    ],
  },
  {
    id: "documentary-story",
    title: "Evidence-led documentary",
    durationSec: 45,
    style: "documentary",
    beats: ["question", "context", "evidence", "interpretation", "resolution"],
    purposes: [
      "Open the central question",
      "Establish time/place",
      "Identify source and uncertainty",
      "Distinguish inference from fact",
      "Resolve the question",
    ],
  },
  {
    id: "music-motion",
    title: "Planned music motion",
    durationSec: 30,
    style: "music-led",
    beats: ["motif", "build", "accent", "variation", "resolve"],
    purposes: [
      "Introduce the visual motif",
      "Build intentional density",
      "Land the planned beat accent",
      "Change one visual parameter",
      "Complete or loop the motif",
    ],
  },
] as const;
export function buildRecipe(input: RecipeRequest): {
  request: ReturnType<typeof RecipeRequestSchema.parse>;
  project: ProjectConfig;
  durationInFrames: number;
  productionReady: false;
  findings: string[];
  beatPurposes: Record<string, string>;
} {
  const parsed = RecipeRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Invalid recipe request: ${parsed.error.message}`,
    });
  }
  const request = parsed.data,
    recipe = RECIPES.find((r) => r.id === request.recipeId)!;
  if (
    new Set(request.beats.map((b) => b.id)).size !== request.beats.length ||
    request.beats.some((b) => !(recipe.beats as readonly string[]).includes(b.id))
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Recipe beat overrides must have unique registered IDs.",
    });
  const profile = STYLE_PROFILES[request.styleProfile ?? (recipe.style as StyleProfileId)];
  const fps = 30,
    count = recipe.beats.length;
  const targetFrames = Math.round((request.durationSec ?? recipe.durationSec) * fps);
  const sequenceFrames = targetFrames + (count - 1) * 12;
  const baseFrames = Math.floor(sequenceFrames / count),
    remainder = sequenceFrames % count;
  const scenes: Scene[] = recipe.beats.map((id, index) => {
    const override = request.beats.find((b) => b.id === id),
      media = request.media.length ? request.media[index % request.media.length] : undefined;
    const headline = override?.headline ?? `${request.topic} — ${id}`;
    const durationInFrames =
      override?.durationSec === undefined
        ? baseFrames + (index < remainder ? 1 : 0)
        : Math.round(override.durationSec * fps);
    return {
      id,
      text: override?.text ?? "",
      headline,
      subtext: recipe.purposes[index],
      visualType: media ? (media.kind === "video" ? "video" : "photo") : "title",
      ...(media ? { imageUrl: media.source } : {}),
      template:
        override?.template ??
        (media
          ? undefined
          : TemplateInstanceSchema.parse({
              id: profile.entrance === "scale" ? "text.scale-emphasis" : "text.word-reveal",
              version: 1,
              props:
                profile.entrance === "scale"
                  ? { text: headline, bounce: "none", staggerSec: 0.12 }
                  : { text: headline, staggerSec: 0.12 },
            })),
      durationInFrames,
      transitionToNext: "fade",
      transitionDurationFrames: 12,
    };
  });
  const project = ProjectConfigSchema.parse({
    name: `[ANIMATIC] ${request.topic}`,
    productName: request.topic,
    tagline: recipe.title,
    formats: [...new Set(request.formats)],
    colors: profile.colors,
    musicVolume: 0,
    musicPrompt: "Plan music after the edit direction is approved",
    scenes,
  });
  const findings = [
    "Draft: no generated/recorded voiceover",
    "Draft: no approved music/mix",
    ...(request.media.length < 2 ? ["Supply at least two approved visual assets for production"] : []),
    "Confirm claims, script, timing and QA before production",
  ];
  return {
    request,
    project,
    durationInFrames: compileTimeline(project.scenes, { fps }).durationInFrames,
    productionReady: false,
    findings,
    beatPurposes: Object.fromEntries(recipe.beats.map((id, i) => [id, recipe.purposes[i]])),
  };
}
