/** The swaps, captionStyle and shorts pre-answers: refused when invalid, applied under a policy, ignored without one. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cli, ID, setup, sha } from "./helpers/film-autonomy";
import { revisePolicy } from "../src/lib/autonomy/policy";
import { preAnswerProblems } from "../src/lib/autonomy/pre-answers";
import { policyBasis } from "../src/lib/film/autonomy";
import { appendDecision, readDecisions } from "../src/lib/film/decisions";
import { decideNext, type FootageState } from "../src/lib/footage/next";
import {
  captionStyleUnderPolicy,
  FOOTAGE_SHORTS_STEP,
  readFootagePolicy,
  type FootagePolicyView,
} from "../src/lib/footage/policy";
import { applyFootagePolicy, PolicyApplyRefusal } from "../src/lib/footage/policy-apply";

const WORDS = "Choose the captions and the shorts yourself, I trust the ranking.";
const HASH = "a".repeat(64);

function scratch(t: test.TestContext, prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A recording's source project with goals only: enough for film:policy, film:revert and the caption pre-answer. */
function footageProject(t: test.TestContext, goals: Record<string, unknown> = { version: 1, goals: ["captions"] }) {
  const root = scratch(t, "policy-footage-");
  const dir = path.join(root, "public/projects/talk");
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  const goalsFile = path.join(dir, "pipeline/footage-goals.json");
  writeFileSync(goalsFile, `${JSON.stringify(goals, null, 2)}\n`);
  return { root, dir, goalsFile };
}

const view = (over: Partial<FootagePolicyView> = {}): FootagePolicyView => ({
  revision: 1,
  grantedBy: WORDS,
  preAnswers: {},
  autoPassShorts: false,
  revokedCaptionStyles: [],
  revokedProposals: [],
  goalsSha256: HASH,
  proposalsSha256: "p".repeat(64),
  seriesRevokedBy: null,
  ...over,
});

/** A footage state at the caption question (no style chosen) or at the shorts approval. */
function footageState(root: string, over: Partial<FootageState> = {}): FootageState {
  return {
    rootDir: root,
    projectId: "talk",
    projectExists: true,
    redirectedFrom: null,
    goalsFile: "public/projects/talk/pipeline/footage-goals.json",
    goals: { version: 1, goals: ["recut", "captions"] },
    goalsSaved: false,
    candidates: [],
    source: {
      file: "public/projects/talk/assets/footage/talk.mp4",
      exists: true,
      width: 1920,
      height: 1080,
      fps: "30/1",
      durationSec: 600,
      problems: [],
    },
    sha256: HASH,
    cameras: [],
    workDir: "public/projects/talk/pipeline/footage/talk",
    transcripts: [
      {
        file: "public/projects/talk/pipeline/footage/talk/transcript.json",
        provider: "elevenlabs",
        model: "scribe_v3",
        verbatim: true,
        diarized: true,
        speakers: ["speaker_0"],
        language: "en",
        valid: true,
        mtimeMs: 1,
        firstWords: [{ speaker: "speaker_0", startSec: 1, endSec: 4 }],
        gluedWords: [],
      },
    ],
    raws: [],
    speechMasks: ["public/projects/talk/pipeline/footage/talk/speech-mask.json"],
    shots: null,
    speakerMap: null,
    multicam: { sync: null, angles: null },
    request: {
      file: "public/projects/talk/pipeline/footage/talk/recut-request.json",
      projectId: "talk-recut",
      formats: ["landscape"],
      mtimeMs: 1,
      planFile: "public/projects/talk/pipeline/footage/talk/recut-plan.md",
      planHash: "b".repeat(64),
      approvedEditHash: "b".repeat(64),
      cuts: [{ id: "C1", kind: "head" }],
    },
    recut: {
      projectId: "talk-recut",
      editHash: "b".repeat(64),
      mtimeMs: 2,
      revision: 1,
      captionStyle: null,
      captionsPlaced: false,
      pictureTrackId: "recording-picture",
      reframed: [],
      renders: { "landscape-clean": { state: "fresh", file: "x" } },
      chapters: true,
    },
    otherRecuts: [],
    takenProjectIds: ["talk", "talk-recut"],
    budget: true,
    openScribe: [],
    shorts: null,
    series: null,
    ...over,
  };
}

const ranked = (proposed: string[]) => ({
  dir: "w/shorts",
  prepared: true,
  candidates: "w/shorts/candidates.json",
  proposals: { file: "w/shorts/proposals.json", projectId: "talk-recut", fresh: true, proposed, others: ["c9"] },
});
const shortsGoals = { version: 1 as const, goals: ["recut" as const, "shorts" as const] };

