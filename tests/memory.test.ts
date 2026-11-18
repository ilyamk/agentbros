import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addMemory,
  consolidate,
  getMemory,
  INDEX_FILE,
  loadMemory,
  markSeen,
  memoryDir,
  memoryFor,
  METRICS_FILE,
  moveProposal,
  PROPOSAL_NEXT,
  VERIFY_DAYS,
  parseFrontMatter,
  queryMemory,
  readFreshIndex,
  recordMetric,
  serialiseFrontMatter,
  setStatus,
  writeIndex,
} from "../src/lib/memory";
import { spawn, spawnSync } from "node:child_process";
import { MemoryIdSchema, PROPOSAL_STATES } from "../src/types/memory";
import { COMMANDS } from "../src/mcp/catalog";
import { PUBLIC_EMAIL } from "../src/lib/leak-scan";
import { prepareCommand } from "../src/mcp/bridge";

const REPO = process.cwd();

delete process.env.AGENTBROS_MEMORY_ROOT;

const fresh = () => mkdtempSync(path.join(tmpdir(), "avc-memory-"));
const user = (quote = "I want it shorter") => ({ kind: "user" as const, quote });
const agent = { kind: "agent" as const, agent: "creative-critic", evidence: "critique.md frame 120" };
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "none";
};

test("memoryDir: the env root wins, else <root>/memory", () => {
  assert.equal(memoryDir("/x"), path.resolve("/x/memory"));
  process.env.AGENTBROS_MEMORY_ROOT = "/tmp/elsewhere";
  try {
    assert.equal(memoryDir("/x"), path.resolve("/tmp/elsewhere"));
  } finally {
    delete process.env.AGENTBROS_MEMORY_ROOT;
  }
});

test("front matter round-trips and refuses lines outside the subset", () => {
  const data = {
    version: 1,
    id: "lesson-20261114-x",
    summary: 'Кавычки "и" \nстроки',
    scope: { playbooks: ["explainer"], project: "demo" },
    source: { kind: "user", quote: "да" },
  };
  const text = serialiseFrontMatter(data, "Body text");
  assert.deepEqual(parseFrontMatter(text), { data, body: "Body text\n" });
  assert.deepEqual(parseFrontMatter("---\ntype: lesson\noccurrences: 2\n---\n").data, {
    type: "lesson",
    occurrences: 2,
  });
  assert.throws(() => parseFrontMatter("no front matter"), /no front matter/);
  assert.throws(() => parseFrontMatter("---\n- item\n---\n"), /line 2/);
  assert.throws(() => parseFrontMatter("---\n  nested: 1\n---\n"), /outside a map/);
  assert.throws(() => parseFrontMatter("---\na: 1\na: 2\n---\n"), /duplicate key a/);
  assert.throws(() => parseFrontMatter("---\na: {broken\n---\n"), /not a JSON value/);
});

test("schema refusals: an agent-sourced lesson, an episode without a project, an id of another type", () => {
  const root = fresh();
  assert.throws(
    () => addMemory({ type: "lesson", summary: "Long holds bore the viewer", scope: {}, source: agent }, root),
    (error: Error & { code?: string }) =>
      error.code === "VALIDATION" && /a lesson comes only from the user's own words/.test(error.message),
  );
  assert.throws(
    () =>
      addMemory(
        {
          type: "episode",
          summary: "Promo delivered in three rounds",
          scope: {},
          source: { kind: "measured", evidence: "film:status" },
        },
        root,
      ),
    /an episode names its project/,
  );
  assert.throws(
    () =>
      addMemory(
        {
          id: "gap-20261114-wrong",
          type: "observation",
          summary: "Critic flagged a flat ending",
          scope: {},
          source: agent,
        },
        root,
      ),
    /id must start with "observation-"/,
  );
  assert.deepEqual(loadMemory(root).entries, [], "nothing is written on a refusal");
  assert.equal(existsSync(path.join(root, "memory", ".lock")), false, "the lock is released");
});

test("add writes the file and index; supersede marks the target; duplicates and near-duplicates are refused", () => {
  const root = fresh();
  const first = addMemory(
    {
      type: "preference",
      summary: "Captions in the lower third, never centred",
      scope: { playbooks: ["explainer"] },
      source: user("субтитры снизу"),
      body: "Said after the second round.",
      createdAt: "2026-11-01",
    },
    root,
  );
  assert.equal(first.id, "preference-20261101-captions-in-the-lower-third-never-centred");
  const stored = getMemory(first.id, root);
  assert.equal(stored.body, "Said after the second round.\n");
  assert.equal(stored.status, "active");
  const index = JSON.parse(readFileSync(path.join(root, "memory", INDEX_FILE), "utf8"));
  assert.deepEqual(
    index.entries.map((entry: { id: string; file: string }) => [entry.id, entry.file]),
    [[first.id, `preferences/${first.id}.md`]],
  );

  assert.equal(
    codeOf(() =>
      addMemory(
        { type: "preference", summary: "Captions in the lower third, never centred!", scope: {}, source: user() },
        root,
      ),
    ),
    "FILE_EXISTS",
  );
  assert.throws(
    () =>
      addMemory(
        { type: "preference", summary: "captions in lower third never centred", scope: {}, source: user() },
        root,
      ),
    /--supersedes preference-20261101/,
  );
  const observation = addMemory(
    { type: "observation", summary: "Endings feel flat in promos", scope: {}, source: agent },
    root,
  );
  assert.throws(
    () => addMemory({ type: "observation", summary: "endings feel flat in promos", scope: {}, source: agent }, root),
    new RegExp(`--seen ${observation.id}`),
  );
  assert.equal(
    codeOf(() =>
      addMemory(
        { id: first.id, type: "preference", summary: "Something else entirely here", scope: {}, source: user() },
        root,
      ),
    ),
    "FILE_EXISTS",
  );
  assert.equal(
    codeOf(() =>
      addMemory(
        {
          type: "decision",
          summary: "Use the brand blue",
          scope: {},
          source: user(),
          supersedes: ["decision-20200101-missing"],
        },
        root,
      ),
    ),
    "VALIDATION",
  );

  const second = addMemory(
    {
      type: "preference",
      summary: "Captions in the lower third, never centred, white",
      scope: {},
      source: user(),
      supersedes: [first.id],
      createdAt: "2026-11-10",
    },
    root,
  );
  assert.equal(getMemory(first.id, root).status, "superseded");
  assert.equal(getMemory(first.id, root).reviewedAt, "2026-11-10");
  assert.equal(getMemory(second.id, root).status, "active");
});

test("ids: Cyrillic summaries get a hash slug, collisions a suffix, and every id passes the schema", () => {
  const root = fresh();
  const cyrillic = addMemory(
    {
      type: "decision",
      summary: "Музыка без слов во всех роликах",
      scope: {},
      source: user("без слов"),
      createdAt: "2026-11-14",
    },
    root,
  );
  assert.match(cyrillic.id, /^decision-20261114-[0-9a-f]{8}$/);
  const long = addMemory(
    {
      type: "observation",
      summary: "a - b  c ".repeat(10) + "tail words that run on",
      scope: {},
      source: agent,
      createdAt: "2026-11-14",
    },
    root,
  );
  assert.ok(MemoryIdSchema.safeParse(long.id).success, long.id);
  setStatus(long.id, "retired", root);
  const again = addMemory(
    {
      type: "observation",
      summary: "a - b  c ".repeat(10) + "tail words that run on",
      scope: {},
      source: agent,
      createdAt: "2026-11-14",
    },
    root,
  );
  assert.equal(again.id, `${long.id}-2`);
});

