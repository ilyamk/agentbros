/**
 * Waiting decisions shaped from a given chain or footage answer (RFC 0004 FR2, FR4): paid quotes with amount,
 * provider, endpoint, maxAdmissibleUsd, budget after and unknown price; the final verdict with its rubric axes; the
 * footage plan approval bound to its edit hash; and every option's argv uses only flags its script declares.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DecisionSchema } from "../src/types/console";
import { STEP, type FootageNext } from "../src/lib/footage/next";
import type { FilmRead, QuoteContext } from "../src/lib/console/view/film";
import { filmWaiting, outputsHash, VERDICT_AXES } from "../src/lib/console/view/film";
import { footageWaiting } from "../src/lib/console/view/footage";
import { projectPaths } from "../src/lib/console/view/files";
import {
  ANSWER_PLACEHOLDER,
  budgetCeilingArgv,
  feedbackClarifyArgv,
  feedbackFileArgv,
  filmApproveArgv,
  memoryChangesArgv,
  filmRightsArgv,
  filmSkipArgv,
  musicRecordArgv,
  shortsRequestArgv,
  splitCommand,
  withAnswer,
} from "../src/lib/console/view/argv";

const REPO = path.resolve(import.meta.dirname, "..");
const ID = "film";
const root = mkdtempSync(path.join(tmpdir(), "console-waiting-"));
after(() => rmSync(root, { recursive: true, force: true }));
const paths = projectPaths(root, ID);
const pipeline = path.join(paths.projectDir, "pipeline");
mkdirSync(pipeline, { recursive: true });
const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(path.join(paths.projectDir, file)), { recursive: true });
  writeFileSync(path.join(paths.projectDir, file), typeof value === "string" ? value : JSON.stringify(value));
};
/** "Ask for changes" as the film is now: feedback once out/<id>/film.mp4 exists, else kept in the memory. */
const changesArgv = (step: string) =>
  existsSync(path.join(paths.outDir, "film.mp4")) ? feedbackFileArgv(ID) : memoryChangesArgv(ID, step);
const money: QuoteContext = { ceilingUsd: 10, reservedUsd: 1, spentUsd: 2, maxAdmissibleUsd: 6 };

/** A chain stopped at `step`, awaiting the user, with these outputs (root-relative) and the chain's approve command. */
function fakeFilm(step: string, outputs: string[], extra: Partial<FilmRead["next"]> = {}): FilmRead {
  const hashes = Object.fromEntries(outputs.map((file) => [`public/projects/${ID}/${file}`, "0".repeat(64)]));
  return {
    project: { id: ID, projectDir: paths.projectDir, rootDir: root } as FilmRead["project"],
    chain: {
      tokens: {},
      steps: [
        {
          id: step,
          status: "awaiting-gate",
          reasons: ["Needs the user's approval of this exact artefact."],
          inputs: {},
          outputs: hashes,
          missingInputs: [],
          openUpstream: [],
        },
      ],
      filmType: "explainer",
      typeDefaulted: false,
    } as unknown as FilmRead["chain"],
    next: {
      action: "ask",
      step,
      why: "Needs the user's approval of this exact artefact.",
      question: "Is this it?",
      show: outputs.map((file) => `public/projects/${ID}/${file}`),
      thenRun: [`pnpm film:approve --project ${ID} --step ${step} --answer "<the user's words>"`],
      ...extra,
    } as FilmRead["next"],
  };
}

const material = (items: Record<string, unknown>[]) =>
  write("pipeline/material.json", { schemaVersion: 1, filmType: "explainer", items });
const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  shots: ["s1"],
  what: "a shot",
  kind: "generated-video",
  route: "generated",
  status: "pending",
  provenance: "fal fal-ai/kling-video/v2",
  licence: "provider terms",
  ...extra,
});

