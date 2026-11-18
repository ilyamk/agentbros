import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { memoryDir } from "../src/lib/memory";

const REPO = path.resolve(import.meta.dirname, "..");
const REAL = path.join(REPO, "memory");

test("every test process has its own memory root outside the checkout", () => {
  const root = process.env.AGENTBROS_MEMORY_ROOT;
  assert.ok(
    root,
    "tests/helpers/memory-root.ts sets AGENTBROS_MEMORY_ROOT; run tests through pnpm test or pnpm test:fast",
  );
  assert.ok(path.isAbsolute(root));
  assert.ok(!path.resolve(root).startsWith(`${REPO}${path.sep}`), root);
  assert.equal(memoryDir(), path.resolve(root));
  assert.equal(memoryDir(REPO), path.resolve(root), "the variable wins over a root argument");
});

test("a command spawned with the inherited environment writes the temporary root, not the checkout's memory/", (t) => {
  if (!process.env.AGENTBROS_MEMORY_ROOT)
    return t.skip(
      "run through pnpm test or pnpm test:fast: without tests/helpers/memory-root.ts this would write the checkout's memory/",
    );
  const before = readdirSync(REAL).sort();
  const run = spawnSync(
    process.execPath,
    [
      path.join(REPO, "node_modules/tsx/dist/cli.mjs"),
      "-e",
      "import { recordMetric } from './src/lib/memory/index.ts'; recordMetric({ at: new Date().toISOString(), project: 'isolation', event: 'round' })",
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readdirSync(REAL).sort(), before);
  assert.ok(readdirSync(process.env.AGENTBROS_MEMORY_ROOT!).includes("metrics.jsonl"));
});
