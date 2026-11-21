import { existsSync } from "node:fs";
import { projectDirectory } from "../src/lib/campaigns/production/files";
import { experimentInstructions } from "../src/lib/experiments/project";
import { TechniqueFunctionSchema } from "../src/types/reference";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { buildCatalogue, type Catalogue, catalogueWarning, readCatalogue } from "../src/lib/library/catalogue";

const CATEGORIES = [
  "typography",
  "finish",
  "backgrounds",
  "ui",
  "transitions",
  "camera",
  "three",
  "data",
  "scenes",
  "kinetic",
  "effects",
  "captions",
] as const;

const SPECS = [
  {
    name: "for-shot",
    choices: TechniqueFunctionSchema.options,
    description: "Up to three ready techniques for this shot function",
  },
  { name: "project", description: "Project whose optional techniques are available for search" },
  { name: "category", choices: CATEGORIES, description: "Only items of this category" },
  { name: "query", description: "Words that must all appear in the id, title, description or tags" },
  { name: "format", choices: ["vertical", "square", "landscape"], description: "Only items checked in this format" },
  {
    name: "id",
    description: "Full detail of one item: usage, exports, props JSON schema, defaults, preview compositions",
  },
  {
    name: "no-sparing",
    type: "boolean",
    description: "Leave out stock-looking devices marked `sparing` (otherwise listed last)",
  },
  { name: "styles", type: "boolean", description: "List the library styles instead of items" },
  { name: "live", type: "boolean", description: "Load the registry (slow) instead of docs/library/catalogue.json" },
] as const;

async function liveCatalogue(): Promise<Catalogue> {
  const { loadLibrary } = await import("../src/lib/library/load");
  const { items, styles } = await loadLibrary();
  return buildCatalogue(items, styles);
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  const warning = args.live ? undefined : catalogueWarning();
  const catalogue = (args.live ? undefined : readCatalogue()) ?? (await liveCatalogue());
  const notes = warning ? { warning } : {};

  if (args.styles) return { metadata: { ...notes, count: catalogue.styles.length, styles: catalogue.styles } };

  if (args.id) {
    const item = catalogue.items.find((candidate) => candidate.id === args.id);
    if (!item)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Unknown library item "${args.id}". Run library:list to see the ids.`,
        details: notes,
      });
    return {
      metadata: {
        ...notes,
        item: {
          ...item,
          ...(item.shotTechnique ? { card: `design-reference/techniques/${item.shotTechnique.id}.md` } : {}),
          preview: { ...item.preview, image: existsSync(item.preview.image) ? item.preview.image : null },
        },
      },
    };
  }

  const projectDir = args.project ? projectDirectory(process.cwd(), args.project) : undefined;
  if (projectDir && !existsSync(projectDir))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `No project ${args.project}` });
  const enabled = new Set(projectDir ? experimentInstructions(projectDir).map(({ id }) => id) : []);
  const functionFilter = args["for-shot"] ? TechniqueFunctionSchema.parse(args["for-shot"]) : undefined;
  const terms = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = catalogue.items.filter((item) => {
    if (item.shotTechnique?.experiment && !enabled.has(item.shotTechnique.experiment)) return false;
    if (functionFilter && !item.shotTechnique?.functions.includes(functionFilter)) return false;
    if (args["no-sparing"] && item.sparing) return false;
    if (args.category && item.category !== args.category) return false;
    if (args.format && !item.formats.includes(args.format as never)) return false;
    const haystack = [item.id, item.title, item.description, ...item.tags].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  // Stock-looking devices go last, so an agent reading top-down meets the defaults first.
  const ordered = [...matches.filter((item) => !item.sparing), ...matches.filter((item) => item.sparing)];
  if (functionFilter) {
    const first = ordered.slice(0, 3);
    return {
      metadata: {
        ...notes,
        count: first.length,
        items: first.map(({ id, description, formats, shotTechnique, preview }) => ({
          id,
          reason: description,
          formats,
          card: `design-reference/techniques/${shotTechnique!.id}.md`,
          preview: { ...preview, image: existsSync(preview.image) ? preview.image : null },
        })),
      },
    };
  }

  return {
    metadata: {
      ...notes,
      count: ordered.length,
      items: ordered.map(
        ({
          id,
          category,
          title,
          description,
          tags,
          formats,
          durationInFrames,
          importPath,
          usage,
          preview,
          sparing,
          cues,
        }) => ({
          ...(sparing ? { sparing: `SPARING: ${sparing}` } : {}),
          id,
          category,
          title,
          description,
          tags,
          formats,
          durationInFrames,
          importPath,
          ...(usage ? { usage } : {}),
          cueKinds: [...new Set((cues ?? []).map((cue) => cue.kind))],
          preview: existsSync(preview.image) ? preview.image : null,
        }),
      ),
    },
  };
});
