/**
 * The DesignBookmark-inspired blocks are in the generated library catalogue, and the five production UI blocks offer
 * a transparent ground so they can be laid over footage (src/motion/library/AGENTS.md). Reads the catalogue inside the
 * test, so a missing block fails this test by name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BLOCKS = [
  "ui-state-morph",
  "ui-swipe-deck",
  "glass-lens",
  "page-turn",
  "kinetic-binary-text",
  "bars-form-number",
  "ui-inspector-geometry",
  "ui-accept-revision",
  "ui-evidence-scroll",
  "ui-variation-select",
  "ui-device-handoff",
];

test("the catalogue lists the DesignBookmark-inspired blocks", () => {
  const catalogue = JSON.parse(readFileSync("docs/library/catalogue.json", "utf8")) as { items: { id: string }[] };
  const ids = new Set(catalogue.items.map(({ id }) => id));
  assert.deepEqual(
    BLOCKS.filter((id) => !ids.has(id)),
    [],
  );
});
