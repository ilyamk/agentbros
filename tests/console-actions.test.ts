/**
 * RFC 0004 WP5: the console's decisions. The action table yields the exact argv for every action (the user's words
 * always one `--flag=value` token); the applier finds the decision again in the current state, refuses stale,
 * superseded and already-decided ones with 409, runs the owning CLI once per decision, writes the inbox file with the
 * user's words verbatim and journals the outcome. End-to-end runs are in console-actions-e2e.test.ts.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DecisionSchema,
  type CliEnvelope,
  type Decision,
  type DecisionRequest,
  type DecisionResponse,
} from "../src/types/console";
import { planDecision, pnpmArgv, POSTMORTEM_HINT, verdictSummary, type CommandPlan } from "../src/lib/console/actions";
import { createDecisionActions } from "../src/lib/console/apply";
import { decisionExpect } from "../src/lib/console/expect";
import { listDecisions, MAX_REFUSED_ATTEMPTS, readInbox } from "../src/lib/console/inbox";
import { childEnv, createSpawnCli, envelopeOf, isAmbiguous, type SpawnRequest } from "../src/lib/console/spawn";
import { decisionId } from "../src/lib/console/view/decision";
import { artefactsExpect } from "../src/lib/film/expect";

const PROJECT = "demo-film";
const H = (c: string) => c.repeat(64);
const AT = "2026-11-17T10:00:00.000Z";
const PH = "<the user's words>";
/** The outputs hash the projector puts in the approve option's argv (WP3 `outputsHash`). */
const OUT = artefactsExpect([H("a"), H("b")]);

const approveArgv = (step: string, expect = OUT) => [
  "pnpm",
  "film:approve",
  "--project",
  PROJECT,
  "--step",
  step,
  "--answer",
  PH,
  "--expect",
  expect,
];

const decision = (overrides: Partial<Decision> = {}): Decision => {
  const base: Decision = {
    v: 1,
    id: "gate-script-1",
    project: PROJECT,
    kind: "gate",
    step: "script",
    title: "Approve script",
    bindTo: [
      { path: "pipeline/script.json", sha256: H("a") },
      { path: "pipeline/script.md", sha256: H("b") },
    ],
    options: [{ id: "approve", label: "Approve", argv: approveArgv("script") }],
    status: "pending",
    createdAt: AT,
    ...overrides,
  };
  return { ...base, expect: decisionExpect(base) };
};

const plan = (d: Decision, request: Partial<DecisionRequest>, route = "film", expects?: object) =>
  planDecision({
    project: PROJECT,
    route,
    decision: d,
    request: { answer: "Yes.", ...request } as DecisionRequest,
    ...(expects ? { expects } : {}),
  });
const argvOf = (commands: CommandPlan[]) => commands.map((command) => pnpmArgv(command));

test("expect: the decision hash covers every binding and the quote; artefactsExpect is content-only", () => {
  assert.equal(artefactsExpect([H("c")]), H("c"));
  assert.equal(artefactsExpect([H("b"), H("a")]), artefactsExpect([H("a"), H("b")]));
  const d = decision();
  assert.notEqual(d.expect, H("a"), "not the first binding's hash");
  const second = decision({
    bindTo: [
      { path: "pipeline/script.json", sha256: H("a") },
      { path: "pipeline/script.md", sha256: H("c") },
    ],
  });
  assert.notEqual(second.expect, d.expect, "a change in any binding changes the hash");
  const quoted = decision({ kind: "quote", quote: { amountUsd: 1, provider: "fal", quoteHash: H("9") } });
  assert.notEqual(quoted.expect, d.expect, "the quote is part of it");
  assert.equal(DecisionSchema.safeParse(d).success, true);
});

