import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { measureBudget } from "../src/lib/context/budget";
import { repositoryText } from "../src/lib/context/repository";
import {
  accumulate,
  bootText,
  briefReads,
  firstFilmAnswers,
  quartersOf,
  simulatePlaybook,
  simulateRun,
  simulationMarkdown,
  type SimEvent,
} from "../src/lib/context/simulate";
import { stepById } from "../src/lib/film/chain";
import { lanesFor } from "../src/lib/film/studio";

const root = path.resolve(import.meta.dirname, "..");
const loader = createRequire(import.meta.url).resolve("tsx");

const event = (step: string, tokens: number, kind: SimEvent["kind"] = "read"): SimEvent => ({
  step,
  kind,
  label: `${step} ${kind}`,
  bytes: tokens * 4,
  quarters: tokens * 4,
});

test("accumulate rounds up once, finds the first step past each threshold and ranks contributors", () => {
  const result = accumulate(
    "synthetic",
    "film",
    "expected",
    [event("a", 60_000), event("b", 30_000, "brief"), event("b", 10_000), event("c", 99_999, "answer"), event("d", 1)],
    [],
  );
  assert.deepEqual(
    result.steps.map((row) => [row.step, row.addedTokens, row.cumulativeTokens]),
    [
      ["a", 60_000, 60_000],
      ["b", 40_000, 100_000],
      ["c", 99_999, 199_999],
      ["d", 1, 200_000],
    ],
  );
  assert.deepEqual(result.crossings, { "100k": "b", "200k": "d" });
  assert.deepEqual(
    result.contributors.map((entry) => entry.kind),
    ["answer", "read", "brief"],
  );
  assert.equal(result.contributors[1]!.estimatedTokens, 70_001);
  assert.equal(result.topItems[0]!.step, "c");
  // Quarter tokens from several events round up once for the conversation.
  const quarters = accumulate(
    "q",
    "film",
    "expected",
    [
      { step: "a", kind: "read", label: "x", bytes: 1, quarters: 1 },
      { step: "a", kind: "read", label: "y", bytes: 1, quarters: 1 },
    ],
    [],
  );
  assert.equal(quarters.totalTokens, 1);
  assert.deepEqual(accumulate("none", "footage", "worst", [event("a", 5)], []).crossings, {
    "100k": null,
    "200k": null,
  });
});

test("briefReads takes paths from the header, goal, inputs and rules, never outputs or commands", () => {
  const prompt = [
    "# Film chain",
    "",
    "You are x. Read your definition first and follow it: .agents/agents/x.md",
    "",
    "## Inputs",
    "",
    "- public/projects/p/pipeline/brief.json: the brief",
    "- {previousCritique}: the last verdict (optional)",
    "",
    "## Your team",
    "",
    'You are the metaphor team. Read the "metaphor" section of .agents/skills/creative-studio/references/creative-teams.md and hold to it.',
    'Write round 1 to public/projects/p/pipeline/concepts/metaphor.json, with "team": "metaphor" and 4 to 6 ideas.',
    "",
    "## Rules, read before you start",
    "",
    "- design-reference/craft-rules.md",
    "",
    "## Outputs",
    "",
    "- public/projects/p/pipeline/design.json: the look",
    "",
    "## Commands, in order",
    "",
    "1. Run\n   `pnpm film:done --project p --step look`",
    "",
  ].join("\n");
  assert.deepEqual(briefReads(prompt), [
    ".agents/agents/x.md",
    "public/projects/p/pipeline/brief.json",
    "{previousCritique}",
    ".agents/skills/creative-studio/references/creative-teams.md",
    "design-reference/craft-rules.md",
  ]);
});

test("the boot text is the budget's claude-code boot row", () => {
  const repo = repositoryText(root);
  const text = bootText(repo);
  const row = measureBudget(repo).boot[0]!;
  assert.equal(Buffer.byteLength(text), row.bytes);
  assert.equal(Math.ceil(quartersOf(text) / 4), row.estimatedTokens);
});

