import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FILM_CHAIN } from "../src/lib/film/chain";
import { approveStep, nextAction, openFilmProject, sealStep } from "../src/lib/film/state";
import { footageCaptureMoment, STEP } from "../src/lib/footage/next";
import { captureFor, type CaptureMoment } from "../src/lib/pipeline/memory";
import { captureFields, passedDeliveryReport } from "../src/lib/pipeline/route";
import { listPlaybookIds } from "../src/lib/playbooks/project";
import { PIPELINE_STAGES } from "../src/types/pipeline";
import { PlaybookPlatformSchema } from "../src/types/playbook";
import { toConceptApproved, toScriptPicked } from "./helpers/film-studio";

const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
const REAL_MEMORY = path.join(REPO, "memory");
const MEMORY_ROOT = mkdtempSync(path.join(tmpdir(), "memory-capture-root-"));
process.env.AGENTBROS_MEMORY_ROOT = MEMORY_ROOT;
const realBefore = existsSync(REAL_MEMORY) ? readdirSync(REAL_MEMORY, { recursive: true }).map(String).sort() : [];
test.after(() => rmSync(MEMORY_ROOT, { recursive: true, force: true }));

const MOMENTS: CaptureMoment[] = ["verdict", "choice", "rejection", "delivery"];
const QUOTE = `--quote "<the user's words>"`;

function workspace(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "memory-capture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "public/projects"), { recursive: true });
  return dir;
}

function bind(dir: string, playbook: string, files: Record<string, unknown> = {}) {
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  for (const [name, value] of Object.entries({
    "playbook.json": { version: 1, id: playbook, chosenAt: "2026-11-14T00:00:00Z", by: "user" },
    ...files,
  }))
    writeFileSync(path.join(dir, "pipeline", name), JSON.stringify(value));
}

