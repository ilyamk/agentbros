/**
 * RFC 0004 WP5 end to end: decisions derived by the real projector (`deriveWaiting`, WP3) on a tests/film-chain
 * fixture, applied through the console endpoint with the real CLIs (A6, A8, A13, ask for changes). The user's words
 * start with dashes on purpose: they must reach the CLI as words, never as flags.
 */
import assert from "node:assert/strict";
import { loadOrCreateSessionToken } from "../src/lib/console/session";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DecisionResponseSchema, type CliEnvelope, type Decision } from "../src/types/console";
import { consoleActionsWith, createDecisionActions } from "../src/lib/console/apply";
import { notImplementedActions } from "../src/lib/console/data";
import { decisionExpect } from "../src/lib/console/expect";
import { listDecisions } from "../src/lib/console/inbox";
import { createSpawnCli, type SpawnRequest } from "../src/lib/console/spawn";
import { controlFileOf } from "../src/lib/console/control";
import { decisionId } from "../src/lib/console/view/decision";
import { feedbackRound } from "../src/lib/console/view/film";
import { deriveWaiting } from "../src/lib/console/view/waiting";
import { approveStep, deriveChain, openFilmProject, sealStep } from "../src/lib/film/state";
import { OperationStore } from "../src/lib/jobs/store";
import { postHeaders, raw, startTestServer } from "./helpers/console-server";
import { toConceptApproved, toScriptPicked } from "./helpers/film-studio";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const FILM = "film";
const AT = "2026-11-17T10:00:00.000Z";
const ON = { ...process.env, AGENTBROS_EVENTS: "on", AGENTBROS_CONSOLE: "off", AGENTBROS_HOOKS: "off" };
const OK: CliEnvelope = { ok: true, outputs: [], metadata: {}, elapsedMs: 1 };

function filmRoot() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-actions-film-")));
  loadOrCreateSessionToken(root); // the console signs its spawns with this checkout's token (grant.ts)
  const init = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/film-init.ts"), "--project", FILM], {
    cwd: root,
    encoding: "utf8",
    env: ON,
  });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const dir = path.join(root, "public/projects", FILM);
  const pipeline = path.join(dir, "pipeline");
  const project = () => openFilmProject(dir, { rootDir: root });
  const film = {
    dir,
    seal: (id: string) => sealStep(project(), id),
    approve: (id: string) => approveStep(project(), id, `yes to ${id}`),
  };
  const place = (...files: string[]) =>
    files.forEach((file) => copyFileSync(path.join(FIXTURES, file), path.join(pipeline, file)));
  return { root, dir, project, film, place };
}

/** A fixture film at its script gate. */
function toScriptGate(f: ReturnType<typeof filmRoot>) {
  f.place("brief.json");
  f.film.seal("intake");
  f.film.approve("intake");
  f.place("product-truth.json");
  f.film.seal("truth");
  f.place("film-targets.json");
  f.film.seal("reference");
  toConceptApproved(f.film, FILM);
  mkdirSync(path.join(f.dir, "music"), { recursive: true });
  copyFileSync(path.join(FIXTURES, "track.wav"), path.join(f.dir, "music/track.wav"));
  f.place("music-shortlist.json", "music-decision.json");
  f.film.seal("music");
  f.film.approve("music");
  f.place("audio-map.json");
  f.film.seal("audio-map");
  toScriptPicked(f.film, FILM);
  f.film.seal("script");
}

const scriptGate = async (root: string) => {
  const gate = (await deriveWaiting(root, FILM)).find((item) => item.step === "script");
  assert.ok(gate, "the projector derives the script gate");
  assert.ok(gate.expect, "with the hash of what the user reviews");
  return gate;
};