test("the assembled first film answer is the real nextAction answer", () => {
  for (const id of ["product-promo", "explainer", "avatar-presenter"]) {
    const { step, real, assembled } = firstFilmAnswers(root, id);
    assert.equal(step, "intake");
    assert.equal(assembled, real, id);
  }
});

test("simulation is deterministic, names no scratch path and covers every film and footage playbook", () => {
  const first = simulatePlaybook(root, "product-promo");
  assert.deepEqual(simulatePlaybook(root, "product-promo"), first);
  assert.deepEqual(simulatePlaybook(root, "shorts-from-long"), simulatePlaybook(root, "shorts-from-long"));
  assert.equal(first.steps[0]!.step, "start");
  assert.deepEqual(
    first.steps.slice(1, 4).map((row) => row.step),
    ["intake", "truth", "reference"],
  );
  assert.equal(first.steps.at(-1)!.step, "human");
  assert.deepEqual(first.missing, []);
  for (let index = 1; index < first.steps.length; index++)
    assert.ok(first.steps[index]!.cumulativeTokens > first.steps[index - 1]!.cumulativeTokens);
  const all = simulateRun(root, undefined);
  const text = JSON.stringify(all);
  assert.ok(!text.includes(tmpdir()) && !text.includes("context-simulate-"), "a scratch path reached the report");
  assert.ok(
    all.playbooks.some((item) => item.route === "footage") && all.playbooks.some((item) => item.route === "film"),
  );
  assert.ok(all.skipped.every((item) => /campaign route/.test(item.reason)));
  for (const item of all.playbooks) assert.deepEqual(item.missing, [], item.id);
  assert.match(simulationMarkdown(all), /\| product-promo \| film \|/);
});

test("worst rounds multiply critic, fixer and fan-out loops by stop.maxRounds", () => {
  const expected = simulatePlaybook(root, "product-promo", { rounds: "expected" });
  const worst = simulatePlaybook(root, "product-promo", { rounds: "worst" });
  const dispatches = (simulation: typeof expected, step: string) =>
    simulation.steps.find((row) => row.step === step)!.dispatches;
  const ideaReview = stepById("idea-review")!;
  const teams = lanesFor(path.join(tmpdir(), "no-project"), "ideas").length;
  assert.equal(dispatches(expected, "idea-review"), 1);
  // Each round a new director; every round after the first sends every team back first.
  assert.equal(dispatches(worst, "idea-review"), ideaReview.stop.maxRounds + (ideaReview.stop.maxRounds - 1) * teams);
  const look = stepById("look")!;
  assert.equal(dispatches(expected, "look"), 2);
  // The designer once, again after each failed round, and a new critic every round.
  assert.equal(dispatches(worst, "look"), 1 + (look.stop.maxRounds - 1) + look.stop.maxRounds);
  assert.equal(dispatches(worst, "build"), stepById("build")!.stop.maxRounds);
  assert.equal(dispatches(worst, "measure"), stepById("measure")!.stop.maxRounds - 1);
  assert.equal(dispatches(expected, "measure"), 0);
  assert.ok(worst.totalTokens > expected.totalTokens);
  assert.equal(
    worst.dispatchCount,
    worst.steps.reduce((sum, row) => sum + row.dispatches, 0),
  );
  // A footage route has no critic or fixer loop.
  assert.equal(
    simulatePlaybook(root, "footage-edit", { rounds: "worst" }).totalTokens,
    simulatePlaybook(root, "footage-edit").totalTokens,
  );
});

