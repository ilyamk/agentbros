import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { addedPackages, checkDependencies, inspectDependencies, licenceStatus } from "../src/lib/contrib/dependencies";
import { CliErrorObject } from "../src/lib/cli";

const before = readFileSync("tests/fixtures/dependencies/base.yaml", "utf8"),
  after = readFileSync("tests/fixtures/dependencies/head.yaml", "utf8");
test("SPDX policy honours OR choices, AND obligations and fails closed on unsupported expressions", () => {
  const policy = JSON.parse(readFileSync("contrib/licence-allowlist.json", "utf8"));
  for (const expression of ["MIT OR GPL-3.0-only", "(MIT AND Apache-2.0)", "GPL-3.0-only OR (MIT AND ISC)"])
    assert.equal(licenceStatus(expression, policy), "allowed", expression);
  assert.equal(licenceStatus("MIT AND MPL-2.0", policy), "review");
  for (const expression of [
    "EPL-2.0 OR GPL-3.0-or-later",
    "MIT AND GPL-3.0-only",
    "MIT OR",
    "(MIT",
    "MIT WITH unknown-exception",
    "MIT OR ISC WITH unknown-exception",
    "MIT OR (ISC AND)",
    "MIT; GPL",
    "MIT Apache-2.0",
    "",
    "OR MIT",
  ])
    assert.equal(licenceStatus(expression, policy), "refused", expression);
});
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "dependency-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "contrib"));
  copyFileSync("contrib/licence-allowlist.json", path.join(root, "contrib/licence-allowlist.json"));
  writeFileSync(path.join(root, "pnpm-lock.yaml"), after);
  for (const [name, version, license] of [
    ["updated-package", "2.0.0", "ISC"],
    ["@example/allowed", "1.0.0", "MIT"],
    ["review-package", "1.0.0", "MPL-2.0"],
    ["refused-package", "1.0.0", "GPL-3.0-only"],
  ]) {
    const dir = path.join(root, "node_modules/.pnpm", `${name!.replace("/", "+")}@${version}`, "node_modules", name!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version, license, scripts: { install: "echo listed, never executed", test: "ignored" } }),
    );
  }
  return root;
}
test("lockfile diff includes new versions and scoped packages; licences and install scripts are checked offline", (t) => {
  const root = fixture(t),
    added = addedPackages(before, after);
  assert.equal(added.length, 4);
  const result = inspectDependencies(root, added);
  assert.deepEqual(
    result.map((item) => item.status),
    ["allowed", "allowed", "review", "refused"],
  );
  assert.deepEqual(result[0]!.scripts, { install: "echo listed, never executed" });
  assert.equal(inspectDependencies(root, [{ name: "missing", version: "1" }])[0]!.status, "missing");
  assert.throws(() => addedPackages(before, "packages: {malformed: {}}"), /Unsupported/);
});
test("dependency gate audits changed manifests, blocks review licences, and propagates audit failures", (t) => {
  const root = fixture(t),
    calls: string[][] = [];
  const run = (bin: string, args: string[]) => {
    calls.push([bin, ...args]);
    return {
      status: 0,
      stdout:
        args[0] === "rev-parse"
          ? "a".repeat(40)
          : args[0] === "diff"
            ? "package.json\n"
            : args[0] === "show"
              ? before
              : "",
      error: undefined,
    };
  };
  assert.throws(
    () => checkDependencies(root, "base", run),
    (error) => error instanceof CliErrorObject && (error.details?.packages as unknown[]).length === 4,
  );
  assert.deepEqual(calls.at(-1), ["pnpm", "audit", "--prod", "--audit-level", "high"]);
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "packages:\n  '@example/allowed@1.0.0': {}\n");
  assert.equal(checkDependencies(root, "base", run).audit, "passed");
  assert.throws(
    () =>
      checkDependencies(root, "base", (bin, args) =>
        bin === "pnpm" ? { ...run(bin, args), status: 1 } : run(bin, args),
      ),
    /Dependency gate failed/,
  );
  assert.equal(
    checkDependencies(root, "base", (bin, args) =>
      args[0] === "diff" ? { ...run(bin, args), stdout: "" } : run(bin, args),
    ).audit,
    "not-needed",
  );
});
test("dependency CLI help and failures follow the single-line JSON contract", () => {
  for (const arg of ["--help", "--unknown"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/deps-check.ts", arg], {
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
    });
    assert.equal(result.status, arg === "--help" ? 0 : 1);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(result.stdout).ok, arg === "--help");
  }
});
test("dependency gate reads an actual temporary git diff and only mocks the registry audit", (t) => {
  const root = fixture(t);
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  writeFileSync(path.join(root, "pnpm-lock.yaml"), before);
  writeFileSync(path.join(root, "package.json"), "{}\n");
  git(["init", "-b", "test"]);
  git(["add", "package.json", "pnpm-lock.yaml"]);
  git(["-c", "user.name=Dependency Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "packages:\n  '@example/allowed@1.0.0': {}\n");
  const result = checkDependencies(root, "HEAD", (bin, args) =>
    bin === "pnpm"
      ? { status: 0, stdout: "offline mocked audit" }
      : spawnSync(bin, args, { cwd: root, encoding: "utf8" }),
  );
  assert.equal(result.audit, "passed");
  assert.equal(result.packages.length, 1);
});

test("pnpm 12 package-manager and application lock documents are compared together", () => {
  const old = "---\npackages:\n  pnpm@12.0.0: {}\n---\npackages:\n  example@1.0.0: {}\n";
  const next = old + "  sharp@0.35.5: {}\n";
  assert.deepEqual(addedPackages(old, next), [{ name: "sharp", version: "0.35.5" }]);
  assert.throws(() => addedPackages("", "---\npackages: {a@1: {}}\n---\npackages: {a@1: {}}"), /Duplicate/);
});
test("owner-reviewed EPL selection uses the exact archive-bound review ledger", async () => {
  const { readLicenceReviews, matchingLicenceReview } = await import("../src/lib/contrib/licence-review");
  const ledger = readLicenceReviews(path.resolve(import.meta.dirname, ".."))!;
  const review = ledger.packages.find((item) => item.name === "elkjs" && item.version === "0.12.1")!;
  assert.equal(review.selectedLicence, "EPL-2.0");
  assert.equal(review.runtimeAuthorisation?.selectedLicence, "EPL-2.0");
  assert.equal(review.runtimeAuthorisation?.source, "owner-explicit-session");
  assert.equal(review.declaration, "EPL-2.0 OR GPL-3.0-or-later");
  assert.equal(matchingLicenceReview(ledger, review, review.declaration)?.decision, "conditional");
  assert.equal(matchingLicenceReview(ledger, { ...review, name: "other" }), undefined);
  assert.equal(matchingLicenceReview(ledger, { ...review, version: "0.12.2" }), undefined);
  assert.throws(() => matchingLicenceReview(ledger, review, "EPL-2.0"), /stale/);
  assert.throws(() => matchingLicenceReview(ledger, { ...review, integrity: "sha512-changed" }), /stale/);
  assert.equal(licenceStatus(review.declaration, { allowed: ["MIT"], review: [] }), "refused");
});