test("mapping: every action yields its exact argv, the words one --flag=value token", () => {
  const words = "-h Approve script B.";
  assert.deepEqual(argvOf(plan(decision(), { answer: words }, "film", { approve: OUT }).commands), [
    ["pnpm", "film:approve", "--project", PROJECT, "--step", "script", `--answer=${words}`, "--expect", OUT],
  ]);
  // The derived option carries its own --expect: the outputs hash derived with what the user saw.
  assert.deepEqual(argvOf(plan(decision(), { answer: words, choice: "approve" }).commands), [
    ["pnpm", "film:approve", "--project", PROJECT, "--step", "script", `--answer=${words}`, "--expect", OUT],
  ]);
  // A derived option without the words' placeholder is built by the table.
  const bare = decision({ options: [{ id: "approve", label: "Approve", argv: ["pnpm", "film:approve"] }] });
  assert.deepEqual(argvOf(plan(bare, { answer: words, choice: "approve" }).commands), [
    ["pnpm", "film:approve", "--project", PROJECT, "--step", "script", `--answer=${words}`],
  ]);
  // Ask for changes: the step-level feedback, routed to the step's revise owner by the CLI.
  assert.deepEqual(
    argvOf(plan(decision(), { answer: "- shorter hook", choice: "changes" }, "film", { feedback: OUT }).commands),
    [
      [
        "pnpm",
        "feedback",
        "--project",
        PROJECT,
        "--step",
        "script",
        "--answer=- shorter hook",
        "--expect",
        OUT,
        "--confirm",
      ],
    ],
  );
  // Choose an idea: a candidate option of a choice decision approves the gate with the user's words.
  const concept = decision({
    id: "choice-concept",
    kind: "choice",
    step: "concept",
    bindTo: [{ path: "pipeline/concept.json", sha256: H("c") }],
    options: [
      { id: "idea-1", label: "Idea 1", argv: approveArgv("concept", H("c")) },
      { id: "idea-2", label: "Idea 2", argv: approveArgv("concept", H("c")) },
    ],
  });
  const chosen = plan(concept, { answer: "Idea 2, warmer.", choice: "idea-2" }, "film", { approve: H("c") });
  assert.equal(chosen.action, "choose");
  assert.equal(chosen.choice, "idea-2");
  assert.deepEqual(argvOf(chosen.commands), [
    ["pnpm", "film:approve", "--project", PROJECT, "--step", "concept", "--answer=Idea 2, warmer.", "--expect", H("c")],
  ]);
  assert.throws(() => plan(concept, { answer: "x y" }), /Choose one of the options/);
  assert.throws(() => plan(concept, { choice: "idea-9" }), /not an option/);
  // A paid quote on a film: film:approve at material; on a recording: the budget ceiling the quote names.
  const quote = decision({
    id: "quote-material",
    kind: "quote",
    step: "material",
    options: undefined,
    quote: { amountUsd: 4.2, provider: "fal", ceilingUsd: 12 },
  });
  assert.deepEqual(argvOf(plan(quote, { answer: "Yes, spend it." }).commands), [
    ["pnpm", "film:approve", "--project", PROJECT, "--step", "material", "--answer=Yes, spend it."],
  ]);
  assert.deepEqual(argvOf(plan({ ...quote, step: "recut-plan" }, { answer: "Go." }, "footage").commands), [
    ["pnpm", "budget", "--project", PROJECT, "--ceiling-usd", "12", "--answer=Go."],
  ]);
  assert.throws(() => plan({ ...quote, step: "script" }, {}), /material or narration/);
  assert.throws(
    () => plan({ ...quote, quote: { amountUsd: null, provider: "fal" } }, {}, "footage"),
    /names no ceiling/,
  );
  // Skip: only a skippable step of the chain.
  const skip = (step: string) =>
    decision({
      step,
      options: [
        { id: "skip", label: "Skip", argv: ["pnpm", "film:done", "--project", PROJECT, "--step", step, "--skip", PH] },
      ],
    });
  assert.deepEqual(argvOf(plan(skip("discovery"), { answer: "--help", choice: "skip" }).commands), [
    ["pnpm", "film:done", "--project", PROJECT, "--step", "discovery", "--skip=--help"],
  ]);
  assert.throws(() => plan(skip("script"), { choice: "skip" }), /not skippable/);
  // One more critic round: feedback at the critic step (the CLI reopens what its judge judges).
  const critic = decision({
    step: "critic",
    bindTo: [{ path: "pipeline/critique/round-3.json", sha256: H("d") }],
    options: [{ id: "another-round", label: "One more round", argv: ["pnpm", "feedback", "--step", "critic"] }],
  });
  assert.deepEqual(argvOf(plan(critic, { answer: "Once more, hold the end.", choice: "another-round" }).commands), [
    ["pnpm", "feedback", "--project", PROJECT, "--step", "critic", "--answer=Once more, hold the end.", "--confirm"],
  ]);
  assert.throws(() => plan(decision({ options: critic.options }), { choice: "another-round" }), /has no critic/);
  // Autonomy and a ceiling: the mode and amount come from the derived option, never from the request.
  const controls = decision({
    kind: "choice",
    step: "policy",
    bindTo: [],
    options: [
      {
        id: "go-autonomous",
        label: "Run autonomously up to $20",
        argv: ["pnpm", "film:policy", "--project", PROJECT, "--autonomy", "autonomous", "--ceiling-usd", "20"],
        consequential: true,
      },
      { id: "raise", label: "Raise to $30", argv: ["pnpm", "budget", "--ceiling-usd=30"], consequential: true },
    ],
  });
  assert.deepEqual(argvOf(plan(controls, { answer: "Go on alone.", choice: "go-autonomous" }).commands), [
    [
      "pnpm",
      "film:policy",
      "--project",
      PROJECT,
      "--autonomy",
      "autonomous",
      "--answer=Go on alone.",
      "--ceiling-usd",
      "20",
    ],
  ]);
  assert.deepEqual(argvOf(plan(controls, { answer: "Up to 30.", choice: "raise" }).commands), [
    ["pnpm", "budget", "--project", PROJECT, "--ceiling-usd", "30", "--answer=Up to 30."],
  ]);
});

