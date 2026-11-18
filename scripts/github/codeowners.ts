import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "../../src/lib/cli";
import { runOffline } from "../../src/lib/contrib/cli";
export function codeowners(paths: string[]): string {
  const patterns = [
    ...new Set(
      paths.map((pattern) => {
        if (!pattern || /[\s!#\\[\]]/.test(pattern)) throw new Error(`Unsupported CODEOWNERS pattern: ${pattern}`);
        return pattern.startsWith("**/") ? pattern : `/${pattern}`;
      }),
    ),
  ];
  return (
    "# Generated from contrib/protected.json by pnpm github:codeowners; do not edit.\n" +
    patterns.map((pattern) => `${pattern} @ilyamk`).join("\n") +
    "\n"
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runOffline(async () => {
    const args = parseArgs([
      { name: "check", type: "boolean", description: "Fail if .github/CODEOWNERS differs from contrib/protected.json" },
    ] as const);
    const output = codeowners(
      (JSON.parse(readFileSync("contrib/protected.json", "utf8")) as { paths: string[] }).paths,
    );
    if (args.check) {
      if (readFileSync(".github/CODEOWNERS", "utf8") !== output)
        throw new Error("CODEOWNERS is stale; run github:codeowners");
    } else writeFileSync(".github/CODEOWNERS", output);
    return { outputs: [".github/CODEOWNERS"], metadata: { checked: args.check } };
  });
