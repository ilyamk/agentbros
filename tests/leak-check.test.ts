import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { loadLeakPatterns, type AllowedHit, type LeakPattern } from "../src/lib/leak-scan";

const repo = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(path.join(repo, "public-export.json"), "utf8")) as {
  leakPatterns: LeakPattern[];
  allowedHits: AllowedHit[];
};
const address = ["fixture", "example.test"].join("@");
const home = ["", "Users", "fixture", "private"].join("/");
const keys = [
  "sk-" + "a".repeat(32),
  "sk-proj-" + "b".repeat(40),
  "AKIA" + "A".repeat(16),
  "ghp_" + "a".repeat(36),
  "github_pat_" + "b".repeat(40),
  "xoxb-" + "1234567890-".repeat(3),
  "xoxp-" + "abcdefghij-".repeat(3),
];
const header = ["-----BEGIN", "RSA", "PRIVATE KEY-----"].join(" ");

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "leak-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", ["test", "example.test"].join("@"));
  git("config", "commit.gpgsign", "false");
  write("public-export.json", JSON.stringify(config));
  write(".gitignore", "/leak-patterns.local.json\n/ignored.txt\n");
  const commit = () => {
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const run = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        path.join(repo, "scripts/leak-check.ts"),
        "--dry-run",
        ...args,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.stdout.trim().split("\n").length, 1, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(result.status, envelope.ok ? 0 : 1, result.stderr);
    return envelope;
  };
  return { root, git, write, commit, run };
}

test("tree scans tracked and untracked files, paths and generic key formats without the export denylist", (t) => {
  const f = fixture(t);
  f.write("tracked.txt", home);
  f.commit();
  f.write("new.txt", [address, ...keys, header, [".codex", "worktrees", "fixture"].join("/")].join("\n"));
  f.write("docs/verification/denied.md", address);
  f.write(`added/${address}`, "safe");
  f.write("ignored.txt", address);
  f.write("binary.bin", "\0" + address);
  f.write("deleted.txt", address);
  f.git("add", "deleted.txt");
  rmSync(path.join(f.root, "deleted.txt"));
  const result = f.run();
  assert.equal(result.error, "VALIDATION");
  const m = result.details;
  assert.equal(m.localPatterns, false);
  assert.ok(
    m.hits.some((h: { file: string; pattern: string }) => h.file === "tracked.txt" && h.pattern === "home-path"),
  );
  assert.equal(m.hits.filter((h: { pattern: string }) => h.pattern === "provider-key").length, keys.length);
  assert.ok(m.hits.some((h: { pattern: string }) => h.pattern === "private-key"));
  assert.ok(m.hits.some((h: { pattern: string }) => h.pattern === "codex-worktree"));
  assert.ok(m.hits.some((h: { file: string; line: number }) => h.file === `added/${address}` && h.line === 0));
  assert.ok(m.hits.some((h: { file: string }) => h.file === "docs/verification/denied.md"));
  assert.ok(!m.hits.some((h: { file: string }) => ["ignored.txt", "binary.bin", "deleted.txt"].includes(h.file)));
});

test("diff scans only added lines and added paths, using committed head and exact line numbers", (t) => {
  const f = fixture(t);
  f.write("changed.txt", `${address}\n${home}\nsafe\n`);
  f.write("removed.txt", header);
  const base = f.commit();
  f.write("changed.txt", `${address}\nsafe\n${keys[0]}\n`);
  rmSync(path.join(f.root, "removed.txt"));
  f.write(`added/${address}`, "safe\n");
  const head = f.commit();
  f.write("changed.txt", header);
  f.write("untracked.txt", address);
  const result = f.run("--mode", "diff", "--base", base, "--head", head);
  assert.equal(result.error, "VALIDATION");
  assert.deepEqual(
    result.details.hits.map((h: { file: string; line: number; pattern: string }) => [h.file, h.line, h.pattern]),
    [
      [`added/${address}`, 0, "email"],
      ["changed.txt", 3, "provider-key"],
    ],
  );
  assert.deepEqual(f.run("--mode", "diff", "--base", head).metadata.hits, []);
});