test("A6: the script gate, derived by the projector, is approved through the endpoint; the chain advances", async (t) => {
  const f = filmRoot();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  toScriptGate(f);
  const pending = await scriptGate(f.root);
  const approve = pending.options!.find((option) => option.argv.includes("film:approve"))!;

  const actions = consoleActionsWith(f.root, notImplementedActions, {
    deriveWaiting,
    spawnCli: createSpawnCli({ env: ON, timeoutMs: 600_000 }),
    env: ON,
  });
  const server = await startTestServer(f.root, { actions });
  t.after(() => server.close());
  const target = `/api/projects/${FILM}/decisions`;
  // Words that parseArgs would read as its help flag if they travelled as their own argv element.
  const phrase = "-h — approve script B.";
  // Exactly what the UI sends (apps/console/components/decision-card.tsx).
  const body = JSON.stringify({ decisionId: pending.id, choice: approve.id, answer: phrase, expect: pending.expect });
  const unknown = await raw(server.port, {
    method: "POST",
    path: `${target}?apply=now`,
    headers: postHeaders(server),
    body,
  });
  assert.equal(unknown.status, 400, "unknown query keys are refused");
  const preview = await raw(server.port, {
    method: "POST",
    path: `${target}?dryRun=1`,
    headers: postHeaders(server),
    body,
  });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(DecisionResponseSchema.parse(preview.json()).decision.status, "pending");
  assert.equal(deriveChain(f.project()).steps.find((s) => s.id === "script")!.status, "awaiting-gate");

  // The user paused the project in the console: their own decision still applies (WP8's console grant).
  mkdirSync(path.dirname(controlFileOf(f.dir)), { recursive: true });
  writeFileSync(
    controlFileOf(f.dir),
    JSON.stringify({ v: 1, state: "paused", by: "user", channel: "console", at: AT, history: [] }),
  );
  const res = await raw(server.port, { method: "POST", path: target, headers: postHeaders(server), body });
  assert.equal(res.status, 200, res.text);
  const reply = DecisionResponseSchema.parse(res.json());
  assert.equal(reply.ok, true, res.text);
  assert.equal(reply.decision.status, "applied");
  assert.deepEqual(reply.decision.argv, [
    "pnpm",
    "film:approve",
    "--project",
    FILM,
    "--step",
    "script",
    `--answer=${phrase}`,
    "--expect",
    approve.argv[approve.argv.indexOf("--expect") + 1],
  ]);
  // film:approve ran with exactly that text, from the console.
  const approvals = JSON.parse(readFileSync(path.join(f.dir, "pipeline/approvals/script.json"), "utf8"));
  assert.equal(approvals.events.at(-1).answer, phrase);
  assert.equal(approvals.events.at(-1).channel, "console");
  // The chain advances.
  assert.equal(deriveChain(f.project()).steps.find((s) => s.id === "script")!.status, "done");
  const next = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/film-next.ts"), "--project", FILM], {
    cwd: f.root,
    encoding: "utf8",
    env: ON,
  });
  const answer = JSON.parse(next.stdout.trim().split("\n").at(-1)!);
  assert.equal(answer.ok, true, next.stdout);
  assert.notEqual(answer.metadata.step, "script");
  // History: the inbox file and the journal (the CLI's own run and the decision event).
  const history = listDecisions(f.root, FILM);
  assert.equal(history.decisions[0]!.answer, phrase);
  assert.equal(history.events.at(-1)!.kind, "decision.applied");
  const journal = readFileSync(path.join(f.dir, "pipeline/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const end = journal.find((event) => event.kind === "cli.end" && event.alias === "film:approve");
  assert.ok(end, "film:approve journaled its run");
  assert.equal(end.channel, "console");
  assert.equal(end.actor, "user");
  // The same command run outside the console, without the grant, is held by the pause.
  const held = spawnSync(
    process.execPath,
    [TSX, path.join(REPO, "scripts/film-approve.ts"), "--project", FILM, "--step", "script", "--answer=Yes."],
    { cwd: f.root, encoding: "utf8", env: ON },
  );
  assert.equal(JSON.parse(held.stdout.trim().split("\n").at(-1)!).error, "PAUSED", held.stdout);
  // A second submit returns the first outcome; another choice is 409 with it.
  const again = await raw(server.port, { method: "POST", path: target, headers: postHeaders(server), body });
  assert.deepEqual(DecisionResponseSchema.parse(again.json()).decision, reply.decision);
  const other = await raw(server.port, {
    method: "POST",
    path: target,
    headers: postHeaders(server),
    body: JSON.stringify({
      decisionId: pending.id,
      choice: "changes",
      answer: "No, change it.",
      expect: pending.expect,
    }),
  });
  assert.equal(other.status, 409, other.text);
  assert.equal(other.json().error, "ALREADY_DECIDED");
  assert.deepEqual(other.json().decision, reply.decision);
});

