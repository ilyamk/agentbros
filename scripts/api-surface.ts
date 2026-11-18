import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { buildSurface, compareSurfaces, SURFACE_PATH, type ApiSurface } from "../src/lib/api-surface";
import { stableJson } from "../src/lib/api-surface/source";

const SPECS = [
  { name: "check", type: "boolean", description: "Fail if docs/api/surface.json is missing or stale; never writes" },
  { name: "compare", description: "Compare an older surface JSON file; classify breaking, minor or patch" },
] as const;
void runScript(async () => {
  const args = parseArgs(SPECS);
  const surface = await buildSurface();
  const text = stableJson(surface);
  const comparison = args.compare
    ? compareSurfaces(JSON.parse(readFileSync(args.compare, "utf8")) as ApiSurface, surface)
    : undefined;
  if (args.check) {
    if (!existsSync(SURFACE_PATH) || readFileSync(SURFACE_PATH, "utf8") !== text)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "API surface is stale. Run pnpm api:surface and include docs/api/surface.json.",
      });
  } else if (!args.compare) {
    mkdirSync(path.dirname(SURFACE_PATH), { recursive: true });
    writeFileSync(SURFACE_PATH, text);
  }
  return {
    outputs: args.check || args.compare ? [] : [SURFACE_PATH],
    metadata: {
      checked: Boolean(args.check),
      ...(comparison ? { comparison } : {}),
      commands: surface.commands.length,
      schemas: surface.schemas.length,
      unknown: surface.unknown,
    },
  };
});
