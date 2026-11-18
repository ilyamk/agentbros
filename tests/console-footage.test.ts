/**
 * The footage route in the console (RFC 0004 US19, A15, WP12): the projector's footage material from footage:next's
 * state and the files it names (fixtures in tests/fixtures/footage-console/, schema-valid artefacts), the recut plan's
 * markdown parser, and the edit-hash approval: the gate's derived `recut:plan --approve` option, its action plan, and
 * the approval itself, which runs only with the console's grant and only for the plan's current hash.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DecisionSchema, FootageMaterialSchema, ProjectViewSchema } from "../src/types/console";
import { RecordingEditRequestSchema } from "../src/types/workflow-recording-edit";
import { planDecision, pnpmArgv } from "../src/lib/console/actions";
import { consoleGrantEnv } from "../src/lib/console/grant";
import { intentPath, matchesIntent, writeIntent } from "../src/lib/console/intent";
import { createDecisionActions } from "../src/lib/console/apply";
import { decisionExpect } from "../src/lib/console/expect";
import { loadOrCreateSessionToken } from "../src/lib/console/session";
import { buildProjectView } from "../src/lib/console/view/build";
import { projectPaths } from "../src/lib/console/view/files";
import { parseRecutPlan, readFootageMaterial } from "../src/lib/console/view/footage-material";
import { approveEditHash, CONSOLE_REVIEWER } from "../src/lib/footage/approve";
import { readFootageState, sha256File, type FootageState } from "../src/lib/footage/next";
import { CliErrorObject } from "../src/lib/cli";

const FIXTURES = "tests/fixtures/footage-console";
const HASH = "5f0c1d2e3a4b59687a8b9cadbecfd0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7081";
const WORK = "public/projects/talk/pipeline/footage/talk";
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const media = { skip: hasFfmpeg ? false : "needs ffmpeg", timeout: 120000 } as const;

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "console-footage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Copies a fixture into the root, with the source's real sha256 in place of the fixture's zeros. */
function place(root: string, name: string, to: string, sha = "0".repeat(64)) {
  const target = path.join(root, to);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(path.join(FIXTURES, name), "utf8").replaceAll("0".repeat(64), sha));
  return target;
}

function state(root: string, over: Partial<FootageState> = {}): FootageState {
  return {
    rootDir: root,
    projectId: "talk",
    projectExists: true,
    redirectedFrom: null,
    goalsFile: "public/projects/talk/pipeline/footage-goals.json",
    goals: { version: 1, goals: ["recut", "captions", "vertical", "shorts"], captionStyle: "outline-pop" },
    goalsSaved: false,
    candidates: [],
    source: {
      file: "public/projects/talk/assets/footage/talk.mp4",
      exists: true,
      width: 64,
      height: 64,
      fps: "30/1",
      durationSec: 1,
      problems: [],
    },
    sha256: "0".repeat(64),
    cameras: [],
    workDir: WORK,
    transcripts: [
      {
        file: `${WORK}/transcript.json`,
        provider: "elevenlabs",
        model: "scribe_v1",
        verbatim: true,
        diarized: true,
        speakers: ["speaker_0", "speaker_1"],
        language: "en",
        valid: true,
        mtimeMs: 1,
        firstWords: [],
        gluedWords: [{ text: "оченьрядом", atSec: 0.4, why: "splits into очень + рядом" }],
      },
    ],
    raws: [],
    speechMasks: [],
    shots: null,
    speakerMap: null,
    multicam: { sync: `${WORK}/sync.json`, angles: `${WORK}/angles.json` },
    request: {
      file: `${WORK}/recut-request.json`,
      projectId: "talk-recut",
      formats: ["landscape", "vertical"],
      mtimeMs: 1,
      planFile: `${WORK}/recut-plan.md`,
      planHash: HASH,
      approvedEditHash: HASH,
      cuts: [],
    },
    recut: {
      projectId: "talk-recut",
      editHash: HASH,
      mtimeMs: 2,
      revision: 4,
      captionStyle: "outline-pop",
      captionsPlaced: true,
      captionUiZone: "tiktok",
      pictureTrackId: "recording-picture",
      reframed: ["vertical"],
      renders: {
        landscape: { state: "fresh", file: "out/talk-recut/landscape.mp4" },
        "landscape-clean": { state: "missing", file: "out/talk-recut/landscape-clean.mp4" },
        vertical: { state: "stale", file: "out/talk-recut/vertical.mp4" },
        "vertical-clean": { state: "missing", file: "out/talk-recut/vertical-clean.mp4" },
        square: { state: "missing", file: "out/talk-recut/square.mp4" },
        "square-clean": { state: "missing", file: "out/talk-recut/square-clean.mp4" },
      },
      chapters: false,
    },
    otherRecuts: [],
    takenProjectIds: ["talk", "talk-recut"],
    budget: false,
    openScribe: [],
    shorts: {
      dir: `${WORK}/shorts`,
      prepared: true,
      candidates: `${WORK}/shorts/candidates.json`,
      proposals: {
        file: `${WORK}/shorts/proposals.json`,
        projectId: null,
        fresh: true,
        proposed: ["s01"],
        others: ["s02"],
      },
    },
    series: null,
    ...over,
  };
}

