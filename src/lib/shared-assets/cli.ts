import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, emitProgress } from "../cli";
import { AssetMissingError, ensureAssets, loadAssets } from "./index";
import { needsForSource } from "./needs";

/** ensureAssets() for a CLI: fetches what is cheap, otherwise fails with ASSET_MISSING naming the command. */
export async function ensureAssetsForCli(ids: readonly string[], { fetch = true } = {}): Promise<void> {
  try {
    await ensureAssets(ids, { fetch, onProgress: emitProgress });
  } catch (error) {
    if (error instanceof AssetMissingError)
      throw new CliErrorObject({ code: "ASSET_MISSING", message: error.message, details: { missing: error.missing } });
    throw error;
  }
}

function texts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return texts(file);
    return /\.(tsx?|json)$/.test(name) && statSync(file).size < 2_000_000 ? [readFileSync(file, "utf8")] : [];
  });
}

/** Shared assets a project's code (src/projects/<id>) and project.json refer to. */
export function needsForProject(projectId: string, root = process.cwd()): string[] {
  const targets = new Map(loadAssets(root).map((entry) => [entry.target, entry.id]));
  const files = [
    ...texts(path.join(root, "src/projects", projectId)),
    ...(existsSync(path.join(root, "public/projects", projectId, "project.json"))
      ? [readFileSync(path.join(root, "public/projects", projectId, "project.json"), "utf8")]
      : []),
  ];
  return [...new Set(files.flatMap((text) => needsForSource(text, targets)))];
}
