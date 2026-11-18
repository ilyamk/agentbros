/**
 * The console's MCP tools (RFC 0004 D17, WP11): `avc_console_url` and `avc_console_view` read, `avc_console_card`
 * posts a card through the CLI; nothing applies a decision or changes control. Project scope, path scope and strict
 * schemas hold for all three.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { COMMANDS } from "../src/mcp/catalog";
import { prepareCommand } from "../src/mcp/bridge";
import { createVideoMcpServer } from "../src/mcp/server";
import { postCard, parseCardInput } from "../src/lib/console/cards";
import * as contract from "../src/types/console";
import { makeRoot, PROJECT, removeRoot } from "./helpers/console-server";

const codeRoot = path.resolve(import.meta.dirname, "..");
const question = (
  JSON.parse(readFileSync(path.join(codeRoot, "tests/fixtures/console/card-inputs.json"), "utf8")) as {
    kind: string;
  }[]
).find((input) => input.kind === "question")!;

async function connect(t: TestContext, projectScope?: string) {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  const server = createVideoMcpServer({ root, codeRoot, allowPaid: false, projectScope, stderr: () => undefined });
  const client = new Client({ name: "console-cards-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    const text = (response.content as { type: string; text: string }[])[0]!.text;
    return {
      isError: !!response.isError,
      body: (text.startsWith("{") ? JSON.parse(text) : { text }) as Record<string, any>,
    };
  };
  return { root, client, call };
}

test("console tools: url and view are read-only, card is the only writer, no decision or control tool", async (t) => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();
  const consoleTools = tools.filter((tool) => tool.name.startsWith("avc_console"));
  assert.deepEqual(consoleTools.map((tool) => tool.name).sort(), [
    "avc_console_card",
    "avc_console_url",
    "avc_console_view",
  ]);
  for (const tool of consoleTools)
    assert.equal(tool.annotations?.readOnlyHint, tool.name !== "avc_console_card", tool.name);
  for (const name of tools.map((tool) => tool.name))
    assert.ok(!/decide|decision|control|console_wait|approve|answer/.test(name), `${name} must not be a tool`);
  const card = COMMANDS.find((command) => command.name === "console_card")!;
  assert.equal(card.paid, "local");
  assert.deepEqual(card.paths, ["data"]);
});

test("avc_console_view returns the trimmed view with cards; avc_console_url never returns a token", async (t) => {
  const { root, call } = await connect(t);
  const posted = postCard(root, PROJECT, parseCardInput(question)).card;
  const view = await call("avc_console_view", { project: PROJECT });
  assert.equal(view.isError, false, JSON.stringify(view.body));
  const trimmed = view.body.metadata.view;
  assert.equal(trimmed.project.id, PROJECT);
  assert.equal(trimmed.cards.open, 1);
  assert.equal(trimmed.cards.items[0].id, posted.id);
  const missing = await call("avc_console_view", { project: "no-such-project" });
  assert.equal(missing.isError, true);
  assert.equal(missing.body.error, "PROJECT_NOT_FOUND");
  const url = await call("avc_console_url", { project: PROJECT });
  assert.equal(url.body.ok, true);
  assert.equal(url.body.metadata.running, false);
  writeFileSync(
    path.join(root, contract.SERVER_LOCK_FILE),
    JSON.stringify({
      v: 1,
      pid: process.pid,
      port: 4317,
      version: "t",
      startedAt: new Date().toISOString(),
      url: "http://127.0.0.1:4317/",
    }),
  );
  writeFileSync(path.join(root, contract.SESSION_FILE), JSON.stringify({ v: 1, token: "a".repeat(64) }));
  const live = await call("avc_console_url", { project: PROJECT });
  assert.equal(live.body.metadata.url, `http://127.0.0.1:4317/#/projects/${PROJECT}`);
  assert.ok(!JSON.stringify(live.body).includes("a".repeat(64)), "no token");
  assert.ok(!JSON.stringify(live.body).includes("#token"), "no token URL");
  assert.equal((await call("avc_console_view", { project: PROJECT, extra: 1 })).isError, true, "strict schema");
});

test("a scoped server reads and posts only for its project", async (t) => {
  const { root, call } = await connect(t, PROJECT);
  mkdirSync(path.join(root, "public/projects/other-project/pipeline"), { recursive: true });
  writeFileSync(path.join(root, "public/projects/other-project/project.json"), "{}");
  for (const name of ["avc_console_view", "avc_console_url"]) {
    const other = await call(name, { project: "other-project" });
    assert.equal(other.isError, true, name);
    assert.match(other.body.message, /scope/);
  }
  const scoped = await call("avc_console_view", {});
  assert.equal(scoped.body.metadata.view.project.id, PROJECT, "defaults to the scoped project");
  const command = COMMANDS.find((entry) => entry.name === "console_card")!;
  const options = { root, codeRoot, allowPaid: false, projectScope: PROJECT };
  writeFileSync(path.join(root, "card.json"), JSON.stringify(question));
  assert.throws(
    () => prepareCommand(command, { project: "other-project", kind: "question", data: "card.json" }, options),
    /scope/,
  );
  assert.throws(() => prepareCommand(command, { kind: "question", data: "card.json" }, options), "project is required");
});

test("avc_console_card refuses injection: paths outside the root, unknown kinds and extra flags", async (t) => {
  const { root } = await connect(t);
  const command = COMMANDS.find((entry) => entry.name === "console_card")!;
  const options = { root, codeRoot, allowPaid: false };
  writeFileSync(path.join(root, "card.json"), JSON.stringify(question));
  for (const data of ["../outside.json", "/etc/passwd"])
    assert.throws(() => prepareCommand(command, { project: PROJECT, kind: "question", data }, options), data);
  for (const extra of [{ kind: "html" }, { answer: "yes" }, { force: true }, { "scope-root": "/" }])
    assert.throws(
      () => prepareCommand(command, { project: PROJECT, kind: "question", data: "card.json", ...extra }, options),
      JSON.stringify(extra),
    );
  const plan = prepareCommand(
    command,
    { project: PROJECT, kind: "question", data: "card.json", "expires-in": "1h; rm -rf /" },
    options,
  );
  assert.ok(plan.argv.includes("--expires-in=1h; rm -rf /"), "literal argv; the CLI refuses the value");
});

test("avc_console_card posts through the CLI, journaled with the mcp channel", async (t) => {
  const previous = process.env.AGENTBROS_EVENTS;
  process.env.AGENTBROS_EVENTS = "on";
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTBROS_EVENTS;
    else process.env.AGENTBROS_EVENTS = previous;
  });
  const { root, call } = await connect(t);
  writeFileSync(path.join(root, "card.json"), JSON.stringify(question));
  const posted = await call("avc_console_card", { project: PROJECT, kind: "question", data: "card.json" });
  assert.equal(posted.isError, false, JSON.stringify(posted.body));
  const cardId = posted.body.metadata.cardId as string;
  const card = contract.CardSchema.parse(
    JSON.parse(readFileSync(path.join(root, "public/projects", PROJECT, contract.cardFile(cardId)), "utf8")),
  );
  assert.equal(card.kind, "question");
  const events = readFileSync(path.join(root, "public/projects", PROJECT, contract.EVENTS_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line) => contract.ConsoleEventSchema.parse(JSON.parse(line)));
  const event = events.find((item) => item.kind === "card.posted")!;
  assert.equal(event.channel, "mcp");
  const refused = await call("avc_console_card", { project: PROJECT, kind: "choice", data: "card.json" });
  assert.equal(refused.isError, true);
  assert.equal(refused.body.error, "VALIDATION");
});
