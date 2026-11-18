/**
 * Attribution from a verified console grant only (RFC 0004 D9, D12, D15): AGENTBROS_ACTOR / AGENTBROS_CHANNEL are
 * claims an agent can set; the user on the console needs a grant signed for this exact argv (cli/channel.ts). The
 * journal, reconciliation evidence and failure-notice suppression all depend on it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ConsoleEventSchema, SESSION_FILE } from "../src/types/console";
import { resolveAttribution, wordsChannel } from "../src/lib/cli/channel";
import { consoleGrantEnv, GRANT_SESSION_FILE, grantSessionToken } from "../src/lib/console/grant";
import { eventNotice } from "../src/lib/console/notify-rules";
import { loadOrCreateSessionToken, readSessionToken } from "../src/lib/console/session";
import { userInputEvidence } from "../src/lib/console/user-actions";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const FIXTURE = path.join(REPO, "tests/fixtures/console-journal/run.ts");
const CLAIM = { AGENTBROS_ACTOR: "user", AGENTBROS_CHANNEL: "console" };

function root(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-attribution-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "public/projects/demo/pipeline/session"), { recursive: true });
  loadOrCreateSessionToken(dir);
  return dir;
}

test("resolveAttribution: the user on the console only with a grant for this argv", (t) => {
  const rootDir = root(t);
  const args = ["--project", "demo", "--answer=Yes."];
  const argv = ["node", "script.ts", ...args];
  const claimed = resolveAttribution({ rootDir, argv, env: CLAIM });
  assert.deepEqual(claimed, {
    actor: "agent",
    channel: "cli",
    verified: false,
    claimed: { actor: "user", channel: "console" },
  });
  const granted = resolveAttribution({ rootDir, argv, env: { ...CLAIM, ...consoleGrantEnv(rootDir, "demo", args) } });
  assert.deepEqual(granted, { actor: "user", channel: "console", verified: true });
  for (const [what, grant] of [
    ["another argv", consoleGrantEnv(rootDir, "demo", ["--project", "demo", "--answer=No."])],
    ["another project", consoleGrantEnv(rootDir, "other", args)],
    ["expired", consoleGrantEnv(rootDir, "demo", args, new Date(Date.now() - 61_000))],
  ] as const)
    assert.equal(resolveAttribution({ rootDir, argv, env: { ...CLAIM, ...grant } }).verified, false, what);
  // A project-less console spawn is signed for "" (spawn.ts).
  const global = ["--add", "--quote=Keep it short."];
  assert.equal(
    resolveAttribution({
      rootDir,
      argv: ["node", "memory.ts", ...global],
      env: { ...CLAIM, ...consoleGrantEnv(rootDir, "", global) },
    }).verified,
    true,
  );
  // Unprivileged channels and actors are taken as they are.
  assert.deepEqual(resolveAttribution({ rootDir, argv, env: { AGENTBROS_CHANNEL: "mcp" } }), {
    actor: "agent",
    channel: "mcp",
    verified: false,
  });
  // Records of the user's words: `channel: "console"` never from env words alone.
  assert.deepEqual(wordsChannel(CLAIM), {});
});

test("a failed run that only claims the user is journaled as the agent's, so its failure is notified", (t) => {
  const rootDir = root(t);
  writeFileSync(
    path.join(rootDir, "public/projects/demo/pipeline/session/lease.json"),
    JSON.stringify({ step: "build", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
  );
  const run = spawnSync(process.execPath, [TSX, FIXTURE, "--project", "demo", "--mode", "cli-error"], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      AGENTBROS_EVENTS: "on",
      AGENTBROS_STEP_GUARD: "off",
      AGENTBROS_RUN_ID: "",
      npm_lifecycle_event: "",
      ...CLAIM,
    },
  });
  assert.equal(run.status, 1, run.stderr);
  const events = readFileSync(path.join(rootDir, "public/projects/demo/pipeline/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => ConsoleEventSchema.parse(JSON.parse(line)));
  const end = events.find((event) => event.kind === "cli.end")!;
  assert.equal(end.ok, false);
  assert.equal(end.actor, "agent");
  assert.equal(end.channel, "cli");
  assert.equal(eventNotice(end)?.kind, "failure", "not suppressed as the user's own console action");
  // The same failure, verified as the user's on the console, is suppressed (the user saw it in the page).
  assert.equal(eventNotice({ ...end, actor: "user", channel: "console" }), undefined);
});

test("reconciliation evidence needs the console channel, which only a verified run writes", (t) => {
  const rootDir = root(t);
  const createdAt = new Date(Date.now() - 1000).toISOString();
  const decision = {
    id: "dec-1",
    project: "demo",
    kind: "rating",
    ratings: { "media/frame.png": 5 },
    createdAt,
  } as unknown as Parameters<typeof userInputEvidence>[1];
  const write = (channel: "cli" | "console") =>
    writeFileSync(
      path.join(rootDir, "public/projects/demo/pipeline/ratings.json"),
      JSON.stringify({
        v: 1,
        ratings: [
          {
            id: "01KA7Z00000000000000000001",
            target: { path: "media/frame.png" },
            kind: "styleframe",
            score: 5,
            by: "user",
            channel,
            at: new Date().toISOString(),
          },
        ],
      }),
    );
  write("cli");
  assert.equal(userInputEvidence(rootDir, decision), false);
  write("console");
  assert.equal(userInputEvidence(rootDir, decision), true);
});

test("the grant's zod-free session reader agrees with the contract's", (t) => {
  assert.equal(GRANT_SESSION_FILE, SESSION_FILE);
  const rootDir = root(t);
  const file = path.join(rootDir, SESSION_FILE);
  assert.equal(grantSessionToken(rootDir), readSessionToken(rootDir));
  for (const body of [
    { v: 1, token: "A".repeat(64) },
    { v: 2, token: "a".repeat(64) },
    { v: 1, token: "a".repeat(64), extra: true },
    { token: "a".repeat(64) },
    "not json",
  ]) {
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    assert.equal(grantSessionToken(rootDir), undefined, JSON.stringify(body));
    assert.equal(readSessionToken(rootDir), undefined, JSON.stringify(body));
  }
});
