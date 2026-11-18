import { parseArgs, runScript } from "../src/lib/cli";
import { addShowcase } from "../src/lib/showcase/add";
void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    { name: "slug", required: true, description: "Public showcase slug" },
    { name: "author", required: true, description: "GitHub handle" },
    { name: "link", description: "HTTPS film link" },
    { name: "out", description: "Entry parent directory (default showcases)" },
    { name: "harness", choices: ["claude-code", "codex"], description: "Declared harness" },
    { name: "model", description: "Declared model" },
    { name: "rights", description: "Author declaration of material and publication rights" },
    { name: "licence", description: "Entry text licence declared by author" },
    { name: "skip-media", type: "boolean", description: "Build metadata only; media remains pending" },
  ] as const);
  return addShowcase({
    ...args,
    project: args.project!,
    slug: args.slug!,
    author: args.author!,
    harness: args.harness as "claude-code" | "codex" | undefined,
    skipMedia: args["skip-media"],
  });
});
