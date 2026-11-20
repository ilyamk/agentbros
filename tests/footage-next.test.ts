import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FootageGoalsSchema } from "../src/types/footage-goals";
import { planFootageFeedback, writeFootageFeedback } from "../src/lib/feedback/footage";
import { listFeedback } from "../src/lib/feedback/store";
import {
  decideNext as decideRaw,
  footageNext as footageRaw,
  gluedWords,
  mergeGoals,
  upscaleFactors,
  probeSource,
  readFootageState,
  sha256File,
  shellQuote,
  type FootageState,
  type TranscriptInfo,
} from "../src/lib/footage/next";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const media = { skip: hasFfmpeg ? false : "needs ffmpeg", timeout: 120000 } as const;
const HASH = "a".repeat(64);
const emitted: string[][] = [];
const record = <T extends { argv?: string[][] }>(result: T): T => {
  emitted.push(...(result.argv ?? []));
  return result;
};
const decideNext = (s: FootageState) => record(decideRaw(s));
const footageNext = (...args: Parameters<typeof footageRaw>) => record(footageRaw(...args));
const PLAN = "b".repeat(64);
const recut0 = (root: string) => state(root).recut!;

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "footage-next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ffmpeg(args: string[]): void {
  const run = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

const transcript = (over: Partial<TranscriptInfo> = {}): TranscriptInfo => ({
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
  ...over,
});

function state(rootDir: string, over: Partial<FootageState> = {}): FootageState {
  return {
    rootDir,
    projectId: "talk",
    projectExists: true,
    redirectedFrom: null,
    goalsFile: "public/projects/talk/pipeline/footage-goals.json",
    goals: { version: 1, goals: ["recut", "captions"], captionStyle: "bold-upper" },
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
    transcripts: [transcript()],
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
      planHash: PLAN,
      approvedEditHash: PLAN,
      cuts: [
        { id: "C1", kind: "head" },
        { id: "C2", kind: "pause" },
      ],
    },
    recut: {
      projectId: "talk-recut",
      editHash: PLAN,
      mtimeMs: 2,
      revision: 1,
      captionStyle: "bold-upper",
      captionsPlaced: true,
      pictureTrackId: "recording-picture",
      reframed: [],
      renders: { landscape: { state: "fresh", file: "out/talk-recut/landscape.mp4" } },
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

test("setup: a missing project and missing goals are questions with ready commands", (t) => {
  const root = scratch(t);
  const missing = decideNext(state(root, { projectExists: false }));
  assert.equal(missing.action, "ask");
  assert.ok(missing.thenRun!.some((c) => c.startsWith("pnpm project:new --project talk")));
  const noGoals = decideNext(state(root, { goals: null }));
  assert.equal(noGoals.step, "setup");
  assert.match(noGoals.thenRun![0]!, /footage:next --project talk --goal/);
});
test("footage boundaries reject traversal, escaping projects, redirects and goals links before writes", (t) => {
  const root = scratch(t),
    outside = path.join(root, "outside"),
    projects = path.join(root, "public/projects");
  mkdirSync(outside);
  mkdirSync(projects, { recursive: true });
  const options = { rootDir: root, overrides: { goals: ["captions"] as const, language: "en" } };
  const read = (id: string) =>
    readFootageState(id, { ...options, overrides: { ...options.overrides, goals: ["captions"] } });
  for (const id of ["../../outside", "../outside", "/tmp", "bad id"])
    assert.throws(() => read(id), { code: "INVALID_INPUT" });
  symlinkSync(outside, path.join(projects, "escape"));
  assert.throws(() => read("escape"), { code: "INVALID_INPUT" });
  mkdirSync(path.join(projects, "recut/pipeline"), { recursive: true });
  writeFileSync(
    path.join(projects, "recut/pipeline/recording-edit.json"),
    JSON.stringify({ source: { file: "public/projects/escape/assets/footage/source.mp4" } }),
  );
  assert.throws(() => read("recut"), { code: "INVALID_INPUT" });
  mkdirSync(path.join(projects, "safe/pipeline"), { recursive: true });
  symlinkSync(path.join(outside, "missing.json"), path.join(projects, "safe/pipeline/footage-goals.json"));
  assert.throws(() => read("safe"), { code: "INVALID_INPUT" });
  assert.equal(existsSync(path.join(outside, "pipeline")), false);
  assert.equal(existsSync(path.join(outside, "missing.json")), false);
});
test("footage CLI refuses traversal with one failure envelope and no outside write", (t) => {
  const root = scratch(t),
    outside = path.join(root, "outside");
  mkdirSync(outside);
  const repo = path.resolve(import.meta.dirname, "..");
  const run = spawnSync(
    process.execPath,
    [
      path.join(repo, "node_modules/tsx/dist/cli.mjs"),
      path.join(repo, "scripts/footage-next.ts"),
      "--project",
      "../../outside",
      "--goal",
      "captions",
      "--language",
      "en",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
      },
      timeout: 20000,
    },
  );
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.equal(run.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(run.stdout).error, "INVALID_INPUT");
  assert.equal(existsSync(path.join(outside, "pipeline")), false);
});
test(
  "footage and next CLIs retain language and transcriber context through unsaved goals and recut redirects",
  media,
  (t) => {
    const root = scratch(t),
      source = path.join(root, "public/projects/talk/assets/footage/talk.mp4");
    mkdirSync(path.dirname(source), { recursive: true });
    ffmpeg([
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
    ]);
    const repo = path.resolve(import.meta.dirname, "..");
    const run = (script: string, project: string, flags: string[] = []) => {
      const child = spawnSync(
        process.execPath,
        [
          path.join(repo, "node_modules/tsx/dist/cli.mjs"),
          path.join(repo, "scripts", script),
          "--project",
          project,
          ...flags,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            AGENTBROS_NO_DOTENV: "1",
            PATH: process.env.PATH,
            AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
          },
          timeout: 60000,
        },
      );
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.equal(child.stdout.trim().split("\n").length, 1);
      return JSON.parse(child.stdout).metadata;
    };
    const flags = ["--goal", "recut", "--language", "ru", "--transcriber", "local"];
    const unsaved = run("footage-next.ts", "talk", [...flags, "--no-save"]);
    assert.equal(unsaved.step, "1-transcript");
    assert.equal(unsaved.state.goals.language, "ru");
    assert.equal(unsaved.localTools?.requirements, undefined);
    assert.ok(unsaved.localTools);
    assert.equal(existsSync(path.join(root, "public/projects/talk/pipeline/footage-goals.json")), false);
    run("footage-next.ts", "talk", flags);
    mkdirSync(path.join(root, "public/projects/talk-recut/pipeline"), { recursive: true });
    writeFileSync(
      path.join(root, "public/projects/talk-recut/pipeline/recording-edit.json"),
      JSON.stringify({ source: { file: "public/projects/talk/assets/footage/talk.mp4" } }),
    );
    for (const script of ["footage-next.ts", "next.ts"]) {
      const metadata = run(script, "talk-recut");
      const answer = metadata.next ?? metadata;
      assert.equal(answer.state.project, "talk");
      assert.equal(answer.step, "1-transcript");
      assert.ok(metadata.localTools);
      assert.equal(metadata.localTools.requirements, undefined);
    }
    const scribe = run("footage-next.ts", "talk-recut", ["--transcriber", "scribe", "--no-save"]);
    assert.equal(scribe.localTools, undefined);
  },
);