function placeAll(root: string) {
  place(root, "transcript.json", `${WORK}/transcript.json`);
  place(root, "recut-request.json", `${WORK}/recut-request.json`);
  place(root, "recut-plan.md", `${WORK}/recut-plan.md`);
  place(root, "proposals.json", `${WORK}/shorts/proposals.json`);
  place(root, "angles.json", `${WORK}/angles.json`);
  place(root, "timeline-edit.json", "public/projects/talk-recut/pipeline/timeline-edit.json");
  mkdirSync(path.join(root, "public/projects/talk/assets/footage"), { recursive: true });
  writeFileSync(path.join(root, "public/projects/talk/assets/footage/talk.mp4"), "not a real video");
}

test("parseRecutPlan reads cuts, kinds, spans, words, reasons, durations and protected statements", () => {
  const parsed = parseRecutPlan(readFileSync(path.join(FIXTURES, "recut-plan.md"), "utf8"));
  assert.deepEqual(
    parsed.cuts.map((cut) => [cut.id, cut.kind, cut.startSec, cut.endSec]),
    [
      ["C1", "head", 0, 0.1],
      ["C2", "filler", 0.3, 0.4],
      ["C3", "retake", 0.6, 0.7],
      ["C4", "tail", 0.9, 1],
    ],
  );
  assert.equal(parsed.cuts[1]!.text, "…so ~~um~~ today we…");
  assert.equal(parsed.cuts[1]!.reason, "marked filler in a verbatim transcript");
  assert.deepEqual([parsed.sourceSec, parsed.outputSec, parsed.removedSec], [1, 0.7, 0.3]);
  assert.equal(parsed.protectedCount, 1);
  // Unknown kinds and garbage are skipped, never thrown on.
  assert.deepEqual(parseRecutPlan("- [ ] **C1** warp · 00:00.000–00:01.000\n# nothing").cuts, []);
});

