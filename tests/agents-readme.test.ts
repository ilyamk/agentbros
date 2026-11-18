import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/** Leaf-agent front matter is the source of truth; .agents/agents/README.md must not drift from it. */
const DIR = ".agents/agents";
/** Claude Code model labels (Codex ignores the field and uses its configured model). */
const MODELS = new Set(["opus", "sonnet", "haiku", "inherit"]);

const agents = readdirSync(DIR)
  .filter((file) => file.endsWith(".md") && file !== "README.md")
  .map((file) => {
    const text = readFileSync(`${DIR}/${file}`, "utf8");
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim();
    return {
      file,
      name: field("name"),
      model: field("model"),
      tools: field("tools"),
      description: field("description"),
    };
  });
const readme = readFileSync(`${DIR}/README.md`, "utf8");

test("every leaf agent has complete front matter with a model label valid in both harnesses", () => {
  assert.ok(agents.length > 0);
  for (const agent of agents) {
    assert.equal(agent.name, agent.file.replace(/\.md$/, ""), `${agent.file}: name matches the file`);
    assert.ok(agent.description && agent.tools, `${agent.file}: description and tools`);
    assert.ok(
      MODELS.has(agent.model ?? ""),
      `${agent.file}: model "${agent.model}" must be one of ${[...MODELS].join(", ")}`,
    );
  }
});

test("leaf agents cannot spawn sub-agents: no Task, Agent or wildcard tool", () => {
  for (const agent of agents) {
    const tools = (agent.tools ?? "")
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((tool) => tool.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    assert.ok(tools.length > 0, `${agent.file}: tools is an explicit list`);
    for (const tool of tools)
      assert.ok(
        !/^(?:Task|Agent)(?:\(|$)|\*/.test(tool),
        `${agent.file}: leaf agents are depth 1 (AGENTS.md "Subagents"); remove "${tool}" from tools`,
      );
  }
});

test("the agents README names every agent and matches each front-matter model", () => {
  const byName = new Map(agents.map((agent) => [agent.name!, agent]));
  for (const agent of agents)
    assert.match(readme, new RegExp(`\`?${agent.name}\`?`), `${agent.name} is described in the README`);
  for (const [, name, model] of readme.matchAll(/^#### ([a-z-]+) \(([a-z]+)\)$/gm)) {
    assert.equal(byName.get(name!)?.model, model, `README heading for ${name}`);
  }
  const rows = [...readme.matchAll(/^\| \*\*([A-Za-z]+)\*\* \| ([^|]+) \|/gm)];
  assert.ok(rows.length > 0, "model rationale table");
  const seen = new Map<string, string>();
  for (const [, label, names] of rows) {
    for (const name of names!.split(",").map((value) => value.trim())) {
      assert.ok(byName.has(name), `table names unknown agent ${name}`);
      assert.equal(seen.has(name), false, `${name} appears twice in the model table`);
      seen.set(name, label!.toLowerCase());
    }
  }
  for (const agent of agents) assert.equal(seen.get(agent.name!), agent.model, `${agent.name} model table row`);
});

test("the agents README does not hard-code agent counts", () => {
  assert.doesNotMatch(
    readme,
    /\b(?:Twenty|Thirty|Fourteen|Fifteen|Sixteen)[- ]?\w* (?:specialised )?(?:sub)?agents\b/i,
  );
});
