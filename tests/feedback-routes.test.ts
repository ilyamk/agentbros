import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { userWordsProblem } from "../src/lib/cli/user-words";
import {
  declineFootageFeedback,
  FOOTAGE_ASPECT_ROUTES,
  FOOTAGE_TARGETS,
  footageFeedbackNext,
  planFootageFeedback,
  routeFootageAspect,
  writeFootageFeedback,
} from "../src/lib/feedback/footage";
import { planCampaignFeedback, writeCampaignFeedback } from "../src/lib/feedback/campaign";
import { listFeedback, readOpenFeedback } from "../src/lib/feedback/store";
import { decideNext, type FootageState } from "../src/lib/footage/next";
import { ASPECTS } from "../src/types/feedback";
import { ProjectConfigSchema } from "../src/types/video";
import { initCampaign } from "../src/lib/campaigns/production/store";
import { runCampaignQueue } from "../src/lib/campaigns/production/queue";
import { campaignInputIdentity } from "../src/lib/campaigns/production/execute";
import { campaignBrief } from "../src/lib/campaigns/production/service";
import { pinFile } from "../src/lib/campaigns/production/files";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");

function scratch(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- The user's own words ---

test("user words: placeholders, narration and echoed hints are refused; short real answers pass", () => {
  for (const placeholder of [
    "",
    "   ",
    "<the user's words>",
    "<the user's own words>",
    '"<the user\'s words>"',
    "THE USER'S WORDS",
    "the user’s words",
    "USER_WORDS",
    "TODO",
    "todo: ask",
    "TBD",
    "<answer>",
    "yes <the user's words>",
    "The user approved.",
    "Approved by the user",
    "user said yes",
  ])
    assert.ok(userWordsProblem(placeholder), `refused: ${JSON.stringify(placeholder)}`);
  const hint = "Is this the film you want: its goal, audience, length and format?";
  assert.match(userWordsProblem(hint, { hints: [hint] }) ?? "", /repeats the hint/);
  assert.match(userWordsProblem("its goal, audience, length and format", { hints: [hint] }) ?? "", /repeats/);
  for (const answer of ["yes", "ok", "да", "approved", "go", "yes, that audience", "давай второй трек", "<3 love it"])
    assert.equal(userWordsProblem(answer, { hints: [hint] }), undefined, `passes: ${answer}`);
});

// --- Footage ---

const HASH = "a".repeat(64);
const PLAN = "b".repeat(64);

function footageState(rootDir: string, over: Partial<FootageState> = {}): FootageState {
  return {
    rootDir,
    projectId: "talk",
    projectExists: true,
    redirectedFrom: null,
    goalsFile: "public/projects/talk/pipeline/footage-goals.json",
    goals: { version: 1, goals: ["recut", "captions", "vertical"], captionStyle: "outline-pop" },
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
    } as FootageState["source"],
    sha256: HASH,
    cameras: [],
    workDir: "public/projects/talk/pipeline/footage/talk",
    transcripts: [
      {
        file: "public/projects/talk/pipeline/footage/talk/transcript.json",
        provider: "elevenlabs",
        model: "scribe_v3",
        verbatim: true,
        diarized: false,
        speakers: [],
        language: "en",
        valid: true,
        mtimeMs: 1,
        firstWords: [],
        gluedWords: [],
      },
    ],
    raws: [],
    speechMasks: ["public/projects/talk/pipeline/footage/talk/speech-mask.json"],
    shots: "public/projects/talk/pipeline/footage/talk/shots/shots.json",
    speakerMap: null,
    multicam: { sync: null, angles: null },
    request: {
      file: "public/projects/talk/pipeline/footage/talk/recut-request.json",
      projectId: "talk-recut",
      formats: ["landscape", "vertical"],
      mtimeMs: 1,
      planFile: "public/projects/talk/pipeline/footage/talk/recut-plan.md",
      planHash: PLAN,
      approvedEditHash: PLAN,
      cuts: [{ id: "C1", kind: "pause" }],
    },
    recut: {
      projectId: "talk-recut",
      editHash: PLAN,
      mtimeMs: 2,
      revision: 3,
      captionStyle: "outline-pop",
      captionsPlaced: true,
      pictureTrackId: "recording-picture",
      reframed: ["vertical"],
      renders: {
        landscape: { state: "fresh", file: "out/talk-recut/landscape.mp4" },
        vertical: { state: "fresh", file: "out/talk-recut/vertical.mp4" },
      },
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

function footageRoot(t: TestContext) {
  const root = scratch(t, "feedback-footage-");
  mkdirSync(path.join(root, "public/projects/talk/pipeline"), { recursive: true });
  mkdirSync(path.join(root, "out/talk-recut"), { recursive: true });
  for (const format of ["landscape", "vertical"]) {
    writeFileSync(path.join(root, `out/talk-recut/${format}.mp4`), `render ${format}`);
    writeFileSync(path.join(root, `out/talk-recut/${format}.mp4.receipt.json`), "{}");
  }
  return root;
}

test("footage feedback table: every aspect reaches a footage step or asks, with a reason", (t) => {
  assert.deepEqual(Object.keys(FOOTAGE_ASPECT_ROUTES).sort(), [...ASPECTS].sort());
  const state = footageState(footageRoot(t));
  for (const aspect of ASPECTS) {
    const routed = routeFootageAspect(aspect, state);
    if (routed.step === "ask") assert.ok("why" in routed && routed.why.length > 10, aspect);
    else assert.ok((FOOTAGE_TARGETS as readonly string[]).includes(routed.step), aspect);
  }
  assert.equal(routeFootageAspect("pacing", state).step, "recut-plan");
  assert.equal(routeFootageAspect("cuts", state).step, "recut-plan");
  assert.equal(routeFootageAspect("captions", state).step, "captions");
  assert.equal(routeFootageAspect("framing", state).step, "reframe");
  assert.equal(routeFootageAspect("music", state).step, "mix");
  assert.equal(routeFootageAspect("shorts", state).step, "ask", "shorts are not among the goals");
  assert.equal(routeFootageAspect("concept", state).step, "ask", "the recording's idea is the user's");
  const noCaptions = footageState(state.rootDir, { goals: { version: 1, goals: ["recut"] } });
  assert.match((routeFootageAspect("captions", noCaptions) as { why: string }).why, /not among the goals/);
});

test("footage feedback: preview binds the render, confirm opens the step, footage:next returns it until it moves", (t) => {
  const root = footageRoot(t);
  const state = footageState(root);
  const raw = {
    verdict: "revise",
    watched: { path: "out/talk-recut/vertical.mp4" },
    items: [
      { quote: "ты вырезал мою шутку про кота на второй минуте", aspect: "cuts", at: { fromSec: 62, toSec: 70 } },
      { quote: "subtitles cover my face", aspect: "captions" },
      { quote: "who is this for?", aspect: "audience" },
    ],
  };
  assert.throws(() => planFootageFeedback(state, { ...raw, watched: undefined }), /Several renders exist/);
  assert.throws(
    () => planFootageFeedback(state, { items: [{ quote: "<the user's words>", aspect: "cuts" }] }),
    /not the user's words/,
  );
  const plan = planFootageFeedback(state, raw, "talk", "2026-11-17T10:00:00.000Z");
  assert.equal(plan.record.route, "footage");
  assert.deepEqual(
    plan.record.items.map((item) => item.routedTo),
    ["recut-plan", "captions", "ask"],
  );
  assert.equal(plan.ask[0]!.aspect, "audience");
  assert.deepEqual(
    plan.opens.map((open) => open.step),
    ["recut-plan", "captions"],
  );
  assert.ok(plan.warnings.some((warning) => /new edit hash/.test(warning)));
  assert.equal(
    existsSync(path.join(root, "public/projects/talk/pipeline/feedback")),
    false,
    "a preview writes nothing",
  );

  writeFootageFeedback(root, plan);
  assert.ok(readOpenFeedback(path.join(root, "public/projects/talk"), "recut-plan"));
  const shown = footageFeedbackNext(state)!;
  assert.deepEqual([shown.step, shown.action], ["3-recut-plan", "agent-task"]);
  assert.ok(shown.why.includes("ты вырезал мою шутку про кота на второй минуте"), "the quote, verbatim");
  assert.match(shown.task!, /pnpm recut:plan .*--project-id talk-recut-v2 .*--reject .*--force/);
  assert.equal(footageFeedbackNext(state)!.step, "3-recut-plan", "asking again changes nothing");

  // A new plan (new edit hash) settles the plan's items; a new recut re-anchors the caption step instead of settling it.
  const replanned = footageState(root, {
    request: { ...state.request!, projectId: "talk-recut-v2", planHash: "c".repeat(64), approvedEditHash: null },
    recut: null,
  });
  assert.equal(footageFeedbackNext(replanned), undefined, "no recut yet: the regular flow asks for the new approval");
  assert.equal(decideNext(replanned).step, "4-approve");
  const created = footageState(root, {
    request: { ...replanned.request!, approvedEditHash: "c".repeat(64) },
    recut: { ...state.recut!, projectId: "talk-recut-v2", revision: 1 },
    takenProjectIds: ["talk", "talk-recut", "talk-recut-v2"],
  });
  const captions = footageFeedbackNext(created)!;
  assert.deepEqual([captions.step, captions.action], ["5-captions", "agent-task"]);
  assert.ok(captions.why.includes("subtitles cover my face"));
  const record = () => listFeedback(path.join(root, "public/projects/talk"))[0]!;
  assert.deepEqual(
    record().items.map((item) => item.status),
    ["addressed", "open", "open"],
  );
  assert.equal(
    readOpenFeedback(path.join(root, "public/projects/talk"), "captions")!.baseline!.recutId,
    "talk-recut-v2",
  );

  // A caption edit on the new recut moves its revision: settled, and footage:next goes back to its own steps.
  const placed = footageState(root, { ...created, recut: { ...created.recut!, revision: 2 } });
  assert.equal(footageFeedbackNext(placed), undefined);
  assert.equal(record().items[1]!.status, "addressed");
  assert.equal(readOpenFeedback(path.join(root, "public/projects/talk"), "captions"), undefined);
});

test("footage feedback: the same objection twice asks the user; a decline settles it with the reason", (t) => {
  const root = footageRoot(t);
  const state = footageState(root);
  const send = (quote: string, at = state) =>
    writeFootageFeedback(
      root,
      planFootageFeedback(at, {
        watched: { path: "out/talk-recut/vertical.mp4" },
        items: [{ quote, aspect: "music" }],
      }),
    );
  send("the music drowns my voice");
  assert.deepEqual([footageFeedbackNext(state)!.step, footageFeedbackNext(state)!.action], ["8-mix", "agent-task"]);
  assert.match(footageFeedbackNext(state)!.task!, /audio-gain/);
  assert.equal(footageFeedbackNext(footageState(root, { recut: { ...state.recut!, revision: 4 } })), undefined);
  send("still too loud under me", footageState(root, { recut: { ...state.recut!, revision: 4 } }));
  const ask = footageFeedbackNext(footageState(root, { recut: { ...state.recut!, revision: 4 } }))!;
  assert.deepEqual([ask.action, ask.step], ["ask", "8-mix"]);
  assert.match(ask.thenRun![0]!, /pnpm feedback --project talk --step mix --clarify/);
  declineFootageFeedback(state, "mix", "the user asked for the original levels after all");
  const records = listFeedback(path.join(root, "public/projects/talk"));
  assert.equal(records[1]!.items[0]!.status, "declined");
  assert.equal(records[1]!.items[0]!.declinedBecause, "the user asked for the original levels after all");

  // New feedback on a step whose earlier items were answered but not read since: those settle, the new ones start now.
  send("the intro music is too quiet now", footageState(root, { recut: { ...state.recut!, revision: 5 } }));
  const later = planFootageFeedback(footageState(root, { recut: { ...state.recut!, revision: 6 } }), {
    watched: { path: "out/talk-recut/vertical.mp4" },
    items: [{ quote: "and the outro is clipped", aspect: "music" }],
  });
  assert.deepEqual(later.settle, ["mix"]);
  writeFootageFeedback(root, later);
  const open = readOpenFeedback(path.join(root, "public/projects/talk"), "mix")!;
  assert.deepEqual(
    open.items.map((item) => item.quote),
    ["and the outro is clipped"],
  );
  assert.equal(open.baseline!.value, "talk-recut@6");
  assert.equal(listFeedback(path.join(root, "public/projects/talk"))[2]!.items[0]!.status, "addressed");
});

// --- Campaign ---

async function campaign(t: TestContext) {
  const root = scratch(t, "feedback-campaign-");
  const project = ProjectConfigSchema.parse({
    name: "Feedback fixture",
    productName: "Synthetic item",
    colors: {},
    musicVolume: 0,
    scenes: [{ id: "hook", text: "", durationInFrames: 30, visualType: "title" }],
  });
  for (const id of ["item-a", "item-b", "item-c"]) {
    mkdirSync(path.join(root, "public/projects", id), { recursive: true });
    writeFileSync(path.join(root, "public/projects", id, "project.json"), JSON.stringify(project));
  }
  writeFileSync(path.join(root, "logo.png"), "logo bytes");
  const member = (id: string, materials: string[]) => ({
    id,
    projectId: `item-${id}`,
    language: "en",
    factors: { hook: id },
    materials,
    adapter: { kind: "existing" as const, projectId: `item-${id}` },
  });
  const plan = initCampaign(
    {
      version: 1,
      id: "batch",
      revision: 1,
      scenario: "ad-experiments",
      brief: "Feedback routing fixture only, not renderer or creative acceptance",
      materials: [
        {
          id: "logo",
          owner: "shared",
          source: { kind: "supplied", file: pinFile(root, path.join(root, "logo.png")), provenance: { by: "fixture" } },
        },
      ],
      members: [member("a", ["logo"]), member("b", ["logo"]), member("c", [])],
    } as Parameters<typeof initCampaign>[0],
    root,
  );
  await runCampaignQueue(
    root,
    plan,
    async (task) => {
      const output = path.join(root, `${task.id}.${task.kind === "render" ? "mp4" : "json"}`);
      writeFileSync(output, task.kind === "render" ? `render of ${task.memberId}` : '{"fixtureOnly":true}');
      return { outputs: [output], metadata: { fixtureOnly: true } };
    },
    { identity: campaignInputIdentity },
  );
  return { root, plan };
}

test("campaign feedback: a variant item reopens that member, a material item every member using it, as fix drafts", async (t) => {
  const { root } = await campaign(t);
  const selection = path.join(root, "public/projects/batch/pipeline/campaign-production/selection.json");
  assert.throws(
    () => planCampaignFeedback(root, "batch", { items: [{ quote: "the hook is slow", aspect: "pacing" }] }),
    /name the render the user watched/,
    "with several variants, the render or the member names the variant",
  );
  const raw = {
    verdict: "revise",
    items: [
      { quote: "the hook is slow", aspect: "pacing", memberId: "a" },
      { quote: "логотип размыт", aspect: "material", memberId: "a" },
      { quote: "hmm", aspect: "unclear", memberId: "a" },
      { quote: "the ending drags", aspect: "length" },
    ],
  };
  const plan = planCampaignFeedback(root, "batch", raw, "2026-11-17T10:00:00.000Z");
  assert.equal(plan.record.route, "campaign");
  assert.deepEqual(
    plan.record.items.map((item) => [item.routedTo, item.memberId, item.materialId]),
    [
      ["variant", "a", undefined],
      ["dependency", "a", "logo"],
      ["ask", "a", undefined],
      ["variant", "a", undefined],
    ],
    "an item without a member is about the variant the user watched",
  );
  assert.match(plan.record.watched.path, /\.mp4$/);
  assert.deepEqual(
    plan.reopens.map((reopen) => [reopen.step, reopen.owner]).sort(),
    [
      ["a", "campaign-producer"],
      ["b", "campaign-producer"],
    ],
    "c does not use the logo",
  );
  assert.equal(existsSync(selection), false, "a preview writes nothing");
  writeCampaignFeedback(root, "batch", plan);
  const saved = JSON.parse(readFileSync(selection, "utf8")) as {
    revision: number;
    choices: { memberId: string; choice: string; note: string; kind: string; feedbackId: string }[];
  };
  assert.equal(saved.revision, 1);
  const a = saved.choices.find((choice) => choice.memberId === "a")!;
  assert.deepEqual([a.choice, a.kind, a.feedbackId], ["fix", "user-feedback", "fb-001"]);
  assert.ok(a.note.includes('"the hook is slow"') && a.note.includes('"логотип размыт"'), "verbatim quotes");
  assert.ok(saved.choices.find((choice) => choice.memberId === "b")!.note.includes("material logo"));
  assert.throws(() => writeCampaignFeedback(root, "batch", plan), /changed since the preview/, "no stale write");
  const brief = campaignBrief(root, "batch", "review-repair");
  assert.match(brief.prompt, /user-feedback carries the user's words verbatim/);

  // The CLI: the route decides; a preview writes nothing, --confirm appends; placeholders and the timeline route refuse.
  const cli = (...args: string[]) => {
    const run = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/feedback.ts"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
    });
    return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, any>;
  };
  const items = (value: unknown) => {
    const file = path.join(root, "items.json");
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const one = items({ items: [{ quote: "make the price bigger", aspect: "framing", memberId: "c" }] });
  const preview = cli("--project", "batch", "--file", one);
  assert.equal(preview.ok, true, preview.message);
  assert.deepEqual(
    [preview.metadata.route, preview.metadata.confirmed, preview.metadata.reopens[0].step],
    ["campaign", false, "c"],
  );
  const before = readFileSync(selection, "utf8");
  assert.equal(readFileSync(selection, "utf8"), before);
  const confirmed = cli("--project", "batch", "--file", one, "--confirm");
  assert.equal(confirmed.ok, true, confirmed.message);
  assert.equal(JSON.parse(readFileSync(selection, "utf8")).revision, 2);
  const placeholder = cli(
    "--project",
    "batch",
    "--file",
    items({ items: [{ quote: "<the user's words>", aspect: "pacing" }] }),
  );
  assert.equal(placeholder.error, "INVALID_INPUT");
  const timeline = cli("--project", "item-c", "--file", one);
  assert.deepEqual([timeline.error, /timeline route/.test(timeline.message)], ["INVALID_INPUT", true]);
});
