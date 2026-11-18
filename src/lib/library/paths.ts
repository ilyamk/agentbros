import { existsSync } from "node:fs";
import type { LibraryCategory, LibraryFormat, LibraryItem } from "../../motion/library/types";

export const PREVIEW_DIR = "docs/library/previews";
export const FORMAT_SUFFIX: Record<LibraryFormat, "V" | "S" | "L"> = { vertical: "V", square: "S", landscape: "L" };

export const previewImage = (id: string) => `${PREVIEW_DIR}/${id}.jpg`;
export const categorySheet = (category: LibraryCategory) => `${PREVIEW_DIR}/_${category}.jpg`;
export const compositionId = (id: string, format: LibraryFormat) => `Lib-${id}-${FORMAT_SUFFIX[format]}`;
export const compositionIds = (item: Pick<LibraryItem, "id" | "formats">) =>
  item.formats.map((format) => compositionId(item.id, format));

/** A category's own preview root bundles only its items; fall back to the whole library. */
export function previewEntry(category: LibraryCategory): string {
  const own = `src/motion/library/${category}/preview.tsx`;
  return existsSync(own) ? own : "src/motion/library/index.tsx";
}

/** `importPath` carries no extension. */
export function sourceFile(importPath: string): string | undefined {
  return [".tsx", ".ts", "/index.tsx", "/index.ts"]
    .map((suffix) => importPath + suffix)
    .find((file) => existsSync(file));
}