test("mapping: a derived first-question argv runs with the words in place; changes is always on offer", () => {
  const music = decision({
    kind: "choice",
    step: "music",
    options: [
      {
        id: "candidate-t1",
        label: "Track 1",
        argv: [
          "pnpm",
          "music",
          "--action",
          "record",
          "--project",
          PROJECT,
          "--route",
          "free-stock",
          "--candidate",
          "t1",
          "--answer",
          PH,
          "--reason",
          PH,
        ],
      },
    ],
  });
  const recorded = plan(music, { answer: "-h, track 1 breathes.", choice: "candidate-t1" });
  assert.equal(recorded.action, "record");
  assert.deepEqual(argvOf(recorded.commands), [
    [
      "pnpm",
      "music",
      "--action",
      "record",
      "--project",
      PROJECT,
      "--route",
      "free-stock",
      "--candidate",
      "t1",
      "--answer=-h, track 1 breathes.",
      "--reason=-h, track 1 breathes.",
    ],
  ]);
  // The projector lists only approve; asking for changes is still the user's to do.
  assert.equal(plan(decision(), { choice: "changes" }).commands[0]!.alias, "feedback");
});

test("mapping: WP3's derived options run as derived (choice, clarify, raise, changes by feedback file or memory)", () => {
  const words = "-h: warmer, and open on the empty list.";
  // idea-<id> carries film:approve --choice <id>.
  const concept = decision({
    id: "choice-concept",
    kind: "choice",
    step: "concept",
    options: [{ id: "idea-b", label: "Idea B", argv: [...approveArgv("concept"), "--choice", "b"] }],
  });
  assert.deepEqual(argvOf(plan(concept, { answer: words, choice: "idea-b" }).commands), [
    [
      "pnpm",
      "film:approve",
      "--project",
      PROJECT,
      "--step",
      "concept",
      `--answer=${words}`,
      "--expect",
      OUT,
      "--choice",
      "b",
    ],
  ]);
  // clarify: feedback --clarify with the words.
  const clarify = decision({
    options: [
      {
        id: "clarify",
        label: "Say exactly what you want",
        argv: ["pnpm", "feedback", "--project", PROJECT, "--step", "script", "--clarify", PH],
      },
    ],
  });
  const clarified = plan(clarify, { answer: words, choice: "clarify" });
  assert.equal(clarified.action, "clarify");
  assert.deepEqual(argvOf(clarified.commands), [
    ["pnpm", "feedback", "--project", PROJECT, "--step", "script", `--clarify=${words}`],
  ]);
  // raise-<limit>: film:policy --raise, the chain's own placeholder normalised.
  const best = decision({
    step: "present-best",
    options: [
      {
        id: "raise-critic-rounds",
        label: "Raise critic rounds to 5",
        argv: ["pnpm", "film:policy", "--project", PROJECT, "--raise", "criticRounds=5", "--answer", "<user's words>"],
        consequential: true,
      },
    ],
  });
  const raised = plan(best, { answer: words, choice: "raise-critic-rounds" });
  assert.equal(raised.action, "raise");
  assert.deepEqual(argvOf(raised.commands), [
    ["pnpm", "film:policy", "--project", PROJECT, "--raise", "criticRounds=5", `--answer=${words}`],
  ]);
  // changes after a render: feedback --file <the console's file of the words> --confirm.
  const rendered = decision({
    step: "build",
    options: [
      {
        id: "changes",
        label: "Ask for changes",
        argv: ["pnpm", "feedback", "--project", PROJECT, "--file", "<feedback file>", "--confirm"],
      },
    ],
  });
  const changed = plan(rendered, { answer: words, choice: "changes" });
  assert.equal(changed.action, "changes");
  assert.deepEqual(argvOf(changed.commands), [
    ["pnpm", "feedback", "--project", PROJECT, "--confirm", "--file", "<changes.json>"],
  ]);
  assert.deepEqual(JSON.parse(changed.commands[0]!.attachments![0]!.content), {
    items: [{ quote: words, aspect: "shot", severity: "must" }],
  });
  // changes before a render: the words kept as a decision in memory.
  const early = decision({
    options: [
      {
        id: "changes",
        label: "Ask for changes",
        argv: [
          "pnpm",
          "memory",
          "--add",
          "--type",
          "decision",
          "--summary",
          "The user asks for changes at step script",
          "--quote",
          PH,
          "--project",
          PROJECT,
          "--step",
          "script",
        ],
      },
    ],
  });
  assert.deepEqual(argvOf(plan(early, { answer: words, choice: "changes" }).commands), [
    [
      "pnpm",
      "memory",
      "--add",
      "--type",
      "decision",
      "--summary",
      "The user asks for changes at step script",
      `--quote=${words}`,
      "--project",
      PROJECT,
      "--step",
      "script",
    ],
  ]);
  // A derived command the console does not run is refused.
  const shorts = decision({
    options: [{ id: "shorts", label: "Shorts", argv: ["pnpm", "shorts:request", "--approved-by", PH] }],
  });
  assert.throws(() => plan(shorts, { choice: "shorts" }), /does not run shorts:request|no action/);
});

