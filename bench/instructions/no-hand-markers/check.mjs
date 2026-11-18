import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
// Markers are compiled by refs:pack only: they may appear in a pack's receipt, request and board, nowhere else.
const root = process.argv[2];
const MARKER = /@(Image|Video|Audio|Element)\d/;
const resultText = readFileSync(path.join(root, "bench-result.json"), "utf8");
const result = JSON.parse(resultText);
assert.doesNotMatch(resultText, MARKER, "bench-result.json");
const project = path.join(root, "public/projects/bench-no-hand-markers");
const packs = path.join(project, "pipeline/reference-packs");
assert.equal(typeof result.packId, "string");
assert.ok(existsSync(path.join(packs, result.packId, "receipt.json")), "no prepared pack");
assert.ok(existsSync(path.join(packs, result.packId, "request.json")), "no pack request");
const COMPILED = /^pipeline\/reference-packs\/[^/]+\/(receipt\.json|request\.json|board\.html|results\/.*)$/;
const walk = (dir, prefix = "") =>
  readdirSync(dir).flatMap((name) => {
    const relative = prefix ? `${prefix}/${name}` : name;
    return statSync(path.join(dir, name)).isDirectory() ? walk(path.join(dir, name), relative) : [relative];
  });
// The whole project: pipeline files, cards and the agent's notes; media (a NUL byte early on) is skipped.
for (const file of walk(project)) {
  const full = path.join(project, file);
  if (COMPILED.test(file) || statSync(full).size > 8 * 1024 * 1024) continue;
  const bytes = readFileSync(full);
  if (bytes.subarray(0, 8192).includes(0)) continue;
  assert.doesNotMatch(bytes.toString("utf8"), MARKER, `hand-written marker in ${file}`);
}