test("A6: what the user saw changed before the CLI ran: film:approve refuses the derived outputs hash", async (t) => {
  const f = filmRoot();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  toScriptGate(f);
  const pending = await scriptGate(f.root);
  // The server derives the gate, then a script output changes before the spawn: the CLI holds the user's snapshot.
  const actions = createDecisionActions(f.root, {
    deriveWaiting: async () => [pending],
    spawnCli: async (request) => {
      const script = path.join(f.dir, "pipeline/script.json");
      writeFileSync(script, `${readFileSync(script, "utf8").trimEnd()} \n`);
      return createSpawnCli({ env: ON, timeoutMs: 600_000 })(request);
    },
    env: ON,
  });
  const result = await actions.decide(FILM, {
    decisionId: pending.id,
    choice: "approve",
    answer: "Approve script B.",
    expect: pending.expect!,
  });
  assert.equal(result.decision.status, "refused", JSON.stringify(result.decision.result));
  assert.equal(result.decision.result!.error, "STAGE_INCOMPLETE");
  assert.notEqual(deriveChain(f.project()).steps.find((s) => s.id === "script")!.status, "done");
});

test("ask for changes at the script gate before a render: the words go to memory; the next round is a new decision", async (t) => {
  const f = filmRoot();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  toScriptGate(f);
  const pending = await scriptGate(f.root);
  const changes = pending.options!.find((option) => option.id === "changes");
  assert.ok(changes, "the projector offers changes");
  const actions = createDecisionActions(f.root, {
    deriveWaiting,
    spawnCli: createSpawnCli({ env: ON, timeoutMs: 600_000 }),
    env: ON,
  });
  const words = "- the hook is too slow; open on the empty list.";
  const result = await actions.decide(FILM, {
    decisionId: pending.id,
    choice: "changes",
    answer: words,
    expect: pending.expect!,
  });
  assert.equal(result.ok, true, JSON.stringify(result.decision.result));
  assert.equal(result.decision.argv![1], "memory");
  assert.ok(result.decision.argv!.includes(`--quote=${words}`));
  const memoryRoot = process.env.AGENTBROS_MEMORY_ROOT!;
  const entry = readdirSync(path.join(memoryRoot, "decisions"))
    .map((name) => readFileSync(path.join(memoryRoot, "decisions", name), "utf8"))
    .find((text) => text.includes(words));
  assert.ok(entry, "the user's words are kept as a decision");
  // The gate is still asked, unchanged files and all, but as a new round: a new id, and the old one never runs again.
  const again = await scriptGate(f.root);
  assert.equal(feedbackRound(f.dir, "script"), 1);
  assert.notEqual(again.id, pending.id);
  assert.equal(again.id, decisionId(FILM, "gate", "script", pending.bindTo, 1));
  const approved = await actions.decide(FILM, {
    decisionId: again.id,
    choice: "approve",
    answer: "Now it works: approve.",
    expect: again.expect!,
  });
  assert.equal(approved.decision.status, "applied", JSON.stringify(approved.decision.result));
  assert.equal(deriveChain(f.project()).steps.find((s) => s.id === "script")!.status, "done");
});

test("A8: a recording's paid quote is approved as a ceiling with the user's words; nothing is spent", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-actions-")));
  loadOrCreateSessionToken(root); // the console signs its spawns with this checkout's token (grant.ts)
  const PROJECT = "demo-rec";
  mkdirSync(path.join(root, "public/projects", PROJECT, "pipeline"), { recursive: true });
  writeFileSync(path.join(root, "public/projects", PROJECT, "project.json"), JSON.stringify({ id: PROJECT }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base: Decision = {
    v: 1,
    id: "quote-recut",
    project: PROJECT,
    kind: "quote",
    step: "recut-plan",
    title: "Dubbing",
    bindTo: [{ path: "pipeline/recut-plan.json", sha256: "a".repeat(64) }],
    quote: { amountUsd: 1.25, provider: "elevenlabs", ceilingUsd: 5, summary: "Dubbing" },
    status: "pending",
    createdAt: AT,
  };
  const quote = { ...base, expect: decisionExpect(base) };
  const actions = createDecisionActions(root, {
    deriveWaiting: async () => [quote],
    spawnCli: createSpawnCli({ env: ON, timeoutMs: 600_000 }),
    routeOf: () => "footage",
    env: ON,
  });
  const words = "--ceiling-usd 500, no: up to five dollars.";
  const result = await actions.decide(PROJECT, { decisionId: "quote-recut", answer: words, expect: quote.expect });
  assert.equal(result.ok, true, JSON.stringify(result.decision.result));
  assert.deepEqual(result.decision.argv, [
    "pnpm",
    "budget",
    "--project",
    PROJECT,
    "--ceiling-usd",
    "5",
    `--answer=${words}`,
  ]);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const store = new OperationStore(PROJECT);
    assert.equal(store.ceilingUsd(), 5);
    const snapshot = store.snapshot();
    assert.deepEqual(Object.keys(snapshot.jobs), [], "the console reserved and spent nothing");
    const grant = snapshot.policyEvents!.at(-1)!.grant as { by: string; answer: string; channel?: string };
    assert.deepEqual(grant, { by: "user", answer: words, channel: "console" });
  } finally {
    process.chdir(cwd);
  }
});