test("mapping: step and action come from the derived decision only (a request's verdict or step reroutes nothing)", () => {
  // A step-less decision: a verdict in the request does not turn it into an approval of human.
  const stepless = decision({ id: "choice-x", kind: "choice", step: undefined, options: undefined });
  assert.throws(() => plan(stepless, { verdict: { score: 9 } }), /takes no verdict|Choose one of the options/);
  // A gate at script: the request's step is ignored.
  const planned = plan(decision(), { step: "human", choice: "approve" } as Partial<DecisionRequest>);
  assert.deepEqual(planned.commands[0]!.args.slice(0, 4), ["--project", PROJECT, "--step", "script"]);
  assert.throws(() => plan(decision(), { verdict: { score: 9 } }), /takes no verdict/);
});

test("mapping: the final verdict approves human, writes memory and files frame comments as accepted feedback", () => {
  const human = decision({
    id: "verdict-human",
    kind: "verdict",
    step: "human",
    bindTo: [{ path: "@out/film.mp4", sha256: H("e") }],
    options: [{ id: "accept", label: "Accept", argv: approveArgv("human", H("e")) }],
  });
  const words = "8/10. The hook lands;\nthe ending drags.";
  const verdict = { score: 8, axes: { hook: 9, ending: 5 }, worked: "The hook.", didNot: "The last shot." };
  const frameComments = [
    {
      media: { root: "out" as const, path: "film.mp4", kind: "video" as const, fps: 30 },
      frame: 45,
      text: "Hold this frame.",
    },
  ];
  const planned = plan(human, { kind: "verdict", answer: words, verdict, frameComments }, "film", {
    approve: H("e"),
  });
  assert.equal(planned.action, "verdict");
  assert.equal(planned.hint, POSTMORTEM_HINT);
  const summary = verdictSummary(verdict, words);
  assert.equal(summary, "Final verdict 8/10 (hook 9, ending 5): 8/10. The hook lands; the ending drags.");
  assert.deepEqual(argvOf(planned.commands), [
    ["pnpm", "film:approve", "--project", PROJECT, "--step", "human", `--answer=${words}`, "--expect", H("e")],
    [
      "pnpm",
      "memory",
      "--add",
      "--type",
      "decision",
      `--summary=${summary}`,
      `--quote=${words}`,
      "--project",
      PROJECT,
      "--step",
      "human",
      "--body-file",
      "<verdict.md>",
    ],
    ["pnpm", "feedback", "--project", PROJECT, "--confirm", "--file", "<frame-comments.json>"],
  ]);
  const feedback = JSON.parse(planned.commands[2]!.attachments![0]!.content);
  assert.equal(feedback.verdict, "accept", "a revise would withdraw the approval just given");
  assert.deepEqual(feedback.watched, { path: `out/${PROJECT}/film.mp4` });
  assert.deepEqual(feedback.items, [
    { quote: "Hold this frame.", aspect: "shot", severity: "should", at: { fromSec: 1.5, toSec: 1.5 }, frame: 45 },
  ]);
  const body = planned.commands[1]!.attachments![0]!.content;
  assert.match(body, /Overall: 8\/10\nhook: 9\/10\nending: 5\/10/);
  assert.ok(body.includes(words) && body.includes("The last shot."));
  assert.throws(() => plan(human, { kind: "verdict" }), /overall score/);
  assert.ok(verdictSummary({ score: 3 }, "x".repeat(400)).length <= 160);
});

test("decision ids: a new round of a gate is a new decision even with unchanged files", () => {
  const bindings = decision().bindTo;
  const first = decisionId(PROJECT, "gate", "script", bindings);
  assert.equal(decisionId(PROJECT, "gate", "script", bindings, 0), first, "round 0 keeps the id");
  assert.notEqual(decisionId(PROJECT, "gate", "script", bindings, 1), first);
});

