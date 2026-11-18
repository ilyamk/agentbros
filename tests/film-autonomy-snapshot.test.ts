/**
 * An interactive project (no pipeline/policy.json, no guard crossing) gets byte-identical film:next answers to the ones
 * the chain gave before autonomy existed. The snapshot was written by the chain before the policy code landed;
 * regenerate it only for a deliberate change to interactive answers: UPDATE_SNAPSHOT=1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nextAction } from "../src/lib/film/state";
import { buildPool, pickIdeas, rankLatest } from "../src/lib/film/studio";
import { skipDiscovery, writeBoards, writeReview, writeStrategy, writeTeams } from "./helpers/film-studio";
import {
  ID,
  REPO,
  critique,
  setup,
  toIntakeApproved,
  toMeasured,
  toMusicShortlist,
  writeCritique,
  sha,
  type Film,
} from "./helpers/film-autonomy";

const SNAPSHOT = path.join(REPO, "tests/fixtures/film-autonomy/interactive-next.json");

/** The action without what depends on the machine: memory and capture come from the per-process memory root. */
const answer = (film: Film) => {
  const next = nextAction(film.project()) as Record<string, unknown>;
  delete next["memory"];
  return next;
};

test("interactive film:next answers are byte-identical to the chain's before autonomy", (t) => {
  const states: Record<string, unknown> = {};

  const fresh = setup(t);
  states["intake-dispatch"] = answer(fresh);

  const intake = setup(t);
  intake.place("brief.json");
  intake.seal("intake");
  states["intake-ask"] = answer(intake);

  const concept = setup(t);
  toIntakeApproved(concept);
  writeStrategy(concept.dir);
  concept.seal("strategy");
  states["strategy-ask"] = answer(concept);
  concept.approve("strategy");
  skipDiscovery(concept.dir);
  writeTeams(concept.dir, 1);
  concept.seal("ideas");
  buildPool(concept.dir, ID, "ideas");
  concept.seal("idea-review");
  writeReview(concept.dir, "ideas", 1, () => 4);
  rankLatest(concept.dir, "ideas");
  pickIdeas(concept.dir);
  writeBoards(concept.dir);
  concept.seal("concept");
  states["concept-ask"] = answer(concept);

  const music = setup(t);
  toMusicShortlist(music);
  states["music-first-ask"] = answer(music);
  music.place("music-decision.json");
  music.seal("music");
  states["music-answered"] = answer(music);

  const human = setup(t);
  toMeasured(human);
  writeCritique(human, "round-1.json", critique(1, sha("render-1"), "approve-for-human"));
  states["human-ask"] = answer(human);

  const text = `${JSON.stringify(states, null, 2)}\n`;
  if (process.env["UPDATE_SNAPSHOT"] === "1") {
    mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, text);
  }
  assert.equal(text, readFileSync(SNAPSHOT, "utf8"));
});
