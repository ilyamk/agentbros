import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { intake, sizeClass, type ChangedFile, type IntakeInput } from "../src/lib/contrib/intake";
import { computeTier } from "../src/lib/contrib/tiers";

const body = (category = "docs", size = "S") => `<!-- agentbros:pr
category: ${category}
size: ${size}
${size !== "S" ? "issue: 123\n" : ""}autonomy: autonomous
harness: codex
model: test-model
owner: person
change: .changes/repair.md
-->`;
const entry = (category = "docs", deps = "") => `---
category: ${category}
bump: patch
breaking: false
pr: 0
authors: [person]
${deps ? `deps: ${deps}\n` : ""}---
Repair the guide.\n`;
const file = (path: string, changes: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  additions: 2,
  deletions: 0,
  binary: false,
  status: "M",
  ...changes,
});
const input = (changes: Partial<IntakeInput> = {}): IntakeInput => ({
  prBody: body(),
  changedFiles: [file("docs/guide.md"), file(".changes/repair.md", { status: "A", content: entry() })],
  authorTier: 0,
  cla: true,
  openPrCount: 1,
  labels: [],
  ...changes,
});
const rules = (value: IntakeInput) => intake(value).findings.map(({ rule }) => rule);

test("happy path, overlapping categories and exact size boundaries", () => {
  assert.deepEqual(rules(input()), []);
  assert.deepEqual([0, 300, 301, 1000, 1001].map(sizeClass), ["S", "S", "M", "M", "L"]);
  const result = intake(input());
  assert.equal(result.facts.size, "S");
  assert.ok(result.facts.categoriesTouched.includes("docs"));
  assert.deepEqual(
    rules(
      input({
        changedFiles: [
          file("docs/library/catalogue.json"),
          file(".changes/repair.md", { status: "A", content: entry() }),
        ],
      }),
    ),
    [],
  );
});
test("a library PR can include its required playbook, documentation and regression test", () => {
  assert.deepEqual(
    rules(
      input({
        prBody: body("library"),
        changedFiles: [
          file("src/motion/library/new-block.tsx"),
          file("playbooks/product-ad/AGENTS.md"),
          file("tests/library-new-block.test.ts"),
          file("docs/motion-library.md"),
          file(".changes/repair.md", { status: "A", content: entry("library") }),
        ],
        labels: ["design-approved"],
      }),
    ),
    [],
  );
});
test("a library PR carries the regenerated API surface without leaving its category", () => {
  assert.deepEqual(
    rules(
      input({
        prBody: body("library"),
        changedFiles: [
          file("src/motion/library/new-block.tsx"),
          file("docs/library/catalogue.json"),
          file("docs/api/surface.json"),
          file(".changes/repair.md", { status: "A", content: entry("library") }),
        ],
      }),
    ),
    [],
  );
});
test("tier zero supporting instruction edits need protected-path approval, not an instructions category", () => {
  const change = input({
    prBody: body("audio"),
    changedFiles: [
      file("src/lib/audio/mix.ts"),
      file("tests/AGENTS.md"),
      file("AGENTS.md"),
      file(".changes/repair.md", { status: "A", content: entry("audio") }),
    ],
  });
  assert.deepEqual(rules(change), ["protected-paths"]);
  assert.deepEqual(rules({ ...change, labels: ["design-approved"] }), []);
  assert.ok(rules({ ...change, prBody: body("instructions"), labels: ["design-approved"] }).includes("tier-category"));
});
const fixtures: [string, Partial<IntakeInput>, string][] = [
  ["unsigned CLA", { cla: false }, "cla"],
  ["missing PR block", { prBody: "No block" }, "pr-block"],
  ["open-PR limit", { openPrCount: 3 }, "open-pr-limit"],
  [
    "wrong category paths",
    { changedFiles: [file("src/templates/Test.tsx"), file(".changes/repair.md", { status: "A", content: entry() })] },
    "category-paths",
  ],
  ["binary", { changedFiles: [file("docs/plate.bin", { binary: true })] }, "media-binary"],
  ["media extension", { changedFiles: [file("docs/plate.mp4")] }, "media-binary"],
  ["oversize declaration", { changedFiles: [file("docs/guide.md", { additions: 301 })] }, "declared-size"],
  ["missing entry", { changedFiles: [file("docs/guide.md")] }, "change-entry"],
  ["modified entry", { changedFiles: [file(".changes/repair.md", { content: entry() })] }, "change-entry"],
  [
    "invalid entry",
    { changedFiles: [file(".changes/repair.md", { status: "A", content: "invalid" })] },
    "change-entry",
  ],
  ["missing content", { changedFiles: [file(".changes/repair.md", { status: "A" })] }, "change-entry"],
  [
    "different change category",
    { changedFiles: [file(".changes/repair.md", { status: "A", content: entry("fix") })] },
    "one-category",
  ],
  [
    "multiple entries",
    {
      changedFiles: [
        file(".changes/repair.md", { status: "A", content: entry() }),
        file(".changes/other.md", { status: "A", content: entry() }),
      ],
    },
    "change-entry",
  ],
  ["wrong change reference", { prBody: body().replace("repair.md", "different.md") }, "change-entry-reference"],
  ["unknown category", { prBody: body("unknown") }, "category"],
  [
    "protected without label",
    {
      prBody: body("fix"),
      changedFiles: [file("scripts/a.ts"), file(".changes/repair.md", { status: "A", content: entry("fix") })],
    },
    "protected-paths",
  ],
  ["tier zero L", { prBody: body("docs", "L") }, "tier-size"],
  ["tier zero instructions", { prBody: body("instructions") }, "tier-category"],
  ["tier zero harness", { prBody: body("harness") }, "tier-category"],
  ["tier zero CI", { prBody: body("test-ci") }, "tier-category"],
  ["tier one L approval", { authorTier: 1, prBody: body("docs", "L") }, "large-approval"],
];
for (const [name, changes, expected] of fixtures) test(name, () => assert.ok(rules(input(changes)).includes(expected)));

