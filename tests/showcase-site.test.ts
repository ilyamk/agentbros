import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInNewContext } from "node:vm";
import { buildSite } from "../site/build";
import { contributorStats } from "../src/lib/community/stats";

const root = path.resolve(import.meta.dirname, "..");
const entry = JSON.parse(readFileSync(path.join(root, "tests/fixtures/showcase/showcase.json"), "utf8"));
const write = (dir: string, file: string, value: unknown) => {
  const target = path.join(dir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
};
function workspace(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "showcase-site-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const htmlFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((row) =>
    row.isDirectory()
      ? htmlFiles(path.join(dir, row.name))
      : row.name.endsWith(".html")
        ? [path.join(dir, row.name)]
        : [],
  );
function git(dir: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      AGENTBROS_NO_DOTENV: "1",
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@invalid.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@invalid.test",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("site:build produces all pages with resolving internal links, escaped content and local filters", (t) => {
  const dir = workspace(t);
  write(dir, "showcases/synthetic-film/showcase.json", { ...entry, title: "<script>alert(1)</script>" });
  write(dir, "community/contributors/fixture-author.json", {
    displayName: "Fixture Author",
    links: ["https://example.org"],
    bio: "<img src=x onerror=alert(1)>",
    credits: "Credit",
  });
  write(dir, "out/metrics/metrics.json", { raw: { blocks: 1 }, health: { context: 42 } });
  write(dir, "bench/results/fixture.json", {
    author: "fixture-author",
    reproduced: true,
    rating: 1000,
    interval: [900, 1100],
  });
  write(dir, "out/contrib/needs.json", {
    opportunities: [
      {
        id: "abc123",
        category: "library",
        size: "M",
        title: "<img src=x onerror=alert(1)> A useful task",
        why: "A gap.",
        evidence: ["src/a.ts:1"],
        definitionOfDone: ["Done."],
        covering: [],
        source: "curated",
      },
      {
        id: "def456",
        category: "library",
        size: "S",
        title: "A scouted task",
        why: "A gap.",
        evidence: ["src/b.ts:1"],
        definitionOfDone: ["Done."],
        covering: [],
        source: "scout:library",
      },
      { title: "malformed rows are skipped" },
    ],
    counts: { library: 7 },
    total: 7,
  });
  write(
    dir,
    "playbooks/explainer/playbook.json",
    JSON.parse(readFileSync(path.join(root, "playbooks/explainer/playbook.json"), "utf8")),
  );
  write(dir, "docs/readme/hero.jpg", "fixture bytes");
  write(
    dir,
    ".agents/agents/fixture-agent.md",
    "---\nname: fixture-agent\ndescription: <b>Judges</b> fixtures.\nmodel: opus\n---\nBody.\n",
  );
  write(dir, "CHANGELOG.md", "# Releases\n\n## 0.1.0\n\nA fixture release.");
  const result = buildSite(dir, "out/site");
  assert.equal(result.metadata.showcases, 1);
  assert.equal(result.metadata.contributors, 1);
  for (const file of [
    "index.html",
    "films/index.html",
    "genres/index.html",
    "library/index.html",
    "crew/index.html",
    "assets/site.css",
    "assets/readme/hero.jpg",
    "showcases/synthetic-film/index.html",
    "contributors/index.html",
    "contributors/fixture-author/index.html",
    "metrics/index.html",
    "benchmarks/index.html",
    "needs/index.html",
    "releases/index.html",
  ])
    assert.ok(existsSync(path.join(dir, "out/site", file)), file);
  for (const file of htmlFiles(path.join(dir, "out/site"))) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /<script[^>]+src=/i);
    assert.ok(source.includes("Skip to content"));
    assert.doesNotMatch(source, /<img src=x/);
    for (const match of source.matchAll(/href="(\/agentbros\/[^"#]*)"/g)) {
      const route = match[1]!.replace("/agentbros/", "");
      const target = path.join(dir, "out/site", route, route.endsWith("/") || !route ? "index.html" : "");
      assert.ok(existsSync(target), `${file}: ${route}`);
    }
  }
  const gallery = readFileSync(path.join(dir, "out/site/films/index.html"), "utf8");
  assert.ok(gallery.includes("&lt;script&gt;"));
  assert.ok(readFileSync(path.join(dir, "out/site/index.html"), "utf8").includes("&lt;script&gt;"));
  assert.ok(gallery.includes('href="/agentbros/assets/site.css"'));
  const css = readFileSync(path.join(dir, "out/site/assets/site.css"), "utf8");
  assert.ok(css.includes("prefers-reduced-motion"));
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/);
  const needs = readFileSync(path.join(dir, "out/site/needs/index.html"), "utf8");
  assert.ok(needs.includes("&lt;img src=x onerror=alert(1)&gt; A useful task"));
  assert.ok(needs.includes("template=opportunity.yml"));
  assert.ok(needs.includes('data-chip="library"'));
  assert.doesNotMatch(needs, /malformed rows/);
  assert.ok(needs.includes("Picked by the maintainer"));
  assert.equal(needs.match(/data-featured/g)?.length, 1, "only source curated rows are featured");
  assert.ok(readFileSync(path.join(dir, "out/site/genres/explainer/index.html"), "utf8").includes("Explainer"));
  const crew = readFileSync(path.join(dir, "out/site/crew/index.html"), "utf8");
  assert.ok(crew.includes("fixture-agent"));
  assert.ok(crew.includes("&lt;b&gt;Judges"));
  for (const file of htmlFiles(path.join(dir, "out/site")))
    assert.doesNotMatch(readFileSync(file, "utf8"), /(?:src|srcset|poster)="https?:/, file);
  for (const name of ["playbook", "harness", "model", "verification", "budget", "length"])
    assert.ok(gallery.includes(`data-filter="${name}"`));
  const controls = [
    {
      dataset: { filter: "harness" },
      value: "codex",
      addEventListener: (_name: string, fn: () => void) => {
        listener = fn;
      },
    },
    {
      dataset: { filter: "budget" },
      value: "0",
      addEventListener: (_name: string, fn: () => void) => {
        listener = fn;
      },
    },
  ];
  let listener = () => {};
  const cards = [
    { dataset: { harness: "codex", budget: "0" }, hidden: false },
    { dataset: { harness: "claude-code", budget: "10" }, hidden: false },
    { dataset: { harness: "codex", budget: "" }, hidden: false },
  ];
  const status = { textContent: "" };
  runInNewContext(/<script>([\s\S]*)<\/script>/.exec(gallery)![1]!, {
    document: {
      querySelectorAll: (selector: string) => (selector === "[data-filter]" ? controls : cards),
      getElementById: () => status,
    },
  });
  listener();
  assert.deepEqual(
    cards.map((card) => card.hidden),
    [false, true, true],
  );
  assert.equal(status.textContent, "1 films shown");
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(dir, "out/site/benchmarks/data/result-1.json"), "utf8")).interval,
    [900, 1100],
  );
  rmSync(path.join(dir, "showcases/synthetic-film/showcase.json"));
  rmSync(path.join(dir, "community/contributors/fixture-author.json"));
  rmSync(path.join(dir, "bench/results/fixture.json"));
  buildSite(dir, "out/site");
  for (const obsolete of [
    "showcases/synthetic-film/index.html",
    "contributors/fixture-author/index.html",
    "benchmarks/data/result-1.json",
  ])
    assert.equal(existsSync(path.join(dir, "out/site", obsolete)), false);
  write(dir, "out/site/.site-files.json", ["../../outside.txt"]);
  assert.throws(() => buildSite(dir, "out/site"));
});

