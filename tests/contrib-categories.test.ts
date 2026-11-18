import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CategoriesFileSchema, CategorySchema, ProtectedPathsSchema } from "../src/types/contrib";
import {
  categoriesForPath,
  categoriesForPaths,
  DEFAULT_CATEGORIES,
  DEFAULT_PROTECTED,
  loadCategories,
  matchesPath,
} from "../src/lib/contrib/categories";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
test("twenty unique categories validate and every tracked path maps", () => {
  assert.equal(DEFAULT_CATEGORIES.categories.length, 20);
  assert.deepEqual(loadCategories("contrib/categories.json"), DEFAULT_CATEGORIES);
  for (const file of tracked) assert.ok(categoriesForPath(file).length, file);
  assert.equal(
    CategoriesFileSchema.safeParse({
      version: 1,
      categories: [DEFAULT_CATEGORIES.categories[0], DEFAULT_CATEGORIES.categories[0]],
    }).success,
    false,
  );
  assert.equal(CategorySchema.safeParse({ ...DEFAULT_CATEGORIES.categories[0], extra: true }).success, false);
  assert.ok(ProtectedPathsSchema.safeParse(DEFAULT_PROTECTED).success);
});
test("every category glob matches current tracked material and gates exist", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  for (const category of DEFAULT_CATEGORIES.categories) {
    for (const glob of category.paths)
      assert.ok(
        tracked.some((file) => matchesPath(file, [glob])),
        `${category.id}: ${glob}`,
      );
    for (const gate of category.gates) {
      assert.match(gate, /^pnpm [\w:-]+$/);
      assert.ok(Object.hasOwn(scripts, gate.slice(5)), gate);
    }
  }
});
test("matching includes dot paths, root instructions and specific category paths", () => {
  assert.ok(categoriesForPath(".agents/skills/example/SKILL.md").some(({ id }) => id === "agent-skill"));
  assert.ok(categoriesForPaths(["AGENTS.md", "src/templates/Text.tsx"]).includes("instructions"));
  assert.ok(categoriesForPaths(["src/templates/Text.tsx"]).includes("template"));
  for (const file of [
    "AGENTS.md",
    "x/AGENTS.md",
    "CLAUDE.md",
    ".mcp.json",
    ".claude/settings.json",
    ".github/trust.json",
    ".github/workflows/ci.yml",
    "x/hooks/pre-push",
    "LICENSE",
    "CLA.md",
    "COMMERCIAL-LICENSE.md",
    "contrib/categories.json",
    "contrib/protected.json",
    "scripts/new.ts",
    "src/lib/providers/a.ts",
    "src/lib/budget/a.ts",
    "src/lib/jobs/a.ts",
    "package.json",
    ".agents/skills/creative-studio/references/creative-rubric-v1.md",
  ])
    assert.ok(matchesPath(file, DEFAULT_PROTECTED.paths), file);
});