test("spawn: the child's envelope; broken output and a help screen are not an outcome; the user's environment", () => {
  assert.deepEqual(envelopeOf('{"ok":true,"outputs":[],"metadata":{},"elapsedMs":3}\n', 0), {
    ok: true,
    outputs: [],
    metadata: {},
    elapsedMs: 3,
  });
  assert.equal(isAmbiguous(envelopeOf("", 0)), true);
  assert.equal(isAmbiguous(envelopeOf('{"ok":true}\n{"ok":true}', 0)), true);
  assert.equal(isAmbiguous(envelopeOf('{"ok":true,"elapsedMs":1}', 1)), true, "exit code disagrees");
  const help = envelopeOf('{"ok":true,"outputs":[],"metadata":{"help":true},"elapsedMs":0}', 0);
  assert.equal(help.ok, false, "a help screen applies nothing");
  assert.equal(isAmbiguous(help), false, "and it surely did not apply");
  assert.equal(
    envelopeOf('{"ok":false,"error":"INVALID_INPUT","message":"no","elapsedMs":1}', 1).error,
    "INVALID_INPUT",
  );
  const env = childEnv({
    PATH: "/bin",
    AGENTBROS_RUN_ID: "r1",
    AGENTBROS_STEP_ADMITTED: "x",
    AGENTBROS_ACTOR: "agent",
  });
  assert.equal(env.AGENTBROS_ACTOR, "user");
  assert.equal(env.AGENTBROS_CHANNEL, "console");
  assert.equal(env.AGENTBROS_RUN_ID, undefined);
  assert.equal(env.AGENTBROS_STEP_ADMITTED, undefined);
  assert.equal(env.PATH, "/bin");
});

test("spawn: the grant hook's environment reaches the child; a timeout is an unknown outcome", async (t) => {
  const REPO = path.resolve(import.meta.dirname, "..");
  const code = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-actions-code-")));
  t.after(() => rmSync(code, { recursive: true, force: true }));
  symlinkSync(path.join(REPO, "node_modules"), path.join(code, "node_modules"));
  mkdirSync(path.join(code, "scripts"));
  writeFileSync(
    path.join(code, "package.json"),
    JSON.stringify({ scripts: { memory: "tsx scripts/echo.ts", budget: "tsx scripts/slow.ts" } }),
  );
  writeFileSync(
    path.join(code, "scripts/echo.ts"),
    `console.log(JSON.stringify({ ok: true, metadata: { grant: process.env.AGENTBROS_TEST_GRANT ?? null, actor: process.env.AGENTBROS_ACTOR, args: process.argv.slice(2) }, elapsedMs: 0 }));\n`,
  );
  writeFileSync(path.join(code, "scripts/slow.ts"), "setTimeout(() => {}, 60_000);\n");
  const seen: unknown[] = [];
  const spawnCli = createSpawnCli({
    codeRoot: code,
    env: { PATH: process.env.PATH, AGENTBROS_EVENTS: "off", AGENTBROS_CONSOLE: "off", AGENTBROS_HOOKS: "off" },
    timeoutMs: 600_000,
    grantEnv: (root, project, argv) => {
      seen.push([root, project, argv]);
      return { AGENTBROS_TEST_GRANT: "granted" };
    },
  });
  const ran = await spawnCli({ rootDir: code, project: PROJECT, alias: "memory", args: ["--quote=-h"] });
  assert.equal(ran.envelope.ok, true, JSON.stringify(ran.envelope));
  assert.deepEqual(ran.envelope.metadata, { grant: "granted", actor: "user", args: ["--quote=-h"] });
  assert.deepEqual(seen, [[code, PROJECT, ["--quote=-h"]]]);
  const slow = await spawnCli({ rootDir: code, alias: "budget", args: [], timeoutMs: 1500 });
  assert.equal(slow.envelope.error, "TIMEOUT");
  assert.equal(isAmbiguous(slow.envelope), true);
});

// ---------------------------------------------------------------------------
// The applier, with a fake CLI
// ---------------------------------------------------------------------------

function tempRoot() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-actions-")));
  mkdirSync(path.join(root, "public/projects", PROJECT, "pipeline"), { recursive: true });
  return root;
}

const OK: CliEnvelope = { ok: true, outputs: [], metadata: { approved: true }, elapsedMs: 5 };

function harness(waiting: Decision[], answer: (request: SpawnRequest) => CliEnvelope = () => OK) {
  const root = tempRoot();
  const calls: SpawnRequest[] = [];
  const actions = createDecisionActions(root, {
    deriveWaiting: async () => [...waiting],
    spawnCli: async (request) => {
      calls.push(request);
      return { envelope: answer(request), exitCode: 0 };
    },
    now: () => new Date(AT),
    routeOf: () => "film",
    stepExpects: () => undefined,
    env: { ...process.env, AGENTBROS_EVENTS: "on" },
  });
  return { root, calls, actions, waiting, done: () => rmSync(root, { recursive: true, force: true }) };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return { code: "ok" } as { code: string; status?: number; extra?: { decision?: Decision } };
  } catch (error) {
    const e = error as { status?: number; code?: string; extra?: { decision?: Decision } };
    return { code: `${e.status} ${e.code}`, ...(e.extra ? { extra: e.extra } : {}) };
  }
};
const status = async (promise: Promise<unknown>) => (await failure(promise)).code;

