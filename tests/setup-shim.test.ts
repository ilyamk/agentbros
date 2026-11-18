/**
 * setup.sh on a machine with no usable Node: a fake old `node`, an empty HOME
 * and a PATH of system basics only, so nothing real is installed or probed.
 * setup.ps1 has no runner here (no PowerShell in CI); it is checked only for the
 * flags SETUP.md promises.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";

const unix = process.platform !== "win32";

function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), "setup-shim-"));
  const repo = path.join(root, "repo"),
    bin = path.join(root, "bin"),
    home = path.join(root, "home");
  for (const directory of [repo, bin, home]) mkdirSync(directory, { recursive: true });
  for (const file of ["setup.sh", "package.json", ".nvmrc"]) copyFileSync(file, path.join(repo, file));
  writeFileSync(path.join(bin, "node"), "#!/bin/sh\necho 20.11.0\n");
  chmodSync(path.join(bin, "node"), 0o755);
  const run = (...args: string[]) =>
    spawnSync("bash", [path.join(repo, "setup.sh"), ...args], {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
    });
  return { run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("setup.sh plans prerequisites as one JSON line and changes nothing", { skip: !unix }, () => {
  const { run, cleanup } = sandbox();
  try {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split("\n");
    assert.equal(lines.length, 1);
    const envelope = JSON.parse(lines[0]!);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.metadata.stage, "prerequisites");
    const step = (id: string) => envelope.metadata.steps.find((item: { id: string }) => item.id === id);
    assert.notEqual(step("node").state, "done", "Node 20 is not a supported runtime");
    assert.equal(step("install").scope, "repo");
    assert.equal(step("install").state, "todo");
    assert.ok(envelope.metadata.needsConsent.includes("node"));
    for (const item of envelope.metadata.steps) assert.ok(["repo", "user", "system"].includes(item.scope));
    assert.match(result.stderr, /prerequisites/);
  } finally {
    cleanup();
  }
});

test("setup.sh --apply with no Node manager stops with a fix, not a guess", { skip: !unix }, () => {
  const { run, cleanup } = sandbox();
  try {
    const result = run("--apply");
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error, "VALIDATION");
    assert.match(envelope.message, /Node|Homebrew/);
  } finally {
    cleanup();
  }
});

test("setup.sh --help answers with the JSON contract", { skip: !unix }, () => {
  const { run, cleanup } = sandbox();
  try {
    const result = run("--help");
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()).metadata, { help: true });
    assert.match(result.stderr, /--apply --system/);
  } finally {
    cleanup();
  }
});

test("setup.sh passes shellcheck when it is installed", { skip: !unix }, (t) => {
  const check = spawnSync("shellcheck", ["setup.sh"], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  if (check.error) return t.skip("shellcheck not installed");
  assert.equal(check.status, 0, check.stdout);
});

test("setup.ps1 offers the switches SETUP.md documents", () => {
  const script = readFileSync("setup.ps1", "utf8");
  for (const name of ["Apply", "System", "Assets", "Smoke", "Goal"]) assert.match(script, new RegExp(`\\$${name}\\b`));
  const guide = readFileSync("SETUP.md", "utf8");
  for (const usage of ["./setup.ps1", "-Apply", "-System", "./setup.sh --apply --system"])
    assert.ok(guide.includes(usage), usage);
});