// --- Validation ---

test("pre-answers that are not an option or do not fit the project are named", () => {
  assert.deepEqual(preAnswerProblems({ captionStyle: "word-box", shorts: 3 }, { route: "footage" }), []);
  assert.match(
    preAnswerProblems({ captionStyle: "neon-glow" }, { route: "footage" }).join(" "),
    /not a caption profile/,
  );
  assert.match(preAnswerProblems({ shorts: 1 }, { route: "footage" }).join(" "), /out of range/);
  assert.match(preAnswerProblems({ shorts: 31 }, { route: "footage" }).join(" "), /out of range/);
  assert.match(preAnswerProblems({ captionStyle: "word-box" }, { route: "film" }).join(" "), /footage:next/);
  assert.deepEqual(preAnswerProblems({ swaps: ["logo"] }, { route: "film", filmType: "replica" }), []);
  assert.match(preAnswerProblems({ swaps: ["logo"] }, { route: "film", filmType: "promo" }).join(" "), /replica/);
  assert.match(
    preAnswerProblems({ swaps: ["Logo", "logo "] }, { route: "film", filmType: "replica" }).join(" "),
    /twice/,
  );
});

test("film:policy refuses an unknown caption style, a shorts count out of range and swaps on a film that is no replica", (t) => {
  const footage = footageProject(t);
  const grant = (...flags: string[]) =>
    cli(
      footage.root,
      "scripts/film-policy.ts",
      "--project",
      "talk",
      "--autonomy",
      "autonomous",
      "--answer",
      WORDS,
      ...flags,
    );
  for (const bad of ["captionStyle=neon-glow", "shorts=1", "shorts=31", "shorts=two", "swaps=logo"]) {
    const refused = grant("--pre-answer", bad);
    assert.equal(refused.status, 1, bad);
    assert.equal(refused.json.error, "INVALID_INPUT", `${bad}: ${refused.json.message}`);
  }
  const granted = grant("--pre-answer", "captionStyle=word-box", "--pre-answer", "shorts=3");
  assert.equal(granted.status, 0, JSON.stringify(granted.json));
  assert.deepEqual(granted.json.metadata.revision.preAnswers, { captionStyle: "word-box", shorts: 3 });

  const film = setup(t);
  const onFilm = cli(
    film.root,
    "scripts/film-policy.ts",
    "--project",
    ID,
    "--autonomy",
    "autonomous",
    "--answer",
    WORDS,
    "--pre-answer",
    "swaps=logo",
  );
  assert.equal(onFilm.json.error, "INVALID_INPUT", String(onFilm.json.message));
  const captionsOnFilm = cli(
    film.root,
    "scripts/film-policy.ts",
    "--project",
    ID,
    "--autonomy",
    "autonomous",
    "--answer",
    WORDS,
    "--pre-answer",
    "captionStyle=word-box",
  );
  assert.equal(captionsOnFilm.json.error, "INVALID_INPUT", String(captionsOnFilm.json.message));
});

// --- captionStyle ---

test("captionStyle: footage:next asks without a policy, runs footage:policy-apply under one, and warns on an invalid one", (t) => {
  const root = scratch(t, "policy-caption-");
  const asked = decideNext(footageState(root));
  assert.equal(asked.action, "ask");
  assert.equal(asked.step, "5-captions");
  assert.equal(asked.policy, undefined);
  assert.equal(asked.advisories, undefined);

  const applied = decideNext(footageState(root, { policy: view({ preAnswers: { captionStyle: "word-box" } }) }));
  assert.equal(applied.action, "run");
  assert.deepEqual(applied.argv![0], [
    "pnpm",
    "footage:policy-apply",
    "--project",
    "talk",
    "--apply",
    "captionStyle",
    "--expect",
    HASH,
  ]);
  assert.deepEqual(applied.policy, { basis: "preAnswer", evidence: { preAnswer: "captionStyle=word-box" } });

  // A policy written before the option set changed: ignored with a warning, the user is asked.
  const stale = decideNext(footageState(root, { policy: view({ preAnswers: { captionStyle: "neon-glow" } }) }));
  assert.equal(stale.action, "ask");
  assert.match(stale.advisories!.join(" "), /captionStyle pre-answer was ignored: captionStyle "neon-glow"/);

  // An interactive policy (not autonomous) is no policy: readFootagePolicy returns nothing.
  const footage = footageProject(t);
  revisePolicy(footage.dir, "talk", { preAnswers: { captionStyle: "word-box" } }, WORDS);
  assert.equal(readFootagePolicy(footage.dir, footage.root, { goals: footage.goalsFile }), undefined);
});

