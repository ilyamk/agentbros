import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, runScript } from "../src/lib/cli";
import { buildCatalogue, CATALOGUE_PATH } from "../src/lib/library/catalogue";

void runScript(async () => {
  parseArgs([] as const);
  const { loadLibrary } = await import("../src/lib/library/load");
  const { items, styles } = await loadLibrary();
  const catalogue = buildCatalogue(items, styles);
  mkdirSync(path.dirname(CATALOGUE_PATH), { recursive: true });
  writeFileSync(CATALOGUE_PATH, `${JSON.stringify(catalogue, null, 1)}\n`);
  return { outputs: [CATALOGUE_PATH], metadata: { items: catalogue.items.length, styles: catalogue.styles.length } };
});
