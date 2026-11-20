/**
 * The console step rail (apps/console/components/step-rail, docs/console-steps.md) maps every step status to one
 * motion, and its legend names every motion in each console language. The console bundles its own TypeScript paths,
 * so this reads the sources instead of importing them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STEP_STATUSES } from "../src/types/console";

const model = readFileSync("apps/console/components/step-rail/model.ts", "utf8");

const motions = (): string[] => {
  const list = /export const MOTIONS = \[([^\]]+)\] as const;/u.exec(model)?.[1];
  assert.ok(list, "model.ts declares MOTIONS");
  return [...list.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
};

test("the step rail maps every step status to a declared motion", () => {
  const body = /export function stepMotion\([\s\S]*?\n\}\n/u.exec(model)?.[0];
  assert.ok(body, "model.ts declares stepMotion");
  const cases = new Set([...body.matchAll(/case "([^"]+)":/gu)].map((match) => match[1]!));
  assert.deepEqual(
    [...STEP_STATUSES].filter((status) => !cases.has(status)),
    [],
  );
  const returned = [...body.matchAll(/return ([^;]+);/gu)].flatMap((match) =>
    [...match[1]!.matchAll(/"([^"]+)"/gu)].map((value) => value[1]!),
  );
  assert.ok(returned.length > 0);
  for (const motion of returned) assert.ok(motions().includes(motion), motion);
});

test("the step rail legend names every motion in every console language", () => {
  for (const language of ["en", "ru", "zh-Hans"]) {
    const source = readFileSync(`apps/console/i18n/${language}.ts`, "utf8");
    const legend = /stepRail: \{[\s\S]*?motions: \{([\s\S]*?)\n {4}\},/u.exec(source)?.[1];
    assert.ok(legend, `${language}: stepRail.motions`);
    for (const motion of motions())
      assert.match(legend, new RegExp(`\\n\\s+${motion}:`, "u"), `${language}: ${motion}`);
  }
});
