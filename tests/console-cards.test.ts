/**
 * Agent cards (RFC 0004 WP11, D14, §6.4, A11 minus console:wait): the card store, the default server's
 * `POST /api/projects/:id/cards/:cardId/answer`, the view's cards and the trimmed agent view.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { consoleAddress, trimView, AGENT_VIEW_LIMITS } from "../src/lib/console/agent-view";
import {
  answerCardSync,
  cardIsOpen,
  listCards,
  MAX_VIEW_CARDS,
  parseCardInput,
  parseExpiresIn,
  postCard,
  readCard,
} from "../src/lib/console/cards";
import { HttpError } from "../src/lib/local-server/errors";
import * as contract from "../src/types/console";
import { makeRoot, PROJECT, postHeaders, raw, removeRoot, startTestServer } from "./helpers/console-server";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/console");
const inputs = JSON.parse(readFileSync(path.join(FIXTURES, "card-inputs.json"), "utf8")) as Record<string, any>[];
const inputOf = (kind: contract.CardKind) => structuredClone(inputs.find((input) => input.kind === kind)!);

const previousEvents = process.env.AGENTBROS_EVENTS;
before(() => {
  process.env.AGENTBROS_EVENTS = "on";
});
after(() => {
  if (previousEvents === undefined) delete process.env.AGENTBROS_EVENTS;
  else process.env.AGENTBROS_EVENTS = previousEvents;
});

/** A temporary root whose project holds every media file the fixture inputs name. */
function rootWithMedia(): string {
  const root = makeRoot();
  for (const input of inputs)
    for (const item of input.media ?? []) {
      const base = item.root === "out" ? path.join(root, "out", PROJECT) : path.join(root, "public/projects", PROJECT);
      mkdirSync(path.dirname(path.join(base, item.path)), { recursive: true });
      writeFileSync(path.join(base, item.path), "media");
    }
  return root;
}

const projectDir = (root: string) => path.join(root, "public/projects", PROJECT);
const journal = (root: string) => {
  const file = path.join(projectDir(root), contract.EVENTS_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => contract.ConsoleEventSchema.parse(JSON.parse(line)));
};

const httpStatus = (status: number, code?: string) => (error: unknown) =>
  error instanceof HttpError && error.status === status && (code === undefined || error.code === code);

/** The answer a user gives to each kind in the round trip. */
function answerFor(card: contract.Card): contract.CardAnswerRequest {
  switch (card.kind) {
    case "rating":
      return { ratings: Object.fromEntries(card.media.map((item, index) => [item.path, index + 3])) };
    case "question":
    case "media":
      return { text: `Answer to ${card.title}` };
    default:
      return { choice: ("options" in card ? card.options : undefined)![0]!.id, text: "Looks right." };
  }
}

test("each answerable kind round-trips: posted, answered over HTTP, stored, journaled and in the view", async (t) => {
  const root = rootWithMedia();
  t.after(() => removeRoot(root));
  const server = await startTestServer(root); // default actions: this proves the wiring
  t.after(() => server.close());
  const kinds = contract.CARD_KINDS.filter((kind) => kind !== "markdown");
  for (const kind of kinds) {
    const input = { ...inputOf(kind), expectsAnswer: true };
    const { card, file } = postCard(root, PROJECT, parseCardInput(input));
    assert.equal(file, `public/projects/${PROJECT}/pipeline/cards/${card.id}.json`);
    assert.ok(contract.ConsoleIdSchema.safeParse(card.id).success);
    const request = answerFor(card);
    const res = await raw(server.port, {
      method: "POST",
      path: `/api/projects/${PROJECT}/cards/${card.id}/answer`,
      headers: postHeaders(server),
      body: JSON.stringify(request),
    });
    assert.equal(res.status, 200, `${kind}: ${res.text}`);
    const reply = contract.CardAnswerResponseSchema.parse(res.json());
    const stored = contract.CardSchema.parse(JSON.parse(readFileSync(path.join(root, file), "utf8")));
    assert.deepEqual(stored, reply.card, kind);
    assert.equal(stored.answer?.choice, request.choice, kind);
    assert.equal(stored.answer?.text, request.text, kind);
    assert.deepEqual(stored.answer?.ratings, request.ratings, kind);
    const events = journal(root).filter((event) => event.data?.cardId === card.id);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["card.posted", "card.answered"],
      kind,
    );
    const answered = events[1]!;
    assert.equal(answered.actor, "user");
    assert.equal(answered.channel, "console");
    assert.equal(answered.data?.choice, request.choice);
  }
  const view = contract.ProjectViewSchema.parse(
    (await raw(server.port, { path: `/api/projects/${PROJECT}/view`, headers: postHeaders(server) })).json(),
  );
  assert.deepEqual(new Set(view.cards.map((card) => card.kind)), new Set(kinds));
  assert.ok(view.cards.every((card) => card.answer));
  // No temporary file is left behind.
  assert.ok(
    readdirSync(path.join(projectDir(root), contract.CARDS_DIR)).every((name) => /^card-[0-9a-z]+\.json$/.test(name)),
  );
});

