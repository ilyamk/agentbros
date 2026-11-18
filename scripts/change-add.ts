import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { CliErrorObject, parseArgs, slugify } from "../src/lib/cli";
import { DEFAULT_CATEGORIES } from "../src/lib/contrib/categories";
import { parseChangeEntry } from "../src/lib/contrib/changes";
import { runOffline } from "../src/lib/contrib/cli";
import { ChangePathSchema } from "../src/types/contrib";

void runOffline(async () => {
  const args = parseArgs([
    { name: "category", required: true, description: "Contribution category id" },
    { name: "bump", required: true, choices: ["patch", "minor", "major"], description: "Release bump" },
    { name: "summary", required: true, description: "Non-empty change summary" },
    { name: "breaking", type: "boolean", description: "Mark a breaking change" },
    { name: "migration", description: "Migration paragraph required for a breaking change" },
    { name: "author", description: "Accountable author's GitHub handle (default: unknown)" },
    { name: "harness", choices: ["claude-code", "codex", "other"], description: "Harness used" },
    { name: "slug", description: "Entry filename without .md (default: summary slug)" },
    { name: "novelty", description: "Name the existing block/playbook id and explain what is new" },
  ] as const);
  if (!DEFAULT_CATEGORIES.categories.some(({ id }) => id === args.category))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown category: ${args.category}` });
  const file = ChangePathSchema.parse(`.changes/${args.slug ?? slugify(args.summary!)}.md`);
  const author = args.author ?? "unknown";
  if (!/^@?[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(author))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Author must be a GitHub handle" });
  if (args.novelty && /[\r\n]/.test(args.novelty))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Novelty justification must be a single line" });
  const source = `---\ncategory: ${args.category}\nbump: ${args.bump}\nbreaking: ${args.breaking}\npr: 0\nauthors: [${author}]\n${args.harness ? `harness: ${args.harness}\n` : ""}${args.novelty ? `novelty: ${args.novelty}\n` : ""}---\n${args.summary!.trim()}\n${args.migration ? `\nMigration: ${args.migration.trim()}\n` : ""}`;
  parseChangeEntry(source, file);
  mkdirSync(".changes", { recursive: true });
  if (!lstatSync(".changes").isDirectory())
    throw new CliErrorObject({ code: "INVALID_INPUT", message: ".changes must be a real directory" });
  try {
    writeFileSync(file, source, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliErrorObject({ code: "FILE_EXISTS", message: `${file} already exists` });
    throw error;
  }
  return { outputs: [file] };
});
