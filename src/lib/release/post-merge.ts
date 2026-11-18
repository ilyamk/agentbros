import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPathWithin, emitProgress } from "../cli";
import { parseChangeEntry } from "../contrib/changes";
import { addedFiles, commit, git } from "./git";

export const FALLBACK_GENERATORS: readonly (readonly string[])[] = [
  ["library:catalogue"],
  ["playbook", "--write-doc"],
  ["commands", "--write-doc"],
  ["film:route", "--write-doc"],
  ["credits:write-doc"],
  ["metrics", "--write", "--write-readme"],
  ["context:budget", "--write"],
  ["api:surface"],
];

export function runGenerator(root: string, args: readonly string[]): void {
  emitProgress(`Regenerating: pnpm ${args.join(" ")}`);
  const result = spawnSync("pnpm", ["--silent", ...args], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const report = JSON.parse(result.stdout.trim()) as { ok?: boolean; message?: string };
  if (result.status !== 0 || report.ok !== true)
    throw new Error(`Generator failed: pnpm ${args.join(" ")}: ${report.message ?? result.status}`);
}

export function regeneratePostMerge(
  root: string,
  options: { base: string; head: string; pr?: number; date?: string },
  run = runGenerator,
) {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date)
    throw new Error("Expected a valid YYYY-MM-DD date");
  if (options.pr !== undefined && (!Number.isSafeInteger(options.pr) || options.pr <= 0))
    throw new Error("PR number must be a positive integer");
  const base = commit(root, options.base);
  const head = commit(root, options.head);
  const changed = git(root, ["diff", "--name-only", "--diff-filter=AMR", "-z", base, head, "--"])
    .split("\0")
    .filter(Boolean);
  const dates = changed.filter((file) => /(^|\/)AGENTS\.md$/.test(file) && existsSync(path.join(root, file)));
  const entries = addedFiles(root, base, head).filter(
    (file) => /^\.changes\/[^/]+\.md$/.test(file) && file !== ".changes/README.md" && existsSync(path.join(root, file)),
  );
  const updates = new Map<string, string>();
  const read = (file: string) => {
    const absolute = path.join(root, file);
    assertPathWithin(root, absolute);
    if (!lstatSync(absolute).isFile()) throw new Error(`Expected a regular file: ${file}`);
    return readFileSync(absolute, "utf8");
  };
  for (const file of dates) {
    const source = read(file);
    if (!/^Last updated: \d{4}-\d{2}-\d{2}$/m.test(source)) throw new Error(`Missing Last updated line: ${file}`);
    updates.set(file, source.replace(/^Last updated: \d{4}-\d{2}-\d{2}$/m, `Last updated: ${date}`));
  }
  if (options.pr !== undefined)
    for (const file of entries) {
      const source = read(file);
      const entry = parseChangeEntry(source, file);
      if (entry.pr === 0) {
        const closing = source.indexOf("\n---", 4);
        const next: string =
          source
            .slice(0, closing)
            .replace(
              /^(pr:[ \t]*)0([ \t]*(?:#[^\r\n]*)?\r?)$/m,
              (_, prefix: string, suffix: string) => `${prefix}${options.pr}${suffix}`,
            ) + source.slice(closing);
        if (parseChangeEntry(next, file).pr !== options.pr) throw new Error(`Cannot fill PR field: ${file}`);
        updates.set(file, next);
      }
    }
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const generators = pkg.scripts?.regen
    ? [["regen"]]
    : existsSync(path.join(root, "scripts/regen.ts"))
      ? [["exec", "tsx", "scripts/regen.ts"]]
      : FALLBACK_GENERATORS;
  for (const args of generators) run(root, args);
  // Read again after generators so regenerated instruction catalogues are preserved.
  for (const file of dates) {
    const source = read(file);
    if (!/^Last updated: \d{4}-\d{2}-\d{2}$/m.test(source))
      throw new Error(`Generator removed Last updated line: ${file}`);
    updates.set(file, source.replace(/^Last updated: \d{4}-\d{2}-\d{2}$/m, `Last updated: ${date}`));
  }
  for (const [file, source] of updates) writeFileSync(path.join(root, file), source);
  return { outputs: [...updates.keys()], metadata: { date, pr: options.pr ?? null, generators } };
}