test("captionStyle: footage:policy-apply writes the goals and the ledger; film:revert drops it and the policy never re-picks it", (t) => {
  const footage = footageProject(t);
  assert.throws(() => applyFootagePolicy("talk", "captionStyle", "x", { rootDir: footage.root }), PolicyApplyRefusal);
  revisePolicy(footage.dir, "talk", { autonomy: "autonomous", preAnswers: { captionStyle: "word-box" } }, WORDS);
  assert.throws(
    () => applyFootagePolicy("talk", "captionStyle", "0".repeat(64), { rootDir: footage.root }),
    /changed since footage:next/,
  );
  const goalsSha = sha(readFileSync(footage.goalsFile, "utf8"));
  const { decision } = applyFootagePolicy("talk", "captionStyle", goalsSha, { rootDir: footage.root });
  assert.equal(JSON.parse(readFileSync(footage.goalsFile, "utf8")).captionStyle, "word-box");
  assert.equal(decision.kind, "preAnswer");
  assert.equal(decision.step, "footage-captions");
  assert.deepEqual((decision as { evidence?: unknown }).evidence, {
    preAnswer: "captionStyle=word-box",
    captionStyle: "word-box",
  });
  assert.equal(readDecisions(footage.dir).length, 1);

  const revert = cli(
    footage.root,
    "scripts/film-revert.ts",
    "--project",
    "talk",
    "--decision",
    decision.id,
    "--answer",
    "Not that style, ask me.",
  );
  assert.equal(revert.status, 0, JSON.stringify(revert.json));
  assert.match(revert.json.metadata.undone, /Dropped captionStyle word-box/);
  assert.equal(JSON.parse(readFileSync(footage.goalsFile, "utf8")).captionStyle, undefined);
  const after = readFootagePolicy(footage.dir, footage.root, { goals: footage.goalsFile });
  const choice = captionStyleUnderPolicy(after);
  assert.equal(choice.style, undefined);
  assert.match(choice.warning!, /revoked the policy's word-box captions/);
});

// --- shorts ---

test("shorts: the top ranked clips under shorts=n, every proposed clip under auto-pass, the user's ask otherwise", (t) => {
  const root = scratch(t, "policy-shorts-");
  const base = { goals: shortsGoals, shorts: ranked(["c1", "c2", "c3"]) };
  const asked = decideNext(footageState(root, base));
  assert.equal(asked.action, "ask");
  assert.equal(asked.policy, undefined);

  const two = decideNext(footageState(root, { ...base, policy: view({ preAnswers: { shorts: 2 } }) }));
  assert.equal(two.action, "run");
  assert.deepEqual(two.argv![0], [
    "pnpm",
    "footage:policy-apply",
    "--project",
    "talk",
    "--apply",
    "shorts",
    "--expect",
    "p".repeat(64),
  ]);
  assert.match(two.why, /top 2 ranked clips .*c1, c2/);
  assert.deepEqual(two.policy, { basis: "preAnswer", evidence: { preAnswer: "shorts=2" } });

  const all = decideNext(footageState(root, { ...base, policy: view({ autoPassShorts: true }) }));
  assert.equal(all.action, "run");
  assert.match(all.why, /every proposed clip .*c1, c2, c3/);

  // More than were proposed: ignored with a warning (the option set changed), the user is asked.
  const many = decideNext(footageState(root, { ...base, policy: view({ preAnswers: { shorts: 5 } }) }));
  assert.equal(many.action, "ask");
  assert.match(many.advisories!.join(" "), /3 clip\(s\) were proposed above the threshold, the pre-answer approves 5/);

  // Out of range in a hand-edited policy: ignored with a warning.
  const range = decideNext(footageState(root, { ...base, policy: view({ preAnswers: { shorts: 40 } }) }));
  assert.equal(range.action, "ask");
  assert.match(range.advisories!.join(" "), /out of range/);
});

test("shorts: a revoked policy approval asks the user again, and the policy never re-picks on the same proposals", (t) => {
  const root = scratch(t, "policy-shorts-revoke-");
  const series = { file: "s.json", seriesId: "talk-recut-shorts", episodes: 2, created: [] };
  const revoked = decideNext(
    footageState(root, {
      goals: shortsGoals,
      shorts: ranked(["c1", "c2"]),
      series,
      policy: view({
        preAnswers: { shorts: 2 },
        seriesRevokedBy: "d-001",
        revokedProposals: [{ sha256: "p".repeat(64), decision: "d-001" }],
      }),
    }),
  );
  assert.equal(revoked.action, "ask");
  assert.match(revoked.advisories!.join(" "), /revoked the policy's approval of s\.json \(d-001\)/);
  assert.match(revoked.advisories!.join(" "), /revoked the policy's pick on these proposals/);

  // readFootagePolicy finds both from the ledger: the request on disk and the proposals the revoked decision covered.
  const footage = footageProject(t, { version: 1, goals: ["recut", "shorts"] });
  revisePolicy(footage.dir, "talk", { autonomy: "autonomous", preAnswers: { shorts: 2 } }, WORDS);
  const proposals = path.join(footage.dir, "pipeline/footage/talk/shorts/proposals.json");
  const request = path.join(footage.root, "public/projects/talk-recut/pipeline/shorts-series-request.json");
  for (const [file, text] of [
    [proposals, '{"proposals":[]}'],
    [request, '{"episodes":[]}'],
  ] as const) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const decision = appendDecision(footage.dir, {
    step: FOOTAGE_SHORTS_STEP,
    kind: "preAnswer",
    artefactHashes: {
      [path.relative(footage.root, proposals)]: sha('{"proposals":[]}'),
      [path.relative(footage.root, request)]: sha('{"episodes":[]}'),
    },
    evidence: { preAnswer: "shorts=2", ids: "c1,c2" },
    judgeVerdict: "the top 2 ranked clips, as pre-answered",
    policyRevision: 1,
    at: new Date().toISOString(),
  });
  const files = { goals: footage.goalsFile, proposals, series: request };
  assert.equal(readFootagePolicy(footage.dir, footage.root, files)!.seriesRevokedBy, null);
  const revert = cli(
    footage.root,
    "scripts/film-revert.ts",
    "--project",
    "talk",
    "--decision",
    decision.id,
    "--answer",
    "I pick the clips.",
  );
  assert.equal(revert.status, 0, JSON.stringify(revert.json));
  const after = readFootagePolicy(footage.dir, footage.root, files)!;
  assert.equal(after.seriesRevokedBy, decision.id);
  assert.deepEqual(after.revokedProposals, [{ sha256: sha('{"proposals":[]}'), decision: decision.id }]);
});

// --- swaps ---

function replicaContext(t: test.TestContext, swaps: string[]) {
  const root = scratch(t, "policy-swaps-");
  const dir = path.join(root, "public/projects/film");
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  const spec = JSON.stringify({ swaps: swaps.map((what) => ({ what, from: "theirs", to: "ours", why: "brand" })) });
  writeFileSync(path.join(dir, "pipeline/replica-spec.json"), spec);
  writeFileSync(path.join(dir, "pipeline/replica-check.json"), JSON.stringify({ ok: true }));
  return {
    dir,
    spec,
    context: {
      projectDir: dir,
      rootDir: root,
      tokens: { dir: "public/projects/film" },
      steps: [{ id: "replica-spec", status: "awaiting-approval", outputs: {} }],
    },
  };
}

test("swaps: replica-spec passes when the spec swaps exactly what the user pre-answered, and warns when it does not", (t) => {
  const { dir, spec, context } = replicaContext(t, ["Logo", "end card copy"]);
  assert.match(policyBasis(context, "replica-spec").refused!, /no autonomous policy/);
  const interactive = revisePolicy(dir, "film", { preAnswers: { swaps: ["logo", "end card copy"] } }, WORDS).revision;
  assert.match(policyBasis(context, "replica-spec", interactive).refused!, /no autonomous policy/);

  const policy = revisePolicy(dir, "film", { autonomy: "autonomous" }, WORDS).revision;
  const passed = policyBasis(context, "replica-spec", policy);
  assert.equal(passed.basis?.kind, "preAnswer");
  assert.equal(passed.basis?.expect, sha(spec));
  assert.equal(passed.basis?.evidence.swaps, "logo; end card copy");

  const fewer = revisePolicy(dir, "film", { preAnswers: { swaps: ["logo"] } }, WORDS).revision;
  const mismatch = policyBasis(context, "replica-spec", fewer);
  assert.equal(mismatch.basis, undefined);
  assert.match(mismatch.refused!, /not pre-answered: end card copy/);
  assert.match(mismatch.warning!, /swaps pre-answer was ignored/);

  // Even with auto-pass replica-spec, the user's named swaps bind.
  const auto = revisePolicy(dir, "film", { autoPass: ["replica-spec"] }, WORDS).revision;
  assert.equal(policyBasis(context, "replica-spec", auto).basis, undefined);
  const autoOnly = revisePolicy(dir, "film", { dropPreAnswers: ["swaps"] }, undefined).revision;
  assert.equal(policyBasis(context, "replica-spec", autoOnly).basis?.kind, "judge");
});
