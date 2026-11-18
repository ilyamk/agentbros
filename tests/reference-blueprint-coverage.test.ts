import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { blueprintCoverageIssues, validateReference } from "../src/lib/reference/library";
import { ReferenceBlueprintSchema, ReferenceEditSchema, type ReferenceBlueprint } from "../src/types/reference";

const slot = (id: string, startSec: number, durationSec: number) => ({
  id,
  role: "role",
  startSec,
  durationSec,
  visualRecipe: "v",
  motionRecipe: "m",
  soundRecipe: "s",
  techniqueIds: [],
});

function blueprint(slots: ReturnType<typeof slot>[], durationSec = 10): ReferenceBlueprint {
  return ReferenceBlueprintSchema.parse({
    schemaVersion: 1,
    referenceId: "film",
    format: { width: 1920, height: 1080, fps: 30 },
    durationSec,
    slots,
    rhythm: { cutGrid: "free" },
    style: "s",
    transferRules: { keep: [], mustChange: [] },
  });
}

test("slots that fill the film pass, whatever order they are written in", () => {
  assert.deepEqual(blueprintCoverageIssues(blueprint([slot("b", 4, 6), slot("a", 0, 4)])), []);
});

test("differences of up to 0.1 s are allowed", () => {
  assert.deepEqual(
    blueprintCoverageIssues(blueprint([slot("a", 0.1, 3.9), slot("b", 4.1, 5.9), slot("c", 9.95, 0.1)]), 10),
    [],
  );
});

test("gaps, overlaps and missing ends are named", () => {
  const [gap] = blueprintCoverageIssues(blueprint([slot("a", 0, 4), slot("b", 4.5, 5.5)]));
  assert.match(gap!, /gap of 0\.500 s between a and b/);
  const [overlap] = blueprintCoverageIssues(blueprint([slot("a", 0, 5), slot("b", 4.5, 5.5)]));
  assert.match(overlap!, /overlap of 0\.500 s between a and b/);
  assert.match(blueprintCoverageIssues(blueprint([slot("a", 1, 9)]))[0]!, /first slot a starts at 1\.000/);
  assert.match(blueprintCoverageIssues(blueprint([slot("a", 0, 8)]))[0]!, /last slot a ends at 8\.000/);
});

test("the blueprint must match the film, not only itself", () => {
  const issues = blueprintCoverageIssues(blueprint([slot("a", 0, 10)]), 12);
  assert.ok(issues.some((issue) => /differs from the film's 12\.000/.test(issue)));
  assert.ok(issues.some((issue) => /ends at 10\.000 s, the film at 12\.000/.test(issue)));
});

test("edit corrections are optional and reject an unknown kind", () => {
  const claim = (value: unknown) => ({ value, basis: "observed", confidence: 0.9, evidence: [] });
  const edit = { schemaVersion: 1, referenceId: "film", rhythm: claim("r"), shots: [] };
  assert.deepEqual(ReferenceEditSchema.parse(edit).corrections, []);
  const correction = { kind: "split", shotIds: ["s001"], timeSec: 1, transition: "cut", note: "n" };
  assert.equal(ReferenceEditSchema.parse({ ...edit, corrections: [claim(correction)] }).corrections.length, 1);
  assert.equal(
    ReferenceEditSchema.safeParse({ ...edit, corrections: [claim({ ...correction, kind: "guess" })] }).success,
    false,
  );
  assert.equal(
    ReferenceEditSchema.safeParse({ ...edit, corrections: [claim({ ...correction, shotIds: [] })] }).success,
    false,
  );
});

test("ref:validate reports a blueprint with holes as invalid", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "blueprint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "film");
  mkdirSync(directory);
  writeFileSync(path.join(directory, "blueprint.json"), JSON.stringify(blueprint([slot("a", 0, 4), slot("b", 6, 4)])));
  const broken = validateReference(directory);
  assert.equal(broken.invalid[0]?.file, "blueprint.json");
  assert.match(broken.invalid[0]!.issues[0]!, /gap of 2\.000 s/);
  writeFileSync(path.join(directory, "blueprint.json"), JSON.stringify(blueprint([slot("a", 0, 4), slot("b", 4, 6)])));
  const fixed = validateReference(directory);
  assert.deepEqual(fixed.invalid, []);
  assert.ok(fixed.valid.includes("blueprint.json"));
});