test("readFootageMaterial: every section from footage:next's state and the files it names", (t) => {
  const root = scratch(t);
  placeAll(root);
  const advisories: string[] = [];
  const material = readFootageMaterial(projectPaths(root, "talk"), state(root), advisories);
  assert.ok(material);
  FootageMaterialSchema.parse(material);
  assert.deepEqual(advisories, []);

  assert.deepEqual(material.source?.media, {
    path: "assets/footage/talk.mp4",
    kind: "video",
    durationSec: 1,
    width: 64,
    height: 64,
    fps: 30,
  });
  const transcript = material.transcript!;
  assert.equal(transcript.wordCount, 9);
  assert.equal(transcript.truncated, false);
  assert.deepEqual(transcript.words[1], { text: "um", start: 0.2, end: 0.28, speaker: "speaker_0", kind: "filler" });
  assert.deepEqual(transcript.speakers, [
    { id: "speaker_0", label: "Host", words: 5 },
    { id: "speaker_1", words: 4 },
  ]);
  assert.equal(transcript.glued[0]!.text, "оченьрядом");

  const plan = material.plan!;
  assert.equal(plan.recutProject, "talk-recut");
  assert.equal(plan.editHash, HASH);
  assert.equal(plan.approvedEditHash, HASH);
  assert.deepEqual(plan.formats, ["landscape", "vertical"]);
  assert.equal(plan.cuts.length, 4);
  assert.deepEqual(plan.keep, [
    { startSec: 0.1, endSec: 0.3 },
    { startSec: 0.4, endSec: 0.9 },
  ]);
  assert.deepEqual(plan.doc, { path: "pipeline/footage/talk/recut-plan.md", kind: "document", label: "recut-plan.md" });

  assert.deepEqual(material.captions, {
    style: "outline-pop",
    wanted: "outline-pop",
    placed: true,
    uiZone: "tiktok",
    choices: material.captions!.choices,
  });
  assert.ok(material.captions!.choices.includes("karaoke"));

  assert.deepEqual(
    material.shorts!.items.map((item) => [item.id, item.proposed, item.score, item.rank ?? null, item.reason ?? null]),
    [
      ["s01", true, 82, 1, null],
      ["s02", false, 41, null, "below-threshold"],
    ],
  );
  assert.deepEqual(material.shorts!.items[0]!.axes, { hook: 8, value: 9 });
  assert.equal(material.shorts!.threshold, 60);

  assert.deepEqual(material.cameras, {
    synced: true,
    method: "mic-energy",
    angles: ["wide", "host"],
    segments: [
      { startSec: 0, endSec: 0.5, angle: "wide", reason: "fallback-wide" },
      { startSec: 0.5, endSec: 1, angle: "host", speaker: "speaker_0", reason: "speaker" },
    ],
  });
  assert.deepEqual(material.reframe, {
    formats: [
      {
        format: "vertical",
        reframed: true,
        fixed: 1,
        tracked: 1,
        points: [
          { frame: 0, x: 0.5, y: 0.4 },
          { frame: 10, x: 0.6, y: 0.4 },
          { frame: 20, x: 0.4, y: 0.45 },
        ],
      },
    ],
  });
  // Renders belong to the recut project; a missing clean render is left out, a wanted format's missing render stays.
  assert.deepEqual(
    material.renders!.map((render) => [
      render.name,
      render.state,
      render.project,
      render.media?.path ?? null,
      render.media?.stale ?? null,
    ]),
    [
      ["landscape", "fresh", "talk-recut", "landscape.mp4", null],
      ["vertical", "stale", "talk-recut", "vertical.mp4", true],
    ],
  );
  assert.deepEqual(material.recut, { project: "talk-recut", revision: 4, editHash: HASH, chapters: false });
});

test("readFootageMaterial degrades: a corrupt file drops its section with an advisory; nothing yet is undefined", (t) => {
  const root = scratch(t);
  placeAll(root);
  writeFileSync(path.join(root, WORK, "transcript.json"), "{torn");
  writeFileSync(path.join(root, WORK, "angles.json"), JSON.stringify({ segments: "no" }));
  const advisories: string[] = [];
  const material = readFootageMaterial(projectPaths(root, "talk"), state(root), advisories)!;
  assert.equal(material.transcript, undefined);
  assert.deepEqual(material.cameras?.segments, []);
  assert.ok(material.plan && material.shorts && material.reframe);
  assert.ok(advisories.some((line) => line.includes("transcript.json")));
  assert.ok(advisories.some((line) => line.includes("angles.json")));

  const empty = state(root, {
    source: null,
    transcripts: [],
    request: null,
    recut: null,
    shorts: null,
    goals: null,
    multicam: { sync: null, angles: null },
  });
  assert.equal(readFootageMaterial(projectPaths(root, "talk"), empty, []), undefined);
});

