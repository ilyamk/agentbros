import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { laneExcerpt, methodExcerpt, rubricExcerpt } from "../src/lib/film/brief";
import { briefFileName, briefMetadata, dispatchLine } from "../src/lib/film/brief-handoff";
import { RUBRIC_FILES } from "../src/lib/film/creative-rubric";
import { capExcerpt, demoteHeadings, EXCERPT_CAP, markdownSection } from "../src/lib/film/excerpt";
import { boundedDigest, digestValue, pick, SHOW_LIMITS } from "../src/lib/film/show";
import { STIMULUS_METHODS } from "../src/lib/film/stimuli";
import { SCRIPT_VARIANTS, TEAM_STANCES } from "../src/types/studio";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
const ID = "handoff";

function cli(root: string, script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AGENTBROS_MEMORY_ROOT: path.join(root, "memory"), AGENTBROS_LOCAL_DOWNLOADS: "never" },
  });
  assert.equal(result.stdout.trim().split("\n").length, 1, result.stdout + result.stderr);
  return { status: result.status, json: JSON.parse(result.stdout) as Record<string, any> };
}

function film(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "film-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(cli(root, "film-init.ts", "--project", ID).status, 0);
  const pipeline = path.join(root, "public/projects", ID, "pipeline");
  copyFileSync(path.join(FIXTURES, "brief.json"), path.join(pipeline, "brief.json"));
  return { root, pipeline };
}

