import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileLeakPatterns, loadLeakPatterns } from "../leak-scan";
import { LeakPatternSchema } from "../../types/leak-scan";
import { ShowcaseSchema, type Showcase } from "../../types/showcase";
import { CliErrorObject } from "../cli";

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}
export function optionalJson(file: string): unknown {
  return existsSync(file) ? readJson(file) : undefined;
}
export function jsonFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((row) => row.isFile() && row.name.endsWith(".json"))
        .map((row) => path.join(dir, row.name))
        .sort()
    : [];
}
export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
export function readShowcases(root: string): Showcase[] {
  const dir = path.join(root, "showcases");
  return !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true })
        .filter((row) => row.isDirectory())
        .flatMap((row) => {
          const file = path.join(dir, row.name, "showcase.json");
          if (!existsSync(file)) return [];
          const entry = ShowcaseSchema.parse(readJson(file));
          if (entry.slug !== row.name) throw new Error("Showcase slug differs from its directory");
          return [entry];
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.slug.localeCompare(b.slug));
}
/** Paths are removed before scanning; other private text causes a refusal for human review. */
export function stripPaths(value: string): string {
  return value.replace(/(?<![\w:/])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^\s"'<>]+/g, "[local path]");
}
export function stripExportPaths<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, field: unknown) => (typeof field === "string" ? stripPaths(field) : field)),
  ) as T;
}
export function assertPublic(value: unknown, root: string): void {
  const config = optionalJson(path.join(root, "public-export.json")) as { leakPatterns?: unknown[] } | undefined;
  const patterns = config?.leakPatterns?.map((row) => LeakPatternSchema.parse(row)) ?? [
    { name: "home-path", regex: "(?:[/]Users[/]|/home/|[A-Za-z]:\\\\Users\\\\)" },
    { name: "secret", regex: "(?:sk-[a-zA-Z0-9]{16,}|AKIA[A-Z0-9]{16}|-----BEGIN.*PRIVATE KEY)" },
    { name: "email", regex: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}" },
  ];
  const testers = compileLeakPatterns(loadLeakPatterns(root, patterns).leakPatterns);
  const source = JSON.stringify(value);
  const hits = testers.filter((row) => row.regex.test(source)).map((row) => row.name);
  if (hits.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Public export refused by leak scan: ${hits.join(", ")}. Review private text locally.`,
    });
}
