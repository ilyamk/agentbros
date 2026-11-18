import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { memoryFor, serialiseFrontMatter, writeIndex, QUERY_LIMIT, QUERY_MAX_CHARS } from "../src/lib/memory";
import { lessonLines, memoryLines, MEMORY_LESSONS } from "../src/lib/film/brief";
import { loadMemoryFast } from "../src/lib/pipeline/memory";
import { MEMORY_HINT, memoryFields, projectPlatform } from "../src/lib/pipeline/route";
import { MEMORY_DIRS, type MemoryEntry, type MemoryType } from "../src/types/memory";

delete process.env.AGENTBROS_MEMORY_ROOT;
const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");

function workspace(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "memory-wire-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "public/projects"), { recursive: true });
  return dir;
}

/** A project bound to a real playbook (playbooks are read from the checkout). */
function project(root: string, id: string, playbook?: string, files: Record<string, unknown> = {}): string {
  const dir = path.join(root, "public/projects", id);
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  if (playbook) files["playbook.json"] = { version: 1, id: playbook, chosenAt: new Date().toISOString(), by: "user" };
  for (const [name, value] of Object.entries(files))
    writeFileSync(path.join(dir, "pipeline", name), JSON.stringify(value));
  return dir;
}

let serial = 0;
type Scope = { playbooks?: string[]; steps?: string[]; platforms?: string[]; project?: string };
/** Writes one entry file directly (addMemory refuses near-duplicates and is slow in bulk). */
function entry(root: string, type: MemoryType, summary: string, scope: Scope = {}, createdAt = "2026-11-01"): string {
  const id = `${type}-${createdAt.replaceAll("-", "")}-e${++serial}`;
  const source = ["preference", "decision", "lesson"].includes(type)
    ? { kind: "user", quote: "so I said" }
    : { kind: "agent", agent: "tester", evidence: "fixture" };
  const data: MemoryEntry = {
    version: 1,
    id,
    type,
    summary,
    scope: { playbooks: [], steps: [], platforms: [], axes: [], ...scope } as MemoryEntry["scope"],
    source: source as MemoryEntry["source"],
    status: "active",
    supersedes: [],
    occurrences: 1,
    sightings: [],
    createdAt,
  };
  const dir = path.join(root, "memory", MEMORY_DIRS[type]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${id}.md`),
    serialiseFrontMatter(data as unknown as Record<string, unknown>, "Body text.\n"),
  );
  return id;
}

const ids = (fields: { memory?: { id: string }[] }) => (fields.memory ?? []).map((ref) => ref.id).sort();

test("a bound project gets the entries scoped to its playbook, step and platform, and nothing else", (t) => {
  const root = workspace(t);
  const dir = project(root, "film", "explainer", { "strategy.json": { platform: { name: "YouTube Shorts" } } });
  const wanted = [
    entry(root, "decision", "Keep the product name in the first frame", { playbooks: ["explainer"], steps: ["build"] }),
    entry(root, "preference", "The user prefers calm music under a voiceover"),
    entry(root, "lesson", "Vertical cuts land better at one idea per beat", { platforms: ["youtube-shorts"] }),
  ];
  entry(root, "decision", "Motion design films open on a bold word", { playbooks: ["motion-design"] });
  entry(root, "preference", "Styleframes in a warm palette", { playbooks: ["explainer"], steps: ["look"] });
  entry(root, "lesson", "TikTok films need the hook in one second", { platforms: ["tiktok"] });
  assert.equal(projectPlatform(dir), "youtube-shorts");
  const fields = memoryFields(dir, "build");
  assert.deepEqual(ids(fields), [...wanted].sort());
  assert.equal(fields.memory![0]!.id, wanted[0], "the specific match ranks first");
  assert.equal(fields.memoryHint, MEMORY_HINT);
  assert.match(MEMORY_HINT, /pnpm memory --id <id>/);
  assert.equal(fields.memoryWarning, undefined);
});

test("an unknown step admits only entries scoped to no step; an unbound project gets no memory", (t) => {
  const root = workspace(t);
  const any = entry(root, "preference", "Short sentences in every caption");
  entry(root, "decision", "Approve the look before the beat sheet", { steps: ["look"] });
  assert.deepEqual(ids(memoryFields(project(root, "bound", "explainer"), null)), [any]);
  assert.deepEqual(memoryFields(project(root, "unbound"), "build"), {}, "an unscoped query would match every playbook");
  const captions = entry(root, "decision", "No emoji in burned captions", { steps: ["5-captions"] });
  assert.deepEqual(
    ids(memoryFields(project(root, "talk", "footage-edit"), "5-captions")),
    [any, captions].sort(),
    "footage step ids scope too",
  );
});

test("strategy and script-variants briefs carry the user's lessons for the playbook even when the cap is full", (t) => {
  const root = workspace(t);
  for (let i = 0; i < 8; i++)
    entry(root, "decision", `Decision ${i} the user made about every explainer film`, { playbooks: ["explainer"] });
  const lesson = entry(root, "lesson", "A proposition the audience can repeat beats a clever one", {
    playbooks: ["explainer"],
  });
  entry(root, "lesson", "Motion design films need one bold word", { playbooks: ["motion-design"] });
  const dir = project(root, "film", "explainer");
  for (const step of ["strategy", "script-variants"]) {
    const lines = memoryLines({ projectDir: dir }, step);
    assert.ok(
      lines.some((line) => line.startsWith(`- ${lesson} (lesson): `)),
      `${step}: ${lines.join("\n")}`,
    );
    assert.ok(!lines.some((line) => /one bold word/.test(line)), "another playbook's lesson stays out");
  }
  assert.ok(MEMORY_LESSONS >= 1);
  const director = lessonLines({ projectDir: dir }, "idea-review");
  assert.ok(
    director.some((line) => line.startsWith(`- ${lesson}: `)),
    "a director's brief lists the user's lessons",
  );
  assert.ok(!director.some((line) => /Decision \d/.test(line)), "and no decisions, preferences or observations");
  assert.equal(director.filter((line) => line.startsWith("- ")).length, 1);
  assert.deepEqual(
    lessonLines({ projectDir: project(root, "plain") }, "idea-review"),
    [],
    "an unbound project gets none",
  );
  assert.ok(
    !memoryLines({ projectDir: dir }, "build").some((line) => line.includes(lesson)),
    "a step without the lessons rule keeps the plain cap",
  );
});

test("an entry from one project stays out of another project's answers; entries with no project reach both", (t) => {
  const root = workspace(t);
  const own = entry(root, "decision", "Project a keeps the blue end card", { project: "a" });
  const shared = entry(root, "preference", "Every film ends on the logo");
  assert.deepEqual(ids(memoryFields(project(root, "a", "explainer"), "build")), [own, shared].sort());
  assert.deepEqual(ids(memoryFields(project(root, "b", "explainer"), "build")), [shared]);
});

test("lessons are reserved inside the one budget: at most QUERY_LIMIT entries and QUERY_MAX_CHARS characters", (t) => {
  const root = workspace(t);
  const long = (word: string, i: number) => `${word} ${i} `.padEnd(150, "x");
  for (let i = 0; i < 10; i++) entry(root, "decision", long("Decision", i), { playbooks: ["explainer"] });
  const lessons = [0, 1, 2].map((i) => entry(root, "lesson", long("Lesson", i), { playbooks: ["explainer"] }));
  const memory = memoryFields(project(root, "film", "explainer"), "strategy", undefined, {
    lessons: MEMORY_LESSONS,
  }).memory!;
  assert.ok(memory.length <= QUERY_LIMIT, `${memory.length} entries`);
  assert.ok(memory.reduce((sum, ref) => sum + ref.summary.length, 0) <= QUERY_MAX_CHARS);
  for (const id of lessons)
    assert.ok(
      memory.some((ref) => ref.id === id),
      `${id} kept`,
    );
  assert.ok(
    memory.some((ref) => ref.type === "decision"),
    "decisions fill the rest",
  );
});

test("the hint says how to weigh each kind of entry", () => {
  assert.match(MEMORY_HINT, /decisions and preferences hold unless the user says otherwise now/);
  assert.match(MEMORY_HINT, /observations are agents' unconfirmed views/);
});

test("the cap holds with 50 matching entries", (t) => {
  const root = workspace(t);
  for (let i = 0; i < 50; i++)
    entry(root, "observation", `Observation ${i} about pacing in the explainer build step, with some detail`, {
      playbooks: ["explainer"],
    });
  const memory = memoryFields(project(root, "film", "explainer"), "build").memory!;
  assert.equal(memory.length, QUERY_LIMIT);
  assert.ok(memory.reduce((sum, ref) => sum + ref.summary.length, 0) <= QUERY_MAX_CHARS);
});

test("an empty or absent memory means no fields at all", (t) => {
  const root = workspace(t);
  const dir = project(root, "film", "explainer");
  assert.deepEqual(memoryFields(dir, "build"), {});
  mkdirSync(path.join(root, "memory/decisions"), { recursive: true });
  assert.deepEqual(memoryFields(dir, "build"), {});
});

test("an invalid memory file is skipped with one warning line; the valid entries still come", (t) => {
  const root = workspace(t);
  const good = entry(root, "decision", "Never show a stock photo of a handshake");
  writeFileSync(path.join(root, "memory/decisions/decision-20261101-broken.md"), "---\nversion: 1\nid: nope\n---\n");
  const fields = memoryFields(project(root, "film", "explainer"), "build");
  assert.deepEqual(ids(fields), [good]);
  assert.match(fields.memoryWarning!, /^1 memory file\(s\) are invalid and were skipped; pnpm memory --list/);
});

test("AGENTBROS_MEMORY_ROOT points the answers at another memory folder", (t) => {
  const root = workspace(t);
  const other = workspace(t);
  const id = entry(other, "preference", "Subtitles always in sentence case");
  process.env.AGENTBROS_MEMORY_ROOT = path.join(other, "memory");
  t.after(() => delete process.env.AGENTBROS_MEMORY_ROOT);
  assert.deepEqual(ids(memoryFields(project(root, "film", "explainer"), "build")), [id]);
});

test("a fresh index.json is read instead of the entry files; a newer file makes it stale", (t) => {
  const root = workspace(t);
  for (let i = 0; i < 3; i++) entry(root, "preference", `Preference number ${i} for the whole workspace`);
  assert.equal(loadMemoryFast(root).fromIndex, false, "no index yet");
  writeIndex(root);
  const fresh = loadMemoryFast(root);
  assert.equal(fresh.fromIndex, true);
  assert.equal(fresh.entries.length, 3);
  const id = entry(root, "decision", "A decision written after the index");
  const future = new Date(Date.now() + 5000);
  utimesSync(path.join(root, "memory/decisions", `${id}.md`), future, future);
  const stale = loadMemoryFast(root);
  assert.equal(stale.fromIndex, false);
  assert.equal(stale.entries.length, 4);
  writeIndex(root);
  assert.equal(loadMemoryFast(root).fromIndex, true, "reindexed");
  const edited = path.join(root, "memory/decisions", `${id}.md`);
  writeFileSync(
    edited,
    readFileSync(edited, "utf8").replace(
      "A decision written after the index",
      "A decision edited in place, same mtime",
    ),
  );
  utimesSync(edited, future, future);
  assert.equal(loadMemoryFast(root).fromIndex, false, "a size change with the same mtime makes the index stale");
  rmSync(edited);
  writeIndex(root);
  writeFileSync(path.join(root, "memory/index.json"), JSON.stringify({ entries: [], warnings: [] }));
  assert.equal(loadMemoryFast(root).fromIndex, false, "an index without fingerprints is stale");
});

test("500 entries: the scoped answer stays cheap (timings printed)", (t) => {
  const root = workspace(t);
  for (let i = 0; i < 500; i++)
    entry(
      root,
      i % 5 ? "observation" : "preference",
      `Fixture entry ${i} on ${i % 2 ? "pacing" : "colour"} for the bench run`,
      i % 3 ? { playbooks: ["explainer"] } : {},
    );
  const dir = project(root, "film", "explainer");
  const time = (fn: () => unknown) => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };
  const files = time(() => loadMemoryFast(root));
  writeIndex(root);
  const index = time(() => assert.equal(loadMemoryFast(root).fromIndex, true));
  const answer = time(() => assert.equal(memoryFields(dir, "build").memory!.length, QUERY_LIMIT));
  const direct = time(() => memoryFor({ playbook: "explainer", step: "build" }, root));
  console.error(
    `memory-wire 500 entries: load from files ${files.toFixed(1)} ms, from index ${index.toFixed(1)} ms, memoryFields ${answer.toFixed(1)} ms, memoryFor ${direct.toFixed(1)} ms`,
  );
  assert.ok(answer < 1000, `memoryFields took ${answer} ms`);
});

// --- Through the commands ---

function cli(script: string, args: string[], cwd: string) {
  // The workspace's own memory, named explicitly so that no command can fall back to the checkout's memory/.
  const env = { ...process.env, AGENTBROS_MEMORY_ROOT: path.join(cwd, "memory") };
  const run = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `${script}: one JSON line\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(lines[0]!);
}

test("next and film:next carry memory once, inside the step's answer; film:brief's owner prompt lists it", (t) => {
  const root = workspace(t);
  assert.equal(cli("scripts/film-init.ts", ["--project", "demo", "--playbook", "explainer"], root).ok, true);
  const id = entry(root, "decision", "Ask about the audience before the topic", {
    playbooks: ["explainer"],
    steps: ["intake"],
  });
  entry(root, "decision", "Strategy names one platform only", { playbooks: ["explainer"], steps: ["strategy"] });
  writeFileSync(path.join(root, "memory/decisions/decision-20261101-broken.md"), "not front matter");

  const next = cli("scripts/next.ts", ["--project", "demo"], root);
  assert.equal(next.ok, true);
  assert.equal(next.metadata.memory, undefined, "not repeated at the top level");
  assert.equal(next.metadata.next.step, "intake");
  assert.deepEqual(next.metadata.next.memory, [
    { id, type: "decision", summary: "Ask about the audience before the topic" },
  ]);
  assert.equal(next.metadata.next.memoryHint, MEMORY_HINT);
  assert.match(next.metadata.next.memoryWarning, /^1 memory file/);
  assert.deepEqual(cli("scripts/film-next.ts", ["--project", "demo"], root).metadata.memory, next.metadata.next.memory);

  const brief = cli("scripts/film-brief.ts", ["--project", "demo", "--step", "intake", "--print"], root);
  assert.equal(brief.ok, true);
  assert.match(
    brief.metadata.prompt,
    new RegExp(
      `## The user's memory for this step\\n\\n- ${id} \\(decision\\): Ask about the audience before the topic\\n`,
    ),
  );
  assert.match(brief.metadata.prompt, /pnpm memory --id <id>/);
  assert.match(brief.metadata.prompt, /Never write memory yourself: propose a new entry/);
  assert.doesNotMatch(brief.metadata.prompt, /Strategy names one platform only/);
});

test("footage:next and a bound but unstarted project carry their step's memory", (t) => {
  const root = workspace(t);
  const id = entry(root, "preference", "Captions in the outline pop style by default", { playbooks: ["footage-edit"] });
  entry(root, "decision", "Caption step: keep the speaker names off", {
    playbooks: ["footage-edit"],
    steps: ["5-captions"],
  });
  project(root, "talk", "footage-edit");
  const footage = cli("scripts/footage-next.ts", ["--project", "talk"], root);
  assert.equal(footage.ok, true);
  assert.equal(footage.metadata.step, "setup");
  assert.deepEqual(
    footage.metadata.memory?.map((ref: { id: string }) => ref.id),
    [id],
    "the 5-captions entry waits for its step",
  );

  project(root, "promo", "explainer");
  const unstarted = cli("scripts/next.ts", ["--project", "promo"], root);
  assert.equal(unstarted.metadata.route, null);
  assert.equal(unstarted.metadata.next.memory, undefined, "nothing scoped to explainer yet");
  const general = entry(root, "preference", "Always ask for the brand colours first");
  assert.deepEqual(
    cli("scripts/next.ts", ["--project", "promo"], root).metadata.next.memory.map((ref: { id: string }) => ref.id),
    [general],
  );
});
