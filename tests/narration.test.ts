/** The film chain's narration step: routes, lease, direction and take checks, and the two-approval flow. No network. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderBrief } from "../src/lib/film/brief";
import { FILM_CHAIN, FEEDBACK_STEPS } from "../src/lib/film/chain";
import { stepEnabled, toolsFor } from "../src/lib/film/routes";
import { directionProblems, measureNarration, narrationFileProblems, takeFileName } from "../src/lib/film/narration";
import { deriveChain, nextAction, skipStep } from "../src/lib/film/state";
import { routeAspect } from "../src/lib/feedback/route";
import { filmLeaseFor, leaseAllow, proseAliases } from "../src/lib/step-lease/issue";
import { NarrationDirectionSchema } from "../src/types/narration";
import { ScriptSchema } from "../src/types/pipeline";
import { FIXTURES, ID, REPO, setup, type Film } from "./helpers/film-autonomy";

const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
import { toConceptApproved, toScriptPicked } from "./helpers/film-studio";

const script = ScriptSchema.parse({
  narratorVoice: "custom",
  voiceoverEnabled: true,
  language: "en",
  beats: [
    { id: "hook", kind: "hook", text: "Words carry the film.", durationSec: 3 },
    { id: "cta", kind: "cta", text: "Start today.", durationSec: 2 },
  ],
});

const direction = (overrides: Record<string, unknown> = {}) =>
  NarrationDirectionSchema.parse({
    route: "elevenlabs",
    voiceWhy: "A calm teacher for a curious audience.",
    modelId: "eleven_v4",
    maxCostUsd: 1,
    beats: [
      { beatId: "hook", directedText: "[curious] Words carry… the film.", emphasisWords: ["film"] },
      { beatId: "cta", directedText: "Start today.", emphasisWords: [] },
    ],
    ...overrides,
  });

test("narration runs for voiced types and hybrids, never for talking-head or motion graphics", () => {
  for (const type of ["explainer", "ui-demo", "ai-video"] as const) assert.ok(stepEnabled("narration", type), type);
  for (const type of ["motion-graphics", "talking-head", "footage", "collage", "replica"] as const)
    assert.ok(!stepEnabled("narration", type), type);
  assert.ok(stepEnabled("narration", "motion-graphics", "explainer"));
  const order = FILM_CHAIN.map((step) => step.id);
  assert.ok(order.indexOf("script") < order.indexOf("narration"));
  assert.ok(order.indexOf("narration") < order.indexOf("beat-sheet"));
  assert.ok(FEEDBACK_STEPS.includes("narration"));
  assert.equal(FILM_CHAIN.find((step) => step.id === "narration")!.skippable, true);
});

test("generate:voiceover is leased at narration only, never at sound", () => {
  for (const type of ["explainer", "ui-demo", "ai-video"] as const) {
    const allow = leaseAllow("narration", type);
    for (const alias of ["generate:voiceover", "voiceover:local", "speech:local", "narration:check"])
      assert.ok(allow.includes(alias), `${type} narration ${alias}`);
  }
  for (const type of ["explainer", "ai-video", "motion-graphics", "talking-head"] as const) {
    assert.ok(!leaseAllow("sound", type).includes("generate:voiceover"), `${type} sound`);
    assert.ok(!toolsFor("sound", type).some((tool) => tool.id === "generate:voiceover"));
  }
});

test("voice feedback goes to narration where the film has it, else to sound", () => {
  assert.deepEqual(routeAspect("voice", { type: "explainer" }), { step: "narration" });
  assert.deepEqual(routeAspect("voice", { type: "motion-graphics" }), { step: "sound" });
});

test("a direction directs every spoken beat and, on the paid route, pins a timestamped voice and a bound", () => {
  assert.deepEqual(directionProblems(direction(), script), []);
  assert.match(directionProblems(direction({ modelId: "eleven_v3" }), script).join(), /voiceRef/);
  assert.match(directionProblems(direction({ maxCostUsd: undefined }), script).join(), /maxCostUsd/);
  assert.deepEqual(directionProblems(direction({ route: "local", maxCostUsd: undefined }), script), []);
  const missing = direction({ beats: [{ beatId: "hook", directedText: "Words carry the film." }] });
  assert.match(directionProblems(missing, script).join(), /beat cta has no directed text/);
  const ssml = direction({
    beats: [
      { beatId: "hook", directedText: 'Words <break time="1s"/> carry the film.' },
      { beatId: "cta", directedText: "Start today." },
    ],
  });
  assert.match(directionProblems(ssml, script).join(), /SSML/);
});

/** ElevenLabs-shaped takes: mp3, take receipt and word sidecar, as executeStudioAudio leaves them. */
function writeTakes(root: string, dir: string, options: { skipReceipt?: string } = {}) {
  mkdirSync(path.join(root, dir, "voiceover"), { recursive: true });
  const words: Record<string, [string, number, number][]> = {
    hook: [
      ["Words", 0.1, 0.4],
      ["carry", 0.45, 0.8],
      ["the", 0.85, 0.95],
      ["film.", 1.0, 1.5],
    ],
    cta: [
      ["Start", 0.1, 0.5],
      ["today.", 0.55, 1.1],
    ],
  };
  for (const [beat, list] of Object.entries(words)) {
    const take = path.join(root, dir, "voiceover", `${beat}.mp3`);
    writeFileSync(take, `audio ${beat}`);
    if (options.skipReceipt !== beat) writeFileSync(`${take}.take.json`, JSON.stringify({ version: 1, sha256: "x" }));
    writeFileSync(
      path.join(root, dir, "voiceover", `${beat}.words.json`),
      JSON.stringify({ words: list.map(([text, start, end]) => ({ text, start, end })) }),
    );
  }
}