test("answers: idempotent for the same answer, refused when different, expired, unfit or unknown", async (t) => {
  const root = rootWithMedia();
  t.after(() => removeRoot(root));
  const server = await startTestServer(root);
  t.after(() => server.close());
  const post = (body: unknown, cardId: string) =>
    raw(server.port, {
      method: "POST",
      path: `/api/projects/${PROJECT}/cards/${cardId}/answer`,
      headers: postHeaders(server),
      body: JSON.stringify(body),
    });
  const choice = postCard(root, PROJECT, parseCardInput(inputOf("choice"))).card as Extract<
    contract.Card,
    { kind: "choice" }
  >;
  assert.equal((await post({ choice: "nope" }, choice.id)).status, 400, "unknown option");
  assert.equal((await post({ text: "no option" }, choice.id)).status, 400, "a choice card needs an option");
  assert.equal((await post({ ratings: { "a.png": 3 } }, choice.id)).status, 400, "ratings on a choice card");
  const first = await post({ choice: choice.options[0]!.id }, choice.id);
  assert.equal(first.status, 200);
  const again = await post({ choice: choice.options[0]!.id }, choice.id);
  assert.equal(again.status, 200, "same answer again");
  assert.deepEqual(again.json().card.answer, first.json().card.answer, "the first answer is kept");
  const other = await post({ choice: choice.options[1]!.id }, choice.id);
  assert.equal(other.status, 409);
  assert.equal(other.json().error, "CONFLICT");
  assert.equal(journal(root).filter((event) => event.kind === "card.answered").length, 1, "one answer event");

  const rating = postCard(root, PROJECT, parseCardInput(inputOf("rating"))).card;
  assert.equal((await post({ text: "nice" }, rating.id)).status, 400, "a rating card needs ratings");
  assert.equal((await post({ ratings: { "other.png": 4 } }, rating.id)).status, 400, "rating of another file");

  const markdown = postCard(root, PROJECT, parseCardInput(inputOf("markdown"))).card;
  assert.equal((await post({ text: "thanks" }, markdown.id)).status, 400, "information cards take no answer");

  const now = Date.now();
  const expiring = postCard(root, PROJECT, parseCardInput(inputOf("question")), {
    now: now - 120_000,
    expiresInMs: 60_000,
  });
  const expired = await post({ text: "too late" }, expiring.card.id);
  assert.equal(expired.status, 409);
  assert.match(expired.json().message, /expired/);

  const unknown = await post({ text: "hello" }, "card-missing");
  assert.equal(unknown.status, 404);
  const traversal = await post({ text: "hello" }, "..");
  assert.equal(traversal.status, 400);
  const empty = await post({ text: "   " }, choice.id);
  assert.equal(empty.status, 400, "an answer says something");
});

