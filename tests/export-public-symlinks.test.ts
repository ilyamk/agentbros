import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const repo = path.resolve(import.meta.dirname, "..");
const script = path.join(repo, "scripts/export-public.ts");

function fixture(t: test.TestContext) {
  const base = mkdtempSync(path.join(tmpdir(), "export-links-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  const files: Record<string, string> = {
    "kit/skills/open/SKILL.md": "# Open skill\n",
    "kit/skills/closed/SKILL.md": "# Closed skill\n",
    "kit/agents/helper.md": "# Helper\n",
    "export.json": JSON.stringify({
      deny: [
        { glob: "kit/skills/closed/**", reason: "third-party, not redistributed" },
        { glob: "kit/hidden-link", reason: "the link itself is private" },
      ],
      denyByContent: [],
      leakPatterns: [],
      allowedHits: [],
    }),
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  mkdirSync(path.join(root, ".tool"), { recursive: true });
  const link = (file: string, target: string) => symlinkSync(target, path.join(root, file));
  link(".tool/skills", "../kit/skills");
  link(".tool/agents", path.join(root, "kit/agents"));
  link("kit/readme-link.md", "skills/open/SKILL.md");
  link("kit/hidden-link", "agents");
  const git = (...args: string[]) =>
    assert.equal(
      spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      }).status,
      0,
      args.join(" "),
    );
  git("init", "-q");
  git("add", "-A");
  const run = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        script,
        "--config",
        path.join(root, "export.json"),
        ...args,
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, AGENTBROS_MEMORY_ROOT: "" } },
    );
    assert.equal(result.stdout.trim().split("\n").length, 1, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { base, root, link, git, run };
}

test("a refused leak scan writes no public files", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, "secret.txt"), "SYNTHETIC_PRIVATE_MARKER");
  writeFileSync(
    path.join(f.root, "export.json"),
    JSON.stringify({
      deny: [],
      denyByContent: [],
      leakPatterns: [{ name: "fixture-secret", regex: "SYNTHETIC_PRIVATE_MARKER" }],
      allowedHits: [],
    }),
  );
  const output = path.join(f.base, "public");
  const result = f.run("--output", output);
  assert.equal(result.error, "VALIDATION", JSON.stringify(result));
  assert.match(result.message, /Leak scan found/);
  assert.ok(!existsSync(output), "refused contents must never be copied");
});

test("publication uses the exact scanned bytes and preserves executable permissions", (t) => {
  const f = fixture(t);
  const source = path.join(f.root, "a.txt");
  writeFileSync(source, "Scanned public bytes\n");
  chmodSync(source, 0o755);
  writeFileSync(
    path.join(f.root, "export.json"),
    JSON.stringify({
      deny: [],
      denyByContent: [],
      leakPatterns: [{ name: "fixture-secret", regex: "^SYNTHETIC_PRIVATE_MARKER$" }],
      allowedHits: [],
    }),
  );
  const output = path.join(f.base, "public");
  const runner = path.join(f.base, "mutate-at-publication.mjs");
  writeFileSync(
    runner,
    [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const mkdir = fs.mkdirSync;",
      `fs.mkdirSync = (...args) => { if (args[0] === ${JSON.stringify(output)}) fs.writeFileSync(${JSON.stringify(source)}, "SYNTHETIC_PRIVATE_MARKER"); return mkdir(...args); };`,
      "syncBuiltinESMExports();",
      `await import(${JSON.stringify(script)});`,
    ].join("\n"),
  );
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      runner,
      "--config",
      path.join(f.root, "export.json"),
      "--output",
      output,
    ],
    { cwd: f.root, encoding: "utf8", env: { ...process.env, AGENTBROS_MEMORY_ROOT: "" }, timeout: 30000 },
  );
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  assert.equal(JSON.parse(child.stdout).metadata.leaks.hits, 0);
  assert.equal(readFileSync(source, "utf8"), "SYNTHETIC_PRIVATE_MARKER", "the race fixture must execute");
  assert.equal(readFileSync(path.join(output, "a.txt"), "utf8"), "Scanned public bytes\n");
  assert.equal(lstatSync(path.join(output, "a.txt")).mode & 0o777, 0o755);
});

test("tracked children cannot be exported through a replaced directory symlink", (t) => {
  const f = fixture(t);
  const external = path.join(f.base, "external");
  mkdirSync(external);
  writeFileSync(path.join(external, "SKILL.md"), "External private contents");
  const parent = path.join(f.root, "kit/skills/open");
  rmSync(parent, { recursive: true });
  symlinkSync(external, parent);
  const output = path.join(f.base, "public");
  const result = f.run("--output", output);
  assert.equal(result.error, "VALIDATION", JSON.stringify(result));
  assert.match(result.message, /symlink ancestor/);
  assert.ok(!existsSync(output));
});

test("a new output directory cannot enter the source tree through a symlink parent", (t) => {
  const f = fixture(t);
  const alias = path.join(f.base, "alias");
  symlinkSync(f.root, alias);
  const output = path.join(alias, "new-public-tree");
  const result = f.run("--output", output);
  assert.equal(result.error, "INVALID_INPUT", JSON.stringify(result));
  assert.match(result.message, /outside the source repository/);
  assert.ok(!existsSync(path.join(f.root, "new-public-tree")));
});

test("export keeps tracked symlinks into the tree as relative links, even into a partly denied directory", (t) => {
  const f = fixture(t);
  const dry = f.run("--dry-run");
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.deepEqual(dry.metadata.symlinks, {
    kept: [
      { path: ".tool/agents", target: "../kit/agents" },
      { path: ".tool/skills", target: "../kit/skills" },
      { path: "kit/readme-link.md", target: "skills/open/SKILL.md" },
    ],
    dropped: [],
  });
  assert.equal(dry.metadata.deniedFiles["kit/hidden-link"], "the link itself is private");

  const output = path.join(f.base, "public");
  const result = f.run("--output", output);
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const [file, target] of [
    [".tool/skills", "../kit/skills"],
    [".tool/agents", "../kit/agents"],
    ["kit/readme-link.md", "skills/open/SKILL.md"],
  ] as const) {
    assert.ok(lstatSync(path.join(output, file)).isSymbolicLink(), file);
    assert.equal(readlinkSync(path.join(output, file)), target);
  }
  assert.deepEqual(
    readdirSync(path.join(output, ".tool/skills")),
    ["open"],
    "the denied sibling stays out behind the link",
  );
  assert.ok(!existsSync(path.join(output, "kit/hidden-link")));
});

test("export fails, writing nothing, when a tracked symlink would be lost", (t) => {
  const f = fixture(t);
  f.link("escape", "../outside");
  f.link("closed-skill", "kit/skills/closed");
  f.link("closed-file", "kit/skills/closed/SKILL.md");
  f.git("add", "-A");
  const output = path.join(f.base, "public");
  const result = f.run("--output", output);
  assert.equal(result.error, "VALIDATION");
  const dropped = result.details.symlinks.dropped as { path: string; reason: string; tracked: boolean }[];
  assert.deepEqual(
    dropped.map((item) => item.path),
    ["closed-file", "closed-skill", "escape"],
  );
  assert.ok(dropped.every((item) => item.tracked));
  assert.match(dropped.find((item) => item.path === "escape")!.reason, /outside the tree/);
  assert.match(dropped.find((item) => item.path === "closed-skill")!.reason, /denied/);
  assert.ok(!existsSync(output) || readdirSync(output).length === 0, "no partial tree is written");
});