test("a long transcript is capped at 600 words in the view and marked truncated", (t) => {
  const root = scratch(t);
  placeAll(root);
  const transcript = JSON.parse(readFileSync(path.join(root, WORK, "transcript.json"), "utf8"));
  transcript.words = Array.from({ length: 1500 }, (_, i) => ({
    id: `w${i}`,
    text: `word${i}`,
    kind: "word",
    startSec: i * 0.3,
    endSec: i * 0.3 + 0.2,
    speaker: "speaker_0",
    channel: null,
    confidence: null,
  }));
  writeFileSync(path.join(root, WORK, "transcript.json"), JSON.stringify(transcript));
  const material = readFootageMaterial(projectPaths(root, "talk"), state(root), [])!;
  assert.equal(material.transcript!.words.length, 600);
  assert.equal(material.transcript!.wordCount, 1500);
  assert.equal(material.transcript!.truncated, true);
});

/** A real footage project: a tiny recording, its transcript, recut request and plan (the plan waits for approval). */
function footageProject(root: string): string {
  const source = path.join(root, "public/projects/talk/assets/footage/talk.mp4");
  mkdirSync(path.dirname(source), { recursive: true });
  const run = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x64:r=30:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      source,
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const sha = sha256File(source);
  mkdirSync(path.join(root, "public/projects/talk/pipeline"), { recursive: true });
  writeFileSync(
    path.join(root, "public/projects/talk/pipeline/footage-goals.json"),
    JSON.stringify({ version: 1, goals: ["recut", "captions"], formats: ["landscape", "vertical"] }),
  );
  place(root, "transcript.json", `${WORK}/transcript.json`, sha);
  place(root, "recut-request.json", `${WORK}/recut-request.json`, sha);
  place(root, "recut-plan.md", `${WORK}/recut-plan.md`, sha);
  // speech:local's VAD mask beside the transcript (only its engine and source are read here).
  writeFileSync(
    path.join(root, WORK, "speech-mask.json"),
    JSON.stringify({
      version: 1,
      source: { file: "public/projects/talk/assets/footage/talk.mp4", sha256: sha },
      engine: { provider: "silero-vad" },
      segments: [],
    }),
  );
  // footage:shots' shot list (the vertical crop resets at each shot).
  writeFileSync(
    path.join(root, WORK, "shots.json"),
    JSON.stringify({
      schemaVersion: 1,
      detector: "scene",
      source: { path: "public/projects/talk/assets/footage/talk.mp4" },
      shots: [],
    }),
  );
  return sha;
}

const DECISION = "dec-footage-approve";
const GRANTED_ARGV = (words: string, decision = DECISION) => [
  "--project",
  "talk",
  "--approve",
  HASH,
  `--answer=${words}`,
  `--decision=${decision}`,
];
/** What the console server writes just before it spawns the approval (apply.ts). */
const intend = (root: string, args: readonly string[], decisionId = DECISION, now = new Date()) =>
  writeIntent(root, { project: "talk", decisionId, alias: "recut:plan", args, now });