test("seen counts sightings of observations and gaps only; retire and reindex", () => {
  const root = fresh();
  const observation = addMemory(
    { type: "observation", summary: "The critic flags flat endings in promos", scope: {}, source: agent },
    root,
  );
  assert.equal(markSeen(observation.id, root).occurrences, 2);
  assert.equal(getMemory(observation.id, root).occurrences, 2);
  const decision = addMemory(
    { type: "decision", summary: "Always deliver a square cut too", scope: {}, source: user() },
    root,
  );
  assert.equal(
    codeOf(() => markSeen(decision.id, root)),
    "VALIDATION",
  );
  assert.equal(
    codeOf(() => markSeen("gap-20261114-none", root)),
    "FILE_NOT_FOUND",
  );
  assert.equal(setStatus(decision.id, "retired", root).status, "retired");
  writeFileSync(path.join(root, "memory", INDEX_FILE), "{}");
  writeIndex(root);
  const index = JSON.parse(readFileSync(path.join(root, "memory", INDEX_FILE), "utf8"));
  assert.deepEqual(
    index.entries
      .map((entry: { id: string; status: string; occurrences: number }) => [entry.id, entry.status, entry.occurrences])
      .sort(),
    [
      [decision.id, "retired", 1],
      [observation.id, "active", 2],
    ].sort(),
  );
});

test("query: text drops entries without a hit; matches keep the user's types first", () => {
  const root = fresh();
  const add = (
    type: "decision" | "preference" | "lesson" | "gap",
    summary: string,
    scope: Record<string, unknown>,
    source: unknown = user(),
  ) => addMemory({ type, summary, scope, source, createdAt: "2026-11-10" } as Parameters<typeof addMemory>[0], root).id;
  const decision = add("decision", "Promo films end on the product shot", {});
  const preference = add("preference", "Keep captions large on vertical films", {});
  const gap = add("gap", "No tool measures caption overlap with the UI", {}, agent);
  const other = add("gap", "Blender renders stall on the first frame", {}, agent);
  const captions = queryMemory({ text: "caption overlap" }, root).map((entry) => entry.id);
  assert.ok(captions.includes(gap), "a matching gap is returned");
  assert.ok(!captions.includes(decision), "a non-matching decision is not");
  assert.ok(!captions.includes(other), "a non-matching gap is not");
  assert.deepEqual(
    queryMemory({ text: "captions large overlap caption" }, root).map((entry) => entry.id),
    [preference, gap],
    "the user's types still rank first among matches",
  );
  assert.deepEqual(queryMemory({ text: "zebra crossing" }, root), [], "no match returns nothing");
  assert.equal(queryMemory({ text: "  " }, root).length, 4, "a query without terms keeps scope-only behaviour");
});

test("query: scope matching, ranking, limit and maxChars", () => {
  const root = fresh();
  const add = (
    type: "decision" | "preference" | "lesson" | "gap" | "observation" | "episode",
    summary: string,
    scope: Record<string, unknown>,
    createdAt: string,
    source: unknown = user(),
  ) => addMemory({ type, summary, scope, source, createdAt } as Parameters<typeof addMemory>[0], root).id;
  const anyObservation = add("observation", "Generic observation about pacing", {}, "2026-11-01", agent);
  const promoDecision = add(
    "decision",
    "Promo films end on the product shot",
    { playbooks: ["product-promo"] },
    "2026-10-01",
  );
  const anyPreference = add("preference", "Keep films under thirty seconds", {}, "2026-11-02");
  const explainerLesson = add(
    "lesson",
    "Explainers need one idea per scene",
    { playbooks: ["explainer"] },
    "2026-11-03",
  );
  const musicStep = add(
    "lesson",
    "Choose music before the script on promos",
    { playbooks: ["product-promo"], steps: ["music"] },
    "2026-11-04",
  );
  const tiktok = add("gap", "No tool trims to the TikTok safe zone", { platforms: ["tiktok"] }, "2026-11-05", agent);
  const episode = add("episode", "Demo promo took four rounds of critique", { project: "demo" }, "2026-11-06", {
    kind: "measured",
    evidence: "film:status",
  });
  const newerPreference = add("preference", "Prefer warm colour grades overall", {}, "2026-11-09");

  const promo = queryMemory({ playbook: "product-promo", step: "music" }, root).map((entry) => entry.id);
  assert.equal(promo[0], musicStep, "two specific matches first");
  assert.equal(promo[1], promoDecision, "then one specific match");
  assert.ok(!promo.includes(explainerLesson), "another playbook is excluded");
  assert.deepEqual(
    promo.slice(2),
    [newerPreference, anyPreference, tiktok, anyObservation, episode],
    "then type priority, newer first",
  );

  assert.deepEqual(
    queryMemory({ platform: "youtube-shorts" }, root)
      .map((entry) => entry.id)
      .includes(tiktok),
    false,
  );
  assert.equal(
    queryMemory({ project: "demo", types: ["observation", "gap", "episode"] }, root)[0]!.id,
    episode,
    "a project match ranks first within its tier",
  );
  assert.ok(!queryMemory({ project: "other" }, root).some((entry) => entry.id === episode));
  assert.deepEqual(
    queryMemory({ types: ["gap"] }, root).map((entry) => entry.id),
    [tiktok],
  );
  assert.equal(queryMemory({ text: "warm grades" }, root)[0]!.id, newerPreference, "text hits raise rank");
  assert.equal(queryMemory({}, root).length, 7, "limit defaults to 7");
  assert.equal(queryMemory({ limit: 2 }, root).length, 2);
  const capped = queryMemory({ maxChars: 70 }, root);
  assert.ok(capped.reduce((sum, entry) => sum + entry.summary.length, 0) <= 70);
  assert.equal(capped.length, 2);
  const preloaded = JSON.parse(readFileSync(path.join(root, "memory", INDEX_FILE), "utf8")).entries;
  assert.deepEqual(
    queryMemory({ playbook: "product-promo", step: "music" }, path.join(root, "nowhere"), preloaded),
    queryMemory({ playbook: "product-promo", step: "music" }, root),
    "index entries without bodies rank the same",
  );
  assert.deepEqual(memoryFor({ playbook: "product-promo" }, undefined, []), []);
  setStatus(promoDecision, "retired", root);
  assert.ok(
    !memoryFor({ playbook: "product-promo" }, root).some((entry) => entry.id === promoDecision),
    "retired entries are hidden",
  );
  assert.ok(
    queryMemory({ playbook: "product-promo", includeInactive: true, limit: 20 }, root).some(
      (entry) => entry.id === promoDecision,
    ),
  );
});

test("invalid and misplaced files become warnings, not exceptions", () => {
  const root = fresh();
  const good = addMemory({ type: "gap", summary: "No sensor for caption overlap", scope: {}, source: agent }, root);
  const dir = path.join(root, "memory");
  writeFileSync(path.join(dir, "gaps", "broken.md"), "no front matter");
  writeFileSync(
    path.join(dir, "gaps", "gap-20261114-agent-lesson.md"),
    serialiseFrontMatter({
      version: 1,
      id: "lesson-20261114-agent-lesson",
      type: "lesson",
      summary: "An agent cannot write this",
      scope: {},
      source: agent,
      createdAt: "2026-11-14",
    }),
  );
  mkdirSync(path.join(dir, "lessons"), { recursive: true });
  writeFileSync(
    path.join(dir, "lessons", "wrong-name.md"),
    serialiseFrontMatter({
      version: 1,
      id: "lesson-20261114-named",
      type: "lesson",
      summary: "File name differs from id",
      scope: {},
      source: user(),
      createdAt: "2026-11-14",
    }),
  );
  const { entries, warnings } = loadMemory(root);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [good.id],
  );
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((warning) => /broken\.md: no front matter/.test(warning)));
  assert.ok(warnings.some((warning) => /comes only from the user's own words/.test(warning)));
  assert.ok(warnings.some((warning) => /must be lesson-20261114-named\.md/.test(warning)));
  assert.equal(consolidate(root).broken.length, 3);
});

