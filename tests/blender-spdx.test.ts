/**
 * The GPL boundary (NOTICE.md, "Blender code under GPL-3.0-or-later"): every tracked Python file of ours that imports
 * `bpy` runs inside Blender and must start with the GPL-3.0-or-later SPDX header. Vendored upstream files keep their
 * own bytes and licence evidence (vendor/vork-blender/PROVENANCE.json) and are not checked here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const HEADER = "# SPDX-License-Identifier: GPL-3.0-or-later";

test("every tracked Python file of ours that imports bpy carries the GPL-3.0-or-later header on line 1", () => {
  const files = execFileSync("git", ["ls-files", "-z", "--", "*.py"], { cwd: REPO, encoding: "utf8" })
    .split("\0")
    .filter((file) => file && !file.startsWith("vendor/"));
  const bpy = files.filter((file) =>
    /^\s*(?:import bpy\b|from bpy\b)/m.test(readFileSync(path.join(REPO, file), "utf8")),
  );
  assert.ok(bpy.length > 50, `found ${bpy.length} bpy files; the scan is broken`);
  const missing = bpy.filter((file) => readFileSync(path.join(REPO, file), "utf8").split("\n")[0] !== HEADER);
  assert.deepEqual(missing, []);
});
