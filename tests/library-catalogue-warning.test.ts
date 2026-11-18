import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { catalogueWarning, librarySourceHash } from "../src/lib/library/catalogue";

const fixture = (t: test.TestContext) => {
  const dir = mkdtempSync(path.join(tmpdir(), "catalogue-warning-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = path.join(dir, "library");
  mkdirSync(path.join(library, "ui"), { recursive: true });
  writeFileSync(path.join(library, "ui", "Block.tsx"), "export const Block = 1;\n");
  writeFileSync(path.join(library, "AGENTS.md"), "# Rules\n");
  const catalogue = path.join(dir, "catalogue.json");
  writeFileSync(
    catalogue,
    JSON.stringify({ version: 1, sourceHash: librarySourceHash([library]), items: [], styles: [] }),
  );
  return { library, catalogue, roots: [library] };
};

test("editing AGENTS.md or touching a source without changing it does not warn", (t) => {
  const { library, catalogue, roots } = fixture(t);
  writeFileSync(path.join(library, "AGENTS.md"), "# Rules\n\nA new rule.\n");
  const later = new Date(Date.now() + 60_000);
  utimesSync(path.join(library, "ui", "Block.tsx"), later, later);
  assert.equal(catalogueWarning(catalogue, roots), undefined);
});

test("a changed, added or removed source file warns", (t) => {
  const { library, catalogue, roots } = fixture(t);
  writeFileSync(path.join(library, "ui", "Block.tsx"), "export const Block = 2;\n");
  assert.match(catalogueWarning(catalogue, roots) ?? "", /library:catalogue/);
  writeFileSync(path.join(library, "ui", "Block.tsx"), "export const Block = 1;\n");
  assert.equal(catalogueWarning(catalogue, roots), undefined);
  writeFileSync(path.join(library, "ui", "Other.ts"), "export const other = 1;\n");
  assert.ok(catalogueWarning(catalogue, roots));
});

test("a missing catalogue or one without a source hash warns", (t) => {
  const { catalogue, roots } = fixture(t);
  assert.match(catalogueWarning(`${catalogue}.absent`, roots) ?? "", /missing/);
  writeFileSync(catalogue, JSON.stringify({ version: 1, items: [], styles: [] }));
  assert.ok(catalogueWarning(catalogue, roots));
});
