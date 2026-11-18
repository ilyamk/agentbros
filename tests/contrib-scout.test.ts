import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { instructionBaseline, lintInstructions } from "../src/lib/context/lint";
import type { CatalogueItem } from "../src/lib/library/catalogue";
import type { Playbook } from "../src/types/playbook";
import type { Opportunity } from "../src/types/contrib-tools";
import {
  meetsRequirements,
  needsMarkdown,
  onlineScout,
  opportunity,
  parseCapabilities,
  rankOpportunities,
  scoutCommands,
  scoutCurated,
  scoutInstructionBaseline,
  scoutLibrary,
  scoutPlaybooks,
  scoutProviders,
  scoutProvisional,
  scoutReferenceGaps,
  scoutShrinking,
  scoutSkippedTests,
  scoutSlop,
  scoutTechniques,
} from "../src/lib/contrib/scout";
import { textRepository } from "./contrib-tools-helpers";

const row = () =>
  opportunity(
    "draft:demo",
    "playbook",
    "M",
    "Improve demo",
    "A draft needs coverage.",
    ["playbooks/demo/playbook.json"],
    ["Add benchmark evidence."],
  );
test("playbook and provisional sources are stable and do not infer readiness", () => {
  const books = [
    { id: "demo", status: "draft" as const, benchmarks: [] },
    { id: "ready", status: "ready" as const, benchmarks: ["fixture"] },
  ];
  assert.deepEqual(
    scoutPlaybooks(books).map((item) => item.category),
    ["playbook", "bench"],
  );
  assert.deepEqual(scoutPlaybooks(books), scoutPlaybooks(books));
  const source = "// provisional: tune on references\nconst limit = 3;\n";
  const repo = textRepository({ "src/lib/sensors/demo.ts": source, "docs/demo.ts": source });
  const provisional = scoutProvisional(repo);
  assert.equal(provisional.length, 1);
  assert.equal(provisional[0]!.category, "sensor");
  assert.equal(
    scoutProvisional(textRepository({ "src/lib/sensors/demo.ts": `\n${source}` }))[0]!.id,
    provisional[0]!.id,
  );
});
test("ready playbooks with no benchmark remain scout opportunities until coverage is added", () => {
  const book = { id: "ready", status: "ready" as const, benchmarks: [] as string[] };
  const rows = scoutPlaybooks([book]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.category, "bench");
  assert.equal(rows[0]!.title, "Benchmark ready");
  assert.deepEqual(scoutPlaybooks([{ ...book, benchmarks: ["task"] }]), []);
});
test("shrinking and provider sources consume shared metrics evidence", () => {
  assert.equal(
    scoutShrinking([{ file: "scripts/AGENTS.md", bytes: 13000, target: 12000 }])[0]!.category,
    "instructions",
  );
  assert.equal(
    scoutProviders([{ id: "demo", verified: false, evidence: [], missing: ["Pricing source and asOf date"] }]).length,
    1,
  );
  assert.deepEqual(
    scoutProviders([{ id: "demo", verified: false, evidence: [], missing: ["A test mentioning the provider"] }]),
    [],
  );
});
test("reference sources parse actual matrix and triage table columns and exclude closed classes", () => {
  const repo = textRepository({
    "design-reference/reference-gap-matrix.md":
      "## A film\n| t (s) | What happens | Engine | Library |\n|---|---|---|---|\n| 0–1 | A new move | R | missing |\n| 1–2 | Good | R | has `block` |\n| 2–3 | Weak | R | weak `other` |",
    "design-reference/gap-triage.md":
      "| # | Family | Member gaps | Class | Target |\n|---|---|---|---|---|\n| A1 | Needed | gap | BLOCK | `new` |\n| A2 | Existing | gap | COVERED | `old` |\n| A3 | Rejected | gap | SKIP | none |\n| A4 | Extension | gap | MODE | `old` |\n| A5 | Helper | gap | HELPER | `fn` |",
  });
  assert.deepEqual(
    scoutReferenceGaps(repo).map((item) => item.title),
    ["A new move", "Weak", "Needed", "Extension", "Helper"],
  );
});
test("library checks preview files and explicit playbook mentions; command coverage uses aliases", () => {
  const item = {
    id: "demo",
    importPath: "src/motion/library/demo.tsx",
    preview: { image: "docs/library/previews/demo.jpg" },
  } as CatalogueItem;
  const books = [{ library: { blocks: ["demo"] }, commands: ["used"] }] as Playbook[];
  assert.equal(
    scoutLibrary({ items: [item] }, books, textRepository({})).length,
    1,
    "declaration without an image is missing a preview",
  );
  assert.equal(
    scoutLibrary({ items: [item] }, books, textRepository({ "docs/library/previews/demo.jpg": "image" })).length,
    0,
  );
  assert.equal(
    scoutLibrary({ items: [item] }, [], textRepository({ "docs/library/previews/demo.jpg": "image" })).length,
    1,
  );
  const registry = [
    { alias: "used", script: null, section: "film" },
    { alias: "unused", script: "scripts/unused.ts", section: "film" },
    { alias: "spare", script: "scripts/spare.ts", section: "film" },
    { alias: "tool", script: "scripts/tool.ts", section: "dev" },
    { alias: null, script: "internal.ts", section: "dev" },
  ] as const;
  const commands = scoutCommands(registry, books);
  assert.deepEqual(
    commands.map((item) => item.title),
    ["Establish playbook use for 2 film commands", "Establish playbook use for 1 dev command"],
  );
  assert.deepEqual(commands[0]!.evidence, ["pnpm commands --section film", "pnpm unused", "pnpm spare"]);
  assert.equal(
    scoutCommands(registry.slice(2), books)[0]!.id,
    commands[0]!.id,
    "the id follows the section, not its members",
  );
  const many = Array.from({ length: 16 }, (_, index) => ({
    alias: `c${index}`,
    script: null,
    section: "dev" as const,
  }));
  const big = scoutCommands(many, books)[0]!;
  assert.equal(big.size, "M");
  assert.equal(big.evidence.length, 17);
  assert.equal(big.evidence.at(-1), "… and 1 more");
});
test("baseline source only proposes existing fingerprint findings; skipped tests retain evidence", () => {
  const files = { "AGENTS.md": "Use `pnpm missing` for this command.", "package.json": '{"scripts":{}}' };
  const baseline = instructionBaseline(lintInstructions(textRepository(files)));
  const rows = scoutInstructionBaseline(
    textRepository({ ...files, "contrib/instructions-baseline.json": JSON.stringify(baseline) }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.category, "instructions");
  assert.equal(rows[0]!.size, "S");
  assert.match(rows[0]!.title, /^Resolve \d+ instruction findings? in AGENTS\.md$/);
  assert.equal(rows[0]!.evidence.at(-1), "pnpm instructions:lint");
  assert.ok(rows[0]!.evidence.slice(0, -1).every((item) => /^AGENTS\.md:\d+$/.test(item)));
  assert.deepEqual(scoutInstructionBaseline(textRepository(files)), []);
  const skipped = scoutSkippedTests(
    textRepository({
      "tests/a.test.ts": "test.skip('a', () => {});\ntest('b', { skip: process.env.NO }, () => {});",
      "tests/b.test.ts": "test('c', () => {});",
    }),
  );
  assert.equal(skipped.length, 1, "one row per test file, none for a file without skips");
  assert.equal(skipped[0]!.title, "Review 2 skipped tests in tests/a.test.ts");
  assert.deepEqual(skipped[0]!.evidence, ["tests/a.test.ts:1", "tests/a.test.ts:2"]);
});
test("ranking follows value order; tier 0 prioritises S and permitted categories", () => {
  const bench = opportunity("b", "bench", "M", "Bench", "why", ["b"], ["done"]);
  const fix = opportunity("f", "fix", "S", "Fix", "why", ["f"], ["done"]);
  const instructions = opportunity("i", "instructions", "S", "Instructions", "why", ["i"], ["done"]);
  assert.deepEqual(
    rankOpportunities([fix, bench, bench, instructions]).map((item) => item.id),
    [bench.id, instructions.id, fix.id],
  );
  assert.deepEqual(
    rankOpportunities([bench, fix, instructions], 0).map((item) => item.id),
    [fix.id, bench.id],
  );
  assert.match(needsMarkdown([bench]), /# Contribution needs/);
});
test("online sources use an injectable gh runner, mark covering and drop taken work", () => {
  const source = row();
  const calls: string[][] = [];
  const runner = (command: string[]) => {
    calls.push(command);
    const stdout =
      command[1] === "issue"
        ? JSON.stringify([
            {
              number: 1,
              title: source.title,
              body: source.id,
              url: "https://example.invalid/issues/1",
              labels: [{ name: "agent-ready" }, { name: "category:playbook" }],
            },
          ])
        : command[1] === "pr"
          ? "[]"
          : "";
    return { exitCode: 0, stdout, stderr: "" };
  };
  const available = onlineScout([source], "/fixture", runner);
  assert.equal(available.opportunities.length, 2);
  assert.equal(available.opportunities[0]!.covering.length, 1);
  assert.ok(calls.every((command) => command[0] === "gh"));
  const taken = onlineScout([source], "/fixture", (command) => ({
    exitCode: 0,
    stdout:
      command[1] === "issue"
        ? "[]"
        : command[1] === "pr"
          ? JSON.stringify([
              {
                number: 2,
                title: "Some PR",
                body: "",
                url: "https://example.invalid/pull/2",
                files: [{ path: source.evidence[0] }],
              },
            ])
          : "",
    stderr: "",
  }));
  assert.equal(taken.opportunities.length, 0);
  assert.equal(taken.dropped[0]!.covering.length, 1);
  const claimed = onlineScout([source], "/fixture", (command) => ({
    exitCode: 0,
    stdout:
      command[1] === "issue"
        ? JSON.stringify([
            {
              number: 3,
              title: source.title,
              body: source.id,
              url: "https://example.invalid/issues/3",
              labels: [{ name: "claimed" }],
            },
          ])
        : command[1] === "pr"
          ? "[]"
          : "",
    stderr: "",
  }));
  assert.equal(claimed.opportunities.length, 0);
  const untriaged = onlineScout([], "/fixture", (command) => ({
    exitCode: 0,
    stdout:
      command[1] === "issue"
        ? JSON.stringify([
            {
              number: 4,
              title: "Unreviewed idea",
              body: "",
              url: "https://example.invalid/issues/4",
              labels: [{ name: "needs-triage" }],
            },
          ])
        : command[1] === "pr"
          ? "[]"
          : "",
    stderr: "",
  }));
  assert.equal(untriaged.opportunities.length, 0, "only maintainer-applied agent-ready issues reach the board");
  assert.match(
    onlineScout([source], "/fixture", () => ({ exitCode: 1, stdout: "", stderr: "no auth" })).warning!,
    /offline results retained/,
  );
  assert.match(
    onlineScout([source], "/fixture", (command) => ({
      exitCode: command[1] === "pr" ? 1 : 0,
      stdout: "",
      stderr: "failed",
    })).warning!,
    /query failed/,
  );
});

test("skip discovery ignores comments, fixture strings and false options, and ids survive line insertions", () => {
  const source = `// test.skip('comment', () => {});\nconst fixture = "test.skip('string', () => {})";\ntest('enabled', { skip: false }, () => {});\ntest.skip('real', () => {});\ntest('conditional', { skip: process.env.OPTIONAL }, () => {});`;
  const before = scoutSkippedTests(textRepository({ "tests/demo.test.ts": source }));
  const after = scoutSkippedTests(textRepository({ "tests/demo.test.ts": `\n\n${source}` }));
  assert.equal(before.length, 1);
  assert.equal(before[0]!.evidence.length, 2);
  assert.deepEqual(
    before.map((item) => item.id),
    after.map((item) => item.id),
  );
});
test("a shared catalogue edit does not take unrelated blocks, while extensionless source paths match", () => {
  const first = opportunity(
    "first",
    "library",
    "S",
    "First block",
    "Missing preview",
    ["docs/library/catalogue.json", "src/motion/library/First"],
    ["Add preview"],
  );
  const second = opportunity(
    "second",
    "library",
    "S",
    "Second block",
    "Missing preview",
    ["docs/library/catalogue.json", "src/motion/library/Second"],
    ["Add preview"],
  );
  const result = onlineScout([first, second], "/fixture", (command) => ({
    exitCode: 0,
    stdout:
      command[1] === "issue"
        ? "[]"
        : command[1] === "pr"
          ? JSON.stringify([
              {
                number: 1,
                title: "Preview first",
                body: "Regenerates docs/library/catalogue.json",
                url: "https://example.invalid/pull/1",
                files: [{ path: "docs/library/catalogue.json" }, { path: "src/motion/library/First.tsx" }],
              },
            ])
          : "",
    stderr: "",
  }));
  assert.deepEqual(
    result.opportunities.map((item) => item.id),
    [second.id],
  );
  assert.deepEqual(
    result.dropped.map((item) => item.id),
    [first.id],
  );
});

test("instruction findings group per file with distinct codes, capped evidence and a size from the count", () => {
  const lines = Array.from({ length: 12 }, (_, index) => `Use \`pnpm missing-${index}\` here.`).join("\n\n");
  const files = { "docs/AGENTS.md": lines, "AGENTS.md": "Use `pnpm absent` once.", "package.json": '{"scripts":{}}' };
  const findings = lintInstructions(textRepository(files));
  const rows = scoutInstructionBaseline(
    textRepository({ ...files, "contrib/instructions-baseline.json": JSON.stringify(instructionBaseline(findings)) }),
  );
  assert.equal(rows.length, 2);
  const big = rows.find((item) => item.title.endsWith("docs/AGENTS.md"))!;
  const count = findings.filter((item) => item.file === "docs/AGENTS.md").length;
  assert.ok(count > 10);
  assert.equal(big.size, "M");
  assert.equal(big.title, `Resolve ${count} instruction findings in docs/AGENTS.md`);
  assert.equal(big.evidence.length, 12);
  assert.equal(big.evidence[10], `… and ${count - 10} more`);
  assert.match(
    big.why,
    new RegExp(
      [...new Set(findings.filter((item) => item.file === "docs/AGENTS.md").map((item) => item.code))].join(", "),
    ),
  );
  assert.notEqual(
    big.id,
    scoutShrinking([{ file: "docs/AGENTS.md", bytes: 2, target: 1 }])[0]!.id,
    "a file both over target and baselined keeps both rows",
  );
});
test("technique source proposes draft cards only, sized by an existing demo, with stable ids", () => {
  const card = (id: string, status: string, demo?: string) =>
    `---\nid: ${id}\nname: "${id} name: quoted"\nintent: x\nroute: remotion\ntiming: x\n${demo ? `demo: ${demo}\n` : ""}sources: ["a.json"]\nstatus: ${status}\n---\n\n**What it does.** x\n`;
  const files = {
    "design-reference/techniques/with-demo.md": card("with-demo", "draft", "src/motion/library/A.tsx"),
    "design-reference/techniques/no-demo.md": card("no-demo", "draft"),
    "design-reference/techniques/done.md": card("done", "demonstrated", "src/motion/library/B.tsx"),
    "design-reference/techniques/confirmed.md": card("confirmed", "confirmed"),
    "design-reference/techniques/README.md": "---\nid: readme\nname: Readme\nstatus: draft\n---\n",
    "design-reference/techniques/notes.md": "No front-matter here.\n",
    "design-reference/techniques/nested/deep.md": card("deep", "draft"),
  };
  const rows = scoutTechniques(textRepository(files));
  assert.deepEqual(
    rows.map((item) => [item.title, item.size, item.category]),
    [
      ["Demonstrate the no-demo name: quoted technique", "M", "library"],
      ["Demonstrate the with-demo name: quoted technique", "S", "library"],
    ],
  );
  assert.deepEqual(rows[1]!.evidence, ["design-reference/techniques/with-demo.md", "src/motion/library/A.tsx"]);
  assert.ok(
    rows.every(
      (item) =>
        item.definitionOfDone.some((step) => /lab composition/.test(step)) &&
        item.definitionOfDone.some((step) => /pnpm library:catalogue/.test(step)),
    ),
  );
  assert.ok(
    rows[0]!.definitionOfDone.some((step) => /library contract/.test(step)),
    "a card without a block asks for one",
  );
  const moved = scoutTechniques(
    textRepository({
      ...files,
      "design-reference/techniques/with-demo.md": `${card("with-demo", "draft", "src/motion/library/A.tsx")}\nMore body.\n`,
    }),
  );
  assert.equal(moved[1]!.id, rows[1]!.id);
  const libraryRow = scoutLibrary(
    { items: [{ id: "with-demo", importPath: "src/motion/library/A.tsx" } as CatalogueItem] },
    [],
    textRepository({}),
  )[0]!;
  assert.notEqual(libraryRow.id, rows[1]!.id, "a technique sharing a block id keeps its own row");
});
test("slop source reads provisional thresholds and critic-only 3D rows by header name", () => {
  const catalogue = [
    "# Slop catalogue",
    "",
    "Prose mentioning provisional and critic is ignored.",
    "",
    "| Signature | Sensor, code | Threshold | Source | Fix |",
    "|---|---|---|---|---|",
    "| Linear easing | plan:check `curve-linear` | names linear | provisional | Name the curve |",
    "| Fast motion | film:measure `fast-motion-sharp` | > 0.5 | calibrated: corpus p90 | Add blur |",
    "| Emoji | motion:check `EMOJI_TEXT` | any emoji | rule | Use a word |",
    "",
    "## 3D slop",
    "",
    "| Fix | Signature | Sensor |",
    "|---|---|---|",
    "| Write the intent | Turntable | critic; film:measure `motion-spread` reads rotation |",
    "| Ease it | Linear subject | critic (no eases read from video yet) |",
    "| Rest it | Floating object | `stage.report` floor gap |",
    "| Fix screens | Grey screens | measurable against the source image; critic |",
    "| Mixed | Mixed sensor | critic with `stage.report` gap; later |",
  ].join("\n");
  const rows = scoutSlop(textRepository({ "design-reference/slop-catalogue.md": catalogue }));
  assert.deepEqual(
    rows.map((item) => item.title),
    ['Calibrate the "Linear easing" threshold', 'Make "Turntable" measurable', 'Make "Linear subject" measurable'],
  );
  assert.ok(rows.every((item) => item.category === "sensor" && item.size === "M"));
  assert.equal(rows[0]!.evidence[0], "design-reference/slop-catalogue.md:7");
  assert.ok(
    rows[0]!.definitionOfDone.some((step) => /judge:calibrate/.test(step)) &&
      rows[0]!.definitionOfDone.some((step) => /calibration\.md/.test(step)),
  );
  const shifted = scoutSlop(textRepository({ "design-reference/slop-catalogue.md": `Intro\n\n${catalogue}` }));
  assert.deepEqual(
    shifted.map((item) => item.id),
    rows.map((item) => item.id),
  );
  assert.deepEqual(scoutSlop(textRepository({})), []);
  const covered = onlineScout(rows, "/fixture", (command) => ({
    exitCode: 0,
    stdout:
      command[1] === "pr"
        ? JSON.stringify([
            {
              number: 1,
              title: "Calibrate one",
              body: "",
              url: "https://example.invalid/pull/1",
              files: [{ path: "design-reference/slop-catalogue.md" }],
            },
          ])
        : command[1] === "issue"
          ? "[]"
          : "",
    stderr: "",
  }));
  assert.equal(covered.opportunities.length, rows.length, "one catalogue edit does not take every slop row");
});
test("curated source validates strictly, fails closed and derives ids from keys", () => {
  const file = (opportunities: unknown[]) =>
    textRepository({ "contrib/opportunities.json": JSON.stringify({ version: 1, opportunities }) });
  const entry = {
    key: "agent-prompts",
    category: "agent-skill",
    size: "M",
    title: "Tighten agent prompts",
    why: "Leaf agents repeat rules.",
    evidence: [".agents/agents/fixer.md"],
    definitionOfDone: ["Remove duplication; pass instruction lint."],
  };
  assert.deepEqual(scoutCurated(textRepository({})), []);
  assert.deepEqual(scoutCurated(file([])), []);
  const [row] = scoutCurated(file([entry]));
  assert.equal(row!.id, opportunity("curated:agent-prompts", "agent-skill", "M", "x", "x", ["x"], ["x"]).id);
  assert.deepEqual(
    [row!.title, row!.category, row!.size, row!.covering],
    [entry.title, entry.category, entry.size, []],
  );
  assert.equal(scoutCurated(file([{ ...entry, title: "Renamed" }]))[0]!.id, row!.id, "editing the text keeps the id");
  assert.throws(
    () => scoutCurated(textRepository({ "contrib/opportunities.json": "{" })),
    /contrib\/opportunities\.json is not valid JSON/,
  );
  assert.throws(() => scoutCurated(file([{ ...entry, extra: true }])), /contrib\/opportunities\.json is invalid/);
  assert.throws(() => scoutCurated(file([{ ...entry, evidence: [] }])), /is invalid/);
  assert.throws(() => scoutCurated(file([entry, entry])), /Duplicate curated opportunity key/);
  assert.throws(
    () => scoutCurated(file([{ ...entry, category: "not-a-category" }])),
    /unknown category not-a-category/,
  );
  assert.throws(
    () =>
      scoutCurated(textRepository({ "contrib/opportunities.json": JSON.stringify({ version: 2, opportunities: [] }) })),
    /is invalid/,
  );
});
test("the tracked curated file is valid", () => {
  assert.ok(
    Array.isArray(
      scoutCurated(
        textRepository({ "contrib/opportunities.json": readFileSync("contrib/opportunities.json", "utf8") }),
      ),
    ),
  );
});
test("F3: library rows ask for a renderable preview composition, never a contributed image", () => {
  const item = {
    id: "demo",
    importPath: "src/motion/library/demo.tsx",
    preview: { image: "docs/library/previews/demo.jpg" },
  } as CatalogueItem;
  const rows = [
    ...scoutLibrary({ items: [item] }, [], textRepository({})),
    ...scoutReferenceGaps(
      textRepository({
        "design-reference/gap-triage.md": "| # | Family | Class |\n|---|---|---|\n| A1 | Needed | BLOCK |",
      }),
    ),
  ];
  assert.equal(rows.length, 2);
  for (const row of rows)
    for (const text of [row.why, ...row.definitionOfDone]) {
      assert.doesNotMatch(
        text,
        /docs\/library\/previews|\.(?:jpg|png|webp)\b|supply a preview|preview image\b(?! is)/i,
        text,
      );
    }
  assert.ok(
    rows[0]!.definitionOfDone.some(
      (step) => /render from defaultProps/.test(step) && /maintainer renders the sheet after merge/.test(step),
    ),
  );
  assert.ok(rows[1]!.definitionOfDone.some((step) => /never commit preview images/.test(step)));
  const unused = scoutLibrary({ items: [item] }, [], textRepository({ "docs/library/previews/demo.jpg": "image" }))[0]!;
  assert.ok(
    unused.definitionOfDone.every((step) => !/preview/.test(step)),
    "a rendered preview is not asked for again",
  );
});
test("task contract: scouted rows carry source, priority 0 and empty requires and verify; ids keep their derivation", () => {
  const [draft] = scoutPlaybooks([{ id: "demo", status: "draft", benchmarks: ["x"] }]);
  assert.equal(draft!.id, createHash("sha256").update("playbook:draft:demo").digest("hex").slice(0, 16));
  assert.deepEqual(
    [draft!.source, draft!.priority, draft!.requires, draft!.read, draft!.verify],
    ["scout:playbooks", 0, { paid: false }, [], []],
  );
  assert.equal(
    scoutSlop(
      textRepository({
        "design-reference/slop-catalogue.md":
          "| Signature | Sensor | Threshold | Source |\n|---|---|---|---|\n| Linear | motion:check | 3 | provisional |",
      }),
    )[0]!.source,
    "scout:slop",
  );
  assert.equal(
    scoutSkippedTests(textRepository({ "tests/a.test.ts": "test.skip('a', () => {});" }))[0]!.source,
    "scout:skipped-tests",
  );
  const issue = onlineScout([], "/fixture", (command) => ({
    exitCode: 0,
    stdout:
      command[1] === "issue"
        ? JSON.stringify([
            {
              number: 9,
              title: "Ready",
              body: "",
              url: "https://example.invalid/issues/9",
              labels: [{ name: "agent-ready" }],
            },
          ])
        : command[1] === "pr"
          ? "[]"
          : "",
    stderr: "",
  }));
  assert.equal(issue.opportunities[0]!.source, "issue");
});
test("curated rows accept typed task fields; priority defaults by verify and spend is never required", () => {
  const file = (opportunities: unknown[]) =>
    textRepository({ "contrib/opportunities.json": JSON.stringify({ version: 1, opportunities }) });
  const base = {
    key: "k",
    category: "audio",
    size: "M",
    title: "T",
    why: "W",
    evidence: ["e"],
    definitionOfDone: ["d"],
  };
  const full = {
    ...base,
    priority: 3,
    value: { metric: "sensor:x.accuracy", rationale: "Why it matters." },
    requires: {
      os: ["macos"],
      gpu: true,
      tools: ["ffmpeg", "python"],
      harnessSession: ["codex"],
      signingKey: true,
      designApproval: true,
      paid: false,
    },
    read: ["a.md"],
    verify: ["pnpm typecheck"],
  };
  const [row] = scoutCurated(file([full]));
  assert.deepEqual(
    [row!.source, row!.priority, row!.value, row!.requires, row!.read, row!.verify],
    ["curated", 3, full.value, full.requires, full.read, full.verify],
  );
  assert.equal(scoutCurated(file([base]))[0]!.priority, 1, "no verify: priority 1");
  assert.deepEqual(scoutCurated(file([base]))[0]!.requires, { paid: false });
  assert.equal(scoutCurated(file([{ ...base, verify: ["pnpm lint"] }]))[0]!.priority, 2, "curated default 2");
  assert.equal(scoutCurated(file([{ ...base, requires: {} }]))[0]!.requires.paid, false);
  assert.throws(() => scoutCurated(file([{ ...base, priority: 2 }])), /without verify commands cannot have priority 2/);
  assert.throws(() => scoutCurated(file([{ ...base, requires: { paid: true } }])), /is invalid/);
  assert.throws(() => scoutCurated(file([{ ...base, requires: { tools: ["photoshop"] } }])), /is invalid/);
  assert.throws(() => scoutCurated(file([{ ...base, priority: 4, verify: ["pnpm lint"] }])), /is invalid/);
  assert.throws(() => scoutCurated(file([{ ...base, value: { metric: "m" } }])), /is invalid/);
});
test("curated rows outrank scouted rows, for every tier; priority orders curated rows", () => {
  const scouted = opportunity("b", "bench", "S", "Bench", "why", ["b"], ["done"]);
  const curated = opportunity("curated:s", "security", "M", "Security", "why", ["s"], ["done"], {
    source: "curated",
    priority: 1,
  });
  const urgent = opportunity("curated:d", "docs", "M", "Docs", "why", ["d"], ["done"], {
    source: "curated",
    priority: 2,
    verify: ["pnpm lint"],
  });
  assert.deepEqual(
    rankOpportunities([scouted, curated, urgent]).map((item) => item.title),
    ["Docs", "Security", "Bench"],
  );
  assert.deepEqual(
    rankOpportunities([scouted, curated, urgent], 0).map((item) => item.title),
    ["Docs", "Security", "Bench"],
    "tier 0 still puts curated M above scouted S",
  );
  assert.deepEqual(
    rankOpportunities([scouted, { ...curated, size: "L" }], 0).map((item) => item.title),
    ["Bench"],
    "the tier filter still applies",
  );
});
test("--can capabilities: unknown names fail; os and harness need one, tools all, gpu and signing key when set", () => {
  assert.throws(() => parseCapabilities("macos,teleport"), /Unknown capability teleport/);
  const caps = parseCapabilities(" macos, FFMPEG ,codex,");
  assert.deepEqual([...caps].sort(), ["codex", "ffmpeg", "macos"]);
  const needs = (requires: Opportunity["requires"]) => meetsRequirements({ requires }, caps);
  assert.ok(needs({ paid: false }));
  assert.ok(
    needs({
      os: ["macos", "linux"],
      harnessSession: ["claude-code", "codex"],
      tools: ["ffmpeg"],
      designApproval: true,
      gpu: false,
      signingKey: false,
      paid: false,
    }),
  );
  assert.ok(!needs({ os: ["linux"], paid: false }));
  assert.ok(!needs({ tools: ["ffmpeg", "blender"], paid: false }));
  assert.ok(!needs({ harnessSession: ["claude-code"], paid: false }));
  assert.ok(!needs({ gpu: true, paid: false }));
  assert.ok(!needs({ signingKey: true, paid: false }));
  assert.ok(
    meetsRequirements({ requires: { gpu: true, signingKey: true, paid: false } }, parseCapabilities("gpu,signing-key")),
  );
});
test("the tracked curated tasks are complete, honest and verifiable offline", () => {
  const rows = scoutCurated(
    textRepository({ "contrib/opportunities.json": readFileSync("contrib/opportunities.json", "utf8") }),
  );
  const scripts = Object.keys(
    (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts,
  );
  assert.ok(rows.length >= 12);
  for (const row of rows) {
    assert.equal(row.source, "curated");
    assert.equal(row.requires.paid, false);
    assert.ok(row.value?.rationale, `${row.title}: value`);
    assert.ok(row.priority < 2 || row.verify.length, `${row.title}: priority ≥ 2 needs verify`);
    for (const file of row.read) assert.ok(existsSync(file), `${row.title}: read ${file}`);
    for (const command of row.verify) {
      const words = command.split(/\s+/);
      if (words[0] === "pnpm")
        assert.ok(scripts.includes(words[1]!), `${row.title}: ${command} names no package script`);
      else {
        assert.deepEqual(
          words.slice(0, 3),
          ["npx", "tsx", "--test"],
          `${row.title}: ${command} is neither pnpm <script> nor npx tsx --test`,
        );
        assert.ok(
          words.length > 3 && words.slice(3).every((file) => /^tests\/.+\.test\.tsx?$/.test(file) && existsSync(file)),
          `${row.title}: ${command} names a missing test file`,
        );
      }
    }
  }
  assert.ok(
    rankOpportunities([...rows, opportunity("b", "bench", "S", "Bench", "why", ["b"], ["done"])])
      .at(-1)!
      .source.startsWith("scout"),
  );
});