test("tier limits and protected path approvals", () => {
  for (const [tier, max] of [
    [0, 2],
    [1, 5],
    [2, 10],
    [3, 1000],
  ] as const) {
    assert.ok(!rules(input({ authorTier: tier, openPrCount: max })).includes("open-pr-limit"));
    assert.equal(rules(input({ authorTier: tier, openPrCount: max + 1 })).includes("open-pr-limit"), tier !== 3);
  }
  assert.deepEqual(rules(input({ authorTier: 1, prBody: body("docs", "L"), labels: ["design-approved"] })), []);
  const result = intake(
    input({
      prBody: body("fix"),
      changedFiles: [file("scripts/a.ts"), file(".changes/repair.md", { status: "A", content: entry("fix") })],
      labels: ["design-approved"],
    }),
  );
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.facts.protectedPathsTouched, ["scripts/a.ts"]);
  assert.ok(
    !rules(
      input({
        changedFiles: [
          file("docs/media.mp4", { binary: true, status: "D" }),
          file(".changes/repair.md", { status: "A", content: entry() }),
        ],
      }),
    ).includes("media-binary"),
  );
});
test("dependency justification compares package names in all sections, fails closed without contents", () => {
  const pkg = {
    dependencies: { existing: "1" },
    devDependencies: { helper: "1" },
    optionalDependencies: { optional: "1" },
    peerDependencies: { peer: "1" },
  };
  const make = (content: string, previousContent?: string, deps = "") =>
    input({
      prBody: body("fix"),
      labels: ["design-approved"],
      changedFiles: [
        file("package.json", { content, previousContent }),
        file(".changes/repair.md", { status: "A", content: entry("fix", deps) }),
      ],
    });
  assert.ok(rules(make(JSON.stringify(pkg), "{}")).includes("dependency-justification"));
  assert.deepEqual(rules(make(JSON.stringify(pkg), "{}", "Used by local parser")), []);
  assert.deepEqual(rules(make(JSON.stringify({ dependencies: { existing: "2" } }), JSON.stringify(pkg))), []);
  assert.ok(rules(make(JSON.stringify(pkg))).includes("dependency-data"));
  assert.ok(rules(make("bad json", "{}")).includes("dependency-data"));
});
test("tier history thresholds, grants and temporary demotion", () => {
  const history = { merged: 0, closedAsSlop: 0, slopClosuresLast30Days: 0 };
  assert.equal(computeTier(history), 0);
  assert.equal(computeTier({ ...history, merged: 3 }), 1);
  assert.equal(computeTier({ ...history, merged: 4, closedAsSlop: 1 }), 0);
  assert.equal(computeTier({ ...history, merged: 10 }), 1);
  assert.equal(computeTier({ ...history, merged: 10, grant: 2 }), 2);
  assert.equal(computeTier({ ...history, merged: 9, grant: 2 }), 1);
  assert.equal(computeTier({ ...history, grant: 3 }), 3);
  assert.equal(computeTier({ ...history, merged: 20, grant: 2, slopClosuresLast30Days: 2 }), 1);
  assert.equal(computeTier({ ...history, merged: 3, slopClosuresLast30Days: 2 }), 0);
  assert.throws(() => computeTier({ ...history, merged: -1 }));
});
test("offline intake CLI reads committed entries, counts binary numstat, rejects invalid input", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "contrib-intake-"));
  const cli = path.resolve("scripts/contrib-intake.ts"),
    tsx = path.resolve("node_modules/tsx/dist/loader.mjs");
  const env = {
    PATH: process.env.PATH,
    HOME: cwd,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(cwd, "no-config"),
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (name: string, value: string | Buffer) => writeFileSync(path.join(cwd, name), value);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", tsx, cli, ...args], { cwd, env, encoding: "utf8" });
  try {
    git("init");
    mkdirSync(path.join(cwd, "docs"));
    write("docs/guide.md", "Before\n");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    mkdirSync(path.join(cwd, ".changes"));
    write(".changes/repair.md", entry());
    write("docs/guide.md", "After\n");
    git("add", ".");
    git("commit", "-m", "repair");
    write("body.txt", body());
    write("context.json", JSON.stringify({ cla: true }));
    write(".env", "INVALID ENV CONTENT\n");
    const args = ["--base", base, "--head", "HEAD", "--body", "body.txt", "--context", "context.json"];
    const good = run(...args);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.equal(good.stdout.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(good.stdout).metadata.findings, []);
    write(".changes/repair.md", "Uncommitted invalid entry");
    assert.equal(run(...args).status, 0, "uses committed content");
    write("docs/binary.dat", Buffer.from([0, 1, 2]));
    write("docs/tab\tname.md", "Tab path\n");
    git("add", "docs");
    git("commit", "-m", "binary");
    const blocked = run(...args);
    assert.equal(blocked.status, 1);
    assert.ok(
      JSON.parse(blocked.stdout).metadata.findings.some((item: { rule: string }) => item.rule === "media-binary"),
    );
    const bad = run("--base", "missing", "--head", "HEAD", "--body", "body.txt");
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).ok, false);
    assert.equal(JSON.parse(run("--help").stdout).metadata.help, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("release route refuses extra package edits, README prose, missing patches and change-entry mutations", () => {
  const release = {
    authorLogin: "agentbros-release[bot]",
    headBranch: "bot/release",
    headRepo: "org/repo",
    baseRepo: "org/repo",
  };
  const pkg = file("package.json", {
    additions: 1,
    deletions: 1,
    previousContent: '{\n "version": "0.1.0"\n}',
    content: '{\n "version": "0.2.0"\n}',
    patch: '@@ -2 +2 @@\n- "version": "0.1.0"\n+ "version": "0.2.0"',
  });
  const value = input({ prBody: "Release", cla: false, release, changedFiles: [pkg] });
  assert.deepEqual(
    intake(value).findings.map((row) => [row.gate, row.rule]),
    [
      ["G0", "release-route"],
      ["G1", "release-route"],
    ],
  );
  const reject = (changedFiles: ChangedFile[]) =>
    assert.equal(intake({ ...value, changedFiles }).facts.releaseRoute, false);
  reject([{ ...pkg, content: pkg.content!.replace("}", ', "scripts": {} }') }]);
  reject([{ ...pkg, patch: undefined }]);
  reject([{ ...pkg, previousPath: "other.json" }]);
  reject([file(".changes/README.md", { status: "D" })]);
  reject([file(".changes/entry.md", { status: "M" })]);
  reject([file("out/metrics/metrics.json")]);
  const before = "# Heading\n<!-- metrics:start -->\nOld\n<!-- metrics:end -->\n";
  const after = before.replace("Old", "New");
  const readme = file("README.md", {
    additions: 1,
    deletions: 1,
    previousContent: before,
    content: after,
    patch: "@@ -3 +3 @@\n-Old\n+New",
  });
  assert.equal(intake({ ...value, changedFiles: [readme] }).facts.releaseRoute, true);
  reject([{ ...readme, content: after.replace("Heading", "Injected") }]);
  reject([{ ...readme, content: after.replace("<!-- metrics:end -->", "") }]);
  reject([{ ...readme, content: after + "<!-- metrics:start -->" }]);
});

test("model refresh route requires verified same-repo bot, exact paths and complete text A/M/D patches", () => {
  const release = {
    authorLogin: "agentbros-release[bot]",
    headBranch: "bot/models-refresh",
    headRepo: "org/repo",
    baseRepo: "org/repo",
  };
  const allowed = [
    "src/lib/models/price-matrix.json",
    "src/lib/models/price-scenarios.json",
    "src/lib/models/fal-historical-prices.json",
    "src/lib/models/model-slots.json",
    "src/lib/models/fal-catalog/model.json",
    "src/lib/providers/schemas/fal/model.json",
    "docs/model-slots.md",
  ];
  const changed = file(allowed[0]!, { additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" });
  const value = input({ prBody: "Automated refresh", cla: false, release, changedFiles: [changed] });
  for (const path of allowed)
    for (const status of ["A", "M", "D"]) {
      const patch =
        status === "A"
          ? { additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+new" }
          : status === "D"
            ? { additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-old" }
            : changed;
      const result = intake({ ...value, changedFiles: [{ ...changed, ...patch, path, status }] });
      assert.equal(result.facts.modelsRefreshRoute, true, `${status} ${path}`);
      assert.equal(result.facts.releaseRoute, false);
      assert.deepEqual(
        result.findings.map((row) => [row.gate, row.rule]),
        [
          ["G0", "models-refresh-route"],
          ["G1", "models-refresh-route"],
        ],
      );
    }
  for (const identity of [
    { ...release, authorLogin: "mallory" },
    { ...release, headBranch: "feature" },
    { ...release, headRepo: "fork/repo" },
    { ...release, headRepo: "", baseRepo: "" },
    { ...release, config: {} },
  ])
    assert.equal(intake({ ...value, release: identity }).facts.modelsRefreshRoute, false);
  for (const files of [
    [],
    [changed, file("scripts/extra.ts")],
    [{ ...changed, binary: true }],
    [{ ...changed, previousPath: "other.json" }],
    [{ ...changed, status: "R" }],
    [{ ...changed, patch: undefined }],
    [{ ...changed, patch: "@@ -1 +1 @@\n+new" }],
    [{ ...changed, patch: "@@ -1 +1 @@\n-old\n+new\0" }],
    [{ ...changed, path: "src/lib/models/../../extra.json" }],
    [{ ...changed, path: "docs/verification/extra.md" }],
    [{ ...changed, path: "out/qa/model-refresh/model-refresh.md" }],
    [{ ...changed, path: "docs/verification/model-refresh.md" }],
  ])
    assert.equal(intake({ ...value, changedFiles: files }).facts.modelsRefreshRoute, false);
});
test("tier 3 maintainers change protected paths without design-approved; lower tiers cannot", () => {
  const change = input({
    prBody: body("audio"),
    changedFiles: [
      file("src/lib/audio/mix.ts"),
      file("AGENTS.md"),
      file(".changes/repair.md", { status: "A", content: entry("audio") }),
    ],
  });
  assert.deepEqual(rules({ ...change, authorTier: 3 }), []);
  for (const tier of [0, 1, 2] as const)
    assert.ok(rules({ ...change, authorTier: tier }).includes("protected-paths"), String(tier));
});
test("same-repository Dependabot manifest, lockfile and workflow updates take a warn-only route", () => {
  const identity = {
    authorLogin: "dependabot[bot]",
    headBranch: "dependabot/npm_and_yarn/development-abc",
    headRepo: "example/repo",
    baseRepo: "example/repo",
  };
  const update = input({
    prBody: "Bumps zod.",
    cla: false,
    openPrCount: 9,
    release: identity,
    changedFiles: [
      file("package.json", { additions: 1, deletions: 1 }),
      file("pnpm-lock.yaml", { additions: 2000, deletions: 1500 }),
      file(".github/workflows/ci.yml"),
    ],
  });
  const result = intake(update);
  assert.equal(result.facts.dependabotRoute, true);
  assert.deepEqual(
    result.findings.map((row) => [row.gate, row.rule, row.severity]),
    [
      ["G0", "dependabot-route", "warn"],
      ["G1", "dependabot-route", "warn"],
    ],
  );
  for (const changed of [
    { release: { ...identity, authorLogin: "mallory" } },
    { release: { ...identity, headRepo: "fork/repo" } },
    { release: { ...identity, headBranch: "main" } },
    { changedFiles: [...update.changedFiles, file("scripts/evil.ts")] },
    { changedFiles: [file("pnpm-lock.yaml", { binary: true })] },
    { changedFiles: [file("pnpm-lock.yaml", { status: "R", previousPath: "other.yaml" })] },
  ])
    assert.equal(intake({ ...update, ...changed }).facts.dependabotRoute, false, JSON.stringify(changed));
});
