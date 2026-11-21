/**
 * The Drei shot techniques (docs/drei-techniques.md) are in the generated library catalogue, each behind the
 * three-shot-techniques@1 experiment, so `library:list` shows them only to a project that enabled it. Reads the
 * catalogue inside the test, so a missing block fails this test by name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DREI = [
  "camera-path-reveal",
  "frosted-product-window",
  "gltf-clip-cue",
  "instanced-assembly",
  "product-model-stage",
  "technical-part-outline",
];

test("the catalogue gates every Drei shot technique behind its experiment", () => {
  const catalogue = JSON.parse(readFileSync("docs/library/catalogue.json", "utf8")) as {
    items: { id: string; shotTechnique?: { experiment?: string } }[];
  };
  for (const id of DREI) {
    const item = catalogue.items.find((entry) => entry.id === id);
    assert.ok(item, `${id} is in the catalogue`);
    assert.equal(item.shotTechnique?.experiment, "three-shot-techniques@1", id);
  }
});
