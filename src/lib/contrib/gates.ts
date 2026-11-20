import type { CategoriesFile } from "../../types/contrib";
import { categoriesForPaths, DEFAULT_CATEGORIES } from "./categories";
import { parseChangeEntry } from "./changes";
import type { ChangedFile } from "./intake";

export interface ContributionGate {
  name: string;
  command: string[];
}
/** Shared ordered list for local execution and CI workflow generation/consistency tests. */
export const COMMON_GATES: readonly ContributionGate[] = [
  { name: "lint", command: ["pnpm", "lint"] },
  { name: "typecheck", command: ["pnpm", "typecheck"] },
  { name: "test:fast", command: ["pnpm", "test:fast"] },
  { name: "context:budget", command: ["pnpm", "context:budget", "--base"] },
  { name: "instructions:lint", command: ["pnpm", "instructions:lint"] },
  { name: "instructions:security", command: ["pnpm", "instructions:security", "--base"] },
  { name: "leak:check", command: ["pnpm", "leak:check", "--mode", "diff", "--base"] },
  { name: "api:surface", command: ["pnpm", "api:surface", "--check"] },
];
export function contributionGates(
  categories: string[],
  base: string,
  body?: string,
  context?: string,
  config: CategoriesFile = DEFAULT_CATEGORIES,
): ContributionGate[] {
  const intake = {
    name: "contrib:intake",
    command: [
      "pnpm",
      "contrib:intake",
      "--base",
      base,
      "--head",
      "HEAD",
      ...(body ? ["--body", body] : []),
      ...(context ? ["--context", context] : []),
    ],
  };
  const seen = new Set<string>();
  const categoryGates: ContributionGate[] = [];
  for (const category of config.categories.filter((row) => categories.includes(row.id)))
    for (const text of category.gates) {
      // Commands in the trusted registry are simple literal argument lists, never shell programmes.
      if (!/^pnpm [\w:./-]+(?: [\w:./=-]+)*$/.test(text)) throw new Error(`Unsupported category gate: ${text}`);
      if (!seen.has(text)) {
        seen.add(text);
        const command = text.split(" ");
        if (["contrib:fails-on-base", "contrib:novelty"].includes(command[1]!)) command.push("--base", base);
        categoryGates.push({ name: `category:${text.slice(5)}`, command });
      }
    }
  return [
    intake,
    ...categoryGates,
    ...COMMON_GATES.map((gate) => ({
      name: gate.name,
      command: [...gate.command, ...(gate.command.at(-1) === "--base" ? [base] : [])],
    })),
  ];
}

export function contributionCategories(
  files: ChangedFile[],
  requested?: string,
  config: CategoriesFile = DEFAULT_CATEGORIES,
): string[] {
  const entries = files.filter(
    (file) => file.status === "A" && file.path !== ".changes/README.md" && /^\.changes\/[^/]+\.md$/.test(file.path),
  );
  let declared: string | undefined;
  if (entries.length === 1) {
    try {
      declared = parseChangeEntry(entries[0]!.content ?? "", entries[0]!.path).category;
    } catch {
      /* Intake reports invalid entries. */
    }
  }
  if (requested && !config.categories.some((row) => row.id === requested))
    throw new Error(`Unknown category: ${requested}`);
  if (requested && declared && requested !== declared)
    throw new Error("Category flag disagrees with the change entry.");
  const category = requested ?? declared;
  if (category) return [category];
  // Catch-all categories (fix, security: paths "**") would match every change, so they apply only when a change entry
  // declares them. Without one (Dependabot, release and models-refresh bot routes), paths alone pick the categories.
  const specific = { ...config, categories: config.categories.filter(({ paths }) => !paths.includes("**")) };
  return categoriesForPaths(
    files.map((file) => file.path),
    specific,
  );
}
