import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
const root = process.argv[2];
const result = JSON.parse(readFileSync(path.join(root,"bench-result.json"),"utf8"));
assert.deepEqual(result,{humanGate:"blocked",proxy:"benchmark"});
