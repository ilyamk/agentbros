import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { FAL_CATEGORIES, FalCurationEntrySchema } from "../src/types/fal-catalog";
import { FAL_TASK_MAP, parseFalTask } from "../src/lib/models/fal-task-map";
import golden from "./fixtures/task-map/golden.json";

// When models-refresh introduces a category/role, add a meaningful concept with ru/en
// synonyms in fal-task-map.ts and a real phrasing in fixtures/task-map/golden.json.
const fix = "Add a concept to fal-task-map.ts and golden phrasing(s) to fixtures/task-map/golden.json";
test("every schema category and curation role is reachable by a concept", () => {
  const categories = new Set(FAL_TASK_MAP.flatMap((rule) => rule.categories));
  const roles = new Set(FAL_TASK_MAP.flatMap((rule) => rule.roles ?? []));
  for (const category of FAL_CATEGORIES.filter((value) => value !== "unknown"))
    assert.ok(categories.has(category), `${category}: ${fix}`);
  for (const role of FalCurationEntrySchema.shape.roles.element.options) assert.ok(roles.has(role), `${role}: ${fix}`);
  assert.equal(new Set(FAL_TASK_MAP.map((rule) => rule.id)).size, FAL_TASK_MAP.length);
  const reached = new Set(golden.flatMap((row) => parseFalTask(row.phrase).concepts));
  for (const rule of FAL_TASK_MAP)
    assert.ok(reached.has(rule.id), `${rule.id} has no reachable golden witness: ${fix}`);
});

test("every raw tracked catalogue category has a concept (refresh coverage gate)", () => {
  const covered = new Set<string>(FAL_TASK_MAP.flatMap((rule) => rule.categories));
  for (const provider of ["fal", "hf"]) {
    const directory = path.resolve(import.meta.dirname, `../src/lib/models/${provider}-catalog`);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()) {
      // Read raw strings: parsing first could normalise a new provider category to unknown.
      const catalogue = JSON.parse(readFileSync(path.join(directory, file), "utf8")) as {
        category: string;
        entries: { category: string }[];
      };
      for (const category of new Set([catalogue.category, ...catalogue.entries.map((entry) => entry.category)])) {
        // Existing unknown rows have no declared capability to map honestly.
        if (category !== "unknown") assert.ok(covered.has(category), `${provider}/${file}: ${category}. ${fix}`);
      }
    }
  }
});