test("step 0: several videos ask which; a broken source runs its ffmpeg fix, or pins an existing fixed copy", (t) => {
  const root = scratch(t);
  const two = decideNext(
    state(root, {
      source: null,
      candidates: [
        { file: "a.mp4", exists: true, width: 1, height: 1, fps: "30/1", durationSec: 1, problems: [] },
        {
          file: "b.webm",
          exists: true,
          width: 1,
          height: 1,
          fps: "30/1",
          durationSec: 1,
          problems: [{ code: "no-duration", message: "x" }],
        },
      ],
    }),
  );
  assert.equal(two.action, "ask");
  assert.deepEqual(two.answers, ["a.mp4", "b.webm (needs a fix first: no-duration)"]);
  const fix = ["ffmpeg", "-i", "talk.webm", "-c:v", "copy", "talk.mp4"];
  const broken = state(root, {
    source: {
      ...state(root).source!,
      file: "talk.webm",
      problems: [{ code: "no-duration", message: "No duration.", fix, fixedFile: "talk.mp4" }],
    },
  });
  const run = decideNext(broken);
  assert.equal(run.action, "run");
  assert.deepEqual(run.argv![0], fix);
  assert.deepEqual(run.argv![1], ["pnpm", "footage:next", "--project", "talk", "--source", "talk.mp4"]);
  writeFileSync(path.join(root, "talk.mp4"), "");
  assert.deepEqual(decideNext(broken).argv, [["pnpm", "footage:next", "--project", "talk", "--source", "talk.mp4"]]);
  const unfixable = decideNext(
    state(root, { source: { ...state(root).source!, problems: [{ code: "too-long", message: "Too long." }] } }),
  );
  assert.equal(unfixable.action, "stop");
});

test("step 0 probe: WebM without duration, late start and long audio get the exact refusal hints", media, (t) => {
  const root = scratch(t);
  const webm = path.join(root, "clip.webm");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=25:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=d=1",
    "-c:v",
    "libvpx",
    "-c:a",
    "libopus",
    webm,
  ]);
  const probed = probeSource(webm, root);
  assert.ok(probed.problems.some((p) => p.code === "no-duration"));
  const problem = probed.problems.find((p) => p.fix)!;
  assert.equal(problem.fixedFile, "clip.mp4");
  ffmpeg(
    problem
      .fix!.slice(1)
      .map((arg) => (arg === "clip.webm" ? webm : arg === "clip.mp4" ? path.join(root, "clip.mp4") : arg)),
  );
  assert.deepEqual(probeSource(path.join(root, "clip.mp4"), root).problems, []);

  const long = path.join(root, "long.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=25:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=d=1.5",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    long,
  ]);
  const longProbe = probeSource(long, root);
  assert.ok(
    longProbe.problems.some((p) => p.code === "audio-longer"),
    JSON.stringify(longProbe.problems),
  );
  assert.equal(longProbe.problems[0]!.fixedFile, "long-fixed.mp4");
  assert.ok(longProbe.problems[0]!.fix!.includes("atrim=end=1"));

  const late = path.join(root, "late.mp4");
  ffmpeg([
    "-itsoffset",
    "0.2",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=30:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=d=1.2",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    late,
  ]);
  const lateProbe = probeSource(late, root);
  const offset = lateProbe.problems.find((p) => p.code === "start-offset");
  assert.ok(offset, JSON.stringify(lateProbe.problems));
  assert.ok(offset.fix!.includes("setpts=PTS-STARTPTS"));
  assert.ok(probeSource(path.join(root, "audio.wav"), root).problems.some((p) => p.code === "unreadable"));
});