test("strategy offers both artefacts in the document dialogue and binds them for approval", () => {
  const structured = "pipeline/strategy.json";
  const readable = "pipeline/strategy.md";
  write(structured, { proposition: "An editable film" });
  write(readable, "# Strategy");

  const decision = DecisionSchema.parse(
    filmWaiting(fakeFilm("strategy", [structured, readable]), paths, money).decisions[0],
  );
  assert.deepEqual(
    decision.media?.map(({ path, kind }) => [path, kind]),
    [
      [structured, "document"],
      [readable, "document"],
    ],
  );
  assert.deepEqual(
    decision.bindTo.map(({ path }) => path),
    [structured, readable],
  );

  write(structured, { proposition: "An editable film rendered locally" });
  const revised = filmWaiting(fakeFilm("strategy", [structured, readable]), paths, money).decisions[0];
  assert.notEqual(revised?.id, decision.id);
});

test("material's paid items are a quote: amount, provider, endpoint, admission and the budget after", () => {
  material([item("a", { maxCostUsd: 1.5 }), item("b", { maxCostUsd: 0.5 })]);
  const { decisions } = filmWaiting(fakeFilm("material", ["pipeline/material.json"]), paths, money);
  const decision = DecisionSchema.parse(decisions[0]);
  assert.equal(decision.kind, "quote");
  assert.deepEqual(
    {
      amount: decision.quote?.amountUsd,
      provider: decision.quote?.provider,
      endpoint: decision.quote?.endpoint,
      max: decision.quote?.maxAdmissibleUsd,
      after: decision.quote?.budgetAfterUsd,
      ceiling: decision.quote?.ceilingUsd,
    },
    { amount: 2, provider: "fal", endpoint: "fal-ai/kling-video/v2", max: 6, after: 5, ceiling: 10 },
  );
  assert.match(decision.quote?.quoteHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(decision.options?.[0]?.consequential, true);
  const hash = decision.quote!.quoteHash;

  material([item("a", { maxCostUsd: 1.5 }), item("b")]);
  const unknown = filmWaiting(fakeFilm("material", ["pipeline/material.json"]), paths, money).decisions[0]!;
  assert.equal(unknown.quote?.amountUsd, null, "one unbounded item: the price is unknown, never free");
  assert.equal(unknown.quote?.budgetAfterUsd, null);
  assert.notEqual(unknown.quote?.quoteHash, hash);
  assert.notEqual(unknown.id, decisions[0]!.id, "the material changed, so the decision did");

  material([item("a", { provenance: "someone's link", maxCostUsd: 1 })]);
  assert.equal(
    filmWaiting(fakeFilm("material", ["pipeline/material.json"]), paths, money).decisions[0]!.quote?.provider,
    "unknown",
    "a provider is never invented",
  );

  material([item("a", { status: "acquired", path: "assets/a.mp4", costUsd: 1 })]);
  assert.equal(filmWaiting(fakeFilm("material", ["pipeline/material.json"]), paths, money).decisions[0]!.kind, "gate");
});

test("narration on the paid route quotes the bound per take times the beats, and may be skipped", () => {
  write("pipeline/narrator-direction.json", {
    route: "elevenlabs",
    voiceWhy: "calm",
    maxCostUsd: 0.25,
    modelId: "eleven_v3",
    beats: [
      { beatId: "b1", directedText: "one" },
      { beatId: "b2", directedText: "two" },
    ],
  });
  const { decisions } = filmWaiting(fakeFilm("narration", ["pipeline/narrator-direction.json"]), paths, money);
  const decision = decisions[0]!;
  if (decision.kind === "quote") {
    assert.equal(decision.quote?.amountUsd, 0.5);
    assert.deepEqual([decision.quote?.provider, decision.quote?.endpoint], ["elevenlabs", "eleven_v3"]);
  } else assert.fail(`narration direction did not validate: ${JSON.stringify(decision)}`);
  assert.deepEqual(
    decision.options?.map((option) => option.id),
    ["approve", "changes", "skip"],
  );
  assert.deepEqual(decision.options?.[1]?.argv, changesArgv("narration"));
  assert.deepEqual(decision.options?.[2]?.argv, filmSkipArgv(ID, "narration"));
});

test("the final verdict carries the film's rubric axes and binds the render under out/", () => {
  mkdirSync(paths.outDir, { recursive: true });
  writeFileSync(path.join(paths.outDir, "film.mp4"), "video");
  const read = fakeFilm("human", [], { show: [`out/${ID}/film.mp4`] });
  read.chain.steps[0]!.outputs = { [`out/${ID}/film.mp4`]: "1".repeat(64) };
  const decision = DecisionSchema.parse(filmWaiting(read, paths, money).decisions[0]);
  assert.equal(decision.kind, "verdict");
  assert.deepEqual(
    decision.bindTo.map((b) => b.path),
    ["@out/film.mp4"],
  );
  assert.deepEqual(decision.media?.[0] && [decision.media[0].root, decision.media[0].path, decision.media[0].kind], [
    "out",
    "film.mp4",
    "video",
  ]);
  for (const axis of VERDICT_AXES) assert.ok(decision.summary?.includes(axis), axis);
  // No approve option (WP10b): the verdict is given on the film.human form; the action builds its own argv.
  // Asking for changes stays on the card (WP3); there is no approve or accept option.
  assert.deepEqual(
    (decision.options ?? []).map((option) => option.id),
    ["changes"],
  );
});

test("every question is a decision (FR2): clarify asks, exhausted fixer rounds and the guard's limits", () => {
  // A repeated objection: answered through feedback --clarify, with the user's words.
  const read = fakeFilm("script", ["pipeline/material.json"], {
    question: "This is the second time you raise this.",
    thenRun: [`pnpm feedback --project ${ID} --step script --clarify "<the user's words>"`],
  });
  const clarify = DecisionSchema.parse(filmWaiting(read, paths, money).decisions[0]);
  assert.equal(clarify.kind, "gate");
  assert.match(clarify.summary ?? "", /second time/);
  assert.deepEqual(
    clarify.options?.map((option) => [option.id, option.argv]),
    [["clarify", feedbackClarifyArgv(ID, "script")]],
  );

  // A fixer that made no progress within its rounds: no command in the chain, so the answer is feedback.
  const exhausted = fakeFilm("measure", ["pipeline/material.json"], {
    question: "The fixer made no progress. How do you want to proceed?",
    thenRun: [],
  });
  const stuck = DecisionSchema.parse(filmWaiting(exhausted, paths, money).decisions[0]);
  assert.equal(stuck.kind, "gate");
  assert.deepEqual(
    stuck.options?.map((option) => [option.id, option.argv]),
    [["changes", changesArgv("measure")]],
  );

  // The guard's stop: one raise option per crossed limit, the user's words as placeholder, plus changes.
  write("pipeline/best.mp4", "best");
  const stop = filmWaiting(
    fakeFilm("present-best", [], {
      action: "stop",
      step: "present-best",
      title: "Present the best version",
      limits: [{ name: "maxTotalRounds", used: 12, max: 12 }],
      best: { file: `public/projects/${ID}/pipeline/best.mp4`, sha256: "0".repeat(64), measurePassed: false },
      raise: [`pnpm film:policy --project ${ID} --raise maxTotalRounds=18 --answer "<the user's words>"`],
    }),
    paths,
    money,
  );
  const limit = DecisionSchema.parse(stop.decisions[0]);
  assert.equal(limit.step, "present-best");
  assert.deepEqual(
    limit.bindTo.map((b) => b.path),
    ["pipeline/best.mp4"],
  );
  assert.deepEqual(
    limit.options?.map((option) => [option.id, option.argv, option.consequential ?? false]),
    [
      [
        "raise-maxTotalRounds",
        ["pnpm", "film:policy", "--project", ID, "--raise", "maxTotalRounds=18", "--answer", ANSWER_PLACEHOLDER],
        true,
      ],
      ["changes", changesArgv("present-best"), false],
    ],
  );
  // An unreadable policy has no limits to raise: told, not decided.
  const broken = filmWaiting(fakeFilm("present-best", [], { action: "stop", step: "present-best" }), paths, money);
  assert.deepEqual(broken.decisions, []);
  assert.equal(broken.advisories.length, 1);
});

test("a critic's ask goes on or asks for changes; no command raises a round limit, so no other option", () => {
  const critic = fakeFilm("look", ["pipeline/material.json"], { thenRun: [`pnpm film:approve --project ${ID}`] });
  critic.chain.steps[0]!.critic = { round: 4, action: "ask", why: "3 rounds used" } as never;
  const pastCritic = DecisionSchema.parse(filmWaiting(critic, paths, money).decisions[0]);
  assert.deepEqual(
    pastCritic.options?.map((option) => option.id),
    ["approve", "changes"],
    "a critic's round limit has no command to raise it",
  );
  const review = fakeFilm("idea-review", ["pipeline/material.json"], {
    thenRun: [`pnpm film:approve --project ${ID}`],
  });
  review.chain.steps[0]!.critic = { round: 4, action: "ask", why: "no progress" } as never;
  const pool = DecisionSchema.parse(filmWaiting(review, paths, money).decisions[0]);
  assert.deepEqual(
    pool.options?.map((option) => option.id),
    ["approve", "changes"],
  );
  // Before any render, changes are kept in the memory; once the film exists, feedback reopens the owning step.
  rmSync(path.join(paths.outDir, "film.mp4"), { force: true });
  assert.deepEqual(
    filmWaiting(review, paths, money).decisions[0]?.options?.[1]?.argv,
    memoryChangesArgv(ID, "idea-review"),
  );
  mkdirSync(paths.outDir, { recursive: true });
  writeFileSync(path.join(paths.outDir, "film.mp4"), "video");
  assert.deepEqual(filmWaiting(review, paths, money).decisions[0]?.options?.[1]?.argv, feedbackFileArgv(ID));
});

test("a broken music candidate is repaired or left out with an advisory; the choice survives", () => {
  // m1 without a title shows its id; m1 again is the same command, kept once; a candidate without an id is left out.
  write("pipeline/music-shortlist.json", {
    schemaVersion: 1,
    brief: "b",
    candidates: [
      { id: "m1", route: "library", title: "" },
      { id: "m1", route: "library", title: "Again" },
      { id: "m2", route: "library", title: "Two", creator: "C" },
      { route: "library", title: "No id" },
    ],
  });
  const read = fakeFilm("music", ["pipeline/music-shortlist.json"], {
    thenRun: [`pnpm music --action record --project ${ID}`, `pnpm film:approve --project ${ID}`],
  });
  read.chain.steps[0]!.firstAsk = true;
  const found = filmWaiting(read, paths, money);
  const decision = DecisionSchema.parse(found.decisions[0]);
  assert.deepEqual(
    decision.options?.map((option) => [option.id, option.label]),
    [
      ["candidate-m1", "candidate-m1"],
      ["candidate-m2", "Two — C"],
    ],
  );
  assert.ok(found.advisories.some((line) => line.startsWith("music shortlist:")));
});

test("a recut plan approval is bound to the request and its plan; a paid transcription is a quote", () => {
  write("pipeline/recut-request.json", { projectId: "rec-cut" });
  write("pipeline/recut-plan.md", "Edit hash to approve: `" + "a".repeat(64) + "`");
  const approve = {
    action: "ask",
    step: STEP.approve[0],
    title: STEP.approve[1],
    why: "The recut plan waits for a person's approval.",
    question: "Watch the whole source.",
    show: [`public/projects/${ID}/pipeline/recut-plan.md`],
    state: {
      request: {
        file: `public/projects/${ID}/pipeline/recut-request.json`,
        planFile: `public/projects/${ID}/pipeline/recut-plan.md`,
        planHash: "a".repeat(64),
      },
    },
  } as unknown as FootageNext;
  const decision = DecisionSchema.parse(footageWaiting(approve, paths, money).decisions[0]);
  assert.equal(decision.kind, "gate");
  assert.match(decision.title, /edit hash aaaaaaaaaaaa/);
  assert.deepEqual(
    decision.bindTo.map((b) => b.path),
    ["pipeline/recut-plan.md", "pipeline/recut-request.json"],
  );
  // WP12: the console approves through recut:plan --approve with the derived hash (console grant only).
  assert.deepEqual(decision.options, [
    {
      id: "approve",
      label: "Approve the edit hash",
      argv: ["pnpm", "recut:plan", "--project", ID, "--approve", "a".repeat(64), "--answer", "<the user's words>"],
    },
  ]);

  const paid = {
    action: "ask",
    step: STEP.transcript[0],
    title: STEP.transcript[1],
    why: "Scribe is paid.",
    cost: {
      model: "elevenlabs:scribe-v3",
      minutes: 10,
      expectedUsd: 0.4,
      highUsd: 0.5,
      source: "list",
      asOf: "2026-11-01",
    },
    thenRun: [
      `pnpm budget --project ${ID} --ceiling-usd 1 --answer "<the user's own words>"`,
      `pnpm footage:next --project ${ID}`,
    ],
    state: {},
  } as unknown as FootageNext;
  const quote = DecisionSchema.parse(footageWaiting(paid, paths, money).decisions[0]);
  assert.equal(quote.kind, "quote");
  assert.deepEqual([quote.quote?.amountUsd, quote.quote?.provider], [0.4, "elevenlabs"]);
  assert.deepEqual(
    quote.options?.map((option) => option.argv),
    [budgetCeilingArgv(ID, 1)],
  );
});

/** Flags a script declares (`name: "<flag>"` in its parseArgs table). */
function declared(alias: string): Set<string> {
  const scripts = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).scripts as Record<string, string>;
  const file = /tsx (scripts\/\S+\.ts)/.exec(scripts[alias] ?? "")?.[1];
  assert.ok(file, `${alias} is a package script`);
  return new Set([...readFileSync(path.join(REPO, file), "utf8").matchAll(/name: "([a-z0-9-]+)"/g)].map((m) => m[1]!));
}