test("consolidate reports repeats, stale entries, duplicates and dangling supersedes", () => {
  const root = fresh();
  const observation = addMemory(
    {
      type: "observation",
      summary: "Hooks land late in vertical promos",
      scope: {},
      source: agent,
      createdAt: "2026-11-01",
    },
    root,
  );
  markSeen(observation.id, root);
  const old = addMemory(
    {
      type: "decision",
      summary: "Logo sits top left in every film",
      scope: {},
      source: user(),
      createdAt: "2026-01-01",
    },
    root,
  );
  addMemory(
    {
      type: "gap",
      summary: "Missing sensor for audio ducking depth",
      scope: {},
      source: agent,
      createdAt: "2026-11-01",
    },
    root,
  );
  const dir = path.join(root, "memory", "gaps");
  writeFileSync(
    path.join(dir, "gap-20261102-twin.md"),
    serialiseFrontMatter({
      version: 1,
      id: "gap-20261102-twin",
      type: "gap",
      summary: "Missing sensor for audio ducking depth!",
      scope: {},
      source: agent,
      supersedes: ["gap-20200101-gone"],
      createdAt: "2026-11-02",
    }),
  );
  const report = consolidate(root, new Date("2026-11-14T00:00:00Z"));
  assert.deepEqual(
    report.repeats.map((entry) => entry.id),
    [observation.id],
  );
  assert.deepEqual(
    report.stale.map((entry) => entry.id),
    [old.id],
  );
  assert.equal(report.duplicates.length, 1);
  assert.ok(report.duplicates[0]!.includes("gap-20261102-twin"));
  assert.deepEqual(report.broken, ["gap-20261102-twin: supersedes a missing entry gap-20200101-gone"]);
});

test("metrics append validated lines", () => {
  const root = fresh();
  recordMetric(
    { at: "2026-11-14T10:00:00Z", project: "demo", playbook: "product-promo", event: "round", value: 2 },
    root,
  );
  recordMetric({ at: "2026-11-14T11:00:00Z", project: "demo", event: "delivered" }, root);
  const lines = readFileSync(path.join(root, "memory", METRICS_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => line.event),
    ["round", "delivered"],
  );
  assert.equal(
    codeOf(() => recordMetric({ at: "yesterday", project: "demo", event: "round" }, root)),
    "VALIDATION",
  );
});

test("CLI: one JSON line per call, typed errors, the schema message", () => {
  const cwd = fresh();
  const run = (...args: string[]) => {
    const env = { ...process.env, AGENTBROS_MEMORY_ROOT: path.join(cwd, "memory") };
    const result = spawnSync(
      process.execPath,
      [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "scripts/memory.ts"), ...args],
      { cwd, encoding: "utf8", env },
    );
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1, result.stdout);
    const envelope = JSON.parse(lines[0]!);
    assert.equal(result.status, envelope.ok ? 0 : 1);
    return envelope;
  };
  const added = run(
    "--add",
    "--type",
    "decision",
    "--summary",
    "Every promo also ships a square cut",
    "--quote",
    "и квадрат тоже",
    "--playbook",
    "product-promo",
  );
  assert.equal(added.ok, true);
  const id = added.metadata.entry.id;
  assert.equal(added.outputs[0], `memory/decisions/${id}.md`);
  assert.equal(
    run("--add", "--type", "decision", "--summary", "Every promo also ships a square cut", "--quote", "again").error,
    "FILE_EXISTS",
  );
  const lesson = run(
    "--add",
    "--type",
    "lesson",
    "--summary",
    "Hooks show the product at once",
    "--agent",
    "creative-critic",
    "--evidence",
    "critique.md",
  );
  assert.equal(lesson.error, "VALIDATION");
  assert.match(lesson.message, /a lesson comes only from the user's own words/);
  assert.equal(run("--add", "--type", "gap", "--summary", "No sensor for caption overlap").error, "INVALID_INPUT");
  assert.equal(run("--list", "--consolidate").error, "INVALID_INPUT");
  assert.equal(run().error, "INVALID_INPUT");
  const gap = run(
    "--add",
    "--type",
    "gap",
    "--summary",
    "No sensor for caption overlap",
    "--agent",
    "qa-reviewer",
    "--evidence",
    "qa.json",
  );
  assert.equal(run("--seen", gap.metadata.entry.id).metadata.entry.occurrences, 2);
  assert.deepEqual(
    run("--query", "square", "--playbook", "product-promo").metadata.entries.map(
      (entry: { id: string }) => entry.id,
    )[0],
    id,
  );
  assert.equal(run("--id", id).metadata.entry.source.quote, "и квадрат тоже");
  assert.equal(run("--id", "gap-20261114-none").error, "FILE_NOT_FOUND");
  assert.equal(run("--retire", id).metadata.entry.status, "retired");
  assert.equal(run("--list", "--type", "decision").metadata.entries[0].status, "retired");
  assert.deepEqual(
    run("--consolidate").metadata.repeats.map((entry: { id: string }) => entry.id),
    [gap.metadata.entry.id],
  );
  assert.equal(run("--reindex").metadata.entries, 2);
});

test("MCP: the memory tool is read-only and refuses add, seen and retire", () => {
  const tool = COMMANDS.find((command) => command.name === "memory")!;
  assert.equal(tool.readOnly, true);
  assert.equal(tool.paid, "local");
  const options = { root: fresh(), codeRoot: REPO, allowPaid: false };
  assert.deepEqual(prepareCommand(tool, { query: "square cut", playbook: "product-promo", limit: 3 }, options).argv, [
    "--query=square cut",
    "--playbook=product-promo",
    "--limit=3",
  ]);
  assert.deepEqual(prepareCommand(tool, { consolidate: true }, options).argv, ["--consolidate=true"]);
  assert.deepEqual(prepareCommand(tool, { query: "sensor", type: "proposal" }, options).argv, [
    "--query=sensor",
    "--type=proposal",
  ]);
  assert.deepEqual(prepareCommand(tool, { list: true, type: "proposal" }, options).argv, [
    "--list=true",
    "--type=proposal",
  ]);
  for (const raw of [
    { add: true, type: "decision", summary: "x", quote: "y" },
    { seen: "gap-20261114-x" },
    { retire: "gap-20261114-x" },
    { reindex: true },
    { propose: true, summary: "x", change: "sensor", target: "a.ts", cause: "gap-20261114-x" },
    { approve: "proposal-20261114-x", quote: "yes" },
    { applied: "proposal-20261114-x", commit: "abcdef1" },
    { reject: "proposal-20261114-x" },
    { verdict: "proposal-20261114-x", state: "verified", text: "held" },
  ]) {
    assert.throws(() => prepareCommand(tool, raw, options), /unrecognized|Unrecognized/, JSON.stringify(raw));
  }
});

const cli = (cwd: string, memoryRoot: string, ...args: string[]) => {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "scripts/memory.ts"), ...args],
    { cwd, encoding: "utf8", env: { ...process.env, AGENTBROS_MEMORY_ROOT: memoryRoot } },
  );
  return JSON.parse(result.stdout.trim());
};