test("step 1: Scribe is asked with a cost; a raw response for the same sha rebuilds for free; an open operation resumes by id", (t) => {
  const root = scratch(t);
  const ask = decideNext(state(root, { transcripts: [], budget: false }));
  assert.equal(ask.action, "ask");
  assert.equal(ask.cost!.model, "elevenlabs:scribe-v3");
  assert.equal(ask.cost!.minutes, 10);
  assert.ok(ask.cost!.expectedUsd! > 0.03 && ask.cost!.expectedUsd! < 0.04);
  assert.match(
    ask.thenRun![0]!,
    /pnpm budget --project talk --ceiling-usd .*pnpm transcribe --project talk --input public\/projects\/talk\/assets\/footage\/talk.mp4 .*--diarize/,
  );
  assert.match(ask.why, /Filler removal needs Scribe/);
  assert.ok(ask.userDecides!.length);

  const raw = decideNext(
    state(root, {
      transcripts: [transcript({ valid: false })],
      raws: [{ file: "x/transcript.scribe.json", sha256: HASH, durationSec: 600 }],
    }),
  );
  assert.equal(raw.action, "run");
  assert.ok(raw.argv![0]!.includes("--from-raw"));
  assert.ok(raw.argv![0]!.includes("x/transcript.scribe.json"));
  const otherSha = decideNext(
    state(root, { transcripts: [], raws: [{ file: "y.scribe.json", sha256: "c".repeat(64), durationSec: 600 }] }),
  );
  assert.equal(otherSha.action, "ask");

  const open = decideNext(
    state(root, { transcripts: [], openScribe: [{ operationId: "scribe-talk-v3", state: "running" }] }),
  );
  assert.match(open.why, /same --operation-id/);
  assert.ok(open.thenRun!.some((c) => c.includes("--operation-id scribe-talk-v3")));

  const unknown = decideNext(
    state(root, {
      transcripts: [],
      goals: { version: 1, goals: ["captions"], transcriber: "local", captionStyle: "bold-upper" },
    }),
  );
  assert.equal(unknown.action, "ask");
  assert.match(unknown.thenRun![0]!, /--language/);
  const local = decideNext(
    state(root, {
      transcripts: [],
      goals: { version: 1, goals: ["captions"], transcriber: "local", captionStyle: "bold-upper", language: "ru" },
    }),
  );
  assert.equal(local.action, "run");
  assert.equal(local.argv![0]![1], "speech:local");
});

test("steps 1–3: the speech mask, shots for a reframe, then recut:plan with every format", (t) => {
  const root = scratch(t);
  const noMask = decideNext(state(root, { speechMasks: [], request: null, recut: null }));
  assert.equal(noMask.step, "1-speech-mask");
  assert.ok(noMask.argv![0]!.includes("--vad-output"));
  const vertical = { version: 1 as const, goals: ["recut" as const, "vertical" as const] };
  const shots = decideNext(state(root, { goals: vertical, request: null, recut: null }));
  assert.equal(shots.step, "2-shots");
  const plan = decideNext(state(root, { goals: vertical, shots: "s/shots.json", request: null, recut: null }));
  assert.equal(plan.step, "3-recut-plan");
  const argv = plan.argv![0]!;
  assert.equal(argv[argv.indexOf("--formats") + 1], "landscape,vertical");
  assert.equal(argv[argv.indexOf("--project-id") + 1], "talk-recut2");
  const captionsOnly = decideNext(
    state(root, {
      goals: { version: 1, goals: ["captions"], captionStyle: "bold-upper" },
      request: null,
      recut: null,
      takenProjectIds: ["talk"],
    }),
  );
  assert.ok(captionsOnly.argv![0]!.includes("--no-fillers"));
  assert.equal(captionsOnly.argv![0]![captionsOnly.argv![0]!.indexOf("--project-id") + 1], "talk-recut");
  const missingFormat = decideNext(
    state(root, {
      goals: { ...vertical, formats: ["landscape", "vertical"] },
      shots: "s.json",
      recut: null,
      request: { ...state(root).request!, approvedEditHash: null },
    }),
  );
  assert.ok(missingFormat.argv![0]!.includes("--force"));
});

test("step 4: approval is the person's; a stale review is named; an approved plan creates; a taken id asks for a new plan", (t) => {
  const root = scratch(t);
  const pending = decideNext(
    state(root, {
      recut: null,
      takenProjectIds: ["talk"],
      request: { ...state(root).request!, approvedEditHash: null },
    }),
  );
  assert.equal(pending.action, "ask");
  assert.match(pending.question!, new RegExp(`"approvedEditHash": "${PLAN}"`));
  assert.match(pending.question!, /An agent never writes this/);
  assert.ok(!pending.thenRun!.some((c) => /review/.test(c) && !c.startsWith("If cuts")));
  const stale = decideNext(
    state(root, {
      recut: null,
      takenProjectIds: ["talk"],
      request: { ...state(root).request!, approvedEditHash: HASH },
    }),
  );
  assert.match(stale.why, /no longer applies/);
  const create = decideNext(state(root, { recut: null, takenProjectIds: ["talk"] }));
  assert.equal(create.step, "4-create");
  assert.deepEqual(create.argv![0], [
    "pnpm",
    "video:workflow",
    "--scenario",
    "recording-edit",
    "--request",
    "public/projects/talk/pipeline/footage/talk/recut-request.json",
    "--action",
    "create",
  ]);
  const taken = decideNext(state(root, { recut: null }));
  assert.equal(taken.action, "ask");
  assert.ok(taken.thenRun![0]!.includes("--project-id talk-recut2"));
});

