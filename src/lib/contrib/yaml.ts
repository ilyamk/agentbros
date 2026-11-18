import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import path from "node:path";

// Reuse the parser pinned transitively in the lockfile without adding a dependency.
const require = createRequire(import.meta.url);
export function parseYaml(text: string): unknown {
  const installed = readdirSync(path.resolve("node_modules/.pnpm")).find((name) => name.startsWith("js-yaml@"));
  if (!installed) throw new Error("Install the locked js-yaml dependency");
  const yaml = require(path.resolve("node_modules/.pnpm", installed, "node_modules/js-yaml")) as {
    load: (source: string) => unknown;
  };
  return yaml.load(text);
}
