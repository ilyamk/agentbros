/**
 * Production style cards (docs/film-styles.md): the catalogue ships with the repository and `film:style` is a
 * registered command. Reads the files inside the test, so a missing card catalogue or command fails it by name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

test("the style card catalogue and the film:style command ship together", () => {
  assert.ok(existsSync("design-reference/style-cards/catalogue.json"), "style card catalogue");
  const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["film:style"], "tsx scripts/film-style.ts");
});