test("steps 5, 8, 9: caption style, speaker map, reframe and render", (t) => {
  const root = scratch(t);
  const recut = state(root).recut!;
  const style = decideNext(state(root, { goals: { version: 1, goals: ["captions"] } }));
  assert.equal(style.action, "ask");
  assert.ok(style.answers!.includes("word-box"));
  const apply = decideNext(state(root, { recut: { ...recut, captionStyle: null } }));
  assert.equal(apply.step, "5-captions");
  assert.deepEqual(apply.argv![0], [
    "pnpm",
    "timeline:edit",
    "--project",
    "talk-recut",
    "--revision",
    "1",
    "--command",
    '{"type":"caption-style","style":{"profile":"bold-upper"}}',
    "--dry-run",
  ]);
  assert.equal(
    apply.commands![1],
    `pnpm timeline:edit --project talk-recut --revision 1 --command ${shellQuote('{"type":"caption-style","style":{"profile":"bold-upper"}}')}`,
  );
  const place = decideNext(state(root, { recut: { ...recut, captionsPlaced: false } }));
  assert.equal(place.step, "5-captions");
  assert.deepEqual(place.argv![0], ["pnpm", "captions:place", "--project", "talk-recut", "--format", "landscape"]);
  assert.deepEqual(place.argv![2], [
    "pnpm",
    "timeline:edit",
    "--project",
    "talk-recut",
    "--revision",
    "1",
    "--command-file",
    "public/projects/talk-recut/pipeline/caption-place.json",
  ]);
  const vertical = decideNext(
    state(root, {
      goals: { version: 1, goals: ["captions"], formats: ["landscape", "vertical"], captionStyle: "bold-upper" },
      recut: { ...recut, captionsPlaced: false, reframed: ["vertical"] },
    }),
  );
  assert.deepEqual(vertical.argv![0], ["pnpm", "captions:place", "--project", "talk-recut", "--format", "vertical"]);
  const karaoke = decideNext(
    state(root, {
      goals: { version: 1, goals: ["captions"], captionStyle: "karaoke" },
      recut: { ...recut, captionStyle: "karaoke", captionsPlaced: false },
    }),
  );
  assert.notEqual(karaoke.argv?.[0]?.[1], "captions:place");
  // A paid placement passes the ad interface to captions:place; a ugc-ad project with no placement is offered it.
  const verticalAd = {
    version: 1 as const,
    goals: ["captions" as const],
    formats: ["vertical" as const],
    captionStyle: "bold-upper" as const,
  };
  const ad = decideNext(
    state(root, {
      goals: { ...verticalAd, placement: "ad", platform: "tiktok" },
      recut: { ...recut, captionsPlaced: false, reframed: ["vertical"] },
    }),
  );
  assert.deepEqual(ad.argv![0], [
    "pnpm",
    "captions:place",
    "--project",
    "talk-recut",
    "--format",
    "vertical",
    "--placement",
    "ad",
    "--platform",
    "tiktok",
  ]);
  assert.match(ad.why, /tiktok ad interface/);
  assert.deepEqual(
    decideNext(
      state(root, {
        goals: { ...verticalAd, placement: "ad" },
        recut: { ...recut, captionsPlaced: false, reframed: ["vertical"] },
      }),
    ).argv![0]!.slice(-2),
    ["--placement", "ad"],
  );
  const bound = decideNext(
    state(root, {
      playbook: "ugc-ad",
      goals: verticalAd,
      recut: { ...recut, captionsPlaced: false, reframed: ["vertical"] },
    }),
  );
  assert.ok(!bound.argv![0]!.includes("--placement"));
  assert.match(bound.optional![0]!, /playbook is ugc-ad.*footage:next --project talk --placement ad/);
  const organic = decideNext(
    state(root, {
      playbook: "ugc-ad",
      goals: { ...verticalAd, placement: "organic" },
      recut: { ...recut, captionsPlaced: false, reframed: ["vertical"] },
    }),
  );
  assert.deepEqual(organic.argv![0]!.slice(-2), ["--placement", "organic"]);
  assert.ok(!organic.optional!.some((o) => /ugc-ad/.test(o)));
  assert.ok(!place.optional!.some((o) => /ugc-ad/.test(o)));
  assert.deepEqual(mergeGoals(verticalAd, { placement: "ad", platform: "reels" }), {
    ...verticalAd,
    placement: "ad",
    platform: "reels",
  });
  assert.throws(() => mergeGoals(verticalAd, { platform: "reels" }), /placement ad only/);
  // Captions placed for one interface are placed again when the goals change it; organic is passed explicitly.
  const placedAd = { ...recut, reframed: ["vertical" as const], captionUiZone: "ad" };
  const back = decideNext(state(root, { goals: { ...verticalAd, placement: "organic" }, recut: placedAd }));
  assert.deepEqual(back.argv![0]!.slice(-2), ["--placement", "organic"]);
  assert.match(back.why, /placed for the ad interface; the goals now want organic/);
  assert.equal(
    decideNext(state(root, { goals: { ...verticalAd, placement: "ad" }, recut: placedAd })).step,
    "9-render",
  );
  assert.equal(
    decideNext(state(root, { goals: { ...verticalAd, placement: "ad", platform: "reels" }, recut: placedAd }))
      .argv![0]![1],
    "captions:place",
  );
  assert.equal(
    decideNext(state(root, { goals: { ...verticalAd, placement: "ad" }, recut: { ...recut, reframed: ["vertical"] } }))
      .argv![0]![1],
    "captions:place",
  );

  const goals = {
    version: 1 as const,
    goals: ["captions" as const, "vertical" as const],
    captionStyle: "bold-upper" as const,
  };
  const two = transcript({
    speakers: ["speaker_0", "speaker_1"],
    firstWords: [
      { speaker: "speaker_0", startSec: 1, endSec: 3 },
      { speaker: "speaker_1", startSec: 5, endSec: 9 },
    ],
  });
  const map = decideNext(state(root, { goals, shots: "s.json", transcripts: [two] }));
  assert.equal(map.action, "agent-task");
  assert.match(map.task!, /"position"/);
  assert.equal(map.argv!.length, 3);
  assert.deepEqual(map.argv![0], ["mkdir", "-p", "public/projects/talk/pipeline/footage/talk/stills"]);
  assert.equal(map.argv![2]![map.argv![2]!.indexOf("-ss") + 1], "7.00");
  const reframe = decideNext(state(root, { goals, shots: "s.json", transcripts: [two], speakerMap: "m.json" }));
  assert.equal(reframe.step, "8-reframe");
  const track = reframe.argv![0]!;
  for (const flag of ["--recording-edit", "--timeline", "--command-output", "--map", "--transcript", "--shots"])
    assert.ok(track.includes(flag), flag);
  assert.equal(track[track.indexOf("--clip-id") + 1], "all");
  assert.deepEqual(
    reframe.argv!.slice(1).map((a) => a.at(-1)),
    ["--dry-run", "public/projects/talk/pipeline/footage/talk/reframe-vertical-edit.json"],
  );

  const render = decideNext(state(root, { goals, recut: { ...recut, reframed: ["vertical"] } }));
  assert.deepEqual(render.argv![0], [
    "pnpm",
    "render",
    "--project",
    "talk-recut",
    "--format",
    "vertical",
    "--timeline",
  ]);
  const stale = decideNext(
    state(root, {
      recut: { ...recut, renders: { landscape: { state: "stale", file: "out/talk-recut/landscape.mp4" } } },
    }),
  );
  assert.match(stale.why, /archives the previous master/);
  const noCaptions = decideNext(state(root, { goals: { version: 1, goals: ["recut"] } }));
  assert.deepEqual(noCaptions.argv![0]!.slice(-2), ["--captions", "off"]);
  assert.equal(
    decideNext(
      state(root, {
        goals: { version: 1, goals: ["recut"] },
        recut: {
          ...recut,
          renders: { "landscape-clean": { state: "fresh", file: "out/talk-recut/landscape-clean.mp4" } },
        },
      }),
    ).action,
    "stop",
  );
  assert.equal(decideNext(state(root)).action, "stop");
});

