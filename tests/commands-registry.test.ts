import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { COMMAND_REGISTRY, CATALOGUE_DOC, findCommands, withCatalogue } from "../src/lib/cli/commands";
import { COMMANDS } from "../src/mcp/catalog";

const aliases = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
const scriptOf = (command: string) => /(?:^|\s)tsx ((?:scripts|src)\/[\w/-]+\.ts)/.exec(command)?.[1] ?? null;

test("every package.json alias has exactly one registry entry, with the script it runs", () => {
  const registered = COMMAND_REGISTRY.flatMap((entry) => (entry.alias ? [entry.alias] : []));
  assert.equal(new Set(registered).size, registered.length, "an alias is registered twice");
  assert.deepEqual([...registered].sort(), Object.keys(aliases).sort());
  for (const entry of COMMAND_REGISTRY) {
    if (entry.alias) assert.equal(entry.script, scriptOf(aliases[entry.alias]!), entry.alias);
    if (entry.guide) assert.ok(existsSync(entry.guide), `${entry.alias}: guide ${entry.guide} is missing`);
    if (entry.script) assert.ok(existsSync(entry.script), `${entry.alias ?? entry.script}: ${entry.script} is missing`);
    assert.equal(
      entry.alias === null,
      entry.unaliased !== undefined,
      `${entry.script}: unaliased needs a reason, an alias none`,
    );
    assert.ok(
      entry.purpose.length > 0 && entry.purpose.length <= 160 && !entry.purpose.includes("\n"),
      `${entry.alias ?? entry.script}: one-line purpose`,
    );
  }
});

test("every script in scripts/ is in the registry", () => {
  const registered = new Set(COMMAND_REGISTRY.map((entry) => entry.script));
  for (const file of readdirSync("scripts").filter(
    (name) => name.endsWith(".ts") && statSync(`scripts/${name}`).isFile(),
  )) {
    assert.ok(registered.has(`scripts/${file}`), `scripts/${file} has no registry entry`);
  }
});

test("every command is an MCP tool or excluded with a reason, and spend agrees with MCP", () => {
  const tools = new Map(COMMANDS.map((command) => [command.name, command]));
  const claimed = COMMAND_REGISTRY.flatMap((entry) => (typeof entry.mcp === "string" ? [entry.mcp] : []));
  assert.equal(new Set(claimed).size, claimed.length, "an MCP tool is claimed twice");
  assert.deepEqual([...claimed].sort(), [...tools.keys()].sort());
  for (const entry of COMMAND_REGISTRY) {
    const name = entry.alias ?? entry.script ?? "";
    if (typeof entry.mcp !== "string") {
      assert.ok(entry.mcp.excluded.trim().length > 0, `${name}: exclusion needs a reason`);
      continue;
    }
    const tool = tools.get(entry.mcp)!;
    assert.equal(entry.script, `scripts/${tool.script}`, name);
    assert.equal(
      tool.paid === "local",
      entry.paid === "none",
      `${name}: registry spend ${entry.paid} disagrees with MCP ${tool.paid}`,
    );
  }
});

test("film chain over MCP: local steps exposed, the user's approvals CLI only", () => {
  const entry = (alias: string) => COMMAND_REGISTRY.find((item) => item.alias === alias)!;
  for (const alias of [
    "film:route",
    "film:init",
    "film:status",
    "film:next",
    "film:brief",
    "film:done",
    "film:stills",
    "film:render",
    "film:measure",
  ]) {
    assert.equal(typeof entry(alias).mcp, "string", alias);
  }
  for (const alias of ["film:approve", "film:rights"])
    assert.deepEqual(entry(alias).mcp, { excluded: "approval is the user's, CLI only" }, alias);
  const route = COMMANDS.find((command) => command.name === "film_route")!;
  assert.equal(route.readOnly, true);
  assert.equal(route.schema.safeParse({ "write-doc": true }).success, false, "regenerating docs stays on the CLI");
});

test(`${CATALOGUE_DOC} carries the generated catalogue and stays small`, () => {
  const doc = readFileSync(CATALOGUE_DOC, "utf8");
  assert.equal(doc, withCatalogue(doc), "run pnpm commands --write-doc");
  // Raised from 24 KiB on 2026-11-17 at the user's request: room for new commands without trimming descriptions.
  assert.ok(Buffer.byteLength(doc) <= 32 * 1024, `${CATALOGUE_DOC} is ${Buffer.byteLength(doc)} bytes`);
});

test("pnpm commands emits one JSON line and filters", () => {
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/commands.ts", "--query", "approve"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  const envelope = JSON.parse(lines[0]!);
  assert.equal(envelope.ok, true);
  assert.ok(envelope.metadata.commands.some((command: { alias: string }) => command.alias === "film:approve"));
  const paid = JSON.parse(
    spawnSync(process.execPath, ["--import", "tsx", "scripts/commands.ts", "--paid"], { encoding: "utf8" }).stdout,
  );
  assert.ok(
    paid.metadata.commands.length > 0 &&
      paid.metadata.commands.every((command: { paid: string }) => command.paid !== "none"),
  );
});

test("keywords find captions, transcription, music and voiceover by the words users say", () => {
  const aliases = (query: string) => findCommands({ query }).map((entry) => entry.alias);
  const before = (list: (string | null)[], first: string, second: string) =>
    assert.ok(
      list.indexOf(first) >= 0 && list.indexOf(first) < list.indexOf(second),
      `${first} before ${second}: ${list.join(", ")}`,
    );
  for (const query of ["subtitle", "caption"]) {
    const list = aliases(query);
    assert.equal(list[0], "footage:next", query);
    before(list, "timeline:edit", "captions:export");
  }
  assert.deepEqual(aliases("caption").slice(0, 2), ["footage:next", "timeline:edit"]);
  assert.deepEqual(aliases("speech-to-text").slice(0, 2), ["transcribe", "speech:local"]);
  assert.equal(aliases("soundtrack")[0], "music");
  assert.equal(aliases("narration")[0], "generate:voiceover");
  assert.ok(aliases("export").includes("render"));
  for (const entry of COMMAND_REGISTRY)
    for (const word of entry.keywords ?? [])
      assert.equal(word, word.toLowerCase(), `${entry.alias}: keywords are lower case`);
});

test("pnpm commands names MCP tools as served, with the avc_ prefix", () => {
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/commands.ts", "--query", "film:next"], {
    encoding: "utf8",
  });
  const envelope = JSON.parse(run.stdout);
  const entry = envelope.metadata.commands.find((command: { alias: string }) => command.alias === "film:next");
  assert.equal(entry.mcp, "avc_film_next");
  assert.match(run.stderr, /MCP avc_film_next/);
});
