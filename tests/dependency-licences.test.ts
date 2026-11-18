import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildLicenceInventory, writeLicenceInventory } from "../src/lib/contrib/licences";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "licence-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  write("contrib/licence-allowlist.json", JSON.stringify({ allowed: ["MIT"], review: ["MPL-2.0"] }));
  write(
    "pnpm-lock.yaml",
    "packages:\n  example@1.0.0:\n    resolution: {integrity: sha512-example}\n  platform@1.0.0: {}\n",
  );
  write(
    "node_modules/example/package.json",
    JSON.stringify({
      name: "example",
      version: "1.0.0",
      license: "MIT",
      author: "Example Author",
      repository: "https://example.invalid/source",
      scripts: { install: "exit 99" },
    }),
  );
  write("node_modules/example/LICENSE", "Copyright Example Author\nMIT licence text fixture\n");
  write("node_modules/example/NOTICE", "Example notice\n");
  write("node_modules/example/licenses/inherited.txt", "Inherited licence text\n");
  write(
    "credits/example.json",
    JSON.stringify({
      source: "External tool",
      url: "https://example.invalid/tool",
      licence: "Unknown model weights",
      whatWeTook: "Invoked separately",
    }),
  );
  write("vendor/example/LICENSE", "Vendored licence text\n");
  write("vendor/example/provenance.json", JSON.stringify({ revision: "pinned-revision" }));
  write("tests/fixtures/hyperframes-engine/notices/acorn-LICENSE", "MIT Acorn fixture\n");
  return { root, write };
}

test("collects exact package notices and external evidence, preserves gaps and deduplicates text", (t) => {
  const { root, write } = fixture(t);
  write("node_modules/example/COPYING", "Example notice\n");
  const inventory = buildLicenceInventory(root, true);
  assert.equal(inventory.packages.length, 2);
  const pkg = inventory.packages[0]!;
  assert.equal(pkg.status, "allowed");
  assert.equal(pkg.evidence?.author, "Example Author");
  assert.deepEqual(
    pkg.evidence?.files.map((file) => file.file),
    ["COPYING", "LICENSE", "NOTICE", "licenses/inherited.txt"],
  );
  assert.equal(Object.keys(inventory.texts).length, 3);
  assert.equal(inventory.packages[1]!.status, "missing");
  assert.equal(inventory.sources.length, 4);
  assert.ok(inventory.sources.some((source) => source.file.endsWith("notices/acorn-LICENSE")));
  assert.match(inventory.sources.find((source) => source.kind === "credit")!.content, /Unknown model weights/);
  assert.ok(!JSON.stringify(inventory).includes(root));
});

test("freshness detects new lock entries, policy changes, registered sources and installed notices", (t) => {
  const { root, write } = fixture(t);
  assert.equal(writeLicenceInventory(root, false).unresolvedPackages, 1);
  assert.equal(writeLicenceInventory(root, true).checked, true);
  write("node_modules/example/NOTICE", "Changed notice\n");
  assert.throws(() => writeLicenceInventory(root, true), /Installed licence evidence changed/);
  writeLicenceInventory(root, false);
  write("credits/another.json", JSON.stringify({ source: "Another", url: "https://example.invalid", licence: "MIT" }));
  assert.throws(() => writeLicenceInventory(root, true), /stale/);
  writeLicenceInventory(root, false);
  write("contrib/licence-allowlist.json", JSON.stringify({ allowed: [], review: ["MIT"] }));
  assert.throws(() => writeLicenceInventory(root, true), /stale/);
  writeLicenceInventory(root, false);
  write("pnpm-lock.yaml", "packages:\n  new-package@2.0.0: {}\n");
  assert.throws(() => writeLicenceInventory(root, true), /stale/);
});

test("checks are portable; saved evidence is retained only for matching lock-entry fingerprints", (t) => {
  const { root, write } = fixture(t);
  writeLicenceInventory(root, false);
  rmSync(path.join(root, "node_modules"), { recursive: true });
  assert.equal(writeLicenceInventory(root, true).packages, 2);
  assert.equal(buildLicenceInventory(root, true).packages[0]!.status, "allowed");
  write("pnpm-lock.yaml", "packages:\n  example@1.0.0:\n    resolution: {integrity: sha512-changed}\n");
  assert.equal(buildLicenceInventory(root, true).packages[0]!.status, "missing");
});

test("strict validation blocks gaps and review licences; saved text corruption fails closed", (t) => {
  const { root, write } = fixture(t);
  writeLicenceInventory(root, false);
  assert.throws(() => writeLicenceInventory(root, true, true), /review is incomplete/);
  write("pnpm-lock.yaml", "packages:\n  example@1.0.0:\n    resolution: {integrity: sha512-example}\n");
  writeLicenceInventory(root, false);
  assert.equal(writeLicenceInventory(root, true, true).unresolvedPackages, 0);
  write("node_modules/example/package.json", JSON.stringify({ name: "example", version: "1.0.0", license: "MPL-2.0" }));
  writeLicenceInventory(root, false);
  assert.throws(() => writeLicenceInventory(root, true, true), /review is incomplete/);
  const snapshot = JSON.parse(readFileSync(path.join(root, "DEPENDENCY_LICENCES.json"), "utf8"));
  snapshot.texts = {};
  write("DEPENDENCY_LICENCES.json", JSON.stringify(snapshot));
  rmSync(path.join(root, "node_modules"), { recursive: true });
  assert.throws(() => writeLicenceInventory(root, true), /Missing or corrupt licence text/);
});

test("newly installed platform evidence stays missing until explicit collection; empty notices block strict checks", (t) => {
  const { root, write } = fixture(t);
  writeLicenceInventory(root, false);
  write("node_modules/platform/package.json", JSON.stringify({ name: "platform", version: "1.0.0", license: "MIT" }));
  assert.equal(writeLicenceInventory(root, true).unresolvedPackages, 1);
  writeLicenceInventory(root, false);
  assert.throws(() => writeLicenceInventory(root, true, true), /review is incomplete/);
  write("node_modules/platform/LICENSE", "Copyright Platform Author\nMIT fixture\n");
  writeLicenceInventory(root, false);
  assert.equal(writeLicenceInventory(root, true, true).unresolvedPackages, 0);
  for (const empty of ["", " \n\t"]) {
    write("node_modules/platform/LICENSE", empty);
    writeLicenceInventory(root, false);
    assert.throws(() => writeLicenceInventory(root, true, true), /review is incomplete/);
  }
});

test("licence CLI uses a single JSON line for help and invalid arguments", () => {
  for (const arg of ["--help", "--unknown"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/licences.ts", arg], {
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
    });
    assert.equal(result.status, arg === "--help" ? 0 : 1);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(result.stdout).ok, arg === "--help");
  }
});

test("refuses symbolic links for generated outputs and registered source evidence", (t) => {
  const { root, write } = fixture(t);
  write("target.txt", "Keep this file intact");
  symlinkSync(path.join(root, "target.txt"), path.join(root, "DEPENDENCY_LICENCES.json"));
  assert.throws(() => writeLicenceInventory(root, false), /must be a regular file/);
  assert.equal(readFileSync(path.join(root, "target.txt"), "utf8"), "Keep this file intact");
  rmSync(path.join(root, "DEPENDENCY_LICENCES.json"));
  rmSync(path.join(root, "vendor/example/LICENSE"));
  symlinkSync(path.join(root, "target.txt"), path.join(root, "vendor/example/LICENSE"));
  assert.throws(() => writeLicenceInventory(root, false), /evidence must be a regular file/);
});
