import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { codeowners } from "../scripts/github/codeowners";

test("CODEOWNERS is generated from every protected path with the maintainer owner", () => {
  const config = JSON.parse(readFileSync("contrib/protected.json", "utf8")) as { paths: string[] };
  assert.equal(readFileSync(".github/CODEOWNERS", "utf8"), codeowners(config.paths));
  assert.match(codeowners(["**/AGENTS.md", ".github/**"]), /\*\*\/AGENTS.md @ilyamk\n\/\.github\/\*\* @ilyamk/);
  assert.equal(codeowners(["scripts/**", "scripts/**"]).match(/@ilyamk/g)?.length, 1);
  assert.throws(() => codeowners(["!private"]));
});
test("codeowners CLI writes, checks and detects stale output in an isolated tree", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "github-codeowners-"));
  const script = path.resolve("scripts/github/codeowners.ts");
  const tsx = path.resolve("node_modules/tsx/dist/loader.mjs");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", tsx, script, ...args], {
      cwd: dir,
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
      encoding: "utf8",
    });
  try {
    mkdirSync(path.join(dir, "contrib"));
    mkdirSync(path.join(dir, ".github"));
    writeFileSync(path.join(dir, "contrib/protected.json"), JSON.stringify({ paths: ["scripts/**"] }));
    assert.equal(run().status, 0);
    assert.equal(run("--check").status, 0);
    writeFileSync(path.join(dir, ".github/CODEOWNERS"), "stale");
    const result = run("--check");
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