/**
 * The orchestrator's whole-run estimate with expected rounds, held just above its 2026-11-16 value after briefs went by
 * reference (product-promo 106,614 tokens, explainer 110,726, shorts-from-long 80,801; before: 140,057 and 144,084).
 * Lower a ceiling when the run shrinks; raising one needs the context-growth review in docs/context-budget.md.
 * 2026-11-17: explainer raised for the narration step it now runs (117,961: one owner dispatch, two user asks, the
 * narration section, and the measured-takes input of four later briefs); the other routes skip it and are unchanged.
 * 2026-11-21: product-promo raised for the boot row only (107,728): the colour-grading skill and colourist agent
 * descriptions add 32 tokens; needs the context-growth-approved label (RFC 0001 §4.2).
 * 2026-11-21: product-promo raised for the boot row (107,763): the Drei shot techniques in the engine-selection skill; context-growth-approved.
 * 2026-11-21: product-promo raised again (107,986): five playbooks recommend the new DesignBookmark-inspired blocks; context-growth-approved.
 */
const RUN_CEILINGS: Record<string, number> = {
  "product-promo": 108_000,
  explainer: 118_500,
  "shorts-from-long": 81_500,
};

test("briefs go by reference: the orchestrator holds film:brief's envelope and one dispatch line, never the text", () => {
  const simulation = simulatePlaybook(root, "product-promo");
  const briefs = simulation.contributors.find((entry) => entry.kind === "brief")!;
  // Two small events per dispatch: the envelope (path, summary, dispatch line) and the Agent call's one line.
  assert.ok(briefs.estimatedTokens / simulation.dispatchCount < 250, `${briefs.estimatedTokens} brief tokens`);
  assert.ok(
    simulation.topItems.every((item) => item.kind !== "brief"),
    "no brief is among the largest orchestrator items",
  );
  for (const dispatch of simulation.largestDispatches)
    assert.match(dispatch.files[1]!, /^public\/projects\/simulated\/pipeline\/briefs\/[a-z-]+\.md$/);
  // A quoted reference is not a read; its full-file link sits in a section agents open only when the quote is not enough.
  const quoted = [
    "## Stance metaphor, quoted from the creative teams reference",
    "",
    "#### Concept teams",
    "",
    "Procedures: `creative-methods.md`, and src/types/studio.ts.",
    "",
    "## Full references, only when a quote above is not enough",
    "",
    "- .agents/skills/creative-studio/references/creative-teams.md",
    "",
  ].join("\n");
  assert.deepEqual(briefReads(quoted), []);
});

test("whole-run orchestrator estimates stay within their ceilings", () => {
  for (const [id, ceiling] of Object.entries(RUN_CEILINGS)) {
    const simulation = simulatePlaybook(root, id);
    assert.ok(
      simulation.totalTokens <= ceiling,
      `${id} runs to ${simulation.totalTokens} estimated tokens, ceiling ${ceiling}`,
    );
  }
});

test("simulate CLI follows the JSON contract and refuses --base and stray flags", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "simulate-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const markdown = path.join(dir, "simulate.md");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", loader, "scripts/context-budget.ts", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  const ok = run(
    "--simulate",
    "--playbook",
    "explainer",
    "--rounds",
    "worst",
    "--report-bytes",
    "1024",
    "--markdown",
    markdown,
  );
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout.trim().split("\n").length, 1);
  const result = JSON.parse(ok.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.options.rounds, "worst");
  assert.equal(result.metadata.options.reportBytes, 1024);
  assert.deepEqual(
    result.metadata.playbooks.map((item: { id: string }) => item.id),
    ["explainer"],
  );
  assert.match(readFileSync(markdown, "utf8"), /### explainer/);
  for (const args of [
    ["--simulate", "--base", "HEAD"],
    ["--rounds", "worst"],
    ["--simulate", "--playbook", "ad-experiments"],
    ["--simulate", "--playbook", "no-such-playbook"],
    ["--simulate", "--playbook", "explainer", "--all"],
  ]) {
    const refused = run(...args);
    assert.notEqual(refused.status, 0, args.join(" "));
    assert.equal(JSON.parse(refused.stdout).error, "INVALID_INPUT", args.join(" "));
  }
});
