import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetCatalogCache } from "../../src/lib/models/fal-catalog";
import { apiModelSource } from "../../src/lib/providers/fal-openapi";
import { FalCatalogEntrySchema, FalCatalogFileSchema, type FalCatalogEntry } from "../../src/types/fal-catalog";

/**
 * A temporary catalogue index and schema cache built from tests/fixtures/fal-catalog, pointed to by
 * AGENTBROS_FAL_CATALOG_DIR and AGENTBROS_FAL_SCHEMA_CACHE for the rest of the test process. Cache files are copied
 * byte for byte, so their hash still matches their name. Offline.
 */
const fixtures = path.resolve(import.meta.dirname, "../fixtures/fal-catalog");
export const falFixtureManifest = JSON.parse(readFileSync(path.join(fixtures, "manifest.json"), "utf8")) as {
  endpoints: Record<string, { sha256: string; category: string }>;
};

export type TempEntry = { endpoint: string; cached?: boolean; patch?: Partial<FalCatalogEntry> };
export function catalogEntry(endpoint: string, patch: Partial<FalCatalogEntry> = {}): FalCatalogEntry {
  const fixture = falFixtureManifest.endpoints[endpoint];
  if (!fixture) throw new Error(`No recorded fixture for ${endpoint}.`);
  return FalCatalogEntrySchema.parse({
    endpoint,
    category: fixture.category,
    displayName: endpoint,
    status: "active",
    firstSeen: "2026-11-15",
    lastSeen: "2026-11-15",
    schema: { sha256: fixture.sha256, asOf: "2026-11-15", source: apiModelSource(endpoint), cached: true },
    inputs: [],
    outputs: { kinds: ["file"], fields: [] },
    transport: "queue",
    price: null,
    tier: "discovered",
    tags: [],
    ...patch,
  });
}
export function useTempFalCatalog(entries: TempEntry[]): { catalogDir: string; cacheDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "fal-catalog-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  const catalogDir = path.join(root, "catalog"),
    cacheDir = path.join(root, "cache");
  mkdirSync(catalogDir);
  mkdirSync(cacheDir);
  const byCategory = new Map<string, FalCatalogEntry[]>();
  for (const { endpoint, cached = true, patch } of entries) {
    const entry = catalogEntry(endpoint, patch);
    byCategory.set(entry.category, [...(byCategory.get(entry.category) ?? []), entry]);
    const sha = falFixtureManifest.endpoints[endpoint]!.sha256;
    if (cached && entry.schema)
      copyFileSync(path.join(fixtures, "schemas", `${sha}.json`), path.join(cacheDir, `${sha}.json`));
  }
  for (const [category, list] of byCategory) {
    const file = FalCatalogFileSchema.parse({
      version: 1,
      category,
      syncedAt: "2026-11-15",
      entries: list.sort((a, b) => (a.endpoint < b.endpoint ? -1 : 1)),
    });
    writeFileSync(path.join(catalogDir, `${category}.json`), JSON.stringify(file, null, 2));
  }
  process.env.AGENTBROS_FAL_CATALOG_DIR = catalogDir;
  process.env.AGENTBROS_FAL_SCHEMA_CACHE = cacheDir;
  resetCatalogCache();
  return { catalogDir, cacheDir };
}
