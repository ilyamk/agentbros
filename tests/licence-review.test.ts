import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildLicenceInventory, writeLicenceInventory } from "../src/lib/contrib/licences";
import { inspectDependencies } from "../src/lib/contrib/dependencies";
import { licenceHash, licenceReviewDocument, readLicenceReviews } from "../src/lib/contrib/licence-review";
import type { DependencyLicenceReviews } from "../src/types/dependency-licences";

test("runtime authorisation links resolve from the generated docs directory to their functional source ledger", () => {
  const ledger = readLicenceReviews(process.cwd())!;
  const doc = licenceReviewDocument(ledger);
  assert.match(doc, /\[evidence\]\(\.\.\/credits\/libraries-elkjs-0-12-1\.json\)/);
  assert.equal(doc.includes("docs/verification/"), false);
});

function fixture(t: test.TestContext, notices = true) {
  const root = mkdtempSync(path.join(tmpdir(), "licence-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
  write("pnpm-lock.yaml", `packages:\n  fixture@1.0.0:\n    resolution: {integrity: ${integrity}}\n`);
  write("contrib/licence-allowlist.json", JSON.stringify({ allowed: ["MIT"], review: ["MPL-2.0"] }));
  const manifest = JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    license: "MPL-2.0",
    scripts: { install: "never executed" },
  });
  write("node_modules/fixture/package.json", manifest);
  if (notices) write("node_modules/fixture/LICENSE", "Fixture MPL notice; not a legal grant\n");
  const original = buildLicenceInventory(root, true);
  const pkg = original.packages[0]!;
  const evidence = pkg.evidence!;
  const terms = "Fixture source-only review evidence; not legal advice or an actual licence\n";
  const hash = licenceHash(terms);
  const ledger: DependencyLicenceReviews = {
    version: 1,
    scope: "repository-source",
    reviewedAt: "2026-11-15",
    reviewer: "Codex: user-requested technical review",
    baselineCommit: "a".repeat(40),
    baselineInventorySha256: licenceHash(JSON.stringify(original)),
    baselinePackages: 1,
    baselineIdentities: ["fixture@1.0.0"],
    limitations: ["Source distribution only; binary payloads excluded"],
    texts: { ...original.texts, [hash]: terms },
    packages: [
      {
        name: pkg.name,
        version: pkg.version,
        lockHash: pkg.lockHash,
        integrity,
        tarballUrl: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
        archiveBytes: 123,
        packageJsonSha256: licenceHash(manifest),
        observedEvidenceSha256: licenceHash(`${JSON.stringify(evidence, null, 2)}\n`),
        declaration: evidence.declaration,
        selectedLicence: "MPL-2.0",
        decision: "conditional",
        rationale: "Fixture permits source references under recorded conditions only.",
        obligations: ["Preserve source availability and notices when distributing covered code"],
        references: [{ url: "https://example.invalid/upstream/LICENSE", sha256: hash, role: "licence" }],
        metadata: {
          repository: evidence.repository,
          author: evidence.author,
          scripts: { install: "never executed" },
          files: evidence.files,
        },
      },
    ],
  };
  const save = () => write("contrib/licence-reviews.json", `${JSON.stringify(ledger, null, 2)}\n`);
  save();
  return { root, ledger, save, write, manifest };
}

test("source-scope review closes exact findings while default policy and original declarations remain", (t) => {
  const f = fixture(t, false);
  writeLicenceInventory(f.root, false);
  assert.throws(() => writeLicenceInventory(f.root, true, true), /review is incomplete/);
  const result = writeLicenceInventory(f.root, true, true, "repository-source");
  assert.equal(result.reviewedPackages, 1);
  assert.equal(result.unresolvedPackages, 0);
  assert.equal(result.legalClearance, false);
  const inventory = buildLicenceInventory(f.root, false);
  assert.equal(inventory.packages[0]!.evidence!.declaration, "MPL-2.0");
  assert.equal(inventory.packages[0]!.status, "review");
  assert.match(
    readFileSync(path.join(f.root, "docs/dependency-licence-review.md"), "utf8"),
    /binary payloads excluded/,
  );
});