test("every argv uses only flags its script declares, and the answer placeholder is replaced verbatim", () => {
  const all = [
    filmApproveArgv(ID, "concept", "f".repeat(64), "a"),
    filmSkipArgv(ID, "narration"),
    feedbackFileArgv(ID),
    memoryChangesArgv(ID, "concept"),
    feedbackClarifyArgv(ID, "script"),
    musicRecordArgv(ID, "free-stock", "stock-1"),
    filmRightsArgv(ID, "owned"),
    shortsRequestArgv(ID, "pipeline/shorts.json", "c1,c2"),
    budgetCeilingArgv(ID, 2),
  ];
  for (const argv of all) {
    assert.equal(argv[0], "pnpm");
    const known = declared(argv[1]!);
    for (const token of argv.slice(2).filter((value) => value.startsWith("--")))
      assert.ok(known.has(token.slice(2)), `${argv[1]} has no ${token}`);
  }
  const words = 'B, but a "shorter" hook --expect x';
  assert.deepEqual(withAnswer(filmApproveArgv(ID, "script"), words).slice(-1), [words]);
  assert.equal(withAnswer(filmApproveArgv(ID, "script"), words).includes(ANSWER_PLACEHOLDER), false);
});

test("splitCommand parses the chain's printed commands and refuses anything but one plain pnpm command", () => {
  assert.deepEqual(splitCommand(`pnpm film:approve --project p --step s --answer "<the user's words>"`), [
    "pnpm",
    "film:approve",
    "--project",
    "p",
    "--step",
    "s",
    "--answer",
    "<the user's words>",
  ]);
  assert.deepEqual(splitCommand("pnpm recut:plan --reject <ids, including earlier rejections> --force")?.slice(2), [
    "--reject",
    "<ids, including earlier rejections>",
    "--force",
  ]);
  assert.equal(splitCommand("pnpm a | tee x"), undefined);
  assert.equal(splitCommand("mkdir -p x && cp a b"), undefined);
  assert.equal(splitCommand("pnpm x > out.json"), undefined);
});
