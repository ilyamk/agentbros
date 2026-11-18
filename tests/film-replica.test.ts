import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FILM_CHAIN } from "../src/lib/film/chain";
import { buildBrief } from "../src/lib/film/brief";
import { replicaPublicationBlock } from "../src/lib/delivery/replica-rights";
import { chainFor, resolveRoute } from "../src/lib/film/routes";
import {
  approveStep,
  deriveChain,
  nextAction,
  openFilmProject,
  sealStep,
  type FilmProject,
  type StepStatus,
} from "../src/lib/film/state";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
const LIBRARY_SOURCE = path.join(REPO, "design-reference/library/firecrawl");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const ID = "film";
const REFERENCE = "firecrawl";
const ROUTE = [
  "intake",
  "rights",
  "replica-reference",
  "replica-spec",
  "music",
  "audio-map",
  "material",
  "build",
  "sound",
  "replica-compare",
  "human",
];

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

function cli(root: string, script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], { cwd: root, encoding: "utf8" });
  const line = result.stdout.trim().split("\n").at(-1) ?? "{}";
  return {
    status: result.status,
    json: JSON.parse(line) as {
      ok: boolean;
      error?: string;
      message?: string;
      outputs: string[];
      metadata: Record<string, any>;
    },
  };
}

function setup(t: TestContext, type = "replica") {
  const root = mkdtempSync(path.join(tmpdir(), "film-replica-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = cli(root, "scripts/film-init.ts", "--project", ID, "--type", type);
  assert.equal(init.status, 0, JSON.stringify(init.json));
  const dir = path.join(root, "public/projects", ID);
  const pipeline = path.join(dir, "pipeline");
  const project = (): FilmProject => openFilmProject(dir, { rootDir: root });
  const write = (relative: string, content: string | object) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  };
  const inPipeline = (file: string) => path.relative(root, path.join(pipeline, file));
  const status = (id: string): StepStatus => deriveChain(project()).steps.find((step) => step.id === id)!.status;
  const reasons = (id: string) =>
    deriveChain(project())
      .steps.find((step) => step.id === id)!
      .reasons.join(" ");
  const seal = (id: string) => sealStep(project(), id);
  const approve = (id: string) => approveStep(project(), id, `yes to ${id}`);
  const brief = { ...JSON.parse(readFileSync(path.join(FIXTURES, "brief.json"), "utf8")), filmType: type };
  write(inPipeline("brief.json"), brief);
  return { root, dir, pipeline, init, project, write, inPipeline, status, reasons, seal, approve };
}

type Film = ReturnType<typeof setup>;

/** A library entry with every measured and judged layer, from a tracked reference's JSON; media are not needed. */
function placeReference(film: Film, rights: string) {
  const target = path.join(film.root, "design-reference/library", REFERENCE);
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(LIBRARY_SOURCE).filter((file) => file.endsWith(".json")))
    cpSync(path.join(LIBRARY_SOURCE, name), path.join(target, name));
  const source = JSON.parse(readFileSync(path.join(target, "source.json"), "utf8"));
  writeFileSync(
    path.join(target, "source.json"),
    JSON.stringify({ ...source, rights: { status: rights, note: "the user's words" } }),
  );
  const targets = JSON.parse(readFileSync(path.join(FIXTURES, "film-targets.json"), "utf8"));
  delete targets.reason;
  film.write(film.inPipeline("film-targets.json"), { ...targets, source: "reference", referenceId: REFERENCE });
}

const spec = (rights: string) => ({
  reference: REFERENCE,
  fps: 30,
  format: "vertical",
  rights: { status: rights, userStatement: "It is our own launch film", askedAt: "2026-11-13T00:00:00.000Z" },
  swaps: [
    {
      what: "logo",
      from: "the reference's logo",
      to: "the user's logo",
      why: "another owner's brand is never copied",
      shots: ["r1"],
    },
  ],
  shots: [
    {
      id: "r1",
      referenceShot: "s001",
      startFrame: 0,
      durationFrames: 30,
      colour: { L: 50, a: 0, b: 0 },
      confidence: "measured",
    },
  ],
  rounds: [],
});