test("the projector shows a recording's material and an edit-hash gate the console can approve", media, (t) => {
  const root = scratch(t);
  footageProject(root);
  const view = ProjectViewSchema.parse(buildProjectView(root, "talk", { now: Date.parse("2026-11-17T12:00:00Z") }));
  assert.equal(view.project.route, "footage");
  assert.equal(view.footage?.plan?.editHash, HASH);
  assert.equal(view.footage?.plan?.approvedEditHash, undefined);
  assert.equal(view.footage?.transcript?.wordCount, 9);
  assert.equal(view.footage?.source?.media?.path, "assets/footage/talk.mp4");
  assert.equal(view.current?.step, "4-approve");
  const gate = DecisionSchema.parse(view.waiting.find((decision) => decision.step === "4-approve"));
  assert.deepEqual(gate.options?.[0]?.argv, [
    "pnpm",
    "recut:plan",
    "--project",
    "talk",
    "--approve",
    HASH,
    "--answer",
    "<the user's words>",
  ]);
  assert.match(gate.summary ?? "", /watched the whole source/);

  // The console's action plan: the derived option with the user's words as one --answer token.
  const plan = planDecision({ project: "talk", route: "footage", decision: gate, request: { answer: "Looks right." } });
  // It names its decision, so the server's intent (written before the spawn) binds this exact argv.
  assert.deepEqual(pnpmArgv(plan.commands[0]!), ["pnpm", "recut:plan", ...GRANTED_ARGV("Looks right.", gate.id)]);
  // A footage gate without a derived command is answered in the chat, never sent to film:approve.
  assert.throws(
    () =>
      planDecision({
        project: "talk",
        route: "footage",
        decision: { ...gate, options: undefined },
        request: { answer: "Yes." },
      }),
    /answer it in the chat/,
  );
  // Asking for changes or another round of a footage step never runs the film chain's feedback.
  for (const choice of ["changes", "another-round"])
    assert.throws(
      () =>
        planDecision({
          project: "talk",
          route: "footage",
          decision: gate,
          request: { answer: "Drop C3.", choice },
        }),
      /answer it in the chat/,
      choice,
    );
});

test("approveEditHash: only with the console's grant, only for the current hash, with the user's words", media, (t) => {
  const root = scratch(t);
  footageProject(root);
  loadOrCreateSessionToken(root);
  const now = new Date();
  const argv = GRANTED_ARGV("Approved, the cuts keep the meaning.");
  const input = {
    rootDir: root,
    project: "talk",
    editHash: HASH,
    answer: "Approved, the cuts keep the meaning.",
    decision: DECISION,
    argv,
    now,
  };
  const requestFile = path.join(root, WORK, "recut-request.json");
  const before = readFileSync(requestFile, "utf8");
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof CliErrorObject ? error.code : String(error);
    }
    return "ok";
  };

  assert.equal(
    code(() => approveEditHash({ ...input, env: {} })),
    "VALIDATION",
    "no grant: an agent cannot approve",
  );
  const env = consoleGrantEnv(root, "talk", argv, now);
  assert.equal(
    code(() => approveEditHash({ ...input, argv: GRANTED_ARGV("other words"), env })),
    "VALIDATION",
    "a grant for other argv",
  );
  assert.equal(
    code(() => approveEditHash({ ...input, answer: "<the user's words>", env })),
    "INVALID_INPUT",
  );
  const noIntent = () => {
    try {
      approveEditHash({ ...input, env });
    } catch (error) {
      return (error as CliErrorObject).message;
    }
    return "ok";
  };
  assert.match(noIntent(), /no console intent/, "a grant without the server's intent: a forged grant does not approve");
  intend(root, GRANTED_ARGV("other words"));
  assert.match(noIntent(), /no console intent/, "an intent for another argv");
  intend(root, argv, "dec-other");
  assert.match(noIntent(), /no console intent/, "an intent for another decision");
  intend(root, argv, DECISION, new Date(now.getTime() - 120_000));
  assert.match(noIntent(), /no console intent/, "an old intent");
  const staleArgv = ["--project", "talk", "--approve", "e".repeat(64), "--answer=ok", `--decision=${DECISION}`];
  intend(root, staleArgv);
  assert.equal(
    code(() =>
      approveEditHash({
        ...input,
        editHash: "e".repeat(64),
        answer: "ok",
        argv: staleArgv,
        env: consoleGrantEnv(root, "talk", staleArgv, now),
      }),
    ),
    "VALIDATION",
    "a hash the plan no longer shows",
  );
  assert.equal(readFileSync(requestFile, "utf8"), before, "nothing written by a refusal");

  intend(root, argv);
  const result = approveEditHash({ ...input, env });
  assert.equal(result.unchanged, false);
  assert.equal(existsSync(intentPath(root, "talk", DECISION)), false, "the intent is consumed");
  assert.match(noIntent(), /no console intent/, "and does not approve twice");
  const written = RecordingEditRequestSchema.parse(JSON.parse(readFileSync(requestFile, "utf8")));
  assert.deepEqual(written.review, {
    reviewer: CONSOLE_REVIEWER,
    reviewedAt: now.toISOString(),
    approvedEditHash: HASH,
    meaningPreserved: true,
  });
  assert.equal(readFootageState("talk", { rootDir: root, save: false }).request?.approvedEditHash, HASH);
  intend(root, argv);
  assert.equal(approveEditHash({ ...input, env }).unchanged, true, "a repeated approval writes nothing");
});

