import { existsSync } from "node:fs";
import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { arsenalPaths } from "../src/lib/blender-arsenal/paths";
import { Kind } from "../src/lib/blender-arsenal/libraries/schemas";
import {
  addAsset,
  buildIndex,
  collectionStatus,
  projectCredits,
  readIndex,
  readManifest,
  searchAssets,
  indexBundled,
  importArchive,
} from "../src/lib/blender-arsenal/libraries/store";

const ACTIONS = ["sources", "search", "add", "index", "show", "credits", "collection", "doctor", "import"] as const;

runScript(async () => {
  const positional = process.argv[2];
  if (ACTIONS.some((action) => action === positional)) {
    if (process.argv.includes("--action"))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose positional action or --action, not both" });
    process.argv.splice(2, 1, "--action", positional!);
  }
  const args = parseArgs([
    { name: "action", choices: ACTIONS, required: true, description: "Library action" },
    { name: "bundled", type: "boolean", description: "Index installed Essentials, matcaps and world HDRIs in place" },
    { name: "file", description: "Manual ZIP archive" },
    { name: "licence", description: "Verified item licence" },
    { name: "source-page", description: "Original asset page URL" },
    { name: "title", description: "Imported title" },
    { name: "id", description: "source:asset id" },
    { name: "query", description: "Search text" },
    { name: "kind", description: "Asset kind" },
    { name: "source", description: "Source id" },
    { name: "local", type: "boolean", description: "Search local files only" },
    { name: "resolution", default: "2k", description: "Download resolution" },
    { name: "consent", description: "Who authorised download, when and why" },
    { name: "pin", type: "boolean", description: "Pin verified bytes in libraries.json" },
    { name: "project", description: "Project id for credits" },
    { name: "name", description: "Collection name" },
  ] as const);
  const required = (value: string | undefined, flag: string) => {
    if (!value?.trim()) throw new CliErrorObject({ code: "INVALID_INPUT", message: `--${flag} required` });
    return value;
  };
  try {
    switch (args.action) {
      case "sources":
        return { metadata: readManifest() };
      case "search":
        return {
          metadata: await searchAssets(required(args.query, "query"), {
            kind: args.kind ? Kind.parse(args.kind) : undefined,
            source: args.source,
            local: args.local,
          }),
        };
      case "add":
        return {
          metadata: {
            asset: await addAsset(required(args.id, "id"), {
              consent: args.consent,
              resolution: args.resolution,
              pin: args.pin,
            }),
          },
        };
      case "import":
        return {
          metadata: {
            asset: importArchive(required(args.file, "file"), required(args.source, "source"), {
              id: args.id,
              kind: args.kind ? Kind.parse(args.kind) : undefined,
              title: args.title,
              licence: required(args.licence, "licence"),
              sourcePage: required(args["source-page"], "source-page"),
              consent: required(args.consent, "consent"),
            }),
          },
        };
      case "index":
        if (args.bundled) {
          const inventory = indexBundled();
          return {
            metadata: {
              blenderVersion: inventory.blenderVersion,
              files: inventory.files.length,
              assets: inventory.files.reduce((sum, file) => sum + file.assets.length, 0),
            },
          };
        }
        return {
          outputs: [arsenalPaths().libraryIndex, arsenalPaths().libraryCatalog],
          metadata: { count: buildIndex().assets.length },
        };
      case "show": {
        const id = required(args.id, "id"),
          asset = readIndex().assets.find((a) => a.id === id);
        if (!asset)
          throw new Error(
            `Unknown local asset ${id}; run pnpm blender:assets --action add --id ${id} --consent "who/when/why"`,
          );
        return { metadata: { asset } };
      }
      case "credits":
        return { metadata: { credits: projectCredits(required(args.project, "project")) } };
      case "collection":
        return { metadata: collectionStatus(required(args.name, "name")) };
      case "doctor": {
        const manifest = readManifest(),
          index = buildIndex();
        return {
          metadata: {
            sources: manifest.sources.length,
            approved: manifest.sources.filter((s) => s.status === "approved").length,
            assets: index.assets.length,
            catalog: existsSync(arsenalPaths().libraryCatalog),
            downloadsRequireConsent: true,
            bundledProbe: "In Blender: avc_assets.bundled_assets()",
          },
        };
      }
      default:
        throw new Error("Unknown action");
    }
  } catch (error) {
    throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
  }
});