const measure = (file: string) => (file.endsWith("hook.mp3") ? 1.8 : 1.2);

function writeDirection(film: Film, value = direction()) {
  writeFileSync(path.join(film.pipeline, "narrator-direction.json"), JSON.stringify(value, null, 2));
}

test("narration:check measures takes, writes caption words and fails on a missing receipt", (t) => {
  const film = setup(t);
  mkdirSync(film.pipeline, { recursive: true });
  writeFileSync(path.join(film.pipeline, "script.json"), JSON.stringify(script));
  writeDirection(film);
  const dir = path.relative(film.root, film.dir);

  writeTakes(film.root, dir, { skipReceipt: "cta" });
  const missing = measureNarration({ root: film.root, projectId: ID, measure });
  assert.equal(missing.narration, undefined);
  assert.match(missing.problems.join(), /cta: .*cta\.mp3\.take\.json missing/);

  writeTakes(film.root, dir);
  const { narration, problems } = measureNarration({ root: film.root, projectId: ID, measure });
  assert.deepEqual(problems, []);
  assert.deepEqual(
    narration!.beats.map((beat) => [beat.beatId, beat.durationSec, beat.startSec]),
    [
      ["hook", 1.8, 0],
      ["cta", 1.2, 1.8],
    ],
  );
  assert.equal(narration!.totalSec, 3);
  const captions = JSON.parse(readFileSync(path.join(film.dir, "voiceover/hook.words.edited.json"), "utf8"));
  assert.equal(captions.words.length, 4);
  assert.ok(captions.words.some((word: { text: string; emphasis: boolean }) => word.emphasis));
  assert.deepEqual(narrationFileProblems(film.root, narration!, script), []);

  writeFileSync(path.join(film.dir, "voiceover/hook.mp3"), "another take");
  assert.match(narrationFileProblems(film.root, narration!, script).join(), /hook.mp3 changed/);
  writeDirection(film, direction({ pacingNote: "slower" }));
  assert.match(narrationFileProblems(film.root, narration!, script).join(), /another direction/);
});

test("word timings past the take's length are refused", (t) => {
  const film = setup(t);
  writeFileSync(path.join(film.pipeline, "script.json"), JSON.stringify(script));
  writeDirection(film);
  writeTakes(film.root, path.relative(film.root, film.dir));
  const short = measureNarration({ root: film.root, projectId: ID, measure: () => 0.5, write: false });
  assert.match(short.problems.join(), /run past the take/);
});

/** An explainer brought to the narration step: intake to the approved script. */
function toNarration(film: Film) {
  film.place("brief.json");
  film.edit("brief.json", (brief) => {
    brief["filmType"] = "explainer";
  });
  film.seal("intake");
  film.approve("intake");
  film.place("product-truth.json");
  film.seal("truth");
  film.place("film-targets.json");
  film.seal("reference");
  toConceptApproved(film, ID);
  mkdirSync(path.join(film.dir, "music"), { recursive: true });
  copyFileSync(path.join(FIXTURES, "track.wav"), path.join(film.dir, "music/track.wav"));
  film.place("music-shortlist.json", "music-decision.json");
  film.seal("music");
  film.approve("music");
  film.place("audio-map.json");
  film.seal("audio-map");
  toScriptPicked(film, ID);
  film.seal("script");
  film.approve("script");
}

test("generate:voiceover quotes a film's directed takes offline, one plan per spoken beat", (t) => {
  const film = setup(t);
  writeFileSync(path.join(film.pipeline, "script.json"), JSON.stringify(script));
  writeDirection(film);
  const run = spawnSync(
    process.execPath,
    [TSX, path.join(REPO, "scripts/generate-voiceover.ts"), "--project", ID, "--directed", "--dry-run"],
    {
      cwd: film.root,
      encoding: "utf8",
      env: { ...process.env, AGENTBROS_NO_DOTENV: "1", ELEVENLABS_API_KEY: "", AGENTBROS_STEP_GUARD: "off" },
    },
  );
  const result = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
  assert.equal(result.ok, true, run.stdout + run.stderr);
  assert.equal(result.metadata.directed, true);
  assert.equal(result.metadata.plans.length, 2);
  assert.ok(result.metadata.plans.every((plan: { state: string }) => plan.state === "planned"));
});