test("diff handles renamed paths, literal tabs and spaces, deletions and binary files", (t) => {
  const f = fixture(t);
  f.write("old.txt", "safe\n");
  const base = f.commit();
  f.git("mv", "old.txt", address);
  f.write("space tab\t file.txt", header);
  f.write("binary.bin", "\0" + address);
  f.commit();
  const result = f.run("--mode", "diff", "--base", base);
  assert.deepEqual(
    result.details.hits.map((h: { file: string; pattern: string }) => [h.file, h.pattern]),
    [
      [address, "email"],
      ["space tab\t file.txt", "private-key"],
    ],
  );
});

test("diff cannot hide plaintext keys behind binary git attributes", (t) => {
  const f = fixture(t);
  const base = f.commit();
  f.write(".gitattributes", "secret.txt -diff\n");
  f.write("secret.txt", keys[0]!);
  f.commit();
  const result = f.run("--mode", "diff", "--base", base);
  assert.equal(result.error, "VALIDATION");
  assert.deepEqual(
    result.details.hits.map((h: { file: string; pattern: string }) => [h.file, h.pattern]),
    [["secret.txt", "provider-key"]],
  );
});

test("local patterns are opt-in for leak:check, required by --local and merged with allowlisted names", (t) => {
  const f = fixture(t);
  const token = "fixtureclient";
  const sha256 = [createHash("sha256").update(token).digest("hex")];
  f.write("private.txt", token);
  assert.equal(f.run("--local").error, "FILE_NOT_FOUND");
  f.write("leak-patterns.local.json", JSON.stringify({ leakPatterns: [{ name: "private-names", sha256 }] }));
  const generic = f.run();
  assert.equal(generic.ok, true, JSON.stringify(generic));
  const result = f.run("--local");
  assert.equal(result.details.localPatterns, true);
  assert.deepEqual(
    result.details.hits.map((h: { file: string; pattern: string }) => [h.file, h.pattern]),
    [["private.txt", "private-names"]],
  );
  f.write(
    "public-export.json",
    JSON.stringify({
      ...config,
      allowedHits: [
        ...config.allowedHits,
        { glob: "private.txt", pattern: "private-names", reason: "synthetic public fixture", only: [token] },
        { glob: "public-export.json", pattern: "private-names", reason: "synthetic allowlist literal", only: [token] },
      ],
    }),
  );
  assert.equal(f.run("--local").ok, true);
  f.write("leak-patterns.local.json", '{"leakPatterns": [{"name": "bad", "sha256": ["not-a-digest"]}]}');
  assert.equal(f.run("--local").error, "VALIDATION");
});

test("shared loader optionally merges local patterns and never drops the tracked patterns", (t) => {
  const f = fixture(t);
  assert.deepEqual(loadLeakPatterns(f.root, config.leakPatterns), {
    leakPatterns: config.leakPatterns,
    localPatterns: false,
  });
  const local = { name: "private-names", sha256: [createHash("sha256").update("fixtureclient").digest("hex")] };
  f.write("leak-patterns.local.json", JSON.stringify({ leakPatterns: [local] }));
  assert.deepEqual(loadLeakPatterns(f.root, config.leakPatterns).leakPatterns, [...config.leakPatterns, local]);
  assert.ok(config.leakPatterns.every((p) => !("sha256" in p)));
  assert.ok(
    JSON.parse(readFileSync(path.join(repo, "leak-patterns.local.example.json"), "utf8")).leakPatterns.every(
      (p: { sha256: string[] }) => p.sha256.length === 0,
    ),
  );
});

