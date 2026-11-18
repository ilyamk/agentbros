import { readFileSync } from "node:fs";
import { runScript, parseArgs, CliErrorObject } from "../src/lib/cli";
import { buildRecipe, RECIPES } from "../src/lib/templates/recipes";
import { materializeRecipe } from "../src/lib/templates/materialize";
import { STYLE_PROFILES } from "../src/lib/templates/styles";
import { TEMPLATE_REGISTRY, findTemplate } from "../src/lib/templates/registry";
import type { TemplateId } from "../src/types/templates";
import type { RecipeRequest } from "../src/types/recipes";
const SPECS = [
  {
    name: "action",
    choices: ["list", "preview", "materialize", "template-preview"],
    default: "list",
    description: "List recipes/templates, preview JSON, or create draft project",
  },
  {
    name: "template",
    choices: TEMPLATE_REGISTRY.map((e) => e.id),
    description: "Registered template ID for local preview",
  },
  { name: "project", description: "New project ID for template preview" },
  { name: "input", description: "Recipe request JSON" },
  {
    name: "dry-run",
    type: "boolean",
    description: "Build canonical config without filesystem writes",
  },
] as const;
void runScript(async () => {
  const args = parseArgs(SPECS);
  if (args.action === "list")
    return {
      metadata: {
        recipes: RECIPES,
        styleProfiles: STYLE_PROFILES,
        templates: TEMPLATE_REGISTRY,
      },
    };
  if (args.action === "template-preview") {
    if (!args.template || !args.project)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Template preview requires --template and --project.",
      });
    const entry = findTemplate(args.template as TemplateId),
      beatIds = RECIPES[0].beats;
    const input: RecipeRequest = {
      projectId: args.project,
      recipeId: "social-hook",
      topic: entry.purpose,
      durationSec: 30,
      beats: beatIds.map((id) => {
        const template = structuredClone(entry.sample);
        if ("imageUrl" in template.props)
          template.props.imageUrl = `projects/${args.project}/assets/animatic/${id}.svg`;
        return { id, template };
      }),
    };
    if (args["dry-run"]) return { metadata: { ...buildRecipe(input), dryRun: true } };
    const result = materializeRecipe(input);
    return { outputs: result.outputs, metadata: { ...result, dryRun: false } };
  }
  if (!args.input)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--input recipe JSON is required.",
    });
  let input: RecipeRequest;
  try {
    input = JSON.parse(readFileSync(args.input, "utf8"));
  } catch {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Cannot read recipe request JSON.",
    });
  }
  if (args.action === "preview" || args["dry-run"]) return { metadata: { ...buildRecipe(input), dryRun: true } };
  const result = materializeRecipe(input);
  return { outputs: result.outputs, metadata: { ...result, dryRun: false } };
});
