/**
 * Every library block's preview sheet is in the repository (docs/assets.md class (c)), so `library:list`, the console
 * Library page and the docs can show it. Reads the catalogue inside the test, so a missing sheet fails it by name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

test("every catalogue block has its preview sheet in the repository", () => {
  const catalogue = JSON.parse(readFileSync("docs/library/catalogue.json", "utf8")) as {
    items: { id: string; preview?: { image?: string } }[];
  };
  const missing = catalogue.items
    .filter(({ preview }) => preview?.image && !existsSync(preview.image))
    .map(({ id }) => id);
  assert.deepEqual(missing, []);
});
