import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { COMMANDS } from "../src/mcp/catalog";
import { createVideoMcpServer, SERVER_INSTRUCTIONS } from "../src/mcp/server";
import { CORE_TOOLS, parseToolsets, sectionOf } from "../src/mcp/toolsets";

const codeRoot = path.resolve(import.meta.dirname, "..");

async function connect(toolsets?: Parameters<typeof createVideoMcpServer>[0]["toolsets"]) {
  const root = mkdtempSync(path.join(tmpdir(), "mcp-toolsets-"));
  const server = createVideoMcpServer({ root, codeRoot, allowPaid: false, toolsets });
  const client = new Client({ name: "toolsets-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const json = (response: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((response.content as { type: string; text: string }[])[0]!.text) as Record<string, unknown>;

test("every core tool is a catalogued command with a registry section", () => {
  for (const name of CORE_TOOLS) {
    assert.ok(
      COMMANDS.some((command) => command.name === name),
      `${name} is not in the MCP catalog`,
    );
    assert.ok(sectionOf(name), `${name} has no registry section`);
  }
  assert.deepEqual(parseToolsets("core, footage"), ["core", "footage"]);
  assert.throws(() => parseToolsets("everything"), /Unknown toolset/);
});

test("the core toolset lists a small set, sends instructions and reaches the rest through avc_call", async () => {
  const { client, close } = await connect(["core"]);
  try {
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.length <= 40, `core lists ${names.length} tools; harness limits start at 40`);
    for (const name of ["avc_next", "avc_capabilities", "avc_help", "avc_guide", "avc_call"])
      assert.ok(names.includes(name), name);
    assert.ok(!names.includes("avc_generate_model"));
    const capabilities = json(await client.callTool({ name: "avc_capabilities", arguments: {} }));
    const generate = (capabilities.tools as { name: string; listed: boolean }[]).find(
      (tool) => tool.name === "avc_generate_model",
    );
    assert.equal(generate?.listed, false);
    const unknown = await client.callTool({ name: "avc_call", arguments: { tool: "no_such_tool" } });
    assert.equal(unknown.isError, true);
    const invalid = await client.callTool({
      name: "avc_call",
      arguments: { tool: "avc_render_project", arguments: { project: "../escape" } },
    });
    assert.equal(invalid.isError, true, "avc_call keeps the tool's own schema checks");
  } finally {
    await close();
  }
});

test("avc_guide lists and reads skills and agents, contained in .agents/", async () => {
  const { client, close } = await connect(["core"]);
  try {
    const skills = json(await client.callTool({ name: "avc_guide", arguments: { kind: "skill" } }));
    assert.ok((skills.entries as { name: string }[]).some((entry) => entry.name === "creative-studio"));
    const skill = json(await client.callTool({ name: "avc_guide", arguments: { name: "creative-studio" } }));
    assert.match(String(skill.text), /^---/);
    assert.ok(Array.isArray(skill.files));
    const agent = json(
      await client.callTool({ name: "avc_guide", arguments: { kind: "agent", name: "motion-engineer" } }),
    );
    assert.match(String(agent.text), /name: motion-engineer/);
    for (const file of ["../../../package.json", "/etc/hosts"]) {
      const escape = await client.callTool({ name: "avc_guide", arguments: { name: "creative-studio", file } });
      assert.equal(escape.isError, true, file);
    }
  } finally {
    await close();
  }
});

test("the default toolset still lists every tool and no avc_call", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "avc_generate_model"));
    assert.ok(!tools.some((tool) => tool.name === "avc_call"));
  } finally {
    await close();
  }
});