test("U+2028 and U+2029 survive a round trip, and supersede marks targets only after the new entry is safe", () => {
  const root = fresh();
  const old = addMemory(
    { type: "decision", summary: "Logo top left in every film", scope: {}, source: user("слева") },
    root,
  );
  const text = serialiseFrontMatter({ summary: "line\u2028separator", source: { quote: "para\u2029graph" } });
  assert.ok(!text.includes("\u2028") && !text.includes("\u2029"), "escaped on disk");
  assert.deepEqual(parseFrontMatter(text).data, {
    summary: "line\u2028separator",
    source: { quote: "para\u2029graph" },
  });
  const next = addMemory(
    {
      type: "decision",
      summary: "Logo top right\u2028in every film now",
      scope: {},
      source: user("справа\u2029всегда"),
      supersedes: [old.id],
    },
    root,
  );
  assert.equal(
    getMemory(next.id, root).source.kind === "user" && getMemory(next.id, root).summary,
    "Logo top right\u2028in every film now",
  );
  assert.equal(getMemory(old.id, root).status, "superseded");
  assert.deepEqual(loadMemory(root).warnings, []);
});

test("only the user's words can supersede a preference, decision or lesson", () => {
  const root = fresh();
  const decision = addMemory(
    { type: "decision", summary: "Every promo ships a square cut", scope: {}, source: user() },
    root,
  );
  assert.throws(
    () =>
      addMemory(
        {
          type: "observation",
          summary: "Square cuts are rarely watched",
          scope: {},
          source: agent,
          supersedes: [decision.id],
        },
        root,
      ),
    (error: Error & { code?: string }) =>
      error.code === "VALIDATION" && /only an entry from the user's words/.test(error.message),
  );
  assert.equal(getMemory(decision.id, root).status, "active");
  assert.equal(loadMemory(root).entries.length, 1, "the refused entry is not written");
  const observation = addMemory(
    { type: "observation", summary: "Square cuts are rarely watched", scope: {}, source: agent },
    root,
  );
  addMemory(
    {
      type: "observation",
      summary: "Square cuts get fewer views than vertical",
      scope: {},
      source: agent,
      supersedes: [observation.id],
    },
    root,
  );
  assert.equal(getMemory(observation.id, root).status, "superseded");
});

test("parallel writers do not lose sightings (lockfile)", async () => {
  const cwd = fresh();
  const memoryRoot = path.join(cwd, "memory");
  const gap = addMemory({ type: "gap", summary: "No sensor for caption overlap", scope: {}, source: agent }, cwd);
  const runs = Array.from(
    { length: 8 },
    () =>
      new Promise<number>((resolve) => {
        const child = spawn(
          process.execPath,
          [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "scripts/memory.ts"), "--seen", gap.id],
          { cwd, env: { ...process.env, AGENTBROS_MEMORY_ROOT: memoryRoot }, stdio: "ignore" },
        );
        child.on("exit", (code) => resolve(code ?? 1));
      }),
  );
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(getMemory(gap.id, cwd).occurrences, 9);
  assert.equal(existsSync(path.join(memoryRoot, ".lock")), false);
});

test("a stale lock is broken", () => {
  const root = fresh();
  mkdirSync(path.join(root, "memory"), { recursive: true });
  const lock = path.join(root, "memory", ".lock");
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  addMemory({ type: "gap", summary: "No sensor for caption overlap", scope: {}, source: agent }, root);
  assert.equal(existsSync(lock), false);
});

test("readFreshIndex returns rows only while every fingerprint matches", () => {
  const root = fresh();
  const gap = addMemory({ type: "gap", summary: "No sensor for caption overlap", scope: {}, source: agent }, root);
  const fresh1 = readFreshIndex(root);
  assert.deepEqual(
    fresh1?.entries.map((entry) => entry.id),
    [gap.id],
  );
  const file = path.join(root, "memory", "gaps", `${gap.id}.md`);
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);
  assert.equal(readFreshIndex(root), undefined, "a touched file");
  writeIndex(root);
  assert.ok(readFreshIndex(root));
  writeFileSync(path.join(root, "memory", "gaps", "extra.md"), "junk");
  assert.equal(readFreshIndex(root), undefined, "an added file");
  writeIndex(root);
  const index = JSON.parse(readFileSync(path.join(root, "memory", INDEX_FILE), "utf8"));
  delete index.files;
  writeFileSync(path.join(root, "memory", INDEX_FILE), JSON.stringify(index));
  assert.equal(readFreshIndex(root), undefined, "an index without fingerprints");
  assert.equal(readFreshIndex(fresh()), undefined, "no index");
});

test("near-duplicates count only within overlapping scope", () => {
  const root = fresh();
  addMemory(
    {
      type: "observation",
      summary: "Endings feel flat in the final cut",
      scope: { project: "alpha", playbooks: ["product-promo"] },
      source: agent,
    },
    root,
  );
  addMemory(
    {
      type: "observation",
      summary: "Endings feel flat in the final cut",
      scope: { project: "beta", playbooks: ["product-promo"] },
      source: agent,
    },
    root,
  );
  addMemory(
    {
      type: "observation",
      summary: "Endings feel flat in the final cut",
      scope: { project: "alpha", playbooks: ["explainer"] },
      source: agent,
    },
    root,
  );
  assert.equal(
    codeOf(() =>
      addMemory(
        {
          type: "observation",
          summary: "Endings feel flat in the final cut",
          scope: { project: "alpha" },
          source: agent,
        },
        root,
      ),
    ),
    "FILE_EXISTS",
  );
  assert.equal(
    codeOf(() =>
      addMemory(
        {
          type: "observation",
          summary: "Endings feel flat in the final cut",
          scope: { project: "alpha", playbooks: ["explainer", "ai-film"] },
          source: agent,
        },
        root,
      ),
    ),
    "FILE_EXISTS",
  );
  assert.deepEqual(consolidate(root).duplicates, []);
});

test("a type folder that is a file is a warning, not an exception", () => {
  const root = fresh();
  mkdirSync(path.join(root, "memory"), { recursive: true });
  writeFileSync(path.join(root, "memory", "gaps"), "not a folder");
  const { entries, warnings } = loadMemory(root);
  assert.deepEqual(entries, []);
  assert.deepEqual(warnings, ["gaps: not a folder"]);
});

test("the user's types rank above agent and measured ones, whatever their scope", () => {
  const root = fresh();
  const observation = addMemory(
    {
      type: "observation",
      summary: "Music choice drives the promo cut",
      scope: { playbooks: ["product-promo"], steps: ["music"] },
      source: agent,
      createdAt: "2026-11-10",
    },
    root,
  );
  const decision = addMemory(
    { type: "decision", summary: "No vocals in any soundtrack", scope: {}, source: user(), createdAt: "2026-01-01" },
    root,
  );
  const lesson = addMemory(
    {
      type: "lesson",
      summary: "Pick music before the script",
      scope: { playbooks: ["product-promo"] },
      source: user(),
      createdAt: "2026-11-01",
    },
    root,
  );
  assert.deepEqual(
    queryMemory({ playbook: "product-promo", step: "music" }, root).map((entry) => entry.id),
    [lesson.id, decision.id, observation.id],
  );
});

test("seen with evidence keeps a dated line in the body", () => {
  const root = fresh();
  const gap = addMemory(
    { type: "gap", summary: "No sensor for caption overlap", scope: {}, source: agent, body: "First seen in demo." },
    root,
  );
  markSeen(gap.id, root, "out/demo-2/qa  frame 40");
  markSeen(gap.id, root, "out/demo-3/qa frame 12");
  const lines = getMemory(gap.id, root).body.trim().split("\n");
  assert.equal(lines[0], "First seen in demo.");
  assert.match(lines[1]!, /^- Seen \d{4}-\d{2}-\d{2}: out\/demo-2\/qa frame 40$/);
  assert.match(lines[2]!, /^- Seen \d{4}-\d{2}-\d{2}: out\/demo-3\/qa frame 12$/);
});