test("recut:plan --approve as the console spawns it: one JSON line, refused without the grant", media, (t) => {
  const root = scratch(t);
  footageProject(root);
  loadOrCreateSessionToken(root);
  const tsx = pathToFileURL(createRequire(path.resolve("package.json")).resolve("tsx")).href;
  const script = path.resolve("scripts/recut-plan.ts");
  const argv = GRANTED_ARGV("Yes, approve it.");
  const base = { ...process.env, AGENTBROS_EVENTS: "off", AGENTBROS_CONSOLE: "off", AGENTBROS_HOOKS: "off" };
  const runCli = (env: NodeJS.ProcessEnv) => {
    const child = spawnSync(process.execPath, ["--import", tsx, script, ...argv], { cwd: root, env, encoding: "utf8" });
    const lines = child.stdout.trim().split("\n");
    assert.equal(lines.length, 1, child.stdout + child.stderr);
    return { status: child.status, envelope: JSON.parse(lines[0]!) };
  };
  const refused = runCli(base);
  assert.equal(refused.status, 1);
  assert.equal(refused.envelope.ok, false);
  assert.equal(refused.envelope.error, "VALIDATION");
  const forged = runCli({ ...base, ...consoleGrantEnv(root, "talk", argv) });
  assert.equal(forged.envelope.error, "VALIDATION", "a grant without the server's intent");
  assert.match(forged.envelope.message, /no console intent/);
  intend(root, argv);
  const applied = runCli({ ...base, ...consoleGrantEnv(root, "talk", argv) });
  assert.equal(applied.status, 0, JSON.stringify(applied.envelope));
  assert.equal(applied.envelope.metadata.approvedEditHash, HASH);
  assert.equal(applied.envelope.metadata.reviewer, CONSOLE_REVIEWER);
});

test("apply: the console writes the intent before it spawns the approval and removes it after", async (t) => {
  const root = scratch(t);
  mkdirSync(path.join(root, "public/projects/talk/pipeline"), { recursive: true });
  const fixture = ProjectViewSchema.parse(JSON.parse(readFileSync("tests/fixtures/console/view-footage.json", "utf8")))
    .waiting[0]!;
  const gate = DecisionSchema.parse({ ...fixture, project: "talk" });
  const seen: { args: readonly string[]; intent: boolean }[] = [];
  const actions = createDecisionActions(root, {
    deriveWaiting: async () => [gate],
    spawnCli: async (request) => {
      const decision = String(request.args.find((arg) => arg.startsWith("--decision="))).slice("--decision=".length);
      seen.push({
        args: request.args,
        intent: matchesIntent({
          rootDir: root,
          project: "talk",
          decisionId: decision,
          alias: "recut:plan",
          args: request.args,
        }),
      });
      return { envelope: { ok: true, outputs: [], metadata: {}, elapsedMs: 1 }, exitCode: 0 };
    },
    routeOf: () => "footage",
    stepExpects: () => undefined,
    env: { ...process.env, AGENTBROS_EVENTS: "off" },
  });
  const reply = await actions.decide("talk", {
    decisionId: gate.id,
    choice: "approve",
    answer: "Approved.",
    expect: gate.expect ?? decisionExpect(gate),
  });
  assert.equal(reply.ok, true);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.args.includes(`--decision=${gate.id}`));
  assert.equal(seen[0]!.intent, true, "the intent matched the spawned argv while the child ran");
  assert.equal(existsSync(intentPath(root, "talk", gate.id)), false, "removed after the child exits");
});
