/**
 * Ratings and frame feedback from the console (RFC 0004 §8, WP9): the server turns a `rating` or `frame-feedback`
 * request into exactly one `ref:rate` or `feedback --frame` argv, every user value one `--flag=value` token, records the
 * decision in the inbox and journals it; a real spawn of `ref:rate` writes ratings.json and the memory preference.
 */
import { loadOrCreateSessionToken } from "../src/lib/console/session";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RatingsFileSchema, type CliEnvelope, type DecisionRequest, type FrameComment } from "../src/types/console";
import { createDecisionActions } from "../src/lib/console/apply";
import { listDecisions, readInbox } from "../src/lib/console/inbox";
import { createSpawnCli, type SpawnRequest } from "../src/lib/console/spawn";
import { planUserInput, scoreOnly, watchedPath } from "../src/lib/console/user-actions";

const PROJECT = "demo-film";
const AT = "2026-11-17T10:00:00.000Z";
const FRAME = "pipeline/look/sf-1.png";
const OK: CliEnvelope = { ok: true, outputs: [], metadata: {}, elapsedMs: 5 };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function harness(
  answer: (request: SpawnRequest) => CliEnvelope = () => OK,
  clock: { at: number } = { at: Date.parse(AT) },
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-user-actions-")));
  mkdirSync(path.join(root, "public/projects", PROJECT, "pipeline"), { recursive: true });
  const calls: SpawnRequest[] = [];
  const actions = createDecisionActions(root, {
    deriveWaiting: async () => [],
    spawnCli: async (request) => {
      calls.push(request);
      return { envelope: answer(request), exitCode: 0 };
    },
    now: () => new Date(clock.at),
    routeOf: () => "film",
    stepExpects: () => undefined,
    env: { ...process.env, AGENTBROS_EVENTS: "on" },
  });
  return { root, calls, actions, clock, done: () => rmSync(root, { recursive: true, force: true }) };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    const e = error as { status?: number; code?: string };
    return `${e.status} ${e.code}`;
  }
};

const comment = (overrides: Partial<FrameComment> = {}): FrameComment => ({
  media: { root: "out", path: "film.mp4", kind: "video", fps: 30, sha256: sha("film") },
  frame: 45,
  region: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 },
  text: "-h the logo is cut off here",
  ...overrides,
});

test("rating: one ref:rate argv, the path and note as --flag=value words, recorded and journalled", async (t) => {
  const h = harness();
  t.after(h.done);
  const words = "--help me: warm light, «да», 第二";
  const request: DecisionRequest = {
    kind: "rating",
    step: "look",
    answer: words,
    ratings: { [FRAME]: 4 },
    expect: sha("frame"),
  };
  const reply = await h.actions.decide(PROJECT, request);
  assert.equal(reply.ok, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.alias, "ref:rate");
  assert.equal(h.calls[0]!.project, PROJECT);
  assert.deepEqual(h.calls[0]!.args, [
    "--project",
    PROJECT,
    `--path=${FRAME}`,
    "--score",
    "4",
    `--note=${words}`,
    "--expect",
    sha("frame"),
  ]);
  const stored = readInbox(h.root, PROJECT, reply.decision.id)!;
  assert.match(stored.id, /^rating-[0-9a-f]{32}$/);
  assert.equal(stored.kind, "rating");
  assert.equal(stored.status, "applied");
  assert.equal(stored.answer, words);
  assert.deepEqual(stored.ratings, { [FRAME]: 4 });
  assert.deepEqual(stored.bindTo, [{ path: FRAME, sha256: sha("frame") }]);
  assert.deepEqual(stored.argv, ["pnpm", "ref:rate", ...h.calls[0]!.args]);
  const history = listDecisions(h.root, PROJECT);
  assert.equal(history.events[0]!.kind, "decision.applied");
  assert.equal(history.events[0]!.data!.decisionKind, "rating");
  // The bare score is not a note: no --note, so nothing goes to memory.
  await h.actions.decide(PROJECT, { kind: "rating", answer: "3/5", ratings: { [FRAME]: 3 } });
  assert.deepEqual(h.calls[1]!.args, ["--project", PROJECT, `--path=${FRAME}`, "--score", "3"]);
});