test("export merges the local file automatically and retains moved-name allowlist rules", (t) => {
  const f = fixture(t);
  const token = "fixtureclient";
  f.write("private.txt", token);
  f.write(
    "leak-patterns.local.json",
    JSON.stringify({
      leakPatterns: [{ name: "private-names", sha256: [createHash("sha256").update(token).digest("hex")] }],
    }),
  );
  const run = () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        path.join(repo, "scripts/export-public.ts"),
        "--dry-run",
      ],
      { cwd: f.root, encoding: "utf8", env: { ...process.env, AGENTBROS_MEMORY_ROOT: "" } },
    );
    assert.equal(result.stdout.trim().split("\n").length, 1);
    return JSON.parse(result.stdout);
  };
  const result = run();
  assert.equal(result.details.localPatterns, true);
  assert.deepEqual(
    result.details.hits.map((h: { file: string }) => h.file),
    ["private.txt"],
  );
  f.write(
    "public-export.json",
    JSON.stringify({
      ...config,
      allowedHits: [
        ...config.allowedHits,
        { glob: "private.txt", pattern: "private-names", reason: "intentional synthetic fixture" },
      ],
    }),
  );
  assert.equal(run().ok, true);
});

test("CLI rejects missing bases, invalid modes and option-like refs", (t) => {
  const f = fixture(t);
  f.commit();
  for (const args of [
    ["--mode", "diff"],
    ["--mode", "unknown"],
    ["--base", "HEAD"],
    ["--mode", "diff", "--base=--output=/tmp/no"],
  ])
    assert.equal(f.run(...args).error, "INVALID_INPUT");
});

test("collected package-author addresses are explained only in the generated licence files, and secrets there still fail", (t) => {
  const f = fixture(t);
  for (const file of ["DEPENDENCY_LICENCES.json", "contrib/licence-reviews.json"]) {
    const rule = config.allowedHits.find((item) => item.glob === file && item.pattern === "email");
    assert.ok(
      rule && !rule.only,
      `${file}: any collected address is explained, so a regenerated inventory needs no new literals`,
    );
  }
  f.write("DEPENDENCY_LICENCES.json", JSON.stringify({ author: `Upstream Author <${address}>` }));
  f.write("contrib/licence-reviews.json", JSON.stringify({ email: address }));
  assert.equal(f.run().ok, true);
  f.write("elsewhere.json", JSON.stringify({ author: address }));
  f.write("DEPENDENCY_LICENCES.json", JSON.stringify({ author: address, secret: keys[0] }));
  const result = f.run();
  assert.equal(result.ok, false);
  const hits = result.details.hits.map((hit: { file: string; pattern: string }) => `${hit.file} ${hit.pattern}`);
  assert.ok(hits.includes("elsewhere.json email"), "the same address outside the inventory still fails");
  assert.ok(hits.includes("DEPENDENCY_LICENCES.json provider-key"));
  assert.ok(!hits.includes("DEPENDENCY_LICENCES.json email"));
});

test("pre-push scans pushed commits against their upstream and ignores branch deletions", (t) => {
  const f = fixture(t);
  const base = f.commit();
  f.git("branch", "upstream");
  f.git("branch", "--set-upstream-to=upstream");
  f.write("safe.txt", "safe");
  const head = f.commit();
  const bin = path.join(f.root, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "pnpm"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$LEAK_HOOK_ARGS"\nexit "${LEAK_HOOK_EXIT:-0}"\n',
    { mode: 0o755 },
  );
  const output = path.join(f.root, "args.txt");
  const input = `refs/heads/main ${head} refs/heads/main ${base}\nrefs/heads/gone ${"0".repeat(40)} refs/heads/gone ${base}\n`;
  const run = (code: string) =>
    spawnSync("sh", [path.join(repo, "scripts/hooks/pre-push"), "origin"], {
      cwd: f.root,
      encoding: "utf8",
      input,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LEAK_HOOK_ARGS: output, LEAK_HOOK_EXIT: code },
    });
  assert.equal(run("0").status, 0);
  assert.deepEqual(readFileSync(output, "utf8").trim().split("\n"), [
    "leak:check",
    "--mode",
    "diff",
    "--local",
    "--base",
    base,
    "--head",
    head,
  ]);
  assert.equal(run("1").status, 1);
});