test("verified archive metadata works on another platform and reports install scripts as data", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.root, "node_modules"), { recursive: true });
  writeLicenceInventory(f.root, false);
  const pkg = buildLicenceInventory(f.root, false).packages[0]!;
  assert.equal(pkg.evidenceOrigin, "reviewed-archive");
  assert.equal(pkg.evidence?.declaration, "MPL-2.0");
  const checked = inspectDependencies(f.root, [{ name: "fixture", version: "1.0.0" }])[0]!;
  assert.equal(checked.metadataSource, "reviewed-archive");
  assert.equal(checked.status, "allowed");
  assert.equal(checked.review?.scope, "repository-source");
  assert.deepEqual(checked.scripts, { install: "never executed" });
});

test("new versions, changed pins, manifests and notice text never inherit an old decision", (t) => {
  const f = fixture(t);
  const checked = inspectDependencies(f.root, [{ name: "fixture", version: "2.0.0" }])[0]!;
  assert.equal(checked.status, "missing");
  f.write("node_modules/fixture/LICENSE", "Changed fixture notice\n");
  assert.throws(() => writeLicenceInventory(f.root, false), /review is stale/);
  f.write("node_modules/fixture/LICENSE", "Fixture MPL notice; not a legal grant\n");
  f.write(
    "node_modules/fixture/package.json",
    JSON.stringify({ name: "fixture", version: "1.0.0", license: "GPL-3.0-only" }),
  );
  assert.throws(() => inspectDependencies(f.root, [{ name: "fixture", version: "1.0.0" }]), /review is stale/);
  f.ledger.packages[0]!.lockHash = "f".repeat(64);
  f.save();
  assert.throws(() => writeLicenceInventory(f.root, false), /review is stale/);
});

test("archive provenance stays stable when the exact platform package becomes installed", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.root, "node_modules"), { recursive: true });
  writeLicenceInventory(f.root, false);
  f.write("node_modules/fixture/package.json", f.manifest);
  f.write("node_modules/fixture/LICENSE", "Fixture MPL notice; not a legal grant\n");
  assert.equal(writeLicenceInventory(f.root, true, true, "repository-source").unresolvedPackages, 0);
  assert.equal(buildLicenceInventory(f.root, false).packages[0]!.evidenceOrigin, "reviewed-archive");
});

test("blocked decisions remain blockers, including after a collector rewrite", (t) => {
  const f = fixture(t);
  f.ledger.packages[0]!.decision = "blocked";
  f.save();
  writeLicenceInventory(f.root, false);
  assert.throws(() => writeLicenceInventory(f.root, true, true, "repository-source"), /review is incomplete/);
  assert.equal(inspectDependencies(f.root, [{ name: "fixture", version: "1.0.0" }])[0]!.status, "review");
});

test("scope refuses dependency patches and tracked node_modules; empty patch maps are harmless", (t) => {
  const f = fixture(t);
  f.write("package.json", JSON.stringify({ pnpm: { patchedDependencies: {} } }));
  writeLicenceInventory(f.root, false);
  writeLicenceInventory(f.root, true, true, "repository-source");
  f.write("pnpm-workspace.yaml", "patchedDependencies:\n  fixture@1.0.0: patches/fixture.patch\n");
  assert.throws(() => writeLicenceInventory(f.root, true, true, "repository-source"), /patched dependencies/);
  f.write("pnpm-workspace.yaml", "patchedDependencies: {}\n");
  assert.equal(spawnSync("git", ["add", "node_modules"], { cwd: f.root }).status, 0);
  assert.throws(() => writeLicenceInventory(f.root, true, true, "repository-source"), /vendored node_modules/);
});

test("ledger validation rejects corrupt evidence, duplicates and loss of baseline identities", (t) => {
  const f = fixture(t);
  const hash = f.ledger.packages[0]!.references[0]!.sha256;
  const original = f.ledger.texts[hash]!;
  f.ledger.texts[hash] = "Tampered";
  f.save();
  assert.throws(() => readLicenceReviews(f.root), /Corrupt/);
  f.ledger.texts[hash] = original;
  f.ledger.packages.push(f.ledger.packages[0]!);
  f.save();
  assert.throws(() => readLicenceReviews(f.root), /Duplicate/);
  f.ledger.packages.pop();
  f.ledger.baselineIdentities = ["another@1.0.0"];
  f.save();
  assert.throws(() => readLicenceReviews(f.root), /baseline identity/);
});