test("frame feedback: one feedback --frame argv with region, render, fps, hash and the words as one token", async (t) => {
  const h = harness();
  t.after(h.done);
  const request: DecisionRequest = { kind: "frame-feedback", answer: comment().text, frameComments: [comment()] };
  const dry = await h.actions.decide(PROJECT, request, { dryRun: true });
  assert.equal(dry.decision.status, "pending");
  assert.equal(h.calls.length, 0, "a dry run spawns nothing");
  const reply = await h.actions.decide(PROJECT, request);
  assert.equal(reply.ok, true);
  assert.equal(h.calls[0]!.alias, "feedback");
  assert.deepEqual(h.calls[0]!.args, [
    "--project",
    PROJECT,
    "--frame",
    "45",
    "--region",
    "0.1,0.2,0.3,0.25",
    `--watched=out/${PROJECT}/film.mp4`,
    "--fps",
    "30",
    "--expect",
    sha("film"),
    "--answer=-h the logo is cut off here",
    "--confirm",
  ]);
  assert.deepEqual(dry.decision.argv, ["pnpm", "feedback", ...h.calls[0]!.args]);
  const stored = readInbox(h.root, PROJECT, reply.decision.id)!;
  assert.equal(stored.kind, "frame-feedback");
  assert.deepEqual(stored.frameComments, [comment()]);
  assert.equal(stored.title, "Frame feedback at frame 45");
  // A project render and no region, no fps, no hash: only what the comment says.
  const plain = planUserInput(PROJECT, {
    kind: "frame-feedback",
    answer: "darker",
    frameComments: [comment({ media: { path: "renders/a.mp4", kind: "video" }, region: undefined, text: "darker" })],
  });
  assert.deepEqual(plain.command.args, [
    "--project",
    PROJECT,
    "--frame",
    "45",
    `--watched=public/projects/${PROJECT}/renders/a.mp4`,
    "--answer=darker",
    "--confirm",
  ]);
});

test("rating and frame feedback: a refused CLI is recorded as refused; malformed requests are 422 and run nothing", async (t) => {
  const h = harness(() => ({ ok: false, error: "VALIDATION", message: "changed since the user saw it" }));
  t.after(h.done);
  const refused = await h.actions.decide(PROJECT, { kind: "rating", answer: "Nice.", ratings: { [FRAME]: 5 } });
  assert.equal(refused.ok, false);
  assert.equal(refused.decision.status, "refused");
  assert.equal(readInbox(h.root, PROJECT, refused.decision.id)!.result!.error, "VALIDATION");
  assert.equal(listDecisions(h.root, PROJECT).events[0]!.kind, "decision.refused");
  const calls = h.calls.length;
  const bad: DecisionRequest[] = [
    { kind: "rating", answer: "Five." },
    { kind: "rating", answer: "Both.", ratings: { [FRAME]: 4, "pipeline/look/sf-2.png": 2 } },
    { kind: "rating", answer: "x", ratings: { [FRAME]: 4 }, frameComments: [comment()] },
    { kind: "rating", answer: "x", ratings: { [FRAME]: 4 }, choice: "approve" },
    { kind: "frame-feedback", answer: "Make it bigger." },
    { kind: "frame-feedback", answer: "Two.", frameComments: [comment(), comment({ frame: 2 })] },
    {
      kind: "frame-feedback",
      answer: "x",
      frameComments: [comment({ media: { path: "look/a.png", kind: "image" } })],
    },
    { kind: "frame-feedback", answer: "x", frameComments: [comment()], ratings: { [FRAME]: 1 } },
  ];
  for (const request of bad) assert.equal(await failure(h.actions.decide(PROJECT, request)), "422 INVALID_INPUT");
  assert.equal(h.calls.length, calls);
});

