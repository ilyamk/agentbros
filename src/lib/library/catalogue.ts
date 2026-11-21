import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Cue, LibraryCategory, LibraryFormat, LibraryItem, LibraryStyle } from "../../motion/library/types";
import { compositionIds, previewEntry, previewImage, sourceFile } from "./paths";

export const CATALOGUE_PATH = "docs/library/catalogue.json";
const LIBRARY_DIR = "src/motion/library";
/** What the catalogue is built from: the library's code and the builder. Docs, previews and AGENTS.md are not inputs. */
const SOURCE_ROOTS = [LIBRARY_DIR, "src/lib/library/catalogue.ts", "src/lib/library/paths.ts"];
const isSource = (file: string) => /\.tsx?$/.test(file);

export type CatalogueItem = {
  id: string;
  category: LibraryCategory;
  title: string;
  description: string;
  tags: string[];
  formats: LibraryFormat[];
  durationInFrames: number;
  importPath: string;
  usage?: string;
  exports: string[];
  inspiredBy?: string[];
  shotTechnique?: LibraryItem["shotTechnique"];
  propsSchema: unknown;
  defaultProps: Record<string, unknown>;
  preview: { image: string; entry: string; compositions: string[] };
  /** Cue frames of the default props: what sound and the cut can lock to. Ambient blocks have none. */
  cues: Pick<Cue, "frame" | "kind" | "sfx" | "weight">[];
  /** Present on stock-looking devices: why and when one is still justified. Agents never pick these by default. */
  sparing?: string;
};
export type Catalogue = {
  version: 1;
  /** sha256 of the source files the catalogue was built from; `library:list` warns when it no longer matches. */
  sourceHash?: string;
  items: CatalogueItem[];
  styles: LibraryStyle[];
};

const sourceFiles = (root: string): string[] => {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return isSource(root) ? [root] : [];
  return readdirSync(root).flatMap((name) => sourceFiles(path.join(root, name)));
};

/** Content hash of the catalogue's inputs: path and bytes of every source file, in a stable order. */
export function librarySourceHash(roots: readonly string[] = SOURCE_ROOTS): string {
  const hash = createHash("sha256");
  for (const file of roots.flatMap(sourceFiles).sort())
    hash
      .update(`${file.split(path.sep).join("/")}\0`)
      .update(readFileSync(file))
      .update("\0");
  return hash.digest("hex");
}

const exportsOf = (file: string | undefined): string[] =>
  file
    ? [...readFileSync(file, "utf8").matchAll(/^export\s+(?:const|function|class)\s+(\w+)/gm)].map((match) => match[1]!)
    : [];

export function buildCatalogue(items: LibraryItem[], styles: LibraryStyle[]): Catalogue {
  return {
    version: 1,
    sourceHash: librarySourceHash(),
    items: items.map((item) => ({
      id: item.id,
      category: item.category,
      title: item.title,
      description: item.description,
      tags: item.tags,
      formats: item.formats,
      durationInFrames: item.durationInFrames,
      importPath: item.importPath,
      ...(item.usage ? { usage: item.usage } : {}),
      exports: exportsOf(sourceFile(item.importPath)),
      ...(item.inspiredBy ? { inspiredBy: item.inspiredBy } : {}),
      ...(item.shotTechnique ? { shotTechnique: item.shotTechnique } : {}),
      propsSchema: z.toJSONSchema(item.schema, { unrepresentable: "any" }),
      defaultProps: item.defaultProps,
      preview: { image: previewImage(item.id), entry: previewEntry(item.category), compositions: compositionIds(item) },
      cues: (item.cues?.(item.defaultProps) ?? []).map(({ frame, kind, sfx, weight }) => ({
        frame,
        kind,
        ...(sfx ? { sfx } : {}),
        ...(weight ? { weight } : {}),
      })),
      ...(item.sparing ? { sparing: item.sparing } : {}),
    })),
    styles,
  };
}

export function readCatalogue(): Catalogue | undefined {
  return existsSync(CATALOGUE_PATH) ? (JSON.parse(readFileSync(CATALOGUE_PATH, "utf8")) as Catalogue) : undefined;
}

/** A warning when the catalogue is missing or was built from other library sources than the ones on disk now. */
export function catalogueWarning(
  cataloguePath: string = CATALOGUE_PATH,
  roots: readonly string[] = SOURCE_ROOTS,
): string | undefined {
  if (!existsSync(cataloguePath)) return `${cataloguePath} is missing. Run \`pnpm library:catalogue\`, or pass --live.`;
  const stored = (JSON.parse(readFileSync(cataloguePath, "utf8")) as Partial<Catalogue>).sourceHash;
  if (stored === librarySourceHash(roots)) return undefined;
  return `${cataloguePath} was built from other library sources than the ones on disk. Run \`pnpm library:catalogue\`, or pass --live.`;
}