function toSpecApproved(film: Film, rights = "owned") {
  film.seal("intake");
  film.approve("intake");
  assert.equal(
    cli(
      film.root,
      "scripts/film-rights.ts",
      "--project",
      ID,
      "--status",
      rights,
      "--answer",
      "It is our own launch film",
    ).status,
    0,
  );
  film.seal("rights");
  placeReference(film, rights);
  film.seal("replica-reference");
  const text = JSON.stringify(spec(rights));
  film.write(film.inPipeline("replica-spec.json"), text);
  film.write(film.inPipeline("replica-shots.json"), { shots: [{ id: "r1", startSec: 0, endSec: 1 }] });
  film.write(film.inPipeline("replica-check.json"), {
    ok: true,
    metadata: { passed: true, issues: [], specSha256: sha(text) },
    elapsedMs: 1,
  });
  film.seal("replica-spec");
  film.approve("replica-spec");
}

function toBuilt(film: Film, rights = "owned") {
  toSpecApproved(film, rights);
  mkdirSync(path.join(film.dir, "music"), { recursive: true });
  copyFileSync(path.join(FIXTURES, "track.wav"), path.join(film.dir, "music/track.wav"));
  for (const file of ["music-shortlist.json", "music-decision.json", "audio-map.json"])
    copyFileSync(path.join(FIXTURES, file), path.join(film.pipeline, file));
  film.seal("music");
  film.approve("music");
  film.seal("audio-map");
  const asset = path.relative(film.root, path.join(film.dir, "assets/capture/home.mp4"));
  film.write(asset, "frames");
  film.write(film.inPipeline("material.json"), {
    schemaVersion: 1,
    filmType: "replica",
    items: [
      {
        id: "home",
        shots: ["r1"],
        what: "the user's home screen in place of the reference's app",
        kind: "ui-capture",
        route: "capture",
        status: "acquired",
        path: asset,
        provenance: "capture:app of the staging app",
        licence: "own product",
      },
    ],
  });
  film.seal("material");
  film.approve("material");
  for (const file of ["build.json", "motion-check.json", "mix-plan.json", "mix-report.json"])
    copyFileSync(path.join(FIXTURES, file), path.join(film.pipeline, file));
  film.seal("build");
  film.write(path.relative(film.root, path.join(film.dir, "audio/master.wav")), "master");
  film.seal("sound");
}

const counts = (failed: number) => ({
  cuts: { held: 3, failed, notMeasured: 0, exempt: 0 },
  lightness: { held: 2, failed: 0, notMeasured: 0, exempt: 1 },
});
const compare = (render: string, failed: number) => ({
  ok: true,
  outputs: [],
  metadata: {
    tolerance: "replica",
    renderSha256: sha(render),
    summary: { offsetSec: 0, withinTolerance: counts(failed) },
    findings: [],
  },
  elapsedMs: 1,
});

test("the replica route: its own steps, nothing of the creative front, never a hybrid", (t) => {
  const route = resolveRoute("replica");
  assert.deepEqual(
    route.steps.map((step) => step.id),
    ROUTE,
  );
  assert.ok(!route.skipped.includes("rights"), "a replica's skipped list is what it switches off");
  for (const type of ["motion-graphics", "ui-demo", "footage"] as const) {
    const other = resolveRoute(type);
    assert.ok(
      ![...other.steps.map((step) => step.id), ...other.skipped].some((id) => /^replica-|^rights$/.test(id)),
      `${type} never sees the replica's steps`,
    );
    assert.equal(chainFor(type).length, 23, type);
  }
  assert.equal(resolveRoute("motion-graphics", "replica").secondary, undefined);
  assert.equal(resolveRoute("replica", "ui-demo").secondary, undefined);
  const build = route.steps.find((step) => step.id === "build")!;
  assert.ok(build.inputs.some((input) => input.path.endsWith("replica-spec.json")));
  assert.ok(
    !resolveRoute("ui-demo")
      .steps.find((step) => step.id === "build")!
      .inputs.some((input) => input.path.endsWith("replica-spec.json")),
  );
  assert.ok(FILM_CHAIN.filter((step) => step.onlyFor).every((step) => step.onlyFor!.includes("replica")));

  const film = setup(t);
  assert.deepEqual(film.init.json.metadata["steps"], ROUTE);
  writeFileSync(path.join(film.root, "reference.mp4"), "film");
  const withFilm = cli(
    film.root,
    "scripts/film-init.ts",
    "--project",
    "copy",
    "--type",
    "replica",
    "--product",
    "reference.mp4",
  );
  assert.equal(withFilm.status, 0, JSON.stringify(withFilm.json));
  assert.equal(withFilm.json.metadata["workflow"], undefined, "the film to copy is not footage to cut");
  assert.ok(!JSON.stringify(withFilm.json.metadata["warnings"] ?? []).includes("video:workflow"));
  for (const [type, secondary] of [
    ["replica", "ui-demo"],
    ["ui-demo", "replica"],
  ]) {
    const refused = cli(
      film.root,
      "scripts/film-init.ts",
      "--project",
      `x-${type}`,
      "--type",
      type!,
      "--secondary",
      secondary!,
    );
    assert.equal(refused.json.error, "INVALID_INPUT", `${type}+${secondary}`);
  }
});