test("helpers: the bare score, the watched render", () => {
  assert.ok(scoreOnly("4/5", 4) && scoreOnly(" 4 / 5 ", 4));
  assert.ok(!scoreOnly("4/5", 3) && !scoreOnly("4/5 but warmer", 4));
  assert.equal(watchedPath("p", comment()), "out/p/film.mp4");
});

test("rating through the real ref:rate: ratings.json and the memory preference, from the console", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-user-rate-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memory = path.join(root, "memory-root");
  const dir = path.join(root, "public/projects", PROJECT);
  mkdirSync(path.join(dir, "pipeline/look"), { recursive: true });
  writeFileSync(path.join(dir, FRAME), "frame");
  loadOrCreateSessionToken(root); // the console's token: its spawns are signed with it (grant.ts)
  const actions = createDecisionActions(root, {
    deriveWaiting: async () => [],
    spawnCli: createSpawnCli({
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AGENTBROS_NO_DOTENV: "1",
        AGENTBROS_EVENTS: "off",
        AGENTBROS_CONSOLE: "off",
        AGENTBROS_HOOKS: "off",
        AGENTBROS_MEMORY_ROOT: memory,
      },
    }),
    routeOf: () => "film",
    stepExpects: () => undefined,
    env: { ...process.env, AGENTBROS_EVENTS: "off" },
  });
  const words = "- this one, but warmer";
  const reply = await actions.decide(PROJECT, {
    kind: "rating",
    answer: words,
    ratings: { [FRAME]: 5 },
    expect: sha("frame"),
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.decision.result));
  const ratings = RatingsFileSchema.parse(JSON.parse(readFileSync(path.join(dir, "pipeline/ratings.json"), "utf8")));
  assert.equal(ratings.ratings.length, 1);
  assert.deepEqual(
    { score: ratings.ratings[0]!.score, note: ratings.ratings[0]!.note, channel: ratings.ratings[0]!.channel },
    { score: 5, note: words, channel: "console" },
  );
  const [entry] = readdirSync(path.join(memory, "preferences"));
  const text = readFileSync(path.join(memory, "preferences", entry!), "utf8");
  assert.ok(text.includes(words));
  assert.match(text, /channel: "?console"?/);
  // A stale view: the file changed after the user saw it, so the rating is refused and nothing more is written.
  const stale = await actions.decide(PROJECT, {
    kind: "rating",
    answer: "4/5",
    ratings: { [FRAME]: 4 },
    expect: sha("old"),
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.decision.result!.error, "VALIDATION");
  assert.equal(
    RatingsFileSchema.parse(JSON.parse(readFileSync(path.join(dir, "pipeline/ratings.json"), "utf8"))).ratings.length,
    1,
  );
});

test("idempotent: a retry with the same requestId returns the first outcome; other content under it is 409", async (t) => {
  const h = harness();
  t.after(h.done);
  const request: DecisionRequest = { kind: "rating", requestId: "req-1", answer: "Warm.", ratings: { [FRAME]: 4 } };
  const first = await h.actions.decide(PROJECT, request);
  const again = await h.actions.decide(PROJECT, request);
  assert.equal(h.calls.length, 1, "applied once");
  assert.deepEqual(again.decision, first.decision);
  h.clock.at += 10 * 60_000;
  await h.actions.decide(PROJECT, request);
  assert.equal(h.calls.length, 1, "a request id holds beyond the window");
  assert.equal(
    await failure(h.actions.decide(PROJECT, { ...request, ratings: { [FRAME]: 2 } })),
    "409 ALREADY_DECIDED",
  );
  // A frame comment retried after a timeout does not reopen the build twice.
  const comment = { kind: "frame-feedback" as const, requestId: "req-2", answer: "x", frameComments: [comment_()] };
  await h.actions.decide(PROJECT, comment);
  await h.actions.decide(PROJECT, comment);
  assert.equal(h.calls.length, 2);
});

function comment_() {
  return comment();
}

