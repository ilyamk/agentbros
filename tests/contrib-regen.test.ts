import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import path from "node:path";
import { GENERATORS, regenerate } from "../src/lib/contrib/regen";
import { temporaryRepository } from "./contrib-tools-helpers";

test("regen runs the fixed list, detects changes and is idempotent on a fixture Git tree", () => {
  const repo = temporaryRepository();
  try {
    repo.write(
      "package.json",
      JSON.stringify({ scripts: Object.fromEntries(GENERATORS.map((command) => [command[1], "fixture"])) }),
    );
    repo.write(".env", "This file must never be opened\n");
    const calls: string[][] = [];
    const runner = (command: string[]) => {
      calls.push(command);
      repo.write(`generated/${command[1]!.replace(/:/g, "-")}.md`, `${command.join(" ")}\n`);
      return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
    };
    const first = regenerate(repo.root, runner);
    assert.deepEqual(calls, GENERATORS);
    assert.equal(first.changed.length, GENERATORS.length);
    assert.deepEqual(first.skipped, []);
    assert.deepEqual(regenerate(repo.root, runner).changed, []);
    repo.write("package.json", '{"scripts":{}}');
    assert.deepEqual(regenerate(repo.root, runner).skipped, ["credits:write-doc", "deps:licences"]);
  } finally {
    repo.dispose();
  }
});
test("regen stops on generator failure and still reports files changed before failure", () => {
  const repo = temporaryRepository();
  try {
    repo.write("package.json", '{"scripts":{}}');
    const result = regenerate(repo.root, (command) => {
      repo.write("generated.md", "changed\n");
      return { exitCode: command[1] === "playbook" ? 2 : 0, stdout: "", stderr: "fixture failure" };
    });
    assert.equal(result.gates.length, 2);
    assert.equal(result.gates[1]!.exitCode, 2);
    assert.deepEqual(result.changed, ["generated.md"]);
  } finally {
    repo.dispose();
  }
});
test("regen CLI help and runner failure use the JSON contract without a network dependency", () => {
  const repo = temporaryRepository();
  try {
    repo.write("package.json", '{"scripts":{}}');
    repo.write("bin/pnpm", "#!/bin/sh\nexit 9\n");
    chmodSync(path.join(repo.root, "bin/pnpm"), 0o755);
    repo.env.PATH = `${path.join(repo.root, "bin")}:${repo.env.PATH}`;
    const result = repo.cli("regen");
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(JSON.parse(result.stdout).metadata.gates[0].exitCode, 9);
    repo.write("bin/pnpm", "#!/bin/sh\nexit 0\n");
    const success = repo.cli("regen");
    assert.equal(success.status, 0, success.stdout + success.stderr);
    assert.equal(JSON.parse(success.stdout).metadata.gates.length, GENERATORS.length - 2);
    assert.equal(JSON.parse(repo.cli("regen", "--help").stdout).metadata.help, true);
  } finally {
    repo.dispose();
  }
});