test("a replica walks rights, measurement, spec and compare with the user's approval points", (t) => {
  const film = setup(t);
  film.write(film.inPipeline("product-sources.json"), { schemaVersion: 1, paths: ["reference.mp4"] });
  film.seal("intake");
  film.approve("intake");

  const ask = nextAction(film.project());
  assert.deepEqual([ask.action, ask.step], ["ask", "rights"]);
  assert.match(ask.question ?? "", /Who owns the film/);
  assert.deepEqual(ask.thenRun, [
    `pnpm film:rights --project ${ID} --status <owned|licensed|study-only> --answer <the user's words>`,
    `pnpm film:done --project ${ID} --step rights`,
  ]);
  assert.equal(ask.benchmarkProxy, undefined, "nobody answers the rights question for the user");
  assert.equal(film.status("replica-reference"), "blocked", "nothing is measured before the answer");
  assert.throws(() => buildBrief(film.project(), "rights"), /belongs to the user/);

  assert.equal(
    cli(film.root, "scripts/film-rights.ts", "--project", ID, "--status", "maybe", "--answer", "x").json.error,
    "INVALID_INPUT",
  );
  const rights = cli(
    film.root,
    "scripts/film-rights.ts",
    "--project",
    ID,
    "--status",
    "owned",
    "--answer",
    "It is our own launch film",
  );
  assert.equal(rights.status, 0, JSON.stringify(rights.json));
  assert.equal(nextAction(film.project()).commands?.[0], `pnpm film:done --project ${ID} --step rights`);
  film.seal("rights");

  const measure = nextAction(film.project());
  assert.deepEqual(
    [measure.action, measure.step, measure.agent],
    ["dispatch", "replica-reference", "reference-analyst"],
  );
  const analyst = buildBrief(film.project(), "replica-reference").prompt;
  assert.match(analyst, /step 3 of 27/, "numbered in the replica's own chain");
  assert.ok(analyst.includes('--rights owned --rights-note "It is our own launch film" --crop auto'));
  assert.ok(analyst.includes(".agents/skills/reference-replica/SKILL.md"));
  assert.ok(analyst.includes("product-sources.json: the material the user named, the film to copy among it"));
  placeReference(film, "study-only");
  assert.equal(film.status("replica-reference"), "failing");
  assert.match(film.reasons("replica-reference"), /rights are study-only, the user said owned/);
  placeReference(film, "owned");
  film.seal("replica-reference");

  const director = nextAction(film.project());
  assert.deepEqual([director.step, director.agent], ["replica-spec", "reference-analyst"]);
  const brief = buildBrief(film.project(), "replica-spec").prompt;
  assert.ok(
    brief.includes(
      `pnpm ref:replica-check --project ${ID} --library-root design-reference/library --write-shots > public/projects/${ID}/pipeline/replica-check.json`,
    ),
  );
  assert.ok(brief.includes(".agents/skills/reference-replica/references/replica-spec.md"));
  const text = JSON.stringify(spec("owned"));
  film.write(film.inPipeline("replica-spec.json"), text);
  film.write(film.inPipeline("replica-shots.json"), { shots: [{ id: "r1", startSec: 0, endSec: 1 }] });
  film.write(film.inPipeline("replica-check.json"), {
    ok: true,
    metadata: { passed: true, issues: [], specSha256: sha("an older spec") },
    elapsedMs: 1,
  });
  assert.equal(film.status("replica-spec"), "failing");
  assert.match(film.reasons("replica-spec"), /another spec/);
  film.write(film.inPipeline("replica-check.json"), {
    ok: true,
    metadata: { passed: false, issues: ["r1: starts at frame 3"], specSha256: sha(text) },
    elapsedMs: 1,
  });
  assert.match(film.reasons("replica-spec"), /r1: starts at frame 3/);
  film.write(film.inPipeline("replica-spec.json"), JSON.stringify(spec("study-only")));
  film.write(film.inPipeline("replica-check.json"), {
    ok: true,
    metadata: { passed: true, issues: [], specSha256: sha(JSON.stringify(spec("study-only"))) },
    elapsedMs: 1,
  });
  assert.match(film.reasons("replica-spec"), /spec's rights are study-only, the user said owned/);
  film.write(film.inPipeline("replica-spec.json"), text);
  film.write(film.inPipeline("replica-check.json"), {
    ok: true,
    metadata: { passed: true, issues: [], specSha256: sha(text) },
    elapsedMs: 1,
  });
  film.seal("replica-spec");
  const approval = nextAction(film.project());
  assert.deepEqual([approval.action, approval.step], ["ask", "replica-spec"]);
  assert.match(approval.question ?? "", /only things swapped/);
  film.approve("replica-spec");
  assert.equal(nextAction(film.project()).step, "music", "the music and voice are the user's checkpoint next");
});

test("a swaps pre-answer passes replica-spec only on the swaps the user named; otherwise the user is asked, with a warning", (t) => {
  const film = setup(t);
  film.seal("intake");
  film.approve("intake");
  const words = "It is our own launch film";
  assert.equal(
    cli(film.root, "scripts/film-rights.ts", "--project", ID, "--status", "owned", "--answer", words).status,
    0,
  );
  film.seal("rights");
  placeReference(film, "owned");
  film.seal("replica-reference");
  const text = JSON.stringify(spec("owned"));
  film.write(film.inPipeline("replica-spec.json"), text);
  film.write(film.inPipeline("replica-shots.json"), { shots: [{ id: "r1", startSec: 0, endSec: 1 }] });
  film.write(film.inPipeline("replica-check.json"), {
    ok: true,
    metadata: { passed: true, issues: [], specSha256: sha(text) },
    elapsedMs: 1,
  });
  film.seal("replica-spec");
  const grant = (swaps: string) =>
    cli(
      film.root,
      "scripts/film-policy.ts",
      "--project",
      ID,
      "--autonomy",
      "autonomous",
      "--answer",
      "Swap only the logo, go on.",
      "--pre-answer",
      `swaps=${swaps}`,
    );
  assert.equal(grant("logo, end card").status, 0);
  const asked = nextAction(film.project());
  assert.deepEqual([asked.action, asked.step], ["ask", "replica-spec"]);
  assert.match(asked.advisories?.join(" ") ?? "", /swaps pre-answer was ignored: .*not in the spec: end card/);
  assert.equal(grant("logo").status, 0);
  const passed = nextAction(film.project());
  assert.deepEqual([passed.action, passed.step], ["run", "replica-spec"]);
  assert.deepEqual(passed.policy?.evidence.preAnswer, "swaps");
  assert.equal(
    passed.commands?.[0],
    `pnpm film:approve --project ${ID} --step replica-spec --policy --expect ${sha(text)}`,
  );
  const approve = cli(
    film.root,
    "scripts/film-approve.ts",
    "--project",
    ID,
    "--step",
    "replica-spec",
    "--policy",
    "--expect",
    sha(text),
  );
  assert.equal(approve.status, 0, JSON.stringify(approve.json));
  assert.equal(nextAction(film.project()).step, "music");
});

test("the replica's compare loop: render, compare at the replica tolerances, fixer within five rounds, then the user", (t) => {
  const film = setup(t);
  toBuilt(film);
  const build = buildBrief(film.project(), "build").prompt;
  assert.ok(
    buildBrief(film.project(), "material").prompt.includes("replica-spec.json: the approved replica spec: each swap"),
    "material sources the spec's swaps",
  );
  assert.ok(
    buildBrief(film.project(), "sound").prompt.includes(
      "replica-spec.json: the approved replica spec: each shot's cues",
    ),
    "sound times to the spec's cues",
  );
  assert.ok(build.includes("replica-spec.json: the approved replica spec"), "the build reads the spec");
  assert.ok(build.includes("docs/real-ui.md"));

  const run = nextAction(film.project());
  assert.deepEqual([run.action, run.step], ["run", "replica-compare"]);
  assert.ok(
    run.commands?.some(
      (command) =>
        command ===
        `pnpm ref:compare --id ${REFERENCE} --render out/${ID}/film.mp4 --render-shots public/projects/${ID}/pipeline/replica-shots.json --tolerance replica --project ${ID} --library-root design-reference/library > public/projects/${ID}/pipeline/replica-compare.json`,
    ),
    JSON.stringify(run.commands),
  );

  film.write(`out/${ID}/film.mp4`, "render-1");
  film.write(film.inPipeline("replica-compare.json"), compare("render-1", 2));
  assert.equal(film.status("replica-compare"), "failing");
  assert.match(film.reasons("replica-compare"), /cuts: 2 shot\(s\) outside the replica tolerance/);
  const fix = nextAction(film.project());
  assert.deepEqual(
    [fix.agent, fix.briefCommand],
    ["fixer", `pnpm film:brief --project ${ID} --step replica-compare --role fixer`],
  );
  const fixer = buildBrief(film.project(), "replica-compare", { role: "fixer" }).prompt;
  assert.ok(
    fixer.includes("replica-compare.json: the findings") &&
      fixer.includes("--tolerance replica") &&
      fixer.includes("--step replica-compare"),
  );
  assert.ok(!fixer.includes("film:measure"), "a replica is held to the reference, not to the targets' style numbers");

  film.write(`out/${ID}/film.mp4`, "render-2");
  assert.match(film.reasons("replica-compare"), /another render/);
  for (const round of [2, 3, 4, 5]) {
    film.write(`out/${ID}/film.mp4`, `render-${round}`);
    film.write(film.inPipeline("replica-compare.json"), compare(`render-${round}`, 1));
    assert.equal(nextAction(film.project()).agent, "fixer", `round ${round}`);
    buildBrief(film.project(), "replica-compare", { role: "fixer" });
  }
  film.write(`out/${ID}/film.mp4`, "render-6");
  film.write(film.inPipeline("replica-compare.json"), compare("render-6", 1));
  const limit = nextAction(film.project());
  assert.equal(limit.action, "ask", "five fixer rounds: the user decides");
  assert.match(limit.question ?? "", /Five renders/);

  film.write(film.inPipeline("replica-compare.json"), compare("render-6", 0));
  film.seal("replica-compare");
  const human = nextAction(film.project());
  assert.deepEqual([human.action, human.step, human.show], ["ask", "human", [`out/${ID}/film.mp4`]]);
  assert.equal(human.benchmarkProxy, undefined);
});

test("film:rights refuses a film that is not a replica, and other types never list the replica's steps", (t) => {
  const film = setup(t, "ui-demo");
  assert.equal(
    cli(film.root, "scripts/film-rights.ts", "--project", ID, "--status", "owned", "--answer", "mine").json.error,
    "INVALID_INPUT",
  );
  const steps = deriveChain(film.project()).steps.map((step) => step.id);
  assert.equal(steps.length, 23);
  assert.ok(!steps.some((id) => /^replica-|^rights$/.test(id)));
  assert.throws(() => sealStep(film.project(), "rights"), /not in the ui-demo route/);
  assert.match(buildBrief(film.project(), "intake").prompt, /step 1 of 23/);
  assert.ok(!buildBrief(film.project(), "intake").prompt.includes("replica-spec"));
});

test("a study-only replica runs to the user's verdict and is never production-ready", (t) => {
  const film = setup(t);
  assert.equal(replicaPublicationBlock(film.dir), undefined, "no answer yet: not a replica's block");
  toBuilt(film, "study-only");
  assert.match(nextAction(film.project()).publication ?? "", /^Study only, not for publication/);
  film.write(`out/${ID}/film.mp4`, "render-1");
  film.write(film.inPipeline("replica-compare.json"), compare("render-1", 0));
  film.seal("replica-compare");
  const human = nextAction(film.project());
  assert.equal(human.step, "human");
  assert.match(human.question ?? "", /Study only, not for publication[\s\S]*does not make the film production-ready/);
  approveStep(film.project(), "human", "Looks right, keep it for study");
  const stop = nextAction(film.project());
  assert.equal(stop.action, "stop");
  assert.match(stop.why, /accepted the film for study\. Study only, not for publication/);
  const owned = setup(t);
  toBuilt(owned);
  assert.equal(nextAction(owned.project()).publication, undefined);
});