test("idempotent without a requestId: the same content within the window applies once, later again (history kept)", async (t) => {
  const h = harness();
  t.after(h.done);
  const request: DecisionRequest = { kind: "rating", answer: "4/5", ratings: { [FRAME]: 4 } };
  const first = await h.actions.decide(PROJECT, request);
  h.clock.at += 5_000;
  await h.actions.decide(PROJECT, request);
  assert.equal(h.calls.length, 1, "a double submit within the window");
  h.clock.at += 120_000;
  const later = await h.actions.decide(PROJECT, request);
  assert.equal(h.calls.length, 2, "the same rating given again later is a new rating");
  assert.equal(later.decision.id, first.decision.id);
  assert.equal(listDecisions(h.root, PROJECT).decisions.length, 2, "the earlier record is kept beside it");
});

test("a refused rating runs again on retry; an unknown one reconciles from ratings.json or runs again", async (t) => {
  let answer: CliEnvelope = { ok: false, error: "VALIDATION", message: "changed" };
  const h = harness(() => answer);
  t.after(h.done);
  const request: DecisionRequest = { kind: "rating", requestId: "req-3", answer: "Warm.", ratings: { [FRAME]: 4 } };
  assert.equal((await h.actions.decide(PROJECT, request)).decision.status, "refused");
  answer = OK;
  assert.equal((await h.actions.decide(PROJECT, request)).decision.status, "applied");
  assert.equal(h.calls.length, 2);

  answer = { ok: false, error: "TIMEOUT", message: "slow", details: { ambiguous: true } };
  const unknown = { ...request, requestId: "req-4" };
  assert.equal((await h.actions.decide(PROJECT, unknown)).decision.status, "unknown");
  // The CLI did write it (as ref:rate does): the retry reconciles without running again.
  writeFileSync(
    path.join(h.root, "public/projects", PROJECT, "pipeline/ratings.json"),
    JSON.stringify({
      v: 1,
      ratings: [
        { id: "r1", target: { path: FRAME }, kind: "styleframe", score: 4, by: "user", channel: "console", at: AT },
      ],
    }),
  );
  const reconciled = await h.actions.decide(PROJECT, unknown);
  assert.equal(reconciled.decision.status, "applied");
  assert.equal(h.calls.length, 3);
  // Without evidence, an unknown outcome runs again.
  const other = { ...request, requestId: "req-5", ratings: { "pipeline/look/sf-2.png": 3 } };
  await h.actions.decide(PROJECT, other);
  answer = OK;
  assert.equal((await h.actions.decide(PROJECT, other)).decision.status, "applied");
  assert.equal(h.calls.length, 5);
});

test("after the CLI applied, an unwritable inbox still answers and journals the outcome", async (t) => {
  const h = harness();
  t.after(h.done);
  writeFileSync(path.join(h.root, "public/projects", PROJECT, "pipeline/inbox"), "not a directory");
  const reply = await h.actions.decide(PROJECT, { kind: "rating", answer: "Warm.", ratings: { [FRAME]: 4 } });
  assert.equal(reply.ok, true);
  assert.equal(reply.decision.status, "applied");
  const events = readFileSync(path.join(h.root, "public/projects", PROJECT, "pipeline/events.jsonl"), "utf8");
  assert.match(events, /"decision\.applied"/);
});

test("frame feedback past the render's last frame is refused before anything runs", async (t) => {
  const h = harness();
  t.after(h.done);
  const media = { root: "out" as const, path: "film.mp4", kind: "video" as const, fps: 30, durationSec: 2 };
  assert.equal(
    await failure(
      h.actions.decide(PROJECT, {
        kind: "frame-feedback",
        answer: "x",
        frameComments: [comment({ media, frame: 60 })],
      }),
    ),
    "422 INVALID_INPUT",
  );
  assert.equal(h.calls.length, 0);
  await h.actions.decide(PROJECT, {
    kind: "frame-feedback",
    answer: "x",
    frameComments: [comment({ media, frame: 59 })],
  });
  assert.equal(h.calls.length, 1);
});
