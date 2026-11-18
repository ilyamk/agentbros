import { existsSync } from "node:fs";
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
          preview: { ...item.preview, image: existsSync(item.preview.image) ? item.preview.image : null },
        },
      },
    };
  }

  const terms = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = catalogue.items.filter((item) => {
    if (args["no-sparing"] && item.sparing) return false;
    if (args.category && item.category !== args.category) return false;
    if (args.format && !item.formats.includes(args.format as never)) return false;
    const haystack = [item.id, item.title, item.description, ...item.tags].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  // Stock-looking devices go last, so an agent reading top-down meets the defaults first.
  const ordered = [...matches.filter((item) => !item.sparing), ...matches.filter((item) => item.sparing)];
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