test("A13: the verdict approves human, writes the memory entry and the frame comments as feedback", async (t) => {
  const f = filmRoot();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.place("brief.json");
  mkdirSync(path.join(f.root, "out", FILM), { recursive: true });
  writeFileSync(path.join(f.root, "out", FILM, "film.mp4"), "fake film");
  const filmSha = createHash("sha256").update("fake film").digest("hex");
  const base: Decision = {
    v: 1,
    id: "verdict-human",
    project: FILM,
    kind: "verdict",
    step: "human",
    title: "Final verdict",
    bindTo: [{ path: "@out/film.mp4", sha256: filmSha }],
    options: [
      {
        id: "accept",
        label: "Accept",
        argv: [
          "pnpm",
          "film:approve",
          "--project",
          FILM,
          "--step",
          "human",
          "--answer",
          "<the user's words>",
          "--expect",
          filmSha,
        ],
      },
    ],
    status: "pending",
    createdAt: AT,
  };
  const human = { ...base, expect: decisionExpect(base) };
  const real = createSpawnCli({ env: ON, timeoutMs: 600_000 });
  const approvals: SpawnRequest[] = [];
  // The chain cannot reach human in a unit fixture: film:approve is checked by its argv, the rest run for real.
  const actions = createDecisionActions(f.root, {
    deriveWaiting: async () => [human],
    spawnCli: async (request) => {
      if (request.alias !== "film:approve") return real(request);
      approvals.push(request);
      return { envelope: OK, exitCode: 0 };
    },
    routeOf: () => "film",
    env: ON,
  });
  const words = "-- 8/10: the hook lands, the ending drags.";
  const result = await actions.decide(FILM, {
    kind: "verdict",
    answer: words,
    expect: human.expect,
    verdict: { score: 8, axes: { hook: 9 }, worked: "The opening.", didNot: "The end card." },
    frameComments: [
      {
        media: { root: "out", path: "film.mp4", kind: "video", sha256: filmSha, fps: 30 },
        frame: 60,
        text: "-h hold this longer.",
      },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.decision.result));
  assert.equal(result.decision.status, "applied");
  assert.deepEqual(approvals[0]!.args, [
    "--project",
    FILM,
    "--step",
    "human",
    `--answer=${words}`,
    "--expect",
    filmSha,
  ]);
  const followUps = (result.decision.result!.metadata as { followUps: { ok: boolean; argv: string[] }[] }).followUps;
  assert.deepEqual(
    followUps.map((item) => [item.argv[1], item.ok]),
    [
      ["memory", true],
      ["feedback", true],
    ],
  );
  // Memory: a decision in the user's words with the scores, from the console.
  const memoryRoot = process.env.AGENTBROS_MEMORY_ROOT!;
  const files = readdirSync(path.join(memoryRoot, "decisions")).filter((name) => name.endsWith(".md"));
  const entry = files
    .map((name) => readFileSync(path.join(memoryRoot, "decisions", name), "utf8"))
    .find((text) => text.includes(words));
  assert.ok(entry, "the verdict's memory entry");
  assert.match(entry, /Final verdict 8\/10 \(hook 9\)/);
  assert.match(entry, /channel: "console"/);
  assert.match(entry, /The end card\./);
  // Feedback: the frame comment as an accepted item at 2 s on the exact film.
  const record = JSON.parse(readFileSync(path.join(f.dir, "pipeline/feedback/fb-001.json"), "utf8"));
  assert.equal(record.verdict, "accept");
  assert.equal(record.source.channel, "console");
  assert.deepEqual(record.watched, { path: `out/${FILM}/film.mp4`, sha256: filmSha });
  assert.equal(record.items[0].quote, "-h hold this longer.");
  assert.deepEqual(record.items[0].at, { fromSec: 2, toSec: 2 });
});