test("posting refuses traversal, missing or symlinked media, HTML, bad options, oversize and a missing project", (t) => {
  const root = rootWithMedia();
  t.after(() => removeRoot(root));
  const refuses = (input: Record<string, any>, check: (error: unknown) => boolean, why: string) =>
    assert.throws(() => postCard(root, PROJECT, parseCardInput(input)), check, why);
  const grid = inputOf("grid");
  for (const bad of ["../secret.png", "/etc/passwd.png", "design/../../x.png", "C:/x.png", "design//sf-1.png"])
    refuses({ ...grid, media: [{ path: bad, kind: "image" }, grid.media[1]] }, httpStatus(400, "VALIDATION"), bad);
  refuses({ ...grid, media: [{ path: "design/none.png", kind: "image" }, grid.media[1]] }, httpStatus(404), "missing");
  refuses(
    { ...grid, media: [{ path: "project.json", kind: "document" }, grid.media[1]] },
    httpStatus(403),
    "a type the console does not serve",
  );
  symlinkSync("/etc/hosts", path.join(projectDir(root), "design/link.png"));
  refuses({ ...grid, media: [{ path: "design/link.png", kind: "image" }, grid.media[1]] }, httpStatus(403), "symlink");
  refuses({ ...grid, media: [grid.media[0], grid.media[0]] }, httpStatus(400, "VALIDATION"), "duplicate media");
  refuses(
    { ...inputOf("markdown"), body: "Hello <script>alert(1)</script>" },
    httpStatus(400, "VALIDATION"),
    "HTML body",
  );
  refuses({ ...inputOf("choice"), title: "<img src=x onerror=alert(1)>" }, httpStatus(400, "VALIDATION"), "HTML title");
  const choice = inputOf("choice");
  refuses(
    { ...choice, options: [{ id: "a", label: "<b>A</b>" }, choice.options[1]] },
    httpStatus(400, "VALIDATION"),
    "HTML label",
  );
  refuses({ ...choice, options: [choice.options[0], choice.options[0]] }, httpStatus(400, "VALIDATION"), "dup ids");
  refuses({ ...choice, options: [{ id: "../x", label: "X" }, choice.options[1]] }, httpStatus(400), "option id");
  refuses({ ...choice, title: "x".repeat(161) }, httpStatus(400, "VALIDATION"), "oversize title");
  refuses({ ...inputOf("markdown"), body: "x".repeat(20_001) }, httpStatus(400, "VALIDATION"), "oversize body");
  refuses({ ...choice, id: "card-mine" }, httpStatus(400, "VALIDATION"), "no id in the input");
  refuses({ ...choice, answer: { choice: "a", at: new Date().toISOString() } }, httpStatus(400), "no answer");
  refuses({ ...choice, expiresAt: "2000-01-01T00:00:00Z" }, httpStatus(400, "VALIDATION"), "expired on arrival");
  assert.throws(() => parseCardInput(choice, "grid"), httpStatus(400, "VALIDATION"), "--kind disagrees");
  assert.equal(parseCardInput({ ...choice, kind: undefined }, "choice").kind, "choice", "--kind fills the kind");
  assert.throws(() => postCard(root, "no-such-project", parseCardInput(choice)), httpStatus(404, "PROJECT_NOT_FOUND"));
  assert.equal(existsSync(path.join(root, "public/projects/no-such-project")), false, "never creates a project");
  assert.equal(existsSync(path.join(projectDir(root), contract.CARDS_DIR)), false, "nothing posted");
});