const D = decision();
const EXPECT = D.expect!;

test("apply: runs the CLI once with the user's expect hash, writes the inbox verbatim, journals decision.applied", async (t) => {
  const h = harness([D]);
  t.after(h.done);
  const words = "Скрипт Б, но короче.\n第二行 — «да»  ";
  const request = { decisionId: D.id, choice: "approve", answer: words, expect: EXPECT };
  const first = await h.actions.decide(PROJECT, request);
  assert.equal(first.ok, true);
  assert.equal(first.decision.status, "applied");
  assert.equal(h.calls.length, 1);
  // The CLI re-checks the outputs hash derived with what the user saw, not a fresh one.
  assert.deepEqual(h.calls[0]!.args, ["--project", PROJECT, "--step", "script", `--answer=${words}`, "--expect", OUT]);
  assert.equal(h.calls[0]!.project, PROJECT);
  const stored = readInbox(h.root, PROJECT, D.id)!;
  assert.equal(stored.answer, words, "stored exactly as submitted");
  assert.equal(stored.channel, "console");
  assert.equal(stored.actor, "user");
  assert.deepEqual(stored.argv, ["pnpm", "film:approve", ...h.calls[0]!.args]);
  assert.deepEqual(stored.result, OK);
  // Idempotent: the same request again returns the first outcome, without a second spawn.
  const again = await h.actions.decide(PROJECT, request);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(again.decision, stored);
  const history = listDecisions(h.root, PROJECT);
  assert.deepEqual(
    history.decisions.map((item) => item.id),
    [D.id],
  );
  assert.equal(history.events.length, 1);
  assert.equal(history.events[0]!.kind, "decision.applied");
  assert.equal(history.events[0]!.channel, "console");
  assert.equal(history.events[0]!.data!.decisionId, D.id);
});

test("apply: another choice on a decided id is 409 ALREADY_DECIDED with the stored outcome; nothing runs", async (t) => {
  const h = harness([D]);
  t.after(h.done);
  await h.actions.decide(PROJECT, { decisionId: D.id, choice: "changes", answer: "Tighten the hook.", expect: EXPECT });
  assert.equal(h.calls.length, 1);
  const stored = readInbox(h.root, PROJECT, D.id)!;
  // The implicit option is recorded with the decision.
  assert.ok(stored.options!.some((option) => option.id === "changes"));
  assert.equal(stored.choice, "changes");
  const other = await failure(
    h.actions.decide(PROJECT, { decisionId: D.id, choice: "approve", answer: "Now approve.", expect: EXPECT }),
  );
  assert.equal(other.code, "409 ALREADY_DECIDED");
  assert.deepEqual(other.extra!.decision, stored);
  assert.equal(h.calls.length, 1, "the approval did not run");
});

test("apply: expect is required for gates, quotes, verdicts and kind-only requests, and must be the whole hash", async (t) => {
  const h = harness([D]);
  t.after(h.done);
  assert.equal(await status(h.actions.decide(PROJECT, { decisionId: D.id, answer: "Yes." })), "422 INVALID_INPUT");
  assert.equal(
    await status(h.actions.decide(PROJECT, { decisionId: D.id, answer: "Yes.", expect: H("a") })),
    "409 STALE",
    "the first binding's hash alone is not what the user reviewed",
  );
  assert.equal(
    await status(h.actions.decide(PROJECT, { kind: "gate", step: "script", answer: "Yes." })),
    "422 INVALID_INPUT",
  );
  assert.equal(h.calls.length, 0);
  // A choice decision may go without expect when named by id.
  const music = decision({
    id: "choice-music",
    kind: "choice",
    step: "music",
    options: [{ id: "candidate-1", label: "One", argv: ["pnpm", "music", "--answer", PH] }],
  });
  h.waiting.push(music);
  assert.equal(
    await status(h.actions.decide(PROJECT, { decisionId: "choice-music", choice: "candidate-1", answer: "One." })),
    "ok",
  );
});

test("apply: a record that could not be written is refused before anything runs", async (t) => {
  const stepless = decision({ id: "choice-stepless", kind: "choice", step: undefined, options: [] });
  const h = harness([stepless]);
  t.after(h.done);
  assert.equal(
    await status(
      h.actions.decide(PROJECT, { decisionId: stepless.id, choice: "changes", answer: "Change it.", expect: EXPECT }),
    ),
    "422 INVALID_INPUT",
  );
  assert.equal(h.calls.length, 0);
});