function cli(script: string, args: string[], cwd: string) {
  const run = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], {
    cwd,
    env: { ...process.env, AGENTBROS_MEMORY_ROOT: MEMORY_ROOT },
    encoding: "utf8",
    timeout: 60000,
  });
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `${script}: one JSON line\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(lines[0]!);
}

// --- The builder ---

test("each moment's templates: the user's words for verdicts, choices and lessons, a measured episode for a delivery", () => {
  const scope = { project: "demo", playbook: "product-promo", step: "concept", platform: "tiktok" };
  const verdict = captureFor("verdict", scope);
  assert.deepEqual(verdict.commands, [
    `pnpm memory --add --type <decision|preference|lesson> --summary "<one line, no brand>" ${QUOTE} --playbook product-promo --step concept --platform tiktok`,
  ]);
  assert.match(verdict.hint, /only the user's own words/);
  assert.match(verdict.hint, /acceptance without words is an episode, not a lesson/);
  assert.match(verdict.hint, /Leaf agents propose; the orchestrator writes/);
  assert.deepEqual(captureFor("choice", scope).commands, [
    `pnpm memory --add --type <decision|preference> --summary "<one line, no brand>" ${QUOTE} --playbook product-promo --step concept --platform tiktok`,
  ]);
  const rejection = captureFor("rejection", scope);
  assert.deepEqual(rejection.commands, [
    `pnpm memory --query "<what was rejected>" --playbook product-promo --step concept`,
    `pnpm memory --seen <observation or gap id> --evidence "<the user's words>"`,
    `pnpm memory --add --type lesson --summary "<one line, no brand>" ${QUOTE} --playbook product-promo --step concept --platform tiktok`,
  ]);
  assert.match(rejection.hint, /observation or gap gets --seen/);
  const delivery = captureFor("delivery", { project: "demo", playbook: "product-promo", platform: "tiktok" });
  assert.deepEqual(delivery.commands, [
    `pnpm memory --query "<film>" --type episode --project demo`,
    `pnpm memory --add --type episode --summary "<one line, no brand>" --measured "<delivery check report>" --project demo --playbook product-promo --platform tiktok`,
    "pnpm memory --consolidate",
  ]);
  assert.doesNotMatch(delivery.commands.join(" "), /--quote/, "an episode is measured, never quoted");
  for (const moment of MOMENTS) assert.equal(captureFor(moment, scope).moment, moment);
});

test("unknown scope flags are left out: no --playbook for an unbound project, no step on a delivery", (t) => {
  for (const moment of MOMENTS)
    assert.doesNotMatch(captureFor(moment, { project: "x" }).commands.join(" "), /--playbook|--step|--platform/);
  const root = workspace(t);
  const dir = path.join(root, "public/projects/promo");
  bind(dir, "product-promo", { "strategy.json": { platform: { name: "Reels" } } });
  assert.deepEqual(captureFields(dir, undefined, "concept"), {}, "no moment, no field");
  assert.match(
    captureFields(dir, "verdict", "concept").capture!.commands[0]!,
    /--playbook product-promo --step concept --platform instagram-reels$/,
  );
  assert.deepEqual(captureFields(dir, "delivery", "human", { project: "promo-recut" }), {}, "no delivery check yet");
  const report = deliveryReport(path.join(root, "public/projects/promo-recut"), "production-ready");
  const delivered = captureFields(dir, "delivery", "human", { project: "promo-recut" }).capture!;
  assert.doesNotMatch(delivered.commands.join(" "), /--step/);
  assert.match(
    delivered.commands[1]!,
    new RegExp(`--measured "${report}" --project promo-recut --playbook product-promo --platform instagram-reels$`),
  );
});

/** A delivery check report as `delivery --action check` writes it; `later` makes it the newest. */
function deliveryReport(projectDir: string, state: string, name = `snap-${state}`, later = 0): string {
  const dir = path.join(projectDir, "pipeline/delivery/reports");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, state }));
  const time = new Date(Date.now() + later);
  utimesSync(file, time, time);
  return `public/projects/${path.basename(projectDir)}/pipeline/delivery/reports/${name}.json`;
}

test("a delivery capture needs the project's newest delivery check to have passed", (t) => {
  const root = workspace(t);
  const dir = path.join(root, "public/projects/promo");
  bind(dir, "product-promo");
  assert.equal(passedDeliveryReport(dir), undefined, "no reports");
  deliveryReport(dir, "blocked");
  assert.equal(passedDeliveryReport(dir), undefined, "blocked");
  assert.deepEqual(captureFields(dir, "delivery", null), {});
  const passed = deliveryReport(dir, "production-ready", "snap-passed", 5000);
  assert.equal(passedDeliveryReport(dir), passed);
  assert.equal(captureFields(dir, "delivery", null).capture?.moment, "delivery");
  deliveryReport(dir, "blocked", "snap-publication-failed", 10000);
  assert.equal(passedDeliveryReport(dir), undefined, "a newer failed check wins");
  deliveryReport(dir, "draft-needs-review", "snap-study", 15000);
  assert.deepEqual(captureFields(dir, "delivery", null), {}, "a study-only replica's check is never production-ready");
});

test("the whole capture stays under 700 characters with the longest playbook, step, platform and project ids", () => {
  const longest = (values: readonly string[]) => values.reduce((a, b) => (b.length > a.length ? b : a));
  const steps = [...FILM_CHAIN.map((step) => step.id), ...Object.values(STEP).map(([id]) => id), ...PIPELINE_STAGES];
  const scope = {
    project: "a-long-project-id-for-the-cap-check",
    measured: `public/projects/a-long-project-id-for-the-cap-check/pipeline/delivery/reports/${"f".repeat(64)}-${"0".repeat(36)}.json`,
    playbook: longest(listPlaybookIds()),
    step: longest(steps),
    platform: longest(PlaybookPlatformSchema.options),
  };
  for (const moment of MOMENTS) {
    const size = JSON.stringify(captureFor(moment, scope)).length;
    assert.ok(size <= 700, `${moment}: ${size} characters`);
  }
});

test("footage: the plan and shorts approvals are verdicts, a plan changed after approval a rejection, choices and done a delivery", () => {
  const none = { request: null };
  const approved = { request: { approvedEditHash: "a".repeat(64) } } as unknown as Parameters<
    typeof footageCaptureMoment
  >[1];
  assert.equal(footageCaptureMoment({ action: "ask", step: "4-approve" }, none), "verdict");
  assert.equal(footageCaptureMoment({ action: "ask", step: "4-approve" }, approved), "rejection");
  assert.equal(footageCaptureMoment({ action: "ask", step: "6-shorts" }, none), "verdict");
  assert.equal(footageCaptureMoment({ action: "ask", step: "5-captions" }, none), "choice");
  assert.equal(
    footageCaptureMoment(
      { action: "ask", step: "1-transcript", userDecides: ["Paid transcription and its budget"] },
      none,
    ),
    "choice",
  );
  assert.equal(
    footageCaptureMoment({ action: "ask", step: "1-transcript" }, none),
    undefined,
    "a fact (the spoken language) is not a choice to remember",
  );
  assert.equal(footageCaptureMoment({ action: "ask", step: "0-source" }, none), undefined);
  assert.equal(footageCaptureMoment({ action: "stop", step: "done" }, none), "delivery");
  assert.equal(
    footageCaptureMoment({ action: "stop", step: "0-source" }, none),
    undefined,
    "a stop on a broken source is no delivery",
  );
  for (const action of ["run", "agent-task"] as const)
    assert.equal(footageCaptureMoment({ action, step: "6-shorts" }, none), undefined);
});

test("footage:next and next carry the goals choice of a bound recording", (t) => {
  const root = workspace(t);
  bind(path.join(root, "public/projects/talk"), "footage-edit");
  const footage = cli("scripts/footage-next.ts", ["--project", "talk", "--no-save"], root).metadata;
  assert.equal(footage.step, "setup");
  assert.equal(footage.capture.moment, "choice");
  assert.match(footage.capture.commands[0], /--playbook footage-edit --step setup$/);
  assert.deepEqual(cli("scripts/next.ts", ["--project", "talk"], root).metadata.next.capture, footage.capture);
});

// --- Film ---

function film(t: TestContext) {
  const root = workspace(t);
  assert.equal(cli("scripts/film-init.ts", ["--project", "film"], root).ok, true);
  const dir = path.join(root, "public/projects/film");
  bind(dir, "explainer");
  const pipeline = path.join(dir, "pipeline");
  const project = () => openFilmProject(dir, { rootDir: root });
  const place = (...files: string[]) =>
    files.forEach((file) => copyFileSync(path.join(FIXTURES, file), path.join(pipeline, file)));
  const blob = (relative: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  };
  return {
    root,
    dir,
    pipeline,
    project,
    place,
    blob,
    seal: (id: string) => sealStep(project(), id),
    approve: (id: string) => approveStep(project(), id, `yes to ${id}`),
  };
}

test("film: a dispatch has no capture; an approval gate is a verdict, through film:next and next alike", (t) => {
  const f = film(t);
  assert.equal(nextAction(f.project()).action, "dispatch");
  assert.equal(nextAction(f.project()).capture, undefined);
  f.place("brief.json");
  f.seal("intake");
  const viaFilm = cli("scripts/film-next.ts", ["--project", "film"], f.root).metadata;
  assert.deepEqual([viaFilm.action, viaFilm.step, viaFilm.capture.moment], ["ask", "intake", "verdict"]);
  assert.match(viaFilm.capture.commands[0], /--playbook explainer --step intake/);
  const viaNext = cli("scripts/next.ts", ["--project", "film"], f.root).metadata;
  assert.deepEqual(viaNext.next.capture, viaFilm.capture);
  assert.equal(viaNext.capture, undefined);
  f.approve("intake");
  assert.equal(nextAction(f.project()).capture, undefined, "answered: the next step is an agent's");
});

test("film: the concept pick is a choice, the human verdict a verdict, and the closed chain a delivery", (t) => {
  const f = film(t);
  f.place("brief.json");
  f.seal("intake");
  f.approve("intake");
  f.place("product-truth.json");
  f.seal("truth");
  f.place("film-targets.json");
  f.seal("reference");
  toConceptApproved(
    { dir: f.dir, seal: f.seal, approve: (id) => (id === "concept" ? undefined : f.approve(id)) },
    "film",
  );
  const concept = nextAction(f.project());
  assert.deepEqual([concept.action, concept.step, concept.capture?.moment], ["ask", "concept", "choice"]);
  f.approve("concept");

  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  mkdirSync(path.join(f.dir, "music"), { recursive: true });
  copyFileSync(path.join(FIXTURES, "track.wav"), path.join(f.dir, "music/track.wav"));
  f.place("music-shortlist.json", "music-decision.json");
  f.seal("music");
  f.approve("music");
  f.place("audio-map.json");
  f.seal("audio-map");
  toScriptPicked(f, "film");
  f.seal("script");
  f.approve("script");
  f.place("design.json");
  f.blob("public/projects/film/pipeline/look/styleframes.png", "frames");
  f.seal("look");
  const critique = (renderSha256: string) => {
    const entry = { score: 5, note: "AUTHOR-FREE", evidence: ["frame 10"] };
    return {
      schemaVersion: 1,
      round: 1,
      renderSha256,
      framesReviewed: [{ path: "frame.png", note: "seen" }],
      scores: {
        idea: entry,
        hook: entry,
        motion: entry,
        rhythm: entry,
        typography: entry,
        composition: entry,
        ending: entry,
      },
      verdict: "approve-for-human",
      actions: [],
    };
  };
  mkdirSync(path.join(f.pipeline, "critique"), { recursive: true });
  writeFileSync(path.join(f.pipeline, "critique/look-round-1.json"), JSON.stringify(critique(sha("frames"))));
  f.place("motion-plan.json", "cue-sheet.json", "plan-check.json");
  f.seal("beat-sheet");
  f.blob("out/film/animatic.mp4", "animatic");
  f.seal("animatic");
  f.approve("animatic");
  f.place("build.json", "motion-check.json");
  f.seal("build");
  f.place("mix-plan.json", "mix-report.json");
  f.blob("public/projects/film/audio/master.wav", "master");
  f.seal("sound");
  f.blob("out/film/film.mp4", "render");
  writeFileSync(
    path.join(f.pipeline, "film-measure.json"),
    JSON.stringify({ schemaVersion: 1, renderSha256: sha("render"), verdict: "pass", legs: [] }),
  );
  f.seal("measure");
  writeFileSync(path.join(f.pipeline, "critique/round-1.json"), JSON.stringify(critique(sha("render"))));
  const human = nextAction(f.project());
  assert.deepEqual([human.action, human.step, human.capture?.moment], ["ask", "human", "verdict"]);
  f.approve("human");
  assert.deepEqual(
    [nextAction(f.project()).action, nextAction(f.project()).capture],
    ["stop", undefined],
    "closed, but no delivery check has passed",
  );
  const report = deliveryReport(f.dir, "production-ready");
  const closed = nextAction(f.project());
  assert.equal(closed.action, "stop");
  assert.equal(closed.capture?.moment, "delivery");
  assert.ok(closed.capture!.commands[1]!.includes(`--measured "${report}"`));
  assert.match(closed.capture!.commands[1]!, /--project film --playbook explainer/);
  assert.ok(closed.capture!.commands.includes("pnpm memory --consolidate"));
});

test("no test here wrote the checkout's memory/", () => {
  const after = existsSync(REAL_MEMORY) ? readdirSync(REAL_MEMORY, { recursive: true }).map(String).sort() : [];
  assert.deepEqual(
    after.filter((file) => !file.endsWith(".lock")),
    realBefore.filter((file) => !file.endsWith(".lock")),
  );
  assert.ok(readFileSync(path.join(REPO, "memory/AGENTS.md"), "utf8").length > 0);
});

test("the filled templates of every moment pass pnpm memory", (t) => {
  const root = workspace(t);
  const env = { ...process.env, AGENTBROS_MEMORY_ROOT: path.join(root, "memory") };
  const run = (argv: string[]) => {
    const result = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/memory.ts"), ...argv], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 60000,
    });
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { ok: boolean; message?: string; outputs: string[] };
  };
  const observation = run([
    "--add",
    "--type",
    "observation",
    "--summary",
    "The brief named two audiences",
    "--agent",
    "tester",
    "--evidence",
    "fixture",
  ]);
  assert.equal(observation.ok, true, observation.message ?? "");
  const observationId = path.basename(observation.outputs[0]!, ".md");
  let serial = 0;
  const fill = (command: string) => {
    const filled = command
      .replace("<decision|preference|lesson>", "decision")
      .replace("<decision|preference>", "preference")
      .replace("<one line, no brand>", `Filled summary number ${++serial} for the check`)
      .replace("<observation or gap id>", observationId)
      .replace(/<[^>]+>/g, "words");
    return [...filled.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!).slice(2);
  };
  const cases: [CaptureMoment, string | undefined][] = [
    ["verdict", "4-approve"],
    ["choice", "setup"],
    ["choice", "3-recut-plan"],
    ["rejection", "brief"],
    ["delivery", undefined],
  ];
  for (const [moment, step] of cases) {
    for (const command of captureFor(moment, {
      project: "demo",
      playbook: "footage-edit",
      platform: "tiktok",
      ...(step ? { step } : {}),
    }).commands) {
      const result = run(fill(command));
      assert.equal(result.ok, true, `${moment}: ${command}\n${result.message}`);
    }
  }
});
