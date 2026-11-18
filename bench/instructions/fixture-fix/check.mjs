import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
const root = process.argv[2];
const result = JSON.parse(readFileSync(path.join(root,"bench-result.json"),"utf8"));
assert.match(readFileSync(path.join(root,"tests/fixtures/bench/seeded.mjs"),"utf8"), /export const multiply = \(a, b\) => a \* b;/);