test("site CLI obeys JSON contract and absent data has clear placeholders", (t) => {
  const dir = workspace(t);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(root, "node_modules/tsx/dist/loader.mjs"),
      path.join(root, "scripts/site-build.ts"),
      "--out",
      "out/site",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, AGENTBROS_MEMORY_ROOT: path.join(dir, "memory") },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.ok(JSON.parse(result.stdout).ok);
  for (const [file, message] of [
    ["index.html", "No showcases published"],
    ["benchmarks/index.html", "No benchmark results"],
    ["metrics/index.html", "No metrics snapshot"],
    ["needs/index.html", "No needs snapshot"],
  ])
    assert.ok(readFileSync(path.join(dir, "out/site", file!), "utf8").includes(message!));
  assert.throws(() => buildSite(dir, "."), /escapes/);
});

test("contributor stats recover consumed change history, deduplicate PRs, count attributed uses and skip unknown authors", (t) => {
  const dir = workspace(t);
  git(dir, ["init", "-q"]);
  write(dir, "AGENTS.md", "Instructions that will be reduced.\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "Initial"]);
  write(
    dir,
    ".changes/first.md",
    '---\ncategory: library\nbump: patch\nbreaking: false\npr: 0\nauthors: ["@previous-author"]\n---\n\nAdd a useful block.\n',
  );
  write(
    dir,
    ".changes/duplicate.md",
    '---\ncategory: library\nbump: patch\nbreaking: false\npr: 10\nauthors: ["@fixture-author"]\n---\n\nSame pull request.\n',
  );
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "Merged library contribution"]);
  write(
    dir,
    ".changes/first.md",
    '---\ncategory: library\nbump: patch\nbreaking: false\npr: 10\nauthors: ["@fixture-author"]\n---\n\nAdd a useful block.\n',
  );
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "Stamp merged PR and correct attribution"]);
  rmSync(path.join(dir, ".changes/first.md"));
  rmSync(path.join(dir, ".changes/duplicate.md"));
  write(
    dir,
    ".changes/instructions.md",
    '---\ncategory: instructions\nbump: patch\nbreaking: false\npr: 11\nauthors: ["@fixture-author"]\n---\n\nReduce instructions.\n',
  );
  write(dir, "AGENTS.md", "Short.\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "Merged instruction contribution"]);
  write(
    dir,
    ".changes/unmerged.md",
    '---\ncategory: sensor\nbump: patch\nbreaking: false\npr: 12\nauthors: ["@fixture-author"]\n---\n\nUnmerged.\n',
  );
  write(dir, "showcases/synthetic-film/showcase.json", entry);
  write(dir, "docs/library/catalogue.json", {
    items: [{ id: "sample-block", authors: ["@fixture-author"] }, { id: "unattributed" }],
  });
  write(dir, "bench/results/example.json", { author: "fixture-author", reproduced: true });
  const result = contributorStats(dir),
    row = result.contributors[0]!;
  assert.equal(result.contributors.length, 1, JSON.stringify(result));
  assert.equal(row.mergedByCategory.library, 1, JSON.stringify(result));
  assert.equal(row.mergedByCategory.instructions, 1, JSON.stringify(result));
  assert.equal(row.mergedByCategory.sensor, undefined);
  assert.equal(row.blocksAuthored, 1);
  assert.equal(row.blockShowcaseUses, 1);
  assert.equal(row.showcases, 1);
  assert.equal(row.benchmarkBundlesReproduced, 1);
  assert.equal(
    row.instructionBytesRemoved,
    Buffer.byteLength("Instructions that will be reduced.\n") - Buffer.byteLength("Short.\n"),
  );
  assert.ok(row.badges.includes("First block"));
  assert.ok(result.warnings.some((warning) => warning.includes("no recorded authors")));
  write(
    dir,
    ".changes/first.md",
    '---\ncategory: sensor\nbump: patch\nbreaking: false\npr: 13\nauthors: ["@new-author"]\n---\n\nA later contribution reuses the consumed filename.\n',
  );
  git(dir, ["add", ".changes/first.md"]);
  git(dir, ["commit", "-qm", "Reuse a consumed change filename"]);
  const reused = contributorStats(dir);
  assert.equal(reused.contributors.find((person) => person.handle === "fixture-author")?.mergedByCategory.library, 1);
  assert.equal(reused.contributors.find((person) => person.handle === "new-author")?.mergedByCategory.sensor, 1);
});
