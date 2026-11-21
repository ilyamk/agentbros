/**
 * The studio console's contract (src/types/console.ts, RFC 0004 §6 and §9): every fixture in tests/fixtures/console/
 * parses, and the schemas refuse what they must (unknown fields, unsafe paths, HTML in Markdown, inconsistent answers).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
  CARD_KINDS,
  CardAnswerRequestSchema,
  CardInputSchema,
  CardSchema,
  CliEnvelopeSchema,
  ConsoleEventSchema,
  ConsoleNextBlockSchema,
  ConsoleSessionSchema,
  ConsoleStreamMessageSchema,
  ControlFileSchema,
  ControlRequestSchema,
  DecisionRequestSchema,
  DecisionSchema,
  EVENT_DATA_MAX_BYTES,
  EVENT_KINDS,
  EventsPageSchema,
  FilmMaterialSchema,
  HookCursorSchema,
  HooksStatusSchema,
  InboxDecisionFileSchema,
  MediaRefSchema,
  ProjectViewSchema,
  LibraryResponseSchema,
  ProjectsResponseSchema,
  RatingsFileSchema,
  ServerLockSchema,
  inboxFile,
  isSafeRelativePath,
  outFile,
  projectFile,
} from "../src/types/console";

const DIR = "tests/fixtures/console";
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(DIR, name), "utf8"));
const clone = <T>(value: T): T => structuredClone(value);
const ok = (schema: z.ZodType, value: unknown, label: string) => {
  const result = schema.safeParse(value);
  assert.ok(result.success, `${label}: ${result.success ? "" : JSON.stringify(result.error.issues, null, 1)}`);
};
const bad = (schema: z.ZodType, value: unknown, label: string) =>
  assert.equal(schema.safeParse(value).success, false, `${label} must be refused`);

const SINGLE: Record<string, z.ZodType> = {
  "view-film-build.json": ProjectViewSchema,
  "view-film-script-gate.json": ProjectViewSchema,
  "view-film-human.json": ProjectViewSchema,
  "view-footage.json": ProjectViewSchema,
  "view-footage-render.json": ProjectViewSchema,
  "view-empty.json": ProjectViewSchema,
  "view-generations.json": ProjectViewSchema,
  "control.json": ControlFileSchema,
  "server.json": ServerLockSchema,
  "session.json": ConsoleSessionSchema,
  "hook-cursor.json": HookCursorSchema,
  "ratings.json": RatingsFileSchema,
  "next-block.json": ConsoleNextBlockSchema,
  "hooks-status.json": HooksStatusSchema,
  "projects-response.json": ProjectsResponseSchema,
  "view-replica.json": ProjectViewSchema,
  "view-recipe.json": ProjectViewSchema,
  "view-campaign.json": ProjectViewSchema,
  "library.json": LibraryResponseSchema,
};
const LISTS: Record<string, z.ZodType> = {
  "events.json": ConsoleEventSchema,
  "cards.json": CardSchema,
  "card-inputs.json": CardInputSchema,
  "decisions.json": InboxDecisionFileSchema,
};

test("every console fixture parses with its schema", () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith(".json"));
  for (const file of files) {
    if (file === "requests.json") continue;
    const single = SINGLE[file];
    const list = LISTS[file];
    assert.ok(single || list, `${file} has no schema in this test`);
    if (single) ok(single, load(file), file);
    else for (const [index, item] of (load(file) as unknown[]).entries()) ok(list!, item, `${file}[${index}]`);
  }
  const requests = load("requests.json") as Record<string, unknown[]>;
  for (const body of requests.decisions!) ok(DecisionRequestSchema, body, "decision request");
  for (const body of requests.control!) ok(ControlRequestSchema, body, "control request");
  for (const body of requests.cardAnswers!) ok(CardAnswerRequestSchema, body, "card answer request");
  for (const message of requests.stream!) ok(ConsoleStreamMessageSchema, message, "stream message");
  ok(EventsPageSchema, requests.eventsPage, "events page");
});

test("fixtures cover every event kind and every card kind", () => {
  const events = load("events.json") as { kind: string }[];
  assert.deepEqual([...new Set(events.map((event) => event.kind))].sort(), [...EVENT_KINDS].sort());
  for (const file of ["cards.json", "card-inputs.json"]) {
    const cards = load(file) as { kind: string }[];
    assert.deepEqual([...new Set(cards.map((card) => card.kind))].sort(), [...CARD_KINDS].sort(), file);
  }
  const build = ProjectViewSchema.parse(load("view-film-build.json"));
  assert.ok(build.waiting.some((decision) => decision.kind === "quote" && decision.quote));
  assert.ok(build.cards.length > 0 && build.agents.active && build.money.jobs.length > 0 && build.media.animatic);
});

test("safe relative paths: no traversal, absolute, drive, scheme, backslash, empty segment or control character", () => {
  for (const good of ["media/hero.png", "a", "out.mp4", "pipeline/inbox/dec-1.json", "a/b..c/d", "...x"])
    assert.ok(isSafeRelativePath(good), good);
  for (const unsafe of [
    "",
    "../x",
    "a/../b",
    "a/..",
    "..",
    ".",
    "./a",
    "/etc/passwd",
    "C:\\x",
    "C:/x",
    "file:///x",
    "https://example.com/a.png",
    "a\\b",
    "a//b",
    "a/",
    "a\u0000b",
    "a\nb",
    "x".repeat(1025),
  ])
    assert.equal(isSafeRelativePath(unsafe), false, JSON.stringify(unsafe));
  assert.equal(projectFile("promo-acme", "pipeline/events.jsonl"), "public/projects/promo-acme/pipeline/events.jsonl");
  assert.equal(outFile("promo-acme", "final/a.mp4"), "out/promo-acme/final/a.mp4");
  assert.equal(inboxFile("dec-1"), "pipeline/inbox/dec-1.json");
  assert.throws(() => projectFile("promo-acme", "../secrets"));
  assert.throws(() => inboxFile("../x"));
});

test("card media must stay inside the project", () => {
  const card = (load("cards.json") as Record<string, unknown>[])[0]!;
  for (const unsafe of ["../outside.mp4", "/abs/a.mp4", "C:\\a.mp4", "a/../../b.mp4", "media\\a.mp4"]) {
    const value = clone(card) as { media: { path: string }[] };
    value.media[0]!.path = unsafe;
    bad(CardSchema, value, `card media ${unsafe}`);
  }
  bad(MediaRefSchema, { path: "a.mp4", kind: "video", root: "home" }, "unknown media root");
  bad(MediaRefSchema, { path: "a.mp4", kind: "video", url: "https://x" }, "media with an unknown field");
});

test("cards: strict, per-kind constraints and consistent answers", () => {
  const cards = load("cards.json") as Record<string, unknown>[];
  const byKind = (kind: string) => clone(cards.find((card) => card.kind === kind)!) as Record<string, unknown>;
  bad(CardSchema, { ...byKind("compare"), html: "<b>x</b>" }, "unknown field");
  bad(CardSchema, { ...byKind("markdown"), body: "Hello <script>alert(1)</script>" }, "HTML in Markdown");
  bad(CardSchema, { ...byKind("markdown"), body: "<img src=x>" }, "HTML tag in Markdown");
  ok(CardSchema, { ...byKind("markdown"), body: "a < b and 3<4" }, "less-than sign is not HTML");
  bad(CardSchema, { ...byKind("markdown"), expectsAnswer: true }, "markdown card expects no answer");
  bad(CardSchema, { ...byKind("markdown"), options: [{ id: "a", label: "A" }] }, "markdown card has no options");
  const compare = byKind("compare");
  bad(CardSchema, { ...compare, media: (compare.media as unknown[]).slice(0, 1) }, "compare with one media item");
  bad(CardSchema, { ...compare, options: undefined }, "answered compare without options");
  bad(CardSchema, { ...byKind("choice"), options: [{ id: "a", label: "A" }] }, "choice with one option");
  bad(
    CardSchema,
    {
      ...byKind("choice"),
      options: [
        { id: "a", label: "A" },
        { id: "a", label: "B" },
      ],
    },
    "duplicate option ids",
  );
  bad(CardSchema, { ...byKind("choice"), answer: { choice: "nope", at: "2026-11-17T10:00:00Z" } }, "unknown choice");
  bad(CardSchema, { ...byKind("rating"), answer: { text: "nice", at: "2026-11-17T10:00:00Z" } }, "rating w/o ratings");
  bad(
    CardSchema,
    { ...byKind("rating"), answer: { ratings: { "media/other.png": 3 }, at: "2026-11-17T10:00:00Z" } },
    "rating of media not on the card",
  );
  bad(CardSchema, { ...byKind("rating"), answer: { ratings: {}, at: "x" } }, "answer time");
  bad(CardSchema, { ...byKind("media"), kind: "html" }, "unknown kind");
  const input = clone((load("card-inputs.json") as Record<string, unknown>[])[0]!);
  bad(CardInputSchema, { ...input, id: "card-1" }, "card input carries no id");
  bad(
    CardInputSchema,
    { ...input, answer: { choice: "a", at: "2026-11-17T10:00:00Z" } },
    "card input carries no answer",
  );
  bad(CardInputSchema, { ...input, from: {} }, "card input names its agent");
});

test("events: strict, bounded data, cli pairing fields, per-kind data", () => {
  const events = load("events.json") as Record<string, unknown>[];
  const start = clone(events[0]!);
  bad(ConsoleEventSchema, { ...start, extra: 1 }, "unknown field");
  bad(ConsoleEventSchema, { ...start, v: 2 }, "version");
  bad(ConsoleEventSchema, { ...start, id: "not-a-ulid" }, "ulid");
  bad(ConsoleEventSchema, { ...start, kind: "cli.crash" }, "unknown kind");
  bad(ConsoleEventSchema, { ...start, runId: undefined }, "cli.start without runId");
  bad(ConsoleEventSchema, { ...start, project: "../x" }, "project id");
  bad(ConsoleEventSchema, { ...start, data: { blob: "x".repeat(EVENT_DATA_MAX_BYTES) } }, "data over 8 KB");
  const end = clone(events[1]!);
  bad(ConsoleEventSchema, { ...end, ok: false }, "failed cli.end without error");
  bad(ConsoleEventSchema, { ...end, elapsedMs: undefined }, "cli.end without elapsedMs");
  const dispatch = clone(events.find((event) => event.kind === "agent.dispatch")!);
  bad(ConsoleEventSchema, { ...dispatch, data: { brief: "../../etc/passwd" } }, "dispatch brief outside the project");
  bad(ConsoleEventSchema, { ...dispatch, data: undefined }, "dispatch without data");
  const job = clone(events.find((event) => event.kind === "job.state")!);
  bad(ConsoleEventSchema, { ...job, data: { jobId: "j", state: "exploded" } }, "unknown job state");
});

test("decisions, inbox files and requests", () => {
  const decisions = load("decisions.json") as Record<string, unknown>[];
  const applied = clone(decisions[0]!);
  bad(DecisionSchema, { ...applied, extra: true }, "unknown field");
  bad(DecisionSchema, { ...applied, decidedAt: undefined }, "decided without decidedAt");
  bad(DecisionSchema, { ...applied, bindTo: [{ path: "/abs", sha256: "a".repeat(64) }] }, "absolute binding");
  bad(DecisionSchema, { ...applied, bindTo: [{ path: "a", sha256: "A".repeat(64) }] }, "uppercase hash");
  bad(InboxDecisionFileSchema, { ...applied, status: "pending", decidedAt: undefined }, "pending in the inbox");
  bad(InboxDecisionFileSchema, { ...applied, answer: "  " }, "inbox without the user's words");
  bad(InboxDecisionFileSchema, { ...applied, result: undefined }, "applied without result");
  const verdict = clone(decisions.find((decision) => decision.kind === "verdict")!) as Record<string, unknown>;
  bad(DecisionSchema, { ...verdict, verdict: { score: 11 } }, "verdict score 1–10");
  bad(DecisionSchema, { ...verdict, verdict: undefined }, "decided verdict without scores");
  const comments = verdict.frameComments as { region: Record<string, number> }[];
  comments[0]!.region = { x: 0.5, y: 0.5, w: 0.6, h: 0.1 };
  bad(DecisionSchema, verdict, "region outside the frame");
  const view = clone(load("view-film-build.json")) as { waiting: Record<string, unknown>[] };
  const quote = view.waiting[0]!;
  bad(DecisionSchema, { ...quote, quote: { ...(quote.quote as object), amountUsd: -1 } }, "negative quote");
  ok(DecisionSchema, { ...quote, quote: { ...(quote.quote as object), amountUsd: null } }, "unknown price is null");
  bad(
    ProjectViewSchema,
    { ...view, waiting: [{ ...quote, status: "applied", decidedAt: "2026-11-17T10:00:00Z" }] },
    "x",
  );
  bad(ProjectViewSchema, { ...view, waiting: [{ ...quote, project: "other" }] }, "waiting decision of another project");
  bad(DecisionRequestSchema, { decisionId: "dec-1", answer: " " }, "blank words");
  bad(DecisionRequestSchema, { answer: "Yes." }, "neither decisionId nor kind");
  bad(DecisionRequestSchema, { kind: "verdict", answer: "8." }, "verdict request without scores");
  bad(DecisionRequestSchema, { kind: "control", answer: "Pause." }, "control through decisions");
  bad(DecisionRequestSchema, { decisionId: "dec-1", answer: "Yes.", proxy: "benchmark" }, "unknown field (no proxy)");
  bad(ControlRequestSchema, { state: "paused" }, "control without words");
  bad(ControlRequestSchema, { state: "frozen", answer: "x" }, "unknown control state");
  bad(CardAnswerRequestSchema, {}, "empty card answer");
  bad(CardAnswerRequestSchema, { text: "x", at: "2026-11-17T10:00:00Z" }, "the server stamps at");
});

test("files and envelopes: strict where the console owns the file, loose for CLI envelopes", () => {
  bad(ConsoleSessionSchema, { v: 1, token: "short" }, "token length");
  bad(ConsoleSessionSchema, { v: 1, token: "a".repeat(64), extra: 1 }, "session unknown field");
  bad(ServerLockSchema, { ...(load("server.json") as object), port: 70000 }, "port range");
  bad(ControlFileSchema, { ...(load("control.json") as object), by: "agent" }, "control by an agent");
  bad(HookCursorSchema, { ...(load("hook-cursor.json") as object), session: "../x" }, "session id");
  ok(
    CliEnvelopeSchema,
    { ok: true, outputs: [], metadata: { any: 1 }, elapsedMs: 1, extraField: true },
    "loose envelope",
  );
  ok(CliEnvelopeSchema, { ok: false, error: "PAUSED", message: "Project paused.", elapsedMs: 1 }, "future code");
  bad(CliEnvelopeSchema, { ok: false, message: "x" }, "failed envelope without error");
  bad(ConsoleNextBlockSchema, { pending: -1, appliedSince: [] }, "negative pending");
});

test("the contract stays browser-safe and apps/console stays out of src/", () => {
  const source = readFileSync("src/types/console.ts", "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ["zod"], "src/types/console.ts imports only zod (apps/console bundles it)");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const file = path.join(dir, name);
      return statSync(file).isDirectory() ? walk(file) : /\.(?:ts|tsx)$/.test(name) ? [file] : [];
    });
  for (const file of walk("src")) {
    if (file.startsWith(path.join("src", "projects"))) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /from\s+["'][^"']*apps\/console/, `${file} imports apps/console`);
  }
});

test("film material (WP10b): bounded, blind and strict", () => {
  const view = load("view-film-human.json") as { film: Record<string, any> };
  const film = view.film;
  ok(FilmMaterialSchema, film, "human fixture's film block");
  const withPool = (mutate: (pool: any) => void) => {
    const copy = clone(film);
    mutate(copy.ideas);
    return copy;
  };
  bad(
    FilmMaterialSchema,
    withPool((pool) => (pool.items[0].id = "metaphor-1")),
    "a non-anonymous pool id",
  );
  bad(
    FilmMaterialSchema,
    withPool((pool) => (pool.items[0].author = "metaphor")),
    "an author on a pool item",
  );
  bad(
    FilmMaterialSchema,
    withPool((pool) => (pool.top = ["I1", "I2", "I3", "I4"])),
    "more than three on top",
  );
  bad(FilmMaterialSchema, { ...clone(film), brief: { excerpt: "x".repeat(4097) } }, "an excerpt over 4 KB");
  bad(FilmMaterialSchema, { ...clone(film), extra: true }, "an unknown section");
  bad(FilmMaterialSchema, { human: { rubric: { version: 3, axes: ["hook"] } } }, "an unknown rubric version");
  const critic = clone(film);
  critic.critic.rounds[0].fixes = Array.from({ length: 8 }, (_, i) => `fix ${i}`);
  bad(FilmMaterialSchema, critic, "more than seven ranked fixes");
  const media = clone(film);
  media.look.styleframes[0].media.path = "../secret.png";
  bad(FilmMaterialSchema, media, "a path out of the project");
  ok(MediaRefSchema, { path: "film.mp4", root: "out", kind: "video", composition: "promo-acme-main" }, "composition");
});
