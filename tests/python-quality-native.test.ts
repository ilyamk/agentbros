import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

test(
  "real Blender enforces animation shapes, tuple focus targets and contact tolerance",
  { skip: process.env.RUN_BLENDER_TESTS !== "1", timeout: 120_000 },
  (t) => {
    const output = path.join("out/qa", `python-quality-${process.pid}`);
    t.after(() => rmSync(output, { recursive: true, force: true }));
    const child = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "scripts/blender-run.ts",
        "--script",
        "tests/fixtures/python-quality-blender.py",
        "--output",
        output,
        "--no-render",
      ],
      { encoding: "utf8", timeout: 110_000 },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.ok, true, JSON.stringify(result));
  },
);