test("a rejected paid take stays; the provider refuses its path, a raised take gets a new one", (t) => {
  const film = setup(t);
  writeFileSync(path.join(film.pipeline, "script.json"), JSON.stringify(script));
  const voiceover = path.join(film.dir, "voiceover");
  mkdirSync(voiceover, { recursive: true });
  // Take 1 exists from an earlier direction, with its receipt (another operation, another text).
  for (const beat of script.beats) {
    writeFileSync(path.join(voiceover, `${beat.id}.mp3`), `old ${beat.id}`);
    writeFileSync(
      path.join(voiceover, `${beat.id}.mp3.take.json`),
      JSON.stringify({
        operationId: "el:tts:old",
        inputHash: "0".repeat(64),
        sha256: "1".repeat(64),
        request: { text: "old" },
      }),
    );
    writeFileSync(
      path.join(voiceover, `${beat.id}.words.json`),
      JSON.stringify({ words: [{ text: "old", start: 0, end: 0.5 }] }),
    );
  }
  const dryRun = (...args: string[]) => {
    const run = spawnSync(
      process.execPath,
      [TSX, path.join(REPO, "scripts/generate-voiceover.ts"), "--project", ID, "--directed", "--dry-run", ...args],
      {
        cwd: film.root,
        encoding: "utf8",
        env: { ...process.env, AGENTBROS_NO_DOTENV: "1", ELEVENLABS_API_KEY: "", AGENTBROS_STEP_GUARD: "off" },
      },
    );
    return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
  };
  writeDirection(film);
  const sameName = dryRun();
  assert.equal(sameName.ok, false, "a take is never overwritten");
  assert.match(JSON.stringify(sameName), /Existing take does not match/);
  assert.match(
    measureNarration({ root: film.root, projectId: ID, measure, write: false }).problems.join(),
    /voices another direction's text: raise the direction's take to 2/,
  );

  writeDirection(film, direction({ take: 2 }));
  const retake = dryRun("--take", "2");
  assert.equal(retake.ok, true, JSON.stringify(retake));
  assert.ok(
    retake.metadata.plans.every((plan: { request: { output: string } }) => /\.take-2\.mp3$/.test(plan.request.output)),
  );
  // Same direction, same take: the same operation, so an ambiguous paid run resumes rather than duplicates.
  assert.deepEqual(
    dryRun("--take", "2").metadata.plans.map((plan: { operationId: string }) => plan.operationId),
    retake.metadata.plans.map((plan: { operationId: string }) => plan.operationId),
  );
  assert.match(
    measureNarration({ root: film.root, projectId: ID, measure, write: false }).problems.join(),
    /hook\.take-2\.mp3/,
  );
  assert.equal(dryRun("--take", "0").error, "INVALID_INPUT");
});

test("local route: system-voice takes from the voiceover:local result, words from speech:local transcripts", (t) => {
  const film = setup(t);
  writeFileSync(path.join(film.pipeline, "script.json"), JSON.stringify(script));
  writeDirection(film, direction({ route: "local", maxCostUsd: undefined }));
  const result = path.join(film.pipeline, "narration-local.json");
  const assets = `${result}.assets/op-1`;
  mkdirSync(assets, { recursive: true });
  const words: Record<string, string[]> = { hook: ["Words", "carry", "the", "film."], cta: ["Start", "today."] };
  for (const [beat, list] of Object.entries(words)) {
    writeFileSync(path.join(assets, `${beat}.mp3`), `local ${beat}`);
    // Both transcript names are accepted: <take base>.transcript.json and <take>.mp3.transcript.json.
    const transcript = beat === "hook" ? `${beat}.transcript.json` : `${beat}.mp3.transcript.json`;
    writeFileSync(
      path.join(assets, transcript),
      JSON.stringify({
        words: list.map((text, index) => ({ text, kind: "word", startSec: index * 0.3, endSec: index * 0.3 + 0.2 })),
      }),
    );
  }
  writeFileSync(
    result,
    JSON.stringify({
      task: "speech.synthesise",
      result: { units: Object.keys(words).map((id) => ({ id, file: path.join(assets, `${id}.mp3`) })) },
    }),
  );
  const missing = measureNarration({ root: film.root, projectId: ID, measure, write: false });
  assert.match(missing.problems.join(), /narration-local\.json\.receipt\.json missing/);
  writeFileSync(`${result}.receipt.json`, "{}");
  const { narration, problems } = measureNarration({ root: film.root, projectId: ID, measure });
  assert.deepEqual(problems, []);
  assert.equal(narration!.route, "local");
  assert.ok(narration!.beats[1]!.words.endsWith("cta.mp3.transcript.json"));
  assert.equal(narration!.beats[0]!.wordCount, 4);
});