test("CLI: playbook and step must be known; --seen --evidence; absolute outputs outside the working directory", () => {
  const cwd = fresh();
  const outside = path.join(fresh(), "memory");
  const unknownPlaybook = cli(
    cwd,
    outside,
    "--add",
    "--type",
    "gap",
    "--summary",
    "No sensor for caption overlap",
    "--agent",
    "orchestrator",
    "--evidence",
    "qa.json",
    "--playbook",
    "no-such-playbook",
  );
  assert.equal(unknownPlaybook.error, "VALIDATION");
  assert.match(unknownPlaybook.message, /Valid: .*product-promo/);
  const unknownStep = cli(cwd, outside, "--query", "x", "--step", "no-such-step");
  assert.equal(unknownStep.error, "VALIDATION");
  assert.match(unknownStep.message, /Valid: .*music.*voiceover/);
  const added = cli(
    cwd,
    outside,
    "--add",
    "--type",
    "gap",
    "--summary",
    "No sensor for caption overlap",
    "--measured",
    "pnpm qa:evidence --project demo",
    "--playbook",
    "product-promo",
    "--step",
    "qa,render",
  );
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.ok(path.isAbsolute(added.outputs[0]), added.outputs[0]);
  const seen = cli(cwd, outside, "--seen", added.metadata.entry.id, "--evidence", "out/demo/qa frame 3");
  assert.equal(seen.metadata.entry.occurrences, 2);
  assert.match(
    cli(cwd, outside, "--id", added.metadata.entry.id).metadata.entry.body,
    /Seen .*: out\/demo\/qa frame 3/,
  );
});

test("an entry can be scoped to a footage step id that starts with a digit", () => {
  const root = fresh();
  const lesson = addMemory(
    {
      type: "lesson",
      summary: "Captions stay two lines at most",
      scope: { steps: ["5-captions"] },
      source: user("две строки"),
    },
    root,
  );
  assert.deepEqual(getMemory(lesson.id, root).scope.steps, ["5-captions"]);
  assert.deepEqual(
    queryMemory({ step: "5-captions" }, root).map((entry) => entry.id),
    [lesson.id],
  );
  assert.deepEqual(queryMemory({ step: "9-render" }, root), []);
  const cwd = fresh();
  const added = cli(
    cwd,
    path.join(cwd, "memory"),
    "--add",
    "--type",
    "gap",
    "--summary",
    "No preview of caption styles side by side",
    "--agent",
    "orchestrator",
    "--evidence",
    "footage:next",
    "--step",
    "5-captions",
  );
  assert.equal(added.ok, true, JSON.stringify(added));
});

const gapIn = (root: string, summary = "No sensor measures caption overlap with UI") =>
  addMemory({ type: "gap", summary, scope: {}, source: agent }, root);
const propose = (root: string, causes: string[], summary = "Add a caption overlap sensor to qa") =>
  addMemory(
    {
      type: "proposal",
      summary,
      scope: {},
      source: { kind: "agent", agent: "orchestrator", evidence: "consolidate repeats" },
      proposal: { change: "sensor", targets: ["scripts/film-measure.ts"], causes, test: "tests/film-measure.test.ts" },
    },
    root,
  );
const SHA = "a".repeat(40);
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const onDisk = (root: string, id: string) => loadMemory(root).entries.find((entry) => entry.id === id)!;

test("seen appends the date to sightings, in step with occurrences, and it round-trips from disk", () => {
  const root = fresh();
  const gap = gapIn(root);
  assert.deepEqual(gap.sightings, []);
  markSeen(gap.id, root);
  markSeen(gap.id, root);
  const back = onDisk(root, gap.id);
  assert.equal(back.occurrences, 3);
  assert.deepEqual(back.sightings, [localToday(), localToday()]);
  assert.match(readFileSync(back.file, "utf8"), /^sightings: \["\d{4}-\d{2}-\d{2}","\d{4}-\d{2}-\d{2}"\]$/m);
});

test("a proposal answers existing, active observations, gaps or lessons and starts proposed", () => {
  const root = fresh();
  const gap = gapIn(root);
  const episode = addMemory(
    {
      type: "episode",
      summary: "Promo delivered after three rounds",
      scope: { project: "demo" },
      source: { kind: "measured", evidence: "delivery" },
    },
    root,
  );
  assert.equal(
    codeOf(() => propose(root, ["gap-20261114-missing"])),
    "VALIDATION",
  );
  assert.equal(
    codeOf(() => propose(root, [episode.id])),
    "VALIDATION",
  );
  assert.equal(
    codeOf(() =>
      addMemory(
        {
          type: "proposal",
          summary: "Add a caption overlap sensor",
          scope: {},
          source: { kind: "measured", evidence: "x" },
          proposal: { change: "sensor", targets: ["a.ts"], causes: [gap.id] },
        },
        root,
      ),
    ),
    "VALIDATION",
  );
  assert.equal(
    codeOf(() =>
      addMemory(
        {
          type: "proposal",
          summary: "Add a caption overlap sensor",
          scope: {},
          source: agent,
          proposal: {
            change: "sensor",
            targets: ["a.ts"],
            causes: [gap.id],
            state: "approved",
            approval: { quote: "yes", at: "2026-11-14" },
          },
        },
        root,
      ),
    ),
    "VALIDATION",
  );
  const retired = gapIn(root, "Nothing checks the loop frame matches the first");
  setStatus(retired.id, "retired", root);
  assert.equal(
    codeOf(() => propose(root, [retired.id])),
    "VALIDATION",
  );
  const proposal = propose(root, [gap.id]);
  assert.equal(proposal.proposal!.state, "proposed");
  const back = onDisk(root, proposal.id);
  assert.deepEqual(back.proposal, {
    change: "sensor",
    targets: ["scripts/film-measure.ts"],
    causes: [gap.id],
    state: "proposed",
    test: "tests/film-measure.test.ts",
    commits: [],
  });
  assert.equal(
    codeOf(() => setStatus(proposal.id, "retired", root)),
    "VALIDATION",
  );
  assert.equal(
    codeOf(() => markSeen(proposal.id, root)),
    "VALIDATION",
  );
});