test("step 6: chapters, prepare, candidates by the agent, rank, the user's approval, create and render", (t) => {
  const root = scratch(t);
  const goals = { version: 1 as const, goals: ["recut" as const, "shorts" as const] };
  const recut = state(root).recut!;
  const base = { goals, recut: { ...recut, renders: { "landscape-clean": { state: "fresh" as const, file: "x" } } } };
  assert.deepEqual(decideNext(state(root, { ...base, recut: { ...base.recut, chapters: false } })).argv![0], [
    "pnpm",
    "shorts:request",
    "--project",
    "talk-recut",
  ]);
  assert.equal(decideNext(state(root, base)).argv![0]![1], "shorts:prepare");
  const shorts = { dir: "w/shorts", prepared: true, candidates: null, proposals: null };
  assert.equal(decideNext(state(root, { ...base, shorts })).action, "agent-task");
  const rank = decideNext(state(root, { ...base, shorts: { ...shorts, candidates: "w/shorts/candidates.json" } }));
  assert.ok(rank.argv![0]!.includes("--speech-mask"));
  const ranked = {
    ...shorts,
    candidates: "w/shorts/candidates.json",
    proposals: {
      file: "w/shorts/proposals.json",
      projectId: "talk-recut",
      fresh: true,
      proposed: ["c1", "c2"],
      others: [],
    },
  };
  assert.equal(
    decideNext(state(root, { ...base, shorts: { ...ranked, proposals: { ...ranked.proposals, projectId: null } } }))
      .argv![0]![1],
    "shorts:rank",
  );
  const approve = decideNext(state(root, { ...base, shorts: ranked }));
  assert.equal(approve.action, "ask");
  assert.match(
    approve.thenRun![0]!,
    /--approved-by '<the user's own words>'|--approved-by '<the user'\\''s own words>'/,
  );
  const series = {
    file: "s.json",
    seriesId: "talk-recut-shorts",
    episodes: 2,
    created: [] as { projectId: string; rendered: boolean }[],
  };
  const create = decideNext(state(root, { ...base, shorts: ranked, series }));
  assert.deepEqual(
    create.argv!.map((a) => a[a.indexOf("--action") + 1]),
    ["plan", "create"],
  );
  const render = decideNext(
    state(root, {
      ...base,
      shorts: ranked,
      series: {
        ...series,
        created: [
          { projectId: "e1", rendered: true },
          { projectId: "e2", rendered: false },
        ],
      },
    }),
  );
  assert.deepEqual(render.argv, [["pnpm", "render", "--project", "e2", "--format", "vertical", "--timeline"]]);
  const done = decideNext(
    state(root, {
      ...base,
      shorts: ranked,
      series: {
        ...series,
        created: [
          { projectId: "e1", rendered: true },
          { projectId: "e2", rendered: true },
        ],
      },
    }),
  );
  assert.equal(done.action, "stop");
  assert.ok(done.optional!.some((o) => o.includes("shorts:calibrate")));
});

