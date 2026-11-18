import { readFileSync } from "node:fs";
import categoriesJson from "../../../contrib/categories.json";
import protectedJson from "../../../contrib/protected.json";
import { CategoriesFileSchema, ProtectedPathsSchema, type CategoriesFile, type Category } from "../../types/contrib";
import { globToRegex } from "../leak-scan";

export const DEFAULT_CATEGORIES = CategoriesFileSchema.parse(categoriesJson);
export const DEFAULT_PROTECTED = ProtectedPathsSchema.parse(protectedJson);
export function loadCategories(file: string): CategoriesFile {
  return CategoriesFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
export function matchesPath(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegex(glob).test(file));
}
export function categoriesForPath(file: string, config: CategoriesFile = DEFAULT_CATEGORIES): Category[] {
  return config.categories.filter(({ paths }) => matchesPath(file, paths));
}
export function categoriesForPaths(files: readonly string[], config: CategoriesFile = DEFAULT_CATEGORIES): string[] {
  return config.categories.filter(({ paths }) => files.some((file) => matchesPath(file, paths))).map(({ id }) => id);
}
