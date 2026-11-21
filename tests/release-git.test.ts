/**
 * The release planner reads whole files out of git (`git show <tag>:docs/api/surface.json`, over 1 MiB since
 * 2026-11-20). execFileSync's default 1 MiB buffer failed those reads with ENOBUFS and stopped every release PR.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../src/lib/release/git";

test("release git reads return outputs larger than 1 MiB", () => {
  const root = mkdtempSync(path.join(tmpdir(), "release-git-"));
  try {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    run("init", "-q");
    const big = `${"x".repeat(99)}\n`.repeat(30_000);
    writeFileSync(path.join(root, "big.txt"), big);
    run("add", "big.txt");
    run("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "big");
    assert.equal(git(root, ["show", "HEAD:big.txt"]).length, big.trimEnd().length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