test("the sound brief's lease never admits generate:voiceover", (t) => {
  const film = setup(t);
  toNarration(film);
  const { prompt } = renderBrief(film.project(), "sound");
  assert.ok(!proseAliases(prompt).includes("generate:voiceover"));
  assert.ok(!leaseAllow("sound", "explainer", undefined, proseAliases(prompt)).includes("generate:voiceover"));
});

test("explainer: the user approves the direction, the takes are made with spend allowed, then approved by ear", (t) => {
  const film = setup(t);
  toNarration(film);
  assert.equal(nextAction(film.project()).step, "narration");
  assert.equal(film.status("narration"), "ready");

  const fixtureScript = ScriptSchema.parse(JSON.parse(readFileSync(path.join(film.pipeline, "script.json"), "utf8")));
  writeDirection(
    film,
    direction({
      beats: fixtureScript.beats.map((beat) => ({ beatId: beat.id, directedText: beat.text, emphasisWords: [] })),
    }),
  );
  film.seal("narration");
  assert.equal(film.status("narration"), "awaiting-gate");
  const before = nextAction(film.project());
  assert.equal(filmLeaseFor(film.project(), before, "film:next")!.paidAllowed, false);

  film.approve("narration");
  assert.equal(film.status("narration"), "failing");
  const reasons = deriveChain(film.project()).steps.find((step) => step.id === "narration")!.reasons;
  assert.match(reasons.join(), /generate:voiceover --directed/);
  const back = nextAction(film.project());
  assert.equal(back.step, "narration");
  assert.equal(filmLeaseFor(film.project(), back, "film:next")!.paidAllowed, true);

  const dir = path.relative(film.root, film.dir);
  const makeTakes = (take: number, prefix = "") => {
    mkdirSync(path.join(film.root, dir, "voiceover"), { recursive: true });
    for (const beat of fixtureScript.beats) {
      const file = path.join(film.root, dir, "voiceover", takeFileName(beat.id, take));
      writeFileSync(file, `audio ${beat.id} take ${take}`);
      writeFileSync(`${file}.take.json`, JSON.stringify({ request: { text: `${prefix}${beat.text}` } }));
      writeFileSync(
        file.replace(/\.mp3$/, ".words.json"),
        JSON.stringify({
          words: beat.text.split(/\s+/).map((text, index) => ({ text, start: index * 0.3, end: index * 0.3 + 0.25 })),
        }),
      );
    }
  };
  makeTakes(1);
  assert.deepEqual(measureNarration({ root: film.root, projectId: ID, measure: () => 4 }).problems, []);
  assert.equal(film.status("narration"), "unsealed");
  film.seal("narration");
  assert.equal(film.status("narration"), "awaiting-gate");

  // The user rejects take 1: the revised direction raises its take, is asked first, and only then may be paid for.
  writeDirection(
    film,
    direction({
      take: 2,
      beats: fixtureScript.beats.map((beat) => ({ beatId: beat.id, directedText: `[soft] ${beat.text}` })),
    }),
  );
  assert.equal(film.status("narration"), "unsealed");
  film.seal("narration");
  assert.equal(film.status("narration"), "awaiting-gate", "the revised direction is the user's to approve");
  assert.equal(filmLeaseFor(film.project(), nextAction(film.project()), "film:next")!.paidAllowed, false);
  film.approve("narration");
  assert.match(
    deriveChain(film.project())
      .steps.find((step) => step.id === "narration")!
      .reasons.join(),
    /make take 2 with generate:voiceover --directed --take 2/,
  );
  assert.equal(filmLeaseFor(film.project(), nextAction(film.project()), "film:next")!.paidAllowed, true);
  makeTakes(2, "[soft] ");
  const measured = measureNarration({ root: film.root, projectId: ID, measure: () => 4 });
  assert.deepEqual(measured.problems, []);
  assert.equal(measured.narration!.take, 2);
  assert.ok(measured.narration!.beats.every((beat) => beat.file.endsWith(".take-2.mp3")));
  film.seal("narration");
  assert.equal(film.status("narration"), "awaiting-gate");
  film.approve("narration");
  assert.equal(film.status("narration"), "done");
  assert.notEqual(nextAction(film.project()).step, "narration");
});

test("a film without a voice skips narration with its reason", (t) => {
  const film = setup(t);
  toNarration(film);
  skipStep(film.project(), "narration", "The script has voiceoverEnabled false.");
  assert.notEqual(nextAction(film.project()).step, "narration");
});