/** Every file under a folder with its size and modification time: a read-only command leaves it unchanged. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      const stat = statSync(file);
      return `${path.relative(dir, file)} ${stat.size} ${stat.mtimeMs}`;
    })
    .sort();
}

test("film:brief returns the brief's path, a summary and a one-line dispatch, not the text; --print adds it", (t) => {
  const { root } = film(t);
  const byReference = cli(root, "film-brief.ts", "--project", ID, "--step", "intake");
  assert.equal(byReference.status, 0, byReference.json.message);
  const { metadata, outputs } = byReference.json;
  const file = `public/projects/${ID}/pipeline/briefs/${briefFileName("intake", undefined, "owner")}`;
  assert.deepEqual(outputs, [file]);
  assert.equal(metadata.brief, file);
  assert.equal(metadata.prompt, undefined, "the brief's text stays out of the orchestrator");
  assert.equal(metadata.dispatch, dispatchLine("brief-collector", file));
  assert.match(
    metadata.dispatch,
    /^You are brief-collector\. Read and follow public\/projects\/handoff\/pipeline\/briefs\/intake\.md/,
  );
  assert.match(metadata.summary, /^Film chain: Intake \(step 1 of \d+, project handoff\)$/);
  const text = readFileSync(path.join(root, file), "utf8");
  assert.equal(metadata.bytes, Buffer.byteLength(text));
  assert.equal(metadata.approxTokens, Math.ceil(metadata.bytes / 4));
  assert.match(text, /pnpm film:show --project handoff --step intake/, "owners are told how to inspect artefacts");
  assert.ok(JSON.stringify(byReference.json).length < 2048, "the envelope stays small");

  const printed = cli(root, "film-brief.ts", "--project", ID, "--step", "intake", "--print");
  assert.equal(printed.json.metadata.prompt, readFileSync(path.join(root, file), "utf8"));
  const { prompt, ...rest } = printed.json.metadata;
  void prompt;
  assert.deepEqual(Object.keys(rest).sort(), Object.keys(metadata).sort());
});

test("briefMetadata is the envelope the simulation measures", () => {
  const prompt = "# Film chain: Look (step 9 of 20, project p)\n\nbody";
  const metadata = briefMetadata({
    projectId: "p",
    step: "look",
    role: "critic",
    agent: "creative-critic",
    file: "x.md",
    prompt,
  });
  assert.equal(metadata.summary, "Film chain: Look (step 9 of 20, project p)");
  assert.equal(metadata.dispatch, dispatchLine("creative-critic", "x.md"));
  assert.ok(!("prompt" in metadata));
  assert.equal(
    briefMetadata({ projectId: "p", step: "look", role: "critic", agent: "a", file: "x.md", prompt, print: true })
      .prompt,
    prompt,
  );
  assert.equal(briefFileName("ideas", "metaphor", "owner"), "ideas-metaphor.md");
  assert.equal(briefFileName("look", undefined, "critic"), "look-critic.md");
});

test("excerpts are deterministic, bounded and keep the shared rules of their kind", () => {
  for (const team of TEAM_STANCES) {
    const quote = laneExcerpt(REPO, "ideas", team);
    assert.equal(quote, laneExcerpt(REPO, "ideas", team));
    assert.ok(Buffer.byteLength(quote) <= EXCERPT_CAP, team);
    assert.match(quote, /^#### Concept teams\n/);
    assert.match(quote, /Every stance: a product-only proof/);
    assert.match(quote, new RegExp(`^##### ${team}$`, "m"));
    for (const other of TEAM_STANCES.filter((name) => name !== team))
      assert.doesNotMatch(quote, new RegExp(`^##### ${other}$`, "m"), `${team} quotes ${other}`);
    assert.doesNotMatch(quote, /^## /m, "a quote never opens a brief section");
  }
  for (const variant of SCRIPT_VARIANTS) {
    const quote = laneExcerpt(REPO, "scripts", variant);
    assert.match(quote, /^#### Script variants\n\nEach variant is written/);
    assert.match(quote, new RegExp(`^##### ${variant}\\n\\n.+density`, "m"));
    assert.doesNotMatch(quote, /Concept teams/);
  }
  for (const method of STIMULUS_METHODS) {
    const quote = methodExcerpt(REPO, method);
    assert.ok(quote.startsWith(`#### ${method}`), method);
    assert.match(quote, /In a concept team, with a category scan/);
    assert.ok(Buffer.byteLength(quote) <= EXCERPT_CAP, method);
  }
  for (const file of Object.values(RUBRIC_FILES)) {
    const whole = Buffer.byteLength(readFileSync(path.join(REPO, file)));
    const ideas = rubricExcerpt(REPO, file, "ideas");
    const scripts = rubricExcerpt(REPO, file, "scripts");
    for (const [quote, own, other] of [
      [ideas, "Idea rubric", "Script rubric"],
      [scripts, "Script rubric", "Idea rubric"],
    ] as const) {
      assert.match(quote, /Every axis is an integer 1–5/);
      assert.match(quote, new RegExp(`^#### ${own}`, "m"));
      assert.doesNotMatch(quote, new RegExp(other));
      assert.match(quote, /^#### Threshold$/m);
      assert.match(quote, /^#### Pairwise comparison, in both orders$/m);
      assert.doesNotMatch(quote, /What the director reads/);
      assert.ok(Buffer.byteLength(quote) < whole, `${file}: a quote is smaller than its file`);
      assert.ok(Buffer.byteLength(quote) <= EXCERPT_CAP);
    }
  }
});

test("markdownSection refuses a missing or ambiguous heading and stops at the next heading of its level", () => {
  const text = "# T\n\nintro\n\n## A\n\na\n\n### A1\n\na1\n\n## B\n\nb\n\n```\n## not a heading\n```\n\n## B (again)\n";
  assert.equal(markdownSection(text, { heading: "A", take: "body" }), "## A\n\na\n\n### A1\n\na1");
  assert.equal(markdownSection(text, { heading: "A", take: "intro" }), "## A\n\na");
  assert.equal(markdownSection(text, { heading: "T", take: "intro" }), "# T\n\nintro");
  assert.throws(() => markdownSection(text, { heading: "C", take: "body" }), /expected one heading "C", found 0/);
  assert.throws(() => markdownSection(text, { heading: "B", take: "body" }), /found 2/);
  assert.equal(demoteHeadings("# a\n#### b\n##### c"), "### a\n###### b\n##### c");
  const long = Array.from({ length: 50 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
  const cut = capExcerpt(long, "ref.md", 512);
  assert.ok(Buffer.byteLength(cut) <= 512);
  assert.match(cut, /\[Quote cut at 512 bytes: the rest is in ref\.md\.\]$/);
  assert.equal(capExcerpt("short", "ref.md", 512), "short");
});

test("digests are bounded: strings cut, arrays by length and first item, deeper levels dropped to fit", () => {
  const value = {
    title: "x".repeat(500),
    ideas: Array.from({ length: 30 }, (_, index) => ({
      id: `I${index}`,
      title: `idea ${index}`,
      nested: { deep: [1, 2] },
    })),
    flag: true,
  };
  const digest = digestValue(value, 2) as Record<string, any>;
  assert.equal(digest.title.length, SHOW_LIMITS.string + "…(+380 chars)".length);
  assert.deepEqual(digest.ideas, { array: 30, first: { id: "I0", title: "idea 0", nested: "object(1 keys)" } });
  assert.equal(digest.flag, true);
  assert.equal(digestValue(value, 0), "object(3 keys)");
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index]));
  assert.equal((digestValue(many, 1) as Record<string, unknown>)["…"], `+${40 - SHOW_LIMITS.keys} keys`);
  const bounded = boundedDigest(value, 4, 200);
  assert.ok(JSON.stringify(bounded.digest).length <= 200);
  assert.ok(bounded.depth < 4);
  assert.deepEqual((pick(value, "ideas.id") as unknown[]).slice(0, 2), ["I0", "I1"]);
  assert.equal((pick(value, "ideas.id") as unknown[]).length, SHOW_LIMITS.items + 1);
  assert.equal(pick(value, "ideas.3.title"), "idea 3");
  assert.deepEqual(pick(value, "ideas.0.nested.deep"), [1, 2]);
  assert.equal(pick(value, "missing.path"), undefined);
});

test("film:show digests a step's inputs and outputs and one artefact, reads only, and refuses paths outside the project", (t) => {
  const { root, pipeline } = film(t);
  writeFileSync(path.join(root, "secret.json"), JSON.stringify({ token: "nope" }));
  const before = snapshot(root);

  const step = cli(root, "film-show.ts", "--project", ID, "--step", "intake");
  assert.equal(step.status, 0, step.json.message);
  const { metadata } = step.json;
  assert.equal(metadata.step, "intake");
  assert.equal(typeof metadata.status, "string");
  const brief = metadata.outputs.find((item: { path: string }) => item.path.endsWith("pipeline/brief.json"));
  assert.equal(brief.exists, true);
  assert.equal(brief.kind, "json");
  assert.equal(brief.schema, "brief");
  assert.equal(typeof brief.valid, "boolean");
  assert.equal(brief.digest.topic, "A demo of a task app");
  assert.equal(brief.bytes, statSync(path.join(pipeline, "brief.json")).size);

  const one = cli(
    root,
    "film-show.ts",
    "--project",
    ID,
    "--artefact",
    `public/projects/${ID}/pipeline/brief.json`,
    "--fields",
    "productName,durationSec,missing.key",
  );
  assert.equal(one.status, 0, one.json.message);
  assert.equal(one.json.metadata.artefact.schema, "brief");
  assert.deepEqual(one.json.metadata.artefact.fields, { productName: "Clear", durationSec: 10 });
  assert.equal(one.json.metadata.artefact.depth, 2);

  const markdown = cli(root, "film-show.ts", "--project", ID, "--artefact", `public/projects/${ID}/pipeline/spine.md`);
  assert.equal(markdown.status, 0, markdown.json.message);
  assert.equal(markdown.json.metadata.artefact.kind, "markdown");
  assert.ok(Array.isArray(markdown.json.metadata.artefact.digest.headings));

  for (const args of [
    ["--artefact", "secret.json"],
    ["--artefact", `public/projects/${ID}/../../../secret.json`],
    ["--artefact", `public/projects/${ID}/pipeline/nothing.json`],
    ["--step", "no-such-step"],
    [],
    ["--step", "intake", "--depth", "9"],
  ]) {
    const refused = cli(root, "film-show.ts", "--project", ID, ...args);
    assert.notEqual(refused.status, 0, args.join(" "));
    assert.equal(refused.json.error, "INVALID_INPUT", args.join(" "));
    assert.doesNotMatch(JSON.stringify(refused.json), /nope/);
  }
  assert.deepEqual(snapshot(root), before, "film:show writes nothing");
});