test("every proposal transition: the legal ones persist, the illegal ones name the legal next states", () => {
  const root = fresh();
  const gap = gapIn(root);
  const moveTo = (to: string) =>
    to === "approved"
      ? ({ to, quote: "да, делай" } as const)
      : to === "applied"
        ? ({ to, commits: [SHA] } as const)
        : to === "rejected"
          ? ({ to, quote: "нет, не надо" } as const)
          : to === "retired"
            ? ({ to, verdict: "Because the user said so" } as const)
            : ({ to: to as "verified", verdict: "Because the user said so", quote: "да, помогло" } as const);
  const path_: Record<string, string[]> = {
    proposed: [],
    approved: ["approved"],
    applied: ["approved", "applied"],
    verified: ["approved", "applied", "verified"],
    ineffective: ["approved", "applied", "ineffective"],
    rejected: ["rejected"],
    retired: ["approved", "applied", "retired"],
  };
  let n = 0;
  for (const from of PROPOSAL_STATES) {
    for (const to of PROPOSAL_STATES) {
      if (to === "proposed") continue;
      const summary = `Proposal number ${++n} for a sensor ${"x".repeat(n)}`;
      const proposal = propose(root, [gap.id], summary);
      for (const step of path_[from]!) moveProposal(proposal.id, moveTo(step) as never, root);
      assert.equal(onDisk(root, proposal.id).proposal!.state, from);
      if (PROPOSAL_NEXT[from].includes(to)) {
        moveProposal(proposal.id, moveTo(to) as never, root);
        const back = onDisk(root, proposal.id);
        assert.equal(back.proposal!.state, to, `${from} -> ${to}`);
        if (to === "approved") assert.deepEqual(back.proposal!.approval, { quote: "да, делай", at: localToday() });
        if (to === "applied") {
          assert.deepEqual(back.proposal!.commits, [SHA]);
          assert.equal(back.proposal!.appliedAt, localToday());
        }
        if (to === "verified" || to === "ineffective" || to === "retired")
          assert.equal(back.proposal!.verdict, "Because the user said so");
        if (to === "verified" || to === "ineffective")
          assert.deepEqual(back.proposal!.confirmation, { quote: "да, помогло", at: localToday() });
        if (to === "rejected")
          assert.deepEqual(back.proposal!.confirmation, { quote: "нет, не надо", at: localToday() });
        assert.equal(back.status, to === "rejected" || to === "retired" ? "retired" : "active");
      } else {
        try {
          moveProposal(proposal.id, moveTo(to) as never, root);
          assert.fail(`${from} -> ${to} should be refused`);
        } catch (error) {
          const { code, message } = error as { code: string; message: string };
          assert.equal(code, "VALIDATION", `${from} -> ${to}`);
          const legal = PROPOSAL_NEXT[from];
          if (legal.length) assert.ok(message.includes(`Legal next states: ${legal.join(", ")}.`), message);
          else assert.match(message, /closed/);
        }
      }
    }
  }
  assert.equal(
    codeOf(() => moveProposal(gap.id, { to: "approved", quote: "yes" }, root)),
    "VALIDATION",
  );
});

test("proposals stay out of memoryFor and default queries, and show only when types names them", () => {
  const root = fresh();
  const gap = gapIn(root);
  const proposal = propose(root, [gap.id], "Caption overlap sensor in qa");
  assert.deepEqual(
    memoryFor({}, root).map((entry) => entry.id),
    [gap.id],
  );
  assert.deepEqual(
    queryMemory({ text: "caption overlap sensor" }, root).map((entry) => entry.id),
    [gap.id],
  );
  assert.deepEqual(
    queryMemory({ types: ["proposal"] }, root).map((entry) => entry.id),
    [proposal.id],
  );
  writeIndex(root);
  const index = readFreshIndex(root)!;
  assert.deepEqual(
    memoryFor({}, root, index.entries).map((entry) => entry.id),
    [gap.id],
  );
});