test("step 6 comes before the full recut render; with shorts that render is optional at the end", (t) => {
  const root = scratch(t);
  const goals = {
    version: 1 as const,
    goals: ["recut" as const, "captions" as const, "shorts" as const],
    captionStyle: "bold-upper" as const,
  };
  const unrendered = { ...recut0(root), renders: {} };
  assert.equal(decideNext(state(root, { goals, recut: unrendered })).argv![0]![1], "shorts:prepare");
  const ranked = {
    dir: "w/shorts",
    prepared: true,
    candidates: "w/shorts/candidates.json",
    proposals: {
      file: "w/shorts/proposals.json",
      projectId: "talk-recut",
      fresh: true,
      proposed: ["c1", "c2"],
      others: [],
    },
  };
  const series = {
    file: "s.json",
    seriesId: "talk-recut-shorts",
    episodes: 2,
    created: [
      { projectId: "e1", rendered: true },
      { projectId: "e2", rendered: true },
    ],
  };
  const done = decideNext(state(root, { goals, recut: unrendered, shorts: ranked, series }));
  assert.equal(done.step, "done");
  assert.ok(done.optional!.some((o) => o.includes("pnpm render --project talk-recut --format landscape --timeline")));
  const rendered = decideNext(state(root, { goals, shorts: ranked, series }));
  assert.equal(rendered.step, "done");
  assert.ok(!rendered.optional!.some((o) => o.includes("--format landscape")));
  assert.equal(decideNext(state(root, { recut: unrendered })).argv![0]![1], "render");
});

test("pace goals reach every recut:plan footage:next prints and are checked against recut:plan's ranges", (t) => {
  const root = scratch(t);
  const goals = { version: 1 as const, goals: ["recut" as const], midPauseMs: 250, sentencePauseMs: 300, punchIn: 1.1 };
  const pace = ["--mid-pause-ms", "250", "--sentence-pause-ms", "300", "--punch-in", "1.1"];
  const has = (argv: string[]) => pace.every((flag, i) => i % 2 === 1 || argv[argv.indexOf(flag) + 1] === pace[i + 1]);
  assert.ok(has(decideNext(state(root, { goals, request: null, recut: null })).argv![0]!));
  const pending = decideNext(
    state(root, {
      goals,
      recut: null,
      takenProjectIds: ["talk"],
      request: { ...state(root).request!, approvedEditHash: null },
    }),
  );
  const rerun = pending.thenRun!.find((c) => c.includes("--reject"))!;
  assert.ok(rerun.includes(pace.join(" ")), rerun);
  const missing = decideNext(
    state(root, {
      goals: { ...goals, formats: ["landscape", "square"] },
      shots: "s.json",
      recut: null,
      request: { ...state(root).request!, approvedEditHash: null },
    }),
  );
  assert.ok(has(missing.argv![0]!) && missing.argv![0]!.includes("--force"));
  const taken = decideNext(state(root, { goals, recut: null }));
  assert.ok(taken.thenRun![0]!.includes(pace.join(" ")));
  assert.ok(!decideNext(state(root, { request: null, recut: null })).argv![0]!.includes("--mid-pause-ms"));
  assert.throws(() => mergeGoals(null, { goals: ["recut"], midPauseMs: 400, sentencePauseMs: 300 }), /midPauseMs/);
  assert.throws(() => mergeGoals(null, { goals: ["recut"], punchIn: 1.3 }));
  assert.equal(mergeGoals({ version: 1, goals: ["recut"] }, { sentencePauseMs: 300 })!.sentencePauseMs, 300);
  assert.ok(FootageGoalsSchema.safeParse({ version: 1, goals: ["shorts"], shortsBrief: "x" }).success);
});

test("step 7: cameras are asked, synced, mapped by the agent, proposed, then left to the documented manual step", (t) => {
  const root = scratch(t);
  const goals = { version: 1 as const, goals: ["multicam" as const] };
  assert.equal(decideNext(state(root, { goals })).action, "ask");
  const sync = decideNext(state(root, { goals: { ...goals, cameras: ["close.mp4"] }, cameras: ["close.mp4"] }));
  assert.deepEqual(sync.argv![0]!.slice(0, 6), [
    "pnpm",
    "multicam:sync",
    "--inputs",
    "public/projects/talk/assets/footage/talk.mp4",
    "close.mp4",
    "--output",
  ]);
  const synced = {
    goals: { ...goals, cameras: ["close.mp4"] },
    cameras: ["close.mp4"],
    multicam: { sync: "w/sync.json", angles: null },
  };
  assert.equal(decideNext(state(root, synced)).action, "agent-task");
  assert.equal(decideNext(state(root, { ...synced, speakerMap: "m.json" })).argv![0]![1], "multicam:angles");
  const done = decideNext(
    state(root, { ...synced, speakerMap: "m.json", multicam: { sync: "w/sync.json", angles: "w/angles.json" } }),
  );
  assert.equal(done.action, "stop");
  assert.ok(done.advisories!.some((a) => a.includes("uncut reference clock")));
});

