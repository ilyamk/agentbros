/**
 * Which route a project follows, as `pnpm next` detects it (src/lib/pipeline/route.ts `detectRoute`), mapped onto the
 * console's routes: a bespoke film whose type is `replica` is `replica`; a `project.json` project made from a recipe
 * (`pipeline/recipe.json`) is `recipe`; a project not started on its bound playbook is `timeline` (minimal view).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { Route } from "../../../types/console";
import { detectRoute } from "../../pipeline/route";
import { readJsonFile } from "./files";

export type RouteInfo = { route: Route; chain: "film" | "footage" | "timeline" | "none"; detectedBy: string };

export function projectRoute(projectDir: string): RouteInfo {
  let detected: ReturnType<typeof detectRoute>;
  try {
    detected = detectRoute(projectDir);
  } catch (error) {
    return { route: "timeline", chain: "none", detectedBy: `route unknown: ${(error as Error).message ?? error}` };
  }
  const brief = readJsonFile(path.join(projectDir, "pipeline", "brief.json")) as { filmType?: unknown } | undefined;
  switch (detected.route) {
    case "film":
      return {
        route: brief?.filmType === "replica" ? "replica" : "film",
        chain: "film",
        detectedBy: detected.detectedBy,
      };
    case "footage":
      return { route: "footage", chain: "footage", detectedBy: detected.detectedBy };
    case "campaign":
      return { route: "campaign", chain: "none", detectedBy: detected.detectedBy };
    case "timeline":
      return {
        route: existsSync(path.join(projectDir, "pipeline", "recipe.json")) ? "recipe" : "timeline",
        chain: "timeline",
        detectedBy: detected.detectedBy,
      };
    default:
      return { route: "timeline", chain: "none", detectedBy: detected.detectedBy };
  }
}