test("consolidate: suggest lists repeats without an open or held proposal; review grades applied proposals against a fixed now", () => {
  const root = fresh();
  const gap = gapIn(root);
  const observation = addMemory(
    { type: "observation", summary: "The critic flagged a flat ending twice", scope: {}, source: agent },
    root,
  );
  const lone = gapIn(root, "Nothing previews caption styles side by side");
  for (const id of [gap.id, observation.id, lone.id]) markSeen(id, root);
  const before = consolidate(root);
  assert.deepEqual(new Set(before.suggest.map((entry) => entry.id)), new Set([gap.id, observation.id, lone.id]));
  assert.deepEqual(before.review, []);
  const rejected = propose(root, [lone.id], "Preview caption styles together");
  moveProposal(rejected.id, { to: "rejected", verdict: "Not needed" }, root);
  const applied = propose(root, [gap.id]);
  moveProposal(applied.id, { to: "approved", quote: "go" }, root);
  moveProposal(applied.id, { to: "applied", commits: [SHA] }, root);
  const second = propose(root, [observation.id], "Critic floor for flat endings");
  moveProposal(second.id, { to: "approved", quote: "go" }, root);
  moveProposal(second.id, { to: "applied", commits: [SHA] }, root);
  const after = consolidate(root);
  assert.deepEqual(
    after.suggest.map((entry) => entry.id),
    [lone.id],
    "a rejected proposal does not answer its cause",
  );
  assert.deepEqual(after.repeats.length, 3, "repeats unchanged");

  const appliedAt = onDisk(root, applied.id).proposal!.appliedAt!;
  const at = (days: number) => new Date(Date.parse(`${appliedAt}T12:00:00`) + days * 86_400_000);
  const watching = consolidate(root, at(10)).review.find((entry) => entry.id === applied.id)!;
  assert.equal(watching.candidate, "watching");
  assert.equal(watching.daysLeft, VERIFY_DAYS - 10);
  assert.deepEqual(watching.recurred, []);
  const due = consolidate(root, at(VERIFY_DAYS)).review.find((entry) => entry.id === applied.id)!;
  assert.equal(due.candidate, "verified");
  assert.equal(due.daysSinceApplied, VERIFY_DAYS);

  const gapFile = onDisk(root, gap.id);
  const later = new Date(Date.parse(`${appliedAt}T12:00:00`) + 3 * 86_400_000);
  const laterDay = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, "0")}-${String(later.getDate()).padStart(2, "0")}`;
  const { data, body } = parseFrontMatter(readFileSync(gapFile.file, "utf8"));
  writeFileSync(
    gapFile.file,
    serialiseFrontMatter({ ...data, occurrences: 3, sightings: [...(data.sightings as string[]), laterDay] }, body),
  );
  const recurred = consolidate(root, at(40)).review;
  assert.deepEqual(recurred.find((entry) => entry.id === applied.id)!.candidate, "ineffective");
  assert.deepEqual(recurred.find((entry) => entry.id === applied.id)!.recurred, [{ id: gap.id, dates: [laterDay] }]);
  assert.equal(
    recurred.find((entry) => entry.id === second.id)!.candidate,
    "verified",
    "a same-day sighting is not after appliedAt",
  );
});

test("CLI: the proposal lifecycle round-trips in a temporary memory root; commits must exist in the repository", () => {
  const memoryRoot = path.join(fresh(), "memory");
  const outside = fresh();
  const run = (cwd: string, ...args: string[]) => cli(cwd, memoryRoot, ...args);
  const gap = run(
    outside,
    "--add",
    "--type",
    "gap",
    "--summary",
    "No sensor measures caption overlap",
    "--agent",
    "qa-reviewer",
    "--evidence",
    "qa.json",
  );
  run(outside, "--seen", gap.metadata.entry.id, "--evidence", "second film");
  assert.deepEqual(
    run(outside, "--consolidate").metadata.suggest.map((entry: { id: string }) => entry.id),
    [gap.metadata.entry.id],
  );
  assert.equal(
    run(
      outside,
      "--add",
      "--type",
      "proposal",
      "--summary",
      "Add a caption overlap sensor",
      "--agent",
      "orchestrator",
      "--evidence",
      "consolidate",
    ).error,
    "INVALID_INPUT",
  );
  assert.equal(run(outside, "--propose", "--summary", "Add a caption overlap sensor").error, "INVALID_INPUT");
  const proposed = run(
    outside,
    "--propose",
    "--summary",
    "Add a caption overlap sensor",
    "--change",
    "sensor",
    "--target",
    "scripts/film-measure.ts,tests/film-measure.test.ts",
    "--cause",
    gap.metadata.entry.id,
    "--test",
    "tests/film-measure.test.ts",
    "--agent",
    "orchestrator",
    "--evidence",
    "consolidate",
  );
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  assert.deepEqual(
    proposed.metadata.warnings.length,
    3,
    "neither target nor the test exists in a temporary working directory",
  );
  const id = proposed.metadata.entry.id;
  assert.match(proposed.outputs[0], new RegExp(`proposals/${id}\\.md$`));
  assert.deepEqual(
    run(outside, "--query", "caption overlap").metadata.entries.map((entry: { id: string }) => entry.id),
    [gap.metadata.entry.id],
  );
  assert.deepEqual(
    run(outside, "--query", "caption overlap", "--type", "proposal").metadata.entries.map(
      (entry: { id: string }) => entry.id,
    ),
    [id],
  );
  assert.equal(run(outside, "--list", "--type", "proposal").metadata.entries[0].state, "proposed");
  assert.deepEqual(run(outside, "--consolidate").metadata.suggest, []);
  assert.equal(run(outside, "--approve", id).error, "INVALID_INPUT");
  const early = run(outside, "--applied", id, "--commit", "abcdef1");
  assert.equal(early.error, "VALIDATION");
  assert.equal(run(outside, "--approve", id, "--quote", "да, добавь").metadata.entry.proposal.state, "approved");
  const notRepo = run(outside, "--applied", id, "--commit", "abcdef1");
  assert.equal(notRepo.error, "VALIDATION");
  assert.match(notRepo.message, /git repository/);
  assert.equal(run(REPO, "--applied", id, "--commit", "0000000deadbeef").error, "VALIDATION");
  assert.match(run(REPO, "--applied", id, "--commit", "HEAD~1").message, /not a commit sha/);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
  const applied = run(REPO, "--applied", id, "--commit", head.slice(0, 10));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const touchesTarget = spawnSync("git", ["show", "--name-only", "--format=", head], { cwd: REPO, encoding: "utf8" })
    .stdout.split("\n")
    .some((file) => file.startsWith("scripts/film-measure.ts") || file.startsWith("tests/film-measure.test.ts"));
  assert.equal(Boolean(applied.metadata.warnings), !touchesTarget);
  assert.deepEqual(applied.metadata.entry.proposal.commits, [head]);
  assert.equal(run(outside, "--consolidate").metadata.review[0].candidate, "watching");
  assert.equal(run(outside, "--verdict", id, "--state", "verified").error, "INVALID_INPUT");
  assert.equal(run(outside, "--retire", id).error, "VALIDATION");
  assert.equal(
    run(outside, "--verdict", id, "--state", "verified", "--text", "No overlap in the next films").error,
    "INVALID_INPUT",
  );
  const verified = run(
    outside,
    "--verdict",
    id,
    "--state",
    "verified",
    "--text",
    "No overlap in the next films",
    "--quote",
    "да, больше не вижу",
  );
  assert.equal(verified.metadata.entry.proposal.confirmation.quote, "да, больше не вижу");
  assert.equal(verified.metadata.entry.proposal.state, "verified");
  const illegal = run(outside, "--reject", id, "--text", "late");
  assert.equal(illegal.error, "VALIDATION");
  assert.match(illegal.message, /Legal next states: retired/);
  assert.equal(
    run(outside, "--verdict", id, "--state", "retired", "--text", "Superseded by a broader sensor").metadata.entry
      .status,
    "retired",
  );
  assert.ok(!existsSync(path.join(REPO, "memory", "proposals", `${id}.md`)), "the real memory/ is untouched");
});

test("a proposal cannot be closed by supersede; a retire proposal with the same words is not a near-duplicate", () => {
  const root = fresh();
  const gap = gapIn(root);
  markSeen(gap.id, root);
  const first = propose(root, [gap.id], "Add a caption overlap sensor to qa");
  assert.equal(
    codeOf(() => propose(root, [gap.id], "Add a caption overlap sensor to qa")),
    "FILE_EXISTS",
  );
  assert.equal(
    codeOf(() =>
      addMemory(
        { type: "gap", summary: "Captions overlap the product UI", scope: {}, source: agent, supersedes: [first.id] },
        root,
      ),
    ),
    "VALIDATION",
  );
  moveProposal(first.id, { to: "approved", quote: "go" }, root);
  moveProposal(first.id, { to: "applied", commits: [SHA] }, root);
  moveProposal(first.id, { to: "ineffective", verdict: "The overlap came back", quote: "не помогло" }, root);
  const retire = addMemory(
    {
      type: "proposal",
      summary: "Add a caption overlap sensor to qa",
      scope: {},
      source: { kind: "agent", agent: "orchestrator", evidence: "consolidate review" },
      proposal: { change: "retire", targets: ["scripts/film-measure.ts"], causes: [gap.id] },
    },
    root,
  );
  assert.equal(retire.proposal!.state, "proposed");
  moveProposal(first.id, { to: "retired", verdict: "Replaced by the retirement" }, root);
  assert.equal(onDisk(root, first.id).status, "retired");
});

test("the user words a verdict or the rejection of an approved proposal; retired and a plain rejection need none", () => {
  const root = fresh();
  const gap = gapIn(root);
  const plain = propose(root, [gap.id], "First idea for a sensor");
  const plainRejected = moveProposal(plain.id, { to: "rejected" }, root);
  assert.equal(plainRejected.proposal!.confirmation, undefined);
  const approved = propose(root, [gap.id], "Second idea for the overlap");
  moveProposal(approved.id, { to: "approved", quote: "go" }, root);
  assert.equal(
    codeOf(() => moveProposal(approved.id, { to: "rejected", verdict: "changed my mind" }, root)),
    "VALIDATION",
  );
  moveProposal(approved.id, { to: "rejected", quote: "передумал" }, root);
  assert.deepEqual(onDisk(root, approved.id).proposal!.confirmation, { quote: "передумал", at: localToday() });
  const applied = propose(root, [gap.id], "Third proposal about captions");
  moveProposal(applied.id, { to: "approved", quote: "go" }, root);
  moveProposal(applied.id, { to: "applied", commits: [SHA] }, root);
  for (const to of ["verified", "ineffective"] as const) {
    assert.equal(
      codeOf(() => moveProposal(applied.id, { to, verdict: "agent thinks so", quote: " " }, root)),
      "VALIDATION",
    );
  }
  assert.equal(
    moveProposal(applied.id, { to: "retired", verdict: "Retired by the orchestrator" }, root).status,
    "retired",
  );
});

test("consolidate review follows the supersede chain of a cause", () => {
  const root = fresh();
  const gap = gapIn(root);
  markSeen(gap.id, root);
  const proposal = propose(root, [gap.id]);
  moveProposal(proposal.id, { to: "approved", quote: "go" }, root);
  moveProposal(proposal.id, { to: "applied", commits: [SHA] }, root);
  const merged = addMemory(
    {
      type: "gap",
      summary: "Captions collide with product screens in qa",
      scope: {},
      source: agent,
      supersedes: [gap.id],
    },
    root,
  );
  const appliedAt = onDisk(root, proposal.id).proposal!.appliedAt!;
  const at = (days: number) => new Date(Date.parse(`${appliedAt}T12:00:00`) + days * 86_400_000);
  assert.equal(consolidate(root, at(40)).review[0]!.candidate, "verified");
  const file = onDisk(root, merged.id).file;
  const { data, body } = parseFrontMatter(readFileSync(file, "utf8"));
  const later = at(5);
  const laterDay = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, "0")}-${String(later.getDate()).padStart(2, "0")}`;
  writeFileSync(file, serialiseFrontMatter({ ...data, occurrences: 3, sightings: [laterDay, laterDay] }, body));
  const review = consolidate(root, at(40)).review[0]!;
  assert.equal(review.candidate, "ineffective");
  assert.deepEqual(review.recurred, [{ id: merged.id, dates: [laterDay, laterDay] }]);
  assert.ok(
    !consolidate(root, at(40)).suggest.some((entry) => entry.id === merged.id),
    "the successor of an answered cause is not suggested again",
  );
});

