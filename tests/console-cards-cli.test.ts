/**
 * `pnpm console:card` (RFC 0004 WP11, §9.2): one JSON line, the card file and `card.posted`, the console's address
 * without the token when a server is live, refusals with the CLI's codes, and nothing written on refusal.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import * as contract from "../src/types/console";
import { makeRoot, PROJECT, postHeaders, raw, removeRoot, startTestServer } from "./helpers/console-server";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const SCRIPT = path.join(REPO, "scripts/console-card.ts");
const inputs = JSON.parse(readFileSync(path.join(REPO, "tests/fixtures/console/card-inputs.json"), "utf8")) as Record<
  string,
  any
>[];

function workspace(t: TestContext): string {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  const sf = path.join(root, "public/projects", PROJECT, "design/styleframes");
  mkdirSync(sf, { recursive: true });
  for (const name of ["sf-1.png", "sf-2.png", "sf-3.png"]) writeFileSync(path.join(sf, name), "png");
  return root;
}

function run(root: string, args: string[], events = "on") {
  const result = spawnSync(process.execPath, [TSX, SCRIPT, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      AGENTBROS_EVENTS: events,
      AGENTBROS_CONSOLE: "off",
      AGENTBROS_HOOKS: "off",
      AGENTBROS_NO_DOTENV: "1",
      AGENTBROS_RUN_ID: "",
      npm_lifecycle_event: "",
    },
  });
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `one JSON line\n${result.stdout}\n${result.stderr}`);
  const envelope = contract.CliEnvelopeSchema.parse(JSON.parse(lines[0]!)) as Record<string, any>;
  assert.equal(result.status, envelope.ok ? 0 : 1, "exit code agrees with the envelope");
  return envelope;
}

const writeData = (root: string, value: unknown, name = "card.json") => {
  const file = path.join(root, name);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};

test("console:card posts a card the console answers (A11), journals both and prints the address without the token", async (t) => {
  const root = workspace(t);
  const port = 4317;
  writeFileSync(
    path.join(root, contract.SERVER_LOCK_FILE),
    JSON.stringify({
      v: 1,
      pid: process.pid,
      port,
      version: "test",
      startedAt: new Date().toISOString(),
      url: `http://127.0.0.1:${port}/`,
    }),
  );
  const grid = inputs.find((input) => input.kind === "grid")!;
  const envelope = run(root, [
    "--project",
    PROJECT,
    "--kind",
    "grid",
    "--data",
    writeData(root, grid),
    "--expires-in",
    "2h",
  ]);
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const { cardId, file, url, expiresAt } = envelope.metadata;
  assert.equal(file, `public/projects/${PROJECT}/pipeline/cards/${cardId}.json`);
  assert.deepEqual(envelope.outputs, [file]);
  assert.equal(url, `http://127.0.0.1:${port}/#/projects/${PROJECT}`);
  assert.ok(!JSON.stringify(envelope).includes("token"), "never the token URL");
  const card = contract.CardSchema.parse(JSON.parse(readFileSync(path.join(root, file), "utf8")));
  assert.equal(card.expiresAt, expiresAt);
  assert.ok(Math.abs(Date.parse(expiresAt) - Date.now() - 7_200_000) < 60_000);
  const events = readFileSync(path.join(root, "public/projects", PROJECT, contract.EVENTS_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line) => contract.ConsoleEventSchema.parse(JSON.parse(line)));
  const posted = events.find((event) => event.kind === "card.posted")!;
  assert.equal(posted.data?.cardId, cardId);
  assert.equal(posted.alias, "console:card");
  assert.deepEqual(
    events.map((event) => event.kind),
    ["cli.start", "card.posted", "cli.end"],
  );
  assert.equal(existsSync(path.join(root, contract.SESSION_FILE)), false, "no session file created");

  // The user answers the CLI-posted card through the default server's endpoint.
  const previous = process.env.AGENTBROS_EVENTS;
  process.env.AGENTBROS_EVENTS = "on";
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTBROS_EVENTS;
    else process.env.AGENTBROS_EVENTS = previous;
  });
  const server = await startTestServer(root);
  t.after(() => server.close());
  const res = await raw(server.port, {
    method: "POST",
    path: `/api/projects/${PROJECT}/cards/${cardId}/answer`,
    headers: postHeaders(server),
    body: JSON.stringify({ choice: "sf-2", text: "The second one." }),
  });
  assert.equal(res.status, 200, res.text);
  const answered = contract.CardSchema.parse(JSON.parse(readFileSync(path.join(root, file), "utf8")));
  assert.equal(answered.answer?.choice, "sf-2");
  const after = readFileSync(path.join(root, "public/projects", PROJECT, contract.EVENTS_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line) => contract.ConsoleEventSchema.parse(JSON.parse(line)));
  const answerEvent = after.find((event) => event.kind === "card.answered")!;
  assert.equal(answerEvent.data?.cardId, cardId);
  assert.equal(answerEvent.actor, "user");
  assert.equal(answerEvent.channel, "console");
  assert.equal(after.find((event) => event.kind === "card.posted")!.channel, "cli");
});

test("console:card refuses bad input with the CLI's codes and writes nothing", (t) => {
  const root = workspace(t);
  const choice = inputs.find((input) => input.kind === "choice")!;
  const grid = inputs.find((input) => input.kind === "grid")!;
  const cases: [string, string[], string][] = [
    [
      "traversal",
      [
        "--kind",
        "grid",
        "--data",
        writeData(root, { ...grid, media: [{ path: "../../x.png", kind: "image" }, grid.media[1]] }, "a.json"),
      ],
      "VALIDATION",
    ],
    [
      "missing media",
      [
        "--kind",
        "grid",
        "--data",
        writeData(root, { ...grid, media: [{ path: "design/none.png", kind: "image" }, grid.media[1]] }, "b.json"),
      ],
      "FILE_NOT_FOUND",
    ],
    ["kind mismatch", ["--kind", "grid", "--data", writeData(root, choice, "c.json")], "VALIDATION"],
    ["not JSON", ["--kind", "choice", "--data", writeData(root, "{nope", "d.json")], "VALIDATION"],
    [
      "oversize",
      ["--kind", "choice", "--data", writeData(root, { ...choice, pad: "x".repeat(300 * 1024) }, "e.json")],
      "INVALID_INPUT",
    ],
    ["no data file", ["--kind", "choice", "--data", path.join(root, "none.json")], "FILE_NOT_FOUND"],
    [
      "bad expiry",
      ["--kind", "choice", "--data", writeData(root, choice, "f.json"), "--expires-in", "1w"],
      "INVALID_INPUT",
    ],
  ];
  for (const [name, args, code] of cases) {
    const envelope = run(root, ["--project", PROJECT, ...args]);
    assert.equal(envelope.ok, false, name);
    assert.equal(envelope.error, code, `${name}: ${envelope.message}`);
  }
  const missing = run(root, ["--project", "no-such-project", "--kind", "choice", "--data", writeData(root, choice)]);
  assert.equal(missing.error, "PROJECT_NOT_FOUND");
  assert.equal(existsSync(path.join(root, "public/projects/no-such-project")), false);
  assert.equal(existsSync(path.join(root, "public/projects", PROJECT, contract.CARDS_DIR)), false);
  assert.deepEqual(readdirSync(path.join(root, "public/projects", PROJECT, "pipeline")).sort(), ["events.jsonl"]);
});
