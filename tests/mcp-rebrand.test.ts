import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createVideoMcpServer } from "../src/mcp/server";

test("the MCP handshake identifies Agent Bros. while keeping existing tool names", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mcp-rebrand-"));
  const server = createVideoMcpServer({ root, codeRoot: path.resolve(import.meta.dirname, ".."), allowPaid: false });
  const client = new Client({ name: "rebrand-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual(client.getServerVersion(), { name: "agentbros", version: "0.1.0" });
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "avc_capabilities"));
    assert.ok(tools.every((tool) => tool.name.startsWith("avc_")));
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