test("CLI --applied: a commit must be reachable from HEAD", () => {
  const repo = fresh();
  const g = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", `user.email=${PUBLIC_EMAIL}`, "-c", "commit.gpgsign=false", ...args], {
      cwd: repo,
      encoding: "utf8",
    });
  g("init", "-q", "-b", "main");
  g("commit", "-q", "--allow-empty", "-m", "base");
  g("checkout", "-q", "-b", "side");
  g("commit", "-q", "--allow-empty", "-m", "unmerged");
  const side = g("rev-parse", "HEAD").stdout.trim();
  g("checkout", "-q", "main");
  const base = g("rev-parse", "HEAD").stdout.trim();
  const memoryRoot = path.join(fresh(), "memory");
  const gap = cli(
    repo,
    memoryRoot,
    "--add",
    "--type",
    "gap",
    "--summary",
    "No sensor measures caption overlap",
    "--agent",
    "qa-reviewer",
    "--evidence",
    "qa.json",
  );
  const id = cli(
    repo,
    memoryRoot,
    "--propose",
    "--summary",
    "Add a caption overlap sensor",
    "--change",
    "sensor",
    "--target",
    "scripts/x.ts",
    "--cause",
    gap.metadata.entry.id,
    "--agent",
    "orchestrator",
    "--evidence",
    "consolidate",
  ).metadata.entry.id;
  cli(repo, memoryRoot, "--approve", id, "--quote", "да");
  assert.equal(
    cli(
      repo,
      memoryRoot,
      "--propose",
      "--summary",
      "A second sensor idea for overlap",
      "--change",
      "critic",
      "--target",
      "scripts/x.ts",
      "--cause",
      gap.metadata.entry.id,
      "--agent",
      "orchestrator",
      "--evidence",
      "consolidate",
    ).metadata.warnings.length,
    1,
  );
  const unmerged = cli(repo, memoryRoot, "--applied", id, "--commit", side);
  assert.equal(unmerged.error, "VALIDATION");
  assert.match(unmerged.message, /not reachable from HEAD/);
  const applied = cli(repo, memoryRoot, "--applied", id, "--commit", base.slice(0, 8));
  assert.deepEqual(applied.metadata.entry.proposal.commits, [base]);
  assert.match(applied.metadata.warnings[0], /None of the commits touches/);
  mkdirSync(path.join(repo, "scripts"));
  writeFileSync(path.join(repo, "scripts/x.ts"), "export {};\n");
  g("add", "scripts/x.ts");
  g("commit", "-q", "-m", "sensor");
  const touching = g("rev-parse", "HEAD").stdout.trim();
  const second = cli(
    repo,
    memoryRoot,
    "--propose",
    "--summary",
    "Another sensor for overlap in qa",
    "--change",
    "tool",
    "--target",
    "scripts/",
    "--cause",
    gap.metadata.entry.id,
    "--agent",
    "orchestrator",
    "--evidence",
    "consolidate",
  );
  assert.equal(second.metadata.warnings, undefined, "an existing directory target is fine");
  cli(repo, memoryRoot, "--approve", second.metadata.entry.id, "--quote", "да");
  assert.equal(
    cli(repo, memoryRoot, "--applied", second.metadata.entry.id, "--commit", touching).metadata.warnings,
    undefined,
  );
});

test("recordMetric with once writes a matching line only the first time, and says whether it wrote", () => {
  const root = fresh();
  const line = {
    at: "2026-11-14T10:00:00Z",
    project: "demo",
    event: "spend" as const,
    value: 1.5,
    detail: "receipt r1",
  };
  const onceFor = (detail: string) => ({ once: (existing: { detail?: string }) => existing.detail === detail });
  const once = onceFor("receipt r1");
  assert.equal(recordMetric(line, root, once), true);
  writeFileSync(
    path.join(memoryDir(root), METRICS_FILE),
    `${readFileSync(path.join(memoryDir(root), METRICS_FILE), "utf8")}not json\n`,
  );
  assert.equal(recordMetric({ ...line, at: "2026-11-14T11:00:00Z" }, root, once), false);
  assert.equal(recordMetric({ ...line, detail: "receipt r2" }, root, onceFor("receipt r2")), true);
  assert.equal(recordMetric(line, root), true, "without once it always appends");
  assert.equal(
    readFileSync(path.join(memoryDir(root), METRICS_FILE), "utf8")
      .trim()
      .split("\n").length,
    4,
  );
});

test("under the test runner, writes refuse the checkout's memory/ unless AGENTBROS_MEMORY_ROOT names it; reads still work", () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, "runs under node --test");
  const saved = process.env.AGENTBROS_MEMORY_ROOT;
  delete process.env.AGENTBROS_MEMORY_ROOT;
  try {
    const before = existsSync(path.join(REPO, "memory")) ? readdirSync(path.join(REPO, "memory")).sort() : [];
    assert.equal(
      codeOf(() => recordMetric({ at: "2026-11-14T10:00:00Z", project: "demo", event: "round" }, REPO)),
      "VALIDATION",
    );
    assert.equal(
      codeOf(() => addMemory({ type: "gap", summary: "Should never be written here", scope: {}, source: agent }, REPO)),
      "VALIDATION",
    );
    assert.equal(
      codeOf(() => writeIndex(REPO)),
      "VALIDATION",
    );
    assert.doesNotThrow(() => loadMemory(REPO));
    assert.deepEqual(
      existsSync(path.join(REPO, "memory")) ? readdirSync(path.join(REPO, "memory")).sort() : [],
      before,
    );
    assert.equal(
      recordMetric({ at: "2026-11-14T10:00:00Z", project: "demo", event: "round" }, fresh()),
      true,
      "a temporary root is fine",
    );
  } finally {
    if (saved === undefined) delete process.env.AGENTBROS_MEMORY_ROOT;
    else process.env.AGENTBROS_MEMORY_ROOT = saved;
  }
});

test("a proposal's scope is the union of its causes' scopes; a project only when all share one", () => {
  const root = fresh();
  const a = addMemory(
    {
      type: "gap",
      summary: "No sensor measures caption overlap with UI",
      scope: { playbooks: ["product-promo"], steps: ["qa"], platforms: ["tiktok"], project: "demo" },
      source: agent,
    },
    root,
  );
  const b = addMemory(
    {
      type: "observation",
      summary: "The critic flagged text over text twice",
      scope: { playbooks: ["ugc-ad"], steps: ["qa", "build"], project: "demo" },
      source: agent,
    },
    root,
  );
  const c = addMemory(
    {
      type: "observation",
      summary: "Loop frames differ from the first frame",
      scope: { platforms: ["youtube-shorts"], project: "other" },
      source: agent,
    },
    root,
  );
  const shared = propose(root, [a.id, b.id], "Overlap sensor for text");
  assert.deepEqual(shared.scope, {
    playbooks: ["product-promo", "ugc-ad"],
    steps: ["qa", "build"],
    platforms: ["tiktok"],
    axes: [],
    project: "demo",
  });
  const mixed = propose(root, [a.id, c.id], "Overlap and loop frame checks");
  assert.deepEqual(mixed.scope, {
    playbooks: ["product-promo"],
    steps: ["qa"],
    platforms: ["tiktok", "youtube-shorts"],
    axes: [],
  });
  assert.deepEqual(onDisk(root, mixed.id).scope, mixed.scope);
});