test(
  "walk: a recording goes from no goals to done through files alone, and a recut resolves to its source",
  media,
  (t) => {
    const root = scratch(t);
    const project = path.join(root, "public/projects/talk");
    mkdirSync(path.join(project, "assets/footage"), { recursive: true });
    const video = path.join(project, "assets/footage/talk.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=d=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      video,
    ]);
    const sha = sha256File(video);
    const next = (overrides = {}) => footageNext("talk", { rootDir: root, overrides });
    const write = (file: string, value: unknown) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value));
    };

    assert.equal(next().step, "setup");
    const asked = next({ goals: ["recut", "captions"], captionStyle: "boxed-word" });
    assert.equal(asked.state.goalsSaved, "public/projects/talk/pipeline/footage-goals.json");
    assert.equal(asked.step, "1-transcript");
    assert.equal(asked.action, "ask");

    const work = "public/projects/talk/pipeline/footage/talk";
    write(`${work}/transcript.json`, {
      version: 1,
      source: { file: "public/projects/talk/assets/footage/talk.mp4", sha256: sha, durationSec: 2 },
      engine: { provider: "elevenlabs", model: "scribe_v3", verbatim: true, diarized: true, timing: "native" },
      language: "en",
      speakers: [{ id: "speaker_0" }],
      words: [
        {
          id: "w1",
          text: "Hello.",
          kind: "word",
          startSec: 0.2,
          endSec: 0.6,
          speaker: "speaker_0",
          channel: null,
          confidence: null,
        },
      ],
      sentences: [
        {
          id: "s1",
          firstWordId: "w1",
          lastWordId: "w1",
          text: "Hello.",
          startSec: 0.2,
          endSec: 0.6,
          speaker: "speaker_0",
        },
      ],
    });
    assert.equal(next().step, "1-speech-mask");
    write(`${work}/speech-mask.json`, {
      version: 1,
      source: { file: "x", sha256: sha, durationSec: 2 },
      engine: {
        provider: "silero-vad",
        version: "5",
        sampleRate: 16000,
        threshold: 0.5,
        minSpeechMs: 250,
        minSilenceMs: 100,
        padMs: 0,
      },
      speech: [{ startSec: 0.2, endSec: 0.6 }],
      speechSec: 0.4,
    });
    const plan = next();
    assert.equal(plan.step, "3-recut-plan");
    assert.equal(plan.argv![0]![plan.argv![0]!.indexOf("--speech-mask") + 1], `${work}/speech-mask.json`);

    const request = {
      version: 3,
      workflow: "recording-edit",
      projectId: "talk-recut",
      formats: ["landscape"],
      source: { file: "public/projects/talk/assets/footage/talk.mp4", sha256: sha },
    };
    write(`${work}/recut-request.json`, request);
    write(`${work}/recut-plan.md`, `# Recut plan\n\n- Edit hash to approve: \`${PLAN}\`\n`);
    assert.equal(next().step, "4-approve");
    write(`${work}/recut-request.json`, {
      ...request,
      review: {
        reviewer: "Person",
        reviewedAt: "2026-11-13T00:00:00Z",
        approvedEditHash: PLAN,
        meaningPreserved: true,
      },
    });
    assert.equal(next().step, "4-create");

    write("public/projects/talk-recut/pipeline/recording-edit.json", { version: 3, request, editHash: PLAN });
    const timeline = (captionStyle?: unknown) => ({
      version: 1,
      revision: captionStyle ? 1 : 0,
      timeline: {
        version: 1,
        projectId: "talk-recut",
        tracks: [
          {
            id: "recording-picture",
            kind: "visual",
            clips: [{ id: "k1", payload: { sourceHash: sha, editHash: PLAN } }],
          },
        ],
        ...(captionStyle ? { captionStyle } : {}),
      },
      undo: [],
      redo: [],
    });
    write("public/projects/talk-recut/pipeline/timeline-edit.json", timeline());
    const captions = next();
    assert.equal(captions.step, "5-captions");
    assert.ok(captions.commands![0]!.includes("--revision 0"));
    write("public/projects/talk-recut/pipeline/timeline-edit.json", timeline({ profile: "boxed-word" }));
    const place = next();
    assert.equal(place.step, "5-captions");
    assert.equal(place.argv![0]![1], "captions:place");
    write(
      "public/projects/talk-recut/pipeline/timeline-edit.json",
      timeline({ profile: "boxed-word", options: { legibility: [], positions: [] } }),
    );
    assert.equal(next().step, "9-render");
    write("out/talk-recut/landscape.mp4", "");
    write("out/talk-recut/landscape.mp4.receipt.json", {
      version: 1,
      captions: "on",
      sources: [
        {
          path: "public/projects/talk-recut/pipeline/timeline-edit.json",
          sha256: sha256File(path.join(root, "public/projects/talk-recut/pipeline/timeline-edit.json")),
        },
      ],
    });
    const done = next();
    assert.equal(done.action, "stop", done.why);

    // The user's feedback on that render reopens the caption step through footage:next, `pnpm next`'s read included.
    const feedbackState = readFootageState("talk-recut", { rootDir: root, save: false });
    const quote = "the captions sit on my chin";
    writeFootageFeedback(
      root,
      planFootageFeedback(feedbackState, { items: [{ quote, aspect: "captions" }] }, "talk-recut"),
    );
    const reopened = footageNext("talk", { rootDir: root, save: false });
    assert.deepEqual([reopened.step, reopened.action], ["5-captions", "agent-task"]);
    assert.ok(reopened.why.includes(quote) && reopened.read!.length > 0 && reopened.state.project === "talk");

    write("public/projects/talk-recut/pipeline/timeline-edit.json", {
      ...timeline({ profile: "boxed-word", options: { legibility: [], positions: [] } }),
      revision: 2,
    });
    assert.match(next().why, /older than the timeline/);
    assert.equal(
      listFeedback(project)[0]!.items[0]!.status,
      "addressed",
      "the timeline moved: the feedback is answered",
    );
    write("out/talk-recut/landscape.mp4.receipt.json", {
      version: 1,
      captions: "on",
      partial: { startFrame: 0, endFrame: 9, totalFrames: 60 },
      sources: [],
    });
    assert.match(next().why, /No full landscape render/);

    const viaRecut = footageNext("talk-recut", { rootDir: root });
    assert.equal(viaRecut.state.project, "talk");
    assert.match(viaRecut.advisories![0]!, /is a recut of the recording in talk/);
    const unsaved = readFootageState("talk", {
      rootDir: root,
      overrides: { captionStyle: "word-highlight" },
      save: false,
    });
    assert.equal(unsaved.goals!.captionStyle, "word-highlight");
    assert.equal(readFootageState("talk", { rootDir: root }).goals!.captionStyle, "boxed-word");
  },
);

