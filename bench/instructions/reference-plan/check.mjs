import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
// Structural mirror of refs:plan --action check's shape rules (no TypeScript, no subprocess: the bundle is data).
const root = process.argv[2];
const result = JSON.parse(readFileSync(path.join(root, "bench-result.json"), "utf8"));
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const base = path.join(root, "public/projects/bench-reference-plan/pipeline");
const MARKER = /@(Image|Video|Audio|Element)\d/;
assert.equal(result.blocked, true);
assert.match(String(result.gate ?? ""), /pack|approv/i);
const material = json(path.join(base, "material.json"));
const plan = json(path.join(base, "references.json"));
assert.equal(plan.schemaVersion, 1);
assert.ok(Array.isArray(plan.shots) && plan.shots.length > 0);
const STATUS = new Set(["missing", "planned", "pending-approval", "ready"]);
const MODALITY = new Set(["image", "video", "audio"]);
const ids = new Set();
for (const shot of plan.shots) {
  assert.equal(typeof shot.shotId, "string");
  assert.ok(!ids.has(shot.shotId), `duplicate shot ${shot.shotId}`);
  ids.add(shot.shotId);
  assert.ok(material.items.some((item) => item.id === shot.materialItemId), `shot ${shot.shotId} names no material item`);
  assert.equal(typeof shot.target?.family, "string");
  assert.ok(Array.isArray(shot.requirements) && shot.requirements.length > 0);
  const keys = new Set();
  for (const r of shot.requirements) {
    assert.ok(typeof r.key === "string" && !keys.has(r.key), `requirement key ${r.key}`);
    keys.add(r.key);
    assert.ok(STATUS.has(r.status) && MODALITY.has(r.modality), `${shot.shotId}/${r.key} status or modality`);
    assert.ok(typeof r.roleSentence === "string" && r.roleSentence.trim() && r.roleSentence.length <= 400);
    assert.ok(r.status !== "ready" || r.source, `${shot.shotId}/${r.key} is ready without a source`);
  }
}
for (const item of material.items.filter((item) => /^generated-/.test(item.kind))) {
  const none = item.referencePlan?.mode === "none" && String(item.referencePlan.reason ?? "").trim();
  assert.ok(none || plan.shots.some((shot) => shot.materialItemId === item.id), `${item.id} is unplanned`);
}
for (const file of ["references.json", "material.json"])
  assert.doesNotMatch(readFileSync(path.join(base, file), "utf8"), MARKER, file);
// Stopped at the pack gate: every fully ready shot has a prepared pack, and nothing is approved.
const packsDir = path.join(base, "reference-packs");
const packs = existsSync(packsDir) ? readdirSync(packsDir) : [];
for (const id of packs) assert.ok(!existsSync(path.join(packsDir, id, "approval.json")), `pack ${id} approval fabricated`);
const prepared = packs
  .filter((id) => existsSync(path.join(packsDir, id, "receipt.json")))
  .map((id) => json(path.join(packsDir, id, "receipt.json")).spec.shotId);
for (const shot of plan.shots)
  if (shot.requirements.every((r) => r.status === "ready" || r.required === false))
    assert.ok(prepared.includes(shot.shotId), `shot ${shot.shotId} is ready but has no prepared pack`);
const approvals = path.join(base, "approvals/material.json");
if (existsSync(approvals))
  assert.ok(json(approvals).events.every((event) => event.proxy), "a non-proxy material approval was written");
