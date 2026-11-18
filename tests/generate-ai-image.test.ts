import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const runner = path.join(repo, "node_modules/.bin/tsx");

function run(args: string[], cwd: string) {
  const env = { ...process.env };
  delete env.FAL_KEY;
  const child = spawnSync(runner, [path.join(repo, "scripts/generate-ai-image.ts"), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 1, child.stderr + child.stdout);
  return { status: child.status, envelope: JSON.parse(lines[0]!) };
}

test("generate-ai-image never falls back to Pollinations, bounds its output path and labels the licence", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ai-image-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Without FAL_KEY and without --provider, the fal path plans; Pollinations is never chosen.
  const implicit = run(["--prompt", "image", "--output", "out.png", "--dry-run"], dir);
  assert.equal(implicit.status, 0, JSON.stringify(implicit.envelope));
  assert.notEqual(implicit.envelope.metadata.provider, "pollinations");
  assert.ok(implicit.envelope.metadata.quote, "fal dry-run returns a quote");

  const explicit = run(["--prompt", "image", "--output", "out.png", "--provider", "pollinations", "--dry-run"], dir);
  assert.equal(explicit.status, 0);
  assert.equal(explicit.envelope.metadata.provider, "pollinations");
  assert.equal(explicit.envelope.metadata.licence, "unclear");
  assert.equal(explicit.envelope.metadata.prototypeOnly, true);

  for (const provider of ["pollinations", "fal"]) {
    for (const output of ["../escape.png", path.join(tmpdir(), "elsewhere.png")]) {
      const escaped = run(["--prompt", "image", "--output", output, "--provider", provider, "--dry-run"], dir);
      assert.equal(escaped.status, 1);
      assert.equal(escaped.envelope.error, "INVALID_INPUT");
      assert.match(escaped.envelope.message, /escapes/);
    }
  }
  assert.deepEqual(readdirSync(dir), []);
});