test("a project without pipeline/ gets only pipeline/cards/, and the view keeps open cards first within its cap", (t) => {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  const bare = path.join(root, "public/projects/bare-project");
  mkdirSync(bare, { recursive: true });
  writeFileSync(path.join(bare, "project.json"), "{}");
  const posted = postCard(root, "bare-project", parseCardInput(inputOf("question")));
  assert.deepEqual(readdirSync(bare).sort(), ["pipeline", "project.json"]);
  assert.deepEqual(readdirSync(path.join(bare, "pipeline")).sort(), ["cards", "events.jsonl"]);
  assert.equal(readCard(root, "bare-project", posted.card.id).id, posted.card.id);

  const base = Date.parse("2026-11-17T10:00:00Z");
  const open = postCard(root, PROJECT, parseCardInput(inputOf("question")), { now: base }).card;
  for (let index = 1; index <= MAX_VIEW_CARDS + 5; index++)
    postCard(root, PROJECT, parseCardInput(inputOf("markdown")), { now: base + index * 1000 });
  writeFileSync(path.join(projectDir(root), contract.CARDS_DIR, "card-broken.json"), "{");
  const cards = listCards(projectDir(root), PROJECT, base + 10_000_000);
  assert.equal(cards.length, MAX_VIEW_CARDS);
  assert.ok(
    cards.some((card) => card.id === open.id),
    "the old open card is kept",
  );
  assert.ok(cardIsOpen(open, base + 1000));
  assert.equal(cards[0]!.id, open.id, "the waiting card comes first");
  const rest = cards.slice(1);
  assert.deepEqual(
    rest.map((card) => card.id),
    [...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((card) => card.id),
    "then newest first",
  );
});

test("--expires-in durations", () => {
  assert.equal(parseExpiresIn("45m"), 45 * 60_000);
  assert.equal(parseExpiresIn("2h"), 7_200_000);
  assert.equal(parseExpiresIn("1d"), 86_400_000);
  assert.equal(parseExpiresIn("30"), 30 * 60_000);
  for (const bad of ["0", "-1m", "31d", "soon", "1w", ""]) assert.throws(() => parseExpiresIn(bad), HttpError, bad);
});

test("answerCardSync journals as the user through the console unless told otherwise", (t) => {
  const root = rootWithMedia();
  t.after(() => removeRoot(root));
  const { card } = postCard(root, PROJECT, parseCardInput(inputOf("question")));
  const posted = journal(root).find((event) => event.kind === "card.posted")!;
  assert.equal(posted.agent?.name, inputOf("question").from.agent);
  assert.deepEqual(posted.outputs, [`pipeline/cards/${card.id}.json`]);
  answerCardSync(root, PROJECT, card.id, { text: "Yes." });
  const answered = journal(root).find((event) => event.kind === "card.answered")!;
  assert.equal(answered.actor, "user");
  assert.equal(answered.channel, "console");
});

test("trimView keeps what an agent needs from every fixture view, bounded", () => {
  for (const name of readdirSync(FIXTURES).filter((file) => /^view-.*\.json$/.test(file))) {
    const view = contract.ProjectViewSchema.parse(JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")));
    const trimmed = trimView(view, Date.parse(view.generatedAt));
    assert.equal(trimmed.project.id, view.project.id, name);
    assert.equal(trimmed.control.state, view.control.state, name);
    assert.equal(trimmed.steps.length, view.steps.length, name);
    assert.equal(trimmed.waiting.total, view.waiting.length, name);
    assert.ok(trimmed.waiting.decisions.length <= AGENT_VIEW_LIMITS.waiting, name);
    assert.ok(trimmed.cards.items.length <= AGENT_VIEW_LIMITS.cards, name);
    assert.equal(trimmed.money.spentUsd, view.money.spentUsd, name);
    const text = JSON.stringify(trimmed);
    assert.ok(!text.includes('"argv"'), `${name}: no option argv`);
    assert.ok(text.length < JSON.stringify(view).length || text.length < 4000, `${name}: smaller`);
    for (const decision of view.waiting)
      assert.ok(
        trimmed.waiting.decisions.some((item) => item.id === decision.id),
        name,
      );
  }
});

test("consoleAddress reads the lock without a token and creates nothing", (t) => {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  assert.deepEqual(consoleAddress(root), { running: false });
  assert.equal(existsSync(path.join(root, contract.SESSION_FILE)), false);
  writeFileSync(
    path.join(root, contract.SERVER_LOCK_FILE),
    JSON.stringify({
      v: 1,
      pid: process.pid,
      port: 4317,
      version: "v",
      startedAt: new Date().toISOString(),
      url: "http://127.0.0.1:4317/",
    }),
  );
  assert.deepEqual(consoleAddress(root, PROJECT), {
    running: true,
    url: `http://127.0.0.1:4317/#/projects/${PROJECT}`,
    port: 4317,
  });
  assert.equal(existsSync(path.join(root, contract.SESSION_FILE)), false);
});