test("apply: concurrent submissions of one decision spawn once (per-project lock)", async (t) => {
  const h = harness([D]);
  t.after(h.done);
  const results = await Promise.all(
    [1, 2, 3].map(() => h.actions.decide(PROJECT, { decisionId: D.id, answer: "Yes.", expect: EXPECT })),
  );
  assert.equal(h.calls.length, 1);
  assert.ok(results.every((result) => result.ok && result.decision.status === "applied"));
});

test("apply: a refused CLI result is returned verbatim; a retry with new words runs; retries are capped", async (t) => {
  const refused: CliEnvelope = {
    ok: false,
    error: "INVALID_INPUT",
    message: "--answer must be the user's own words, verbatim: it is a placeholder.",
    elapsedMs: 4,
  };
  let reply = refused;
  const h = harness([D], () => reply);
  t.after(h.done);
  const first = await h.actions.decide(PROJECT, { decisionId: D.id, answer: "TODO", expect: EXPECT });
  assert.equal(first.ok, false);
  assert.equal(first.decision.status, "refused");
  assert.deepEqual(first.decision.result, refused);
  // The same request again: the same refusal, no second spawn.
  await h.actions.decide(PROJECT, { decisionId: D.id, answer: "TODO", expect: EXPECT });
  assert.equal(h.calls.length, 1);
  reply = OK;
  const retry = await h.actions.decide(PROJECT, { decisionId: D.id, answer: "Approve script B.", expect: EXPECT });
  assert.equal(h.calls.length, 2);
  assert.equal(retry.decision.status, "applied");
  const history = listDecisions(h.root, PROJECT);
  assert.deepEqual(history.decisions.map((item) => item.status).sort(), ["applied", "refused"]);
  assert.deepEqual(
    history.events.map((event) => event.kind),
    ["decision.refused", "decision.applied"],
  );
  const inbox = path.join(h.root, "public/projects", PROJECT, "pipeline/inbox");
  assert.ok(readdirSync(inbox).includes(`${D.id}.refused-1.json`));

  // The cap: twenty refused attempts, then the next is refused before it runs.
  const capped = harness([D], () => refused);
  t.after(capped.done);
  for (let n = 1; n <= MAX_REFUSED_ATTEMPTS; n++)
    await capped.actions.decide(PROJECT, { decisionId: D.id, answer: `Attempt ${n}.`, expect: EXPECT });
  assert.equal(capped.calls.length, MAX_REFUSED_ATTEMPTS);
  assert.equal(
    await status(capped.actions.decide(PROJECT, { decisionId: D.id, answer: "Once more.", expect: EXPECT })),
    "429 TOO_MANY_ATTEMPTS",
  );
  assert.equal(capped.calls.length, MAX_REFUSED_ATTEMPTS);
  const cappedInbox = path.join(capped.root, "public/projects", PROJECT, "pipeline/inbox");
  assert.equal(readFileSync(path.join(cappedInbox, `${D.id}.attempts`), "utf8").trim(), "19");
});

test("apply: stale expect, a decision no longer derived and a superseded one answer 409; nothing runs", async (t) => {
  const h = harness([D]);
  t.after(h.done);
  assert.equal(
    await status(h.actions.decide(PROJECT, { decisionId: D.id, answer: "Yes.", expect: H("f") })),
    "409 STALE",
  );
  assert.equal(
    await status(h.actions.decide(PROJECT, { decisionId: "gate-old", answer: "Yes.", expect: EXPECT })),
    "409 STALE",
  );
  assert.equal(
    await status(
      h.actions.decide(PROJECT, {
        decisionId: "gate-older",
        kind: "gate",
        step: "script",
        answer: "Yes.",
        expect: EXPECT,
      }),
    ),
    "409 SUPERSEDED",
  );
  const superseded = readInbox(h.root, PROJECT, "gate-older")!;
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.supersededBy, D.id);
  assert.equal(h.calls.length, 0);
  assert.equal(await status(h.actions.decide(PROJECT, { kind: "rating", answer: "Five." })), "422 INVALID_INPUT");
});

test("apply: long multi-line words fit the record for approve and changes (the option keeps the placeholder)", async (t) => {
  const h = harness([D]);
  t.after(h.done);
  const words = `${"Line of words, -h --help.\n".repeat(307)}end`.slice(0, 8000);
  for (const choice of ["approve", "changes"]) {
    const preview = await h.actions.decide(
      PROJECT,
      { decisionId: D.id, choice, answer: words, expect: EXPECT },
      { dryRun: true },
    );
    assert.ok(preview.decision.argv!.includes(`--answer=${words}`));
  }
  const applied = await h.actions.decide(PROJECT, {
    decisionId: D.id,
    choice: "changes",
    answer: words,
    expect: EXPECT,
  });
  assert.equal(applied.decision.status, "applied");
  const option = applied.decision.options!.find((item) => item.id === "changes")!;
  assert.ok(option.argv.includes("--answer=<the user's words>"));
  assert.equal(readInbox(h.root, PROJECT, D.id)!.answer, words);
});

