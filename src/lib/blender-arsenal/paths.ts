import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * One home for everything the Blender arsenal keeps: tracked manifests at the top of
 * `blender-arsenal/`, fetched and generated material under the git-ignored `local/`.
 * The Python twin is `scripts/workers/blender/avc_arsenal.py`; keep both in step.
 */
export const ARSENAL_DIR = "blender-arsenal";

/** Kinds of library asset, each a folder under `local/library/`. */
export const ASSET_KINDS = ["models", "materials", "hdri", "textures", "node-groups", "fonts", "decals"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface ArsenalPaths {
  root: string;
  /** Tracked: pinned, approved or proposed extensions. */
  extensionsManifest: string;
  /** Tracked: asset sources (libraries) and their adapters. */
  librariesManifest: string;
  /** Tracked: curated lists of asset ids per use case. */
  collections: string;
  /** Tracked: VFX and scene recipes (Python) live in scripts/blender/recipes/. */
  recipes: string;
  /** Git-ignored root of everything fetched or generated. */
  local: string;
  /** BLENDER_USER_RESOURCES for runs that use extensions; never the user's own Blender profile. */
  blenderUser: string;
  /** Content-addressed verified downloads: `<sha256>.<ext>`. */
  downloads: string;
  /** Unpacked library assets: `library/<kind>/<source>/<asset-id>/` with `asset.json`. */
  library: string;
  /** Generated search index of the local library. */
  libraryIndex: string;
  /** Generated Blender asset catalog for the local library. */
  libraryCatalog: string;
  /** Simulation caches: `bakes/<recipe>/<param-hash>/`. */
  bakes: string;
  /** Sandbox trials of candidates not yet approved: `trials/<candidate-id>/`. */
  trials: string;
}

export function arsenalPaths(root = process.cwd()): ArsenalPaths {
  const base = path.join(root, ARSENAL_DIR);
  const local = path.join(base, "local");
  const library = path.join(local, "library");
  return {
    root: base,
    extensionsManifest: path.join(base, "extensions.json"),
    librariesManifest: path.join(base, "libraries.json"),
    collections: path.join(base, "collections"),
    recipes: path.join(root, "scripts", "blender", "recipes"),
    local,
    blenderUser: path.join(local, "blender-user"),
    downloads: path.join(local, "downloads"),
    library,
    libraryIndex: path.join(library, "index.json"),
    libraryCatalog: path.join(library, "blender_assets.cats.txt"),
    bakes: path.join(local, "bakes"),
    trials: path.join(local, "trials"),
  };
}

/** Creates the local layout (idempotent) so an agent sees where things go before anything is fetched. */
export function ensureArsenalLayout(root = process.cwd()): ArsenalPaths {
  const paths = arsenalPaths(root);
  for (const dir of [
    paths.blenderUser,
    paths.downloads,
    paths.bakes,
    paths.trials,
    ...ASSET_KINDS.map((kind) => path.join(paths.library, kind)),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}
