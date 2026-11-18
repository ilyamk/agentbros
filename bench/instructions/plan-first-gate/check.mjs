import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
const root = process.argv[2];
const result = JSON.parse(readFileSync(path.join(root,"bench-result.json"),"utf8"));
const base=path.join(root,"public/projects/bench-plan-first-gate/pipeline"); assert.ok(existsSync(path.join(base,"brief.json"))); assert.ok(!existsSync(path.join(base,"approvals/material.json"))); assert.equal(result.blocked,true);