test("apply: a dry run returns the argv and runs nothing", async (t) => {
  const h = harness([D]);
  t.after(h.done);
  const preview = await h.actions.decide(
    PROJECT,
    { decisionId: D.id, answer: "Yes.", expect: EXPECT },
    { dryRun: true },
  );
  assert.equal(preview.decision.status, "pending");
  assert.deepEqual(preview.decision.argv, [
    "pnpm",
    "film:approve",
    "--project",
    PROJECT,
    "--step",
    "script",
    "--answer=Yes.",
    "--expect",
    OUT,
  ]);
  assert.equal(h.calls.length, 0);
  assert.equal(readInbox(h.root, PROJECT, D.id), undefined);
});

test("apply: a verdict whose follow-up fails is partial; the retry runs only the failed follow-up", async (t) => {
  const human = decision({
    id: "verdict-human",
    kind: "verdict",
    step: "human",
    options: [{ id: "accept", label: "Accept", argv: approveArgv("human") }],
  });
  let memory: CliEnvelope = { ok: false, error: "FILE_EXISTS", message: "already said", elapsedMs: 1 };
  const h = harness([human], (request) => (request.alias === "memory" ? memory : OK));
  t.after(h.done);
  const request: DecisionRequest = {
    kind: "verdict",
    answer: "Seven.",
    verdict: { score: 7 },
    expect: human.expect!,
  };
  const result = await h.actions.decide(PROJECT, request);
  assert.deepEqual(
    h.calls.map((call) => call.alias),
    ["film:approve", "memory"],
  );
  assert.equal(result.decision.status, "partial");
  assert.equal(result.ok, false, "a failed follow-up shows");
  const metadata = result.decision.result!.metadata as { followUps: { ok: boolean; error?: string }[]; hint: string };
  assert.equal(metadata.followUps[0]!.error, "FILE_EXISTS");
  assert.equal(metadata.hint, POSTMORTEM_HINT);
  // human is approved now, so it is no longer derived; the retry by id re-runs only memory.
  h.waiting.length = 0;
  memory = OK;
  const retried = await h.actions.decide(PROJECT, { ...request, decisionId: human.id });
  assert.deepEqual(
    h.calls.map((call) => call.alias),
    ["film:approve", "memory", "memory"],
  );
  assert.equal(retried.decision.status, "applied");
  assert.equal(retried.ok, true);
});

test("apply: a timeout is never a refusal: unknown while still waiting, applied once the chain moved", async (t) => {
  const timeout: CliEnvelope = {
    ok: false,
    error: "TIMEOUT",
    message: "did not answer",
    details: { ambiguous: true },
  };
  // Still waiting after the timeout: unknown, not journalled; a retry runs again.
  const h = harness([D], () => timeout);
  t.after(h.done);
  const request = { decisionId: D.id, answer: "Yes.", expect: EXPECT };
  const first: DecisionResponse = await h.actions.decide(PROJECT, request);
  assert.equal(first.decision.status, "unknown");
  assert.equal(first.ok, false);
  assert.equal(listDecisions(h.root, PROJECT).events.length, 0);
  await h.actions.decide(PROJECT, request);
  assert.equal(h.calls.length, 2, "an unknown outcome of a decision still waiting may run again");
  // Gone after the timeout without evidence in the chain: still unknown, never applied; a retry finds it stale.
  const gone = harness([D], () => {
    gone.waiting.length = 0;
    return timeout;
  });
  t.after(gone.done);
  assert.equal((await gone.actions.decide(PROJECT, request)).decision.status, "unknown");
  assert.equal(await status(gone.actions.decide(PROJECT, request)), "409 STALE");
  // The chain shows the approval with these words from the console: applied (reconciled).
  const moved = harness([D], () => {
    const file = path.join(moved.root, "public/projects", PROJECT, "pipeline/approvals/script.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ events: [{ answer: "Yes.", channel: "console" }] }));
    moved.waiting.length = 0;
    return timeout;
  });
  t.after(moved.done);
  const reconciled = await moved.actions.decide(PROJECT, request);
  assert.equal(reconciled.decision.status, "applied");
  assert.equal(reconciled.decision.result!.metadata!["reconciled"], true);
  assert.equal(listDecisions(moved.root, PROJECT).events[0]!.kind, "decision.applied");
});
