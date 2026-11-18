import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseChangeEntry } from "../contrib/changes";
import { ContributorHandleSchema, ContributorSchema, type Contributor } from "../../types/contributor";
import { jsonFiles, optionalJson, readShowcases } from "../showcase/data";

export interface ContributorStats {
  handle: string;
  profile?: Contributor;
  mergedByCategory: Record<string, number>;
  blocksAuthored: number;
  blockShowcaseUses: number;
  showcases: number;
  benchmarkBundlesReproduced: number;
  instructionBytesRemoved: number;
  badges: string[];
}
export const BADGES = [
  { id: "first-block", label: "First block", qualifies: (stats: ContributorStats) => stats.blocksAuthored >= 1 },
  { id: "ten-blocks", label: "Ten blocks", qualifies: (stats: ContributorStats) => stats.blocksAuthored >= 10 },
  {
    id: "sensor-contributor",
    label: "Sensor contributor",
    qualifies: (stats: ContributorStats) => (stats.mergedByCategory.sensor ?? 0) > 0,
  },
  { id: "showcase-author", label: "Showcase author", qualifies: (stats: ContributorStats) => stats.showcases > 0 },
  {
    id: "reproduced-benchmark",
    label: "Reproduced benchmark",
    qualifies: (stats: ContributorStats) => stats.benchmarkBundlesReproduced > 0,
  },
  {
    id: "instruction-editor",
    label: "Instruction editor",
    qualifies: (stats: ContributorStats) => stats.instructionBytesRemoved > 0,
  },
] as const;
const handleOf = (value: unknown): string | undefined => {
  const result = ContributorHandleSchema.safeParse(
    typeof value === "string" ? value.replace(/^@/, "").toLowerCase() : value,
  );
  return result.success ? result.data : undefined;
};
export function contributorStats(root: string) {
  const warnings: string[] = [],
    people = new Map<string, ContributorStats>();
  const person = (handle: string) => {
    const id = handleOf(handle);
    if (!id) throw new Error("Invalid contributor handle");
    if (!people.has(id))
      people.set(id, {
        handle: id,
        mergedByCategory: {},
        blocksAuthored: 0,
        blockShowcaseUses: 0,
        showcases: 0,
        benchmarkBundlesReproduced: 0,
        instructionBytesRemoved: 0,
        badges: [],
      });
    return people.get(id)!;
  };
  for (const file of jsonFiles(path.join(root, "community/contributors")))
    person(path.basename(file, ".json")).profile = ContributorSchema.parse(optionalJson(file));
  const seen = new Set<string>();
  const credit = (handle: string, category: string, key: string) => {
    const row = person(handle),
      id = `${row.handle}:${category}:${key}`;
    if (!seen.has(id)) {
      seen.add(id);
      row.mergedByCategory[category] = (row.mergedByCategory[category] ?? 0) + 1;
    }
  };
  const git = (args: string[]) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const history = git(["log", "--no-renames", "--format=%H", "--diff-filter=A", "--", ".changes/"]);
  if (git(["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true")
    warnings.push("Shallow git history: fetch full history to compute complete contribution statistics.");
  if (history.status !== 0) warnings.push("Git history is unavailable; merged change statistics may be incomplete.");
  for (const commit of [...new Set(history.stdout?.trim().split("\n").filter(Boolean) ?? [])]) {
    const files = git([
      "diff-tree",
      "--no-renames",
      "--root",
      "--no-commit-id",
      "--name-only",
      "--diff-filter=A",
      "-r",
      commit,
      "--",
      ".changes/",
    ])
      .stdout.trim()
      .split("\n")
      .filter((file) => /^\.changes\/[a-z0-9-]+\.md$/.test(file) && file !== ".changes/README.md");
    const instructionAuthors = new Set<string>();
    for (const file of files) {
      try {
        const deletion = git([
          "log",
          "--reverse",
          "--no-renames",
          "--format=%H",
          "--diff-filter=D",
          `${commit}..HEAD`,
          "--",
          file,
        ])
          .stdout.trim()
          .split("\n")[0];
        const lastVersion = deletion ? `${deletion}^` : "HEAD";
        const entry = parseChangeEntry(git(["show", `${lastVersion}:${file}`]).stdout, file);
        for (const author of entry.authors) {
          const handle = handleOf(author);
          if (!handle) {
            warnings.push(`Skipped non-handle change author in ${file}.`);
            continue;
          }
          credit(handle, entry.category, entry.pr ? `pr:${entry.pr}` : file);
          if (entry.category === "instructions") instructionAuthors.add(handle);
        }
      } catch {
        warnings.push(`Skipped invalid historical change entry ${file}.`);
      }
    }
    if (instructionAuthors.size) {
      let removed = 0;
      const paths = git(["diff-tree", "--no-commit-id", "--name-only", "-r", commit])
        .stdout.trim()
        .split("\n")
        .filter((file) => /(?:^|\/)AGENTS\.md$/.test(file));
      for (const file of paths) {
        const before = git(["show", `${commit}^:${file}`]),
          after = git(["show", `${commit}:${file}`]);
        if (before.status === 0)
          removed += Math.max(
            0,
            Buffer.byteLength(before.stdout) - Buffer.byteLength(after.status === 0 ? after.stdout : ""),
          );
      }
      for (const handle of instructionAuthors) person(handle).instructionBytesRemoved += removed;
    }
  }
  // Release credits preserve attribution after consumed change entries disappear from shallow histories.
  const changelog = path.join(root, "CHANGELOG.md");
  if (existsSync(changelog)) {
    const source = readFileSync(changelog, "utf8");
    for (const section of source.split(/^## /m).slice(1)) {
      const credits = /### Contributors\r?\n([\s\S]*?)(?=\r?\n### |$)/.exec(section)?.[1] ?? "";
      for (const line of credits.split("\n")) for (const match of line.matchAll(/\[@([\w-]+)\]/g)) person(match[1]!);
    }
    if (history.status !== 0 || !history.stdout.trim())
      warnings.push(
        "Release credits identify contributors; category PR counts need full .changes git history and are not inferred from release mentions.",
      );
  }
  const showcases = readShowcases(root);
  showcases.forEach((entry) => {
    person(entry.author.handle).showcases++;
  });
  const catalogue = optionalJson(path.join(root, "docs/library/catalogue.json")) as
    { items?: { id: string; authors?: string[] }[] } | undefined;
  let missingAuthors = 0;
  for (const block of catalogue?.items ?? []) {
    if (!block.authors?.length) {
      missingAuthors++;
      continue;
    }
    for (const author of new Set(block.authors.map(handleOf).filter((handle): handle is string => Boolean(handle)))) {
      const row = person(author);
      row.blocksAuthored++;
      row.blockShowcaseUses += showcases.filter((entry) => entry.libraryBlocks.includes(block.id)).length;
    }
  }
  if (missingAuthors)
    warnings.push(`${missingAuthors} library blocks have no recorded authors; skipped author attribution.`);
  for (const file of jsonFiles(path.join(root, "bench/results"))) {
    const bundle = optionalJson(file) as {
      author?: string;
      submitter?: string;
      reproduced?: boolean;
      verification?: string;
    };
    const handle = handleOf(bundle.author ?? bundle.submitter);
    if (handle && (bundle.reproduced === true || bundle.verification === "reproduced"))
      person(handle).benchmarkBundlesReproduced++;
    else warnings.push(`Benchmark attribution/reproduction not recorded in ${path.relative(root, file)}; skipped.`);
  }
  const contributors = [...people.values()].sort((a, b) => a.handle.localeCompare(b.handle));
  contributors.forEach((row) => {
    row.badges = BADGES.filter((badge) => badge.qualifies(row)).map((badge) => badge.label);
  });
  return { contributors, warnings };
}
