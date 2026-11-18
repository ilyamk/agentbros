/**
 * The motion library on the console (RFC 0004 WP15, US21): `docs/library/catalogue.json` (written by
 * `pnpm library:catalogue`) trimmed to what a person browses — id, category, title, description, tags, formats,
 * length, import path, usage and the `inspiredBy` credits — without props schemas, default props or exports. Read-only.
 * Preview stills are served only through a catalogue entry's own `preview.image`, confined to the previews folder:
 * the client names a block id, never a path.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { FORMATS, LibraryResponseSchema, type LibraryItem, type LibraryResponse } from "../../types/console";

export const LIBRARY_CATALOGUE = "docs/library/catalogue.json";
export const LIBRARY_PREVIEWS = "docs/library/previews";
/** The catalogue is about 0.8 MB; a file far beyond that is refused rather than parsed. */
const CATALOGUE_MAX_BYTES = 32 * 1024 * 1024;
const PREVIEW = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(jpe?g|png|webp)$/;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const list = (value: unknown, count: number, max: number): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => bounded(item, max))
        .filter((item): item is string => !!item)
        .slice(0, count)
    : [];
const FORMAT_SET = new Set<string>(FORMATS);
const isFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

export interface LibraryCatalogue {
  response: LibraryResponse;
  /** Block id → absolute preview file (inside the previews folder), when the catalogue names one. */
  previews: Map<string, string>;
}

/** The previews folder's file for a catalogue `preview.image`, or undefined when it points anywhere else. */
export function previewFile(rootDir: string, image: unknown): string | undefined {
  if (typeof image !== "string") return undefined;
  const prefix = `${LIBRARY_PREVIEWS}/`;
  if (!image.startsWith(prefix)) return undefined;
  const name = image.slice(prefix.length);
  if (!PREVIEW.test(name)) return undefined;
  return path.join(rootDir, LIBRARY_PREVIEWS, name);
}

/** Parses a catalogue object into the trimmed response (pure; tests feed it objects). */
export function trimCatalogue(rootDir: string, catalogue: unknown): LibraryCatalogue {
  const source = isObject(catalogue) ? catalogue : {};
  const previews = new Map<string, string>();
  const items: LibraryItem[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(source.items) ? source.items : []) {
    if (!isObject(raw)) continue;
    const id = bounded(raw.id, 128);
    const category = bounded(raw.category, 64);
    const title = bounded(raw.title, 200);
    const importPath = bounded(raw.importPath, 512);
    if (!id || !category || !title || !importPath || seen.has(id)) continue;
    seen.add(id);
    const named = previewFile(rootDir, isObject(raw.preview) ? raw.preview.image : undefined);
    // A still the catalogue names but the checkout lacks (not rendered yet) is no preview.
    const preview = named && isFile(named) ? named : undefined;
    if (preview) previews.set(id, preview);
    const duration = raw.durationInFrames;
    const usage = bounded(typeof raw.usage === "string" ? raw.usage : undefined, 4000);
    items.push({
      id,
      category,
      title,
      description: bounded(raw.description, 4000) ?? "",
      tags: list(raw.tags, 64, 128),
      formats: [
        ...new Set(list(raw.formats, 3, 16).filter((format) => FORMAT_SET.has(format))),
      ] as LibraryItem["formats"],
      ...(typeof duration === "number" && Number.isInteger(duration) && duration >= 0
        ? { durationInFrames: duration }
        : {}),
      importPath,
      inspiredBy: list(raw.inspiredBy, 32, 1000),
      ...(usage ? { usage } : {}),
      preview: !!preview,
    });
    if (items.length >= 2000) break;
  }
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  const version =
    typeof source.version === "number" && Number.isInteger(source.version) && source.version >= 0 ? source.version : 0;
  const response = LibraryResponseSchema.parse({
    v: 1,
    version,
    items,
    categories: [...counts].slice(0, 64).map(([id, count]) => ({ id, count })),
  });
  return { response, previews };
}

/** Reads the catalogue of `rootDir`, memoised by size and mtime; undefined when there is none or it is unreadable. */
export class LibraryReader {
  private cached: { key: string; value: LibraryCatalogue } | undefined;
  constructor(private readonly rootDir: string) {}

  read(): LibraryCatalogue | undefined {
    const file = path.join(this.rootDir, LIBRARY_CATALOGUE);
    let info;
    try {
      info = statSync(file);
    } catch {
      return undefined;
    }
    if (!info.isFile() || info.size > CATALOGUE_MAX_BYTES) return undefined;
    const key = `${info.size}:${info.mtimeMs}`;
    if (this.cached?.key === key) return this.cached.value;
    try {
      const value = trimCatalogue(this.rootDir, JSON.parse(readFileSync(file, "utf8")) as unknown);
      this.cached = { key, value };
      return value;
    } catch {
      return undefined;
    }
  }
}
