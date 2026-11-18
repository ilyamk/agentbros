import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "../../src/lib/cli";
import { runOffline } from "../../src/lib/contrib/cli";
import { categoriesForPaths } from "../../src/lib/contrib/categories";
import { contributionCategories } from "../../src/lib/contrib/gates";
import { gateTimeoutMs } from "../../src/lib/contrib/check";
import { changedFiles } from "../../src/lib/contrib/git";
export type Gate = { name: string; command: string[] };
export type Gates = (categories: string[], base: string) => Gate[];
export function categoryPlan(
  files: string[],
  base: string,
  gates: Gates,
  categories = categoriesForPaths(files),
): Gate[] {
  // Includes G3 regression proof and novelty through the same category registry as contrib:check.
  return gates(categories, base).filter((gate) => gate.name.startsWith("category:"));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runOffline(async () => {
    const args = parseArgs([
      { name: "base", required: true, description: "Trusted base commit for shared category gates" },
    ] as const);
    const base = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${args.base}^{commit}`], {
      encoding: "utf8",
    }).trim();
    const files = changedFiles(process.cwd(), base);
    const categories = contributionCategories(files);
    const modulePath = "../../src/lib/contrib/gates.ts";
    const { contributionGates } = (await import(modulePath)) as { contributionGates: Gates };
    const plan = categoryPlan(
      files.map((file) => file.path),
      base,
      contributionGates,
      categories,
    );
    const results = [];
    for (const gate of plan) {
      const result = spawnSync(gate.command[0]!, gate.command.slice(1), {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: gateTimeoutMs(gate.command),
      });
      results.push({ name: gate.name, exitCode: result.status });
      if (result.status !== 0)
        throw new Error(
          `${gate.name} failed: ${(result.stderr || result.error?.message || result.stdout).slice(-2000)}`,
        );
    }
    return { metadata: { categories, results } };
  });