test("follow-up: one setup ask covers goals, formats, style, language and the transcriber with its cost", (t) => {
  const root = scratch(t);
  const ask = decideNext(state(root, { goals: null }));
  for (const word of ["Formats", "Caption style", "language", "Scribe", "local engine", "about $0.033"])
    assert.ok(ask.question!.includes(word), word);
  assert.equal(ask.cost!.minutes, 10);
  assert.match(ask.thenRun![0]!, /--language '<code>' --transcriber '<scribe\|local>'/);
  assert.ok(!decideNext(state(root, { goals: null, source: null })).cost);
});

test("follow-up: the transcript ask asks for an unknown language and names the right fillers for a known one", (t) => {
  const root = scratch(t);
  const unknown = decideNext(state(root, { transcripts: [] }));
  assert.match(unknown.question!, /Which language is spoken/);
  assert.ok(unknown.thenRun!.every((c) => c.includes("--language '<code>'")));
  assert.doesNotMatch(unknown.why, /Russian/);
  const ru = decideNext(state(root, { transcripts: [], goals: { version: 1, goals: ["recut"], language: "ru" } }));
  assert.match(ru.why, /standalone "ну"/);
  assert.doesNotMatch(ru.question!, /Which language/);
  assert.ok(ru.thenRun![0]!.includes("--language ru"));
  const inferred = decideNext(
    state(root, {
      goals: { version: 1, goals: ["recut"] },
      transcripts: [transcript({ language: "ru", valid: true })],
      request: null,
      recut: null,
      takenProjectIds: ["talk"],
    }),
  );
  assert.equal(inferred.step, "3-recut-plan");
  const und = decideNext(state(root, { transcripts: [transcript({ language: "und" })] }));
  assert.ok(und.advisories!.some((a) => a.includes('"und"')));
});

test("follow-up: glued words in a local transcript are named for captions; a large upscale is stated", (t) => {
  const root = scratch(t);
  const words = [
    "очень",
    "рядом",
    "это",
    "было",
    "оченьрядом",
    "правозащитнойжурналистикой",
    "поинтересовалась",
    "неважно",
    "настолько",
    "только",
    "some",
    "thing",
    "something",
    "очень",
    "очень",
    "вкусный",
    "оченьвкусный",
  ].map((text, i) => ({ text, startSec: i }));
  assert.deepEqual(
    gluedWords(words).map((g) => [g.text, g.why]),
    [
      ["оченьрядом", "splits into очень + рядом"],
      ["правозащитнойжурналистикой", "26 letters"],
      ["оченьвкусный", "splits into очень + вкусный"],
    ],
  );
  const glued = gluedWords(words);
  const local = decideNext(
    state(root, { transcripts: [transcript({ provider: "local", verbatim: false, gluedWords: glued })] }),
  );
  assert.ok(local.advisories!.some((a) => a.includes("оченьрядом") && a.includes("00:04.0") && a.includes("Scribe")));
  assert.ok(
    !decideNext(
      state(root, {
        goals: { version: 1, goals: ["recut"] },
        transcripts: [transcript({ provider: "local", gluedWords: glued })],
      }),
    ).advisories?.some((a) => a.includes("glued")),
  );
  assert.deepEqual(upscaleFactors(640, 480, ["vertical", "landscape", "square"]), [
    { format: "vertical", factor: 4 },
    { format: "landscape", factor: 3 },
    { format: "square", factor: 2.3 },
  ]);
  const small = decideNext(
    state(root, {
      goals: { version: 1, goals: ["captions"], formats: ["vertical"], captionStyle: "bold-upper" },
      source: { ...state(root).source!, width: 640, height: 480 },
    }),
  );
  assert.ok(
    small.advisories!.some((a) => a.includes("640x480") && a.includes("vertical enlarges the crop about 4.0x")),
  );
  assert.ok(!decideNext(state(root)).advisories);
});

test("follow-up: the approval ask uses the plan's real ids and mentions retakes only when there are some", (t) => {
  const root = scratch(t);
  const pending = {
    recut: null,
    takenProjectIds: ["talk"],
    request: { ...state(root).request!, approvedEditHash: null },
  };
  const ask = decideNext(state(root, pending));
  assert.match(ask.question!, /cut ids are C1–C2/);
  assert.ok(!ask.answers!.some((a) => /C3|C7/.test(a)));
  assert.equal(ask.optional, undefined);
  const withRetake = decideNext(
    state(root, {
      ...pending,
      request: {
        ...pending.request,
        cuts: [
          { id: "C1", kind: "head" },
          { id: "C2", kind: "retake" },
        ],
      },
    }),
  );
  assert.match(withRetake.optional![0]!, /^Retakes C2/);
});

test("every emitted pnpm command uses flags its script declares", () => {
  const repo = path.resolve(import.meta.dirname, "..");
  const scripts = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).scripts as Record<string, string>;
  const pnpm = emitted.filter((argv) => argv[0] === "pnpm");
  const aliases = new Set(pnpm.map((argv) => argv[1]));
  assert.ok(aliases.size >= 12, [...aliases].join(" "));
  for (const argv of pnpm) {
    const file = /scripts\/[\w-]+\.ts/.exec(scripts[argv[1]!] ?? "")?.[0];
    assert.ok(file, `no script for ${argv[1]}`);
    const source = readFileSync(path.join(repo, file), "utf8");
    for (const flag of argv.filter((arg) => arg.startsWith("--"))) {
      const name = flag.slice(2).replace(/^no-/, "");
      assert.ok(new RegExp(`name:\\s*["']${name}["']`).test(source), `${argv[1]} has no --${name}`);
    }
  }
});
