import test, { type TestContext } from "node:test";
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
  writeFileSync,
} from "node:fs";
import { readAssetRegistry } from "../src/lib/assets/registry";
import { requireProject } from "../src/lib/cli";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COMMAND_SCRIPTS,
  FILM_CHAIN,
  FORBIDDEN_FOR_ALL,
  PENDING_AGENTS,
  PENDING_RULES,
  RULE_FILES,
  STEP_RULES,
  chainProblems,
  type CommandAlias,
} from "../src/lib/film/chain";
import { buildBrief, dispatchTotals, renderBrief } from "../src/lib/film/brief";
import { FILM_TYPES } from "../src/lib/film/routes";
import { PIPELINE_STAGES } from "../src/types/pipeline";
import { usageDir } from "../src/lib/library/usage";
import { takeRepeated } from "../src/lib/film/cli";
import { readUserWords } from "../src/lib/film/spine";
import {
  toConceptApproved,
  toScriptPicked,
  writeBoards,
  writeReview,
  writeStrategy,
  writeTeams,
  writeVariants,
} from "./helpers/film-studio";
import { clarifyFeedback, planFeedback, writeFeedback } from "../src/lib/feedback/apply";
import { planFrameFeedback } from "../src/lib/feedback/frame";
import { buildPool, pickIdeas, pickScript, poolReopens, rankLatest, reopensFile } from "../src/lib/film/studio";
import {
  FILM_FINDING_CODES,
  approveStep,
  baseTokens,
  deriveChain,
  fill,
  filmFindings,
  nextAction,
  openFilmProject,
  renderCommand,
  sealStep,
  skipStep,
  type FilmProject,
  type StepStatus,
} from "../src/lib/film/state";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const ID = "film";

/** Scripts that the parallel tasks A1, A2 and A3 add. Their flags are checked as soon as they exist. */
const PENDING_SCRIPTS: CommandAlias[] = [
  "audio:map",
  "edit:snap",
  "edit:plan",
  "music:backtime",
  "music",
  "sfx:library",
  "film:targets",
  "film:measure",
  "plan:check",
  "critic:pack",
  "film:render",
  "film:stills",
];

function cli(root: string, script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], { cwd: root, encoding: "utf8" });
  const line = result.stdout.trim().split("\n").at(-1) ?? "{}";
  return {
    status: result.status,
    stderr: result.stderr,
    json: JSON.parse(line) as {
      ok: boolean;
      error?: string;
      message?: string;
      outputs: string[];
      metadata: Record<string, any>;
    },
  };
}

type Temp = ReturnType<typeof setup>;

function setup(t: TestContext, profile?: "promo", briefFields: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "film-chain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = cli(root, "scripts/film-init.ts", "--project", ID);
  assert.equal(init.status, 0, JSON.stringify(init.json));
  const dir = path.join(root, "public/projects", ID);
  const project = (): FilmProject => openFilmProject(dir, { rootDir: root });
  const pipeline = path.join(dir, "pipeline");
  const place = (...files: string[]) => {
    for (const file of files) {
      copyFileSync(path.join(FIXTURES, file), path.join(pipeline, file));
      if (file === "brief.json" && (profile || Object.keys(briefFields).length))
        writeFileSync(
          path.join(pipeline, file),
          JSON.stringify({
            ...JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")),
            ...(profile ? { profile } : {}),
            ...briefFields,
          }),
        );
    }
  };
  const blob = (relative: string, content: string) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const edit = (file: string, change: (json: Record<string, any>) => void) => {
    const target = path.join(pipeline, file);
    const json = JSON.parse(readFileSync(target, "utf8")) as Record<string, any>;
    change(json);
    writeFileSync(target, JSON.stringify(json));
  };
  const status = (id: string): StepStatus => deriveChain(project()).steps.find((step) => step.id === id)!.status;
  const seal = (id: string) => sealStep(project(), id);
  const approve = (id: string) => approveStep(project(), id, `yes to ${id}`);
  return { root, dir, pipeline, project, place, blob, edit, status, seal, approve };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function toMusicApproved(film: Temp) {
  film.place("brief.json");
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
}

function toScriptApproved(film: Temp) {
  toMusicApproved(film);
  film.place("audio-map.json");
  film.seal("audio-map");
  toScriptPicked(film, ID);
  film.seal("script");
  film.approve("script");
}

const critique = (round: number, renderSha256: string, verdict: string, score = 3) => {
  const entry = { score, note: "AUTHOR-FREE", evidence: ["frame 10"] };
  return {
    schemaVersion: 1,
    round,
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
    verdict,
    actions: verdict === "revise" ? ["Hold the first frame longer"] : [],
  };
};

const writeCritique = (film: Temp, name: string, value: unknown) => {
  mkdirSync(path.join(film.pipeline, "critique"), { recursive: true });
  writeFileSync(path.join(film.pipeline, "critique", name), JSON.stringify(value));
};

const measureFor = (renderText: string, verdict: "pass" | "fail") => ({
  schemaVersion: 1,
  renderSha256: sha(renderText),
  verdict,
  legs: verdict === "fail" ? [{ id: "cuts", status: "fail", value: 1, message: "too few cuts", evidence: [] }] : [],
});

function toBeatSheet(film: Temp, plan?: (json: Record<string, any>) => void) {
  toScriptApproved(film);
  film.place("design.json");
  film.blob(path.join(path.relative(film.root, film.pipeline), "look/styleframes.png"), "frames");
  film.seal("look");
  writeCritique(film, "look-round-1.json", critique(1, sha("frames"), "approve-for-human"));
  film.place("motion-plan.json", "cue-sheet.json", "plan-check.json");
  if (plan) film.edit("motion-plan.json", plan);
  film.seal("beat-sheet");
}

function toMeasured(film: Temp, renderText = "render-1") {
  toBeatSheet(film);
  film.blob(`out/${ID}/animatic.mp4`, "animatic");
  film.seal("animatic");
  film.approve("animatic");
  film.place("build.json", "motion-check.json");
  film.seal("build");
  film.place("mix-plan.json", "mix-report.json");
  film.blob(path.join(path.relative(film.root, film.dir), "audio/master.wav"), "master");
  film.seal("sound");
  film.blob(`out/${ID}/film.mp4`, renderText);
  writeFileSync(path.join(film.pipeline, "film-measure.json"), JSON.stringify(measureFor(renderText, "pass")));
  film.seal("measure");
}

// --- The chain as data ---

test("the chain's twenty-three steps, in order, with their owners and gates", () => {
  assert.deepEqual(
    FILM_CHAIN.filter((step) => !step.onlyFor).map((step) => [step.id, step.owner, step.gate]),
    [
      ["intake", "brief-collector", "user"],
      ["truth", "concept-director", "none"],
      ["reference", "reference-analyst", "none"],
      ["strategy", "strategist", "user"],
      ["discovery", "category-scout", "none"],
      ["ideas", "concept-director", "none"],
      ["idea-review", "script", "critic"],
      ["concept", "creative-director", "user"],
      ["music", "sound-director", "user"],
      ["audio-map", "script", "none"],
      ["script-variants", "script-writer", "none"],
      ["script-review", "script", "critic"],
      ["script", "script", "user"],
      ["narration", "narrator-director", "user"],
      ["material", "asset-planner", "user"],
      ["look", "design-director", "critic"],
      ["beat-sheet", "motion-director", "measure"],
      ["animatic", "motion-engineer", "user"],
      ["build", "motion-engineer", "measure"],
      ["sound", "sound-director", "measure"],
      ["measure", "script", "measure"],
      ["critic", "creative-critic", "critic"],
      ["human", "user", "user"],
    ],
  );
  assert.deepEqual(chainProblems(), []);
});

test("every step has its own forbidden moves, and the shared ones forbid composing a brief", () => {
  for (const step of FILM_CHAIN) assert.ok(step.forbidden.length, step.id);
  assert.ok(FORBIDDEN_FOR_ALL.some((line) => /must not add technique lists/.test(line) && /fixed topic/.test(line)));
});

test("agent definitions: absent ones are listed as pending, present ones are strict", () => {
  const owners = new Set(
    FILM_CHAIN.map((step) => step.owner).filter((owner) => owner !== "script" && owner !== "user"),
  );
  owners.add("fixer");
  for (const agent of owners) {
    const file = path.join(REPO, ".agents/agents", `${agent}.md`);
    if (!existsSync(file)) {
      assert.ok(
        (PENDING_AGENTS as readonly string[]).includes(agent),
        `${agent} has no definition and is not listed as pending`,
      );
      continue;
    }
    assert.match(readFileSync(file, "utf8"), new RegExp(`^name: ${agent}$`, "m"), `${agent}: frontmatter name`);
  }
  for (const agent of PENDING_AGENTS)
    assert.equal(
      existsSync(path.join(REPO, ".agents/agents", `${agent}.md`)),
      false,
      `${agent} now exists: remove it from PENDING_AGENTS`,
    );
});

test("rule files: absent ones are listed as pending", () => {
  for (const file of RULE_FILES) {
    if (!existsSync(path.join(REPO, file))) assert.ok((PENDING_RULES as readonly string[]).includes(file), file);
  }
});

test("command templates use only flags their script declares, once the script exists", () => {
  const used = new Map<CommandAlias, Set<string>>();
  for (const step of FILM_CHAIN) {
    for (const command of [...step.commands, ...(step.firstAsk ? [step.firstAsk.thenRun] : [])]) {
      const flags = used.get(command.alias) ?? new Set<string>();
      for (const flag of Object.keys(command.args)) flags.add(flag);
      used.set(command.alias, flags);
    }
  }
  for (const [alias, flags] of used) {
    const script = COMMAND_SCRIPTS[alias];
    if (!existsSync(path.join(REPO, script))) {
      assert.ok(PENDING_SCRIPTS.includes(alias), `${alias}: ${script} is absent and not listed as pending`);
      continue;
    }
    const help = spawnSync(process.execPath, [TSX, path.join(REPO, script), "--help"], { cwd: REPO, encoding: "utf8" });
    const known = new Set([...help.stderr.matchAll(/--([a-z0-9-]+)/g)].map((match) => match[1]));
    for (const flag of flags) assert.ok(known.has(flag), `${alias} has no --${flag}`);
  }
});

test("the music and the reference are first-class inputs from the script step on", () => {
  const start = FILM_CHAIN.findIndex((step) => step.id === "script");
  const makers = FILM_CHAIN.slice(start).filter(
    (step) => !step.onlyFor && !["narration", "measure", "critic", "human"].includes(step.id),
  );
  assert.equal(makers.length, 7, "the voice step reads only the music it sits over");
  for (const step of makers) {
    const inputs = step.inputs.map((input) => input.path);
    for (const needed of [
      "{dir}/pipeline/music-decision.json",
      "{dir}/pipeline/audio-map.json",
      "{musicFile}",
      "{dir}/pipeline/film-targets.json",
      "{library}/{referenceId}/blueprint.json",
    ])
      assert.ok(inputs.includes(needed), `${step.id}: ${needed}`);
  }
});

test("film:init takes several product paths and leaves a brief the intake rule refuses", (t) => {
  assert.deepEqual(takeRepeated(["--project", "x", "--product", "a", "b", "--product=c"], "product"), {
    values: ["a", "b", "c"],
    rest: ["--project", "x"],
  });
  const root = mkdtempSync(path.join(tmpdir(), "film-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "a.md"), "a");
  writeFileSync(path.join(root, "b.md"), "b");
  const init = cli(root, "scripts/film-init.ts", "--project", ID, "--product", "a.md", "b.md");
  assert.equal(init.status, 0, init.json.message ?? "");
  const dir = path.join(root, "public/projects", ID, "pipeline");
  assert.equal(JSON.parse(readFileSync(path.join(dir, "brief.json"), "utf8")).renderMode, "bespoke");
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "product-sources.json"), "utf8")).paths, ["a.md", "b.md"]);
  assert.match(readFileSync(path.join(dir, "spine.md"), "utf8"), /^# Spine: film$/m);
  assert.equal(existsSync(path.join(dir, "pipeline-state.json")), false, "film:init writes no legacy pipeline state");
  assert.equal(cli(root, "scripts/film-init.ts", "--project", ID).json.error, "FILE_EXISTS");
  assert.equal(
    cli(root, "scripts/film-init.ts", "--project", "other", "--product", "missing.md").json.error,
    "FILE_NOT_FOUND",
  );
});

test("a project.json project with a legacy pipeline-state.json is not a film: the film commands refuse it", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "film-template-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects", ID);
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  writeFileSync(path.join(dir, "project.json"), "{}");
  writeFileSync(path.join(dir, "pipeline/pipeline-state.json"), "{}");
  assert.equal(existsSync(path.join(dir, "pipeline/brief.json")), false);
  assert.deepEqual(filmFindings(dir, { rootDir: root }), []);
  const next = cli(root, "scripts/film-next.ts", "--project", ID);
  assert.equal(next.status, 1);
  assert.equal(next.json.error, "INVALID_INPUT");
});

// --- Status ---

test("a file's presence is not enough: an empty brief and invalid JSON do not pass", (t) => {
  const film = setup(t);
  assert.equal(film.status("intake"), "failing");
  assert.match(deriveChain(film.project()).current!.reasons.join(" "), /brief.topic is empty/);
  film.place("brief.json");
  writeFileSync(path.join(film.pipeline, "product-truth.json"), "{ not json");
  assert.equal(film.status("truth"), "blocked");
  film.seal("intake");
  film.approve("intake");
  assert.equal(film.status("truth"), "invalid");
  assert.throws(() => film.seal("truth"), /not done/);
});

test("the CLI walks the project to the music step, refusing each gate until it is approved", (t) => {
  const film = setup(t);
  const next = () => cli(film.root, "scripts/film-next.ts", "--project", ID).json.metadata;
  const done = (step: string) => cli(film.root, "scripts/film-done.ts", "--project", ID, "--step", step);
  const approve = (step: string, answer = "yes") =>
    cli(film.root, "scripts/film-approve.ts", "--project", ID, "--step", step, "--answer", answer);

  let action = next();
  assert.equal(action["action"], "dispatch");
  assert.equal(action["agent"], "brief-collector");
  assert.equal(action["briefCommand"], `pnpm film:brief --project ${ID} --step intake`);
  assert.ok(action["forbidden"].some((line: string) => /technique lists/.test(line)));
  assert.ok(action["orchestratorChecks"].before.length);
  assert.equal(done("intake").json.error, "STAGE_INCOMPLETE");

  film.place("brief.json");
  assert.equal(approve("intake").json.error, "STAGE_INCOMPLETE", "approving before film:done is refused");
  action = next();
  assert.deepEqual([action["action"], action["commands"]], ["run", [`pnpm film:done --project ${ID} --step intake`]]);
  assert.equal(done("intake").status, 0);
  action = next();
  assert.equal(action["action"], "ask");
  assert.ok(action["show"].includes(`public/projects/${ID}/pipeline/brief.json`));
  assert.match(action["thenRun"][0], /film:approve/);
  assert.equal(approve("truth").json.error, "STAGE_INCOMPLETE");
  assert.equal(approve("intake", "   ").status, 1);
  for (const placeholder of [
    "<the user's words>",
    "THE USER'S WORDS",
    "TODO",
    "The user approved the brief.",
    "Is this the film you want: its goal, audience, length and format?",
  ]) {
    const refused = approve("intake", placeholder);
    assert.deepEqual([refused.status, refused.json.error], [1, "INVALID_INPUT"], placeholder);
    assert.match(refused.json.message ?? "", /the user's own words/);
  }
  assert.throws(
    () => approveStep(film.project(), "intake", "<the user's words>"),
    /own words/,
    "the library refuses a placeholder too",
  );
  assert.equal(approve("intake", "yes, that is the film").status, 0);

  assert.equal(next()["agent"], "concept-director");
  film.place("product-truth.json");
  assert.equal(approve("truth").json.error, "STAGE_INCOMPLETE", "a step without a user gate cannot be approved");
  assert.equal(done("truth").status, 0);
  assert.equal(next()["agent"], "reference-analyst");
  film.place("film-targets.json");
  assert.equal(done("reference").status, 0);

  assert.equal(next()["agent"], "strategist");
  const blockedBrief = cli(
    film.root,
    "scripts/film-brief.ts",
    "--project",
    ID,
    "--step",
    "script-variants",
    "--variant",
    "a",
  );
  assert.equal(blockedBrief.json.error, "STAGE_INCOMPLETE");
  writeStrategy(film.dir);
  assert.equal(done("strategy").status, 0);
  action = next();
  assert.deepEqual([action["action"], action["step"]], ["ask", "strategy"]);
  assert.match(action["benchmarkProxy"], /--proxy benchmark --reason/);
  assert.equal(approve("strategy", "yes, that audience").status, 0);

  action = next();
  assert.deepEqual(
    [action["action"], action["step"], action["agent"]],
    ["dispatch", "discovery", "category-scout"],
    "the category is read before any idea",
  );
  const scout = cli(film.root, "scripts/film-brief.ts", "--project", ID, "--step", "discovery", "--print").json
    .metadata["prompt"] as string;
  for (const needed of ["category-scan.json", "category terms only", "Downloading videos", "study only"])
    assert.ok(scout.includes(needed), needed);
  assert.equal(
    cli(film.root, "scripts/film-done.ts", "--project", ID, "--step", "discovery", "--skip", " ").json.error,
    "STAGE_INCOMPLETE",
    "a skip needs its reason",
  );
  assert.equal(
    cli(film.root, "scripts/film-done.ts", "--project", ID, "--step", "ideas", "--skip", "no").json.ok,
    false,
    "only a skippable step can be skipped",
  );
  const skipped = cli(
    film.root,
    "scripts/film-done.ts",
    "--project",
    ID,
    "--step",
    "discovery",
    "--skip",
    "the user wants ideas without a scan in this run",
  );
  assert.equal(skipped.json.ok, true, JSON.stringify(skipped.json));
  assert.equal(deriveChain(film.project()).steps.find((step) => step.id === "discovery")!.status, "skipped");
  assert.match(
    deriveChain(film.project()).steps.find((step) => step.id === "discovery")!.reasons[0]!,
    /Skipped: the user wants ideas without a scan/,
  );

  action = next();
  assert.deepEqual([action["action"], action["step"], action["agent"]], ["dispatch", "ideas", "concept-director"]);
  assert.deepEqual(
    action["dispatches"].map((item: { briefCommand: string }) => item.briefCommand),
    ["metaphor", "product-in-use", "provocation"].map(
      (team) => `pnpm film:brief --project ${ID} --step ideas --team ${team}`,
    ),
  );
  assert.equal(
    cli(film.root, "scripts/film-brief.ts", "--project", ID, "--step", "ideas").json.error,
    "STAGE_INCOMPLETE",
    "a team step needs --team",
  );
  const teamBrief = cli(
    film.root,
    "scripts/film-brief.ts",
    "--project",
    ID,
    "--step",
    "ideas",
    "--team",
    "metaphor",
    "--print",
  ).json;
  assert.match(teamBrief.metadata["prompt"], /You are the metaphor team/);
  assert.doesNotMatch(
    teamBrief.metadata["prompt"],
    /film:show --project/,
    "a team cannot digest the other teams' files",
  );
  assert.match(teamBrief.metadata["prompt"], /concepts\/metaphor\.json/);
  assert.doesNotMatch(
    teamBrief.metadata["prompt"],
    /concepts\/provocation\.json/,
    "a team never sees another team's path",
  );
  writeTeams(film.dir, 1);
  assert.equal(done("ideas").status, 0);
  action = next();
  assert.deepEqual(
    [action["action"], action["commands"]],
    ["run", [`pnpm creative:pool --project ${ID} --kind ideas`]],
    "the pool alone: it records the step itself",
  );
  const critic = cli(
    film.root,
    "scripts/film-brief.ts",
    "--project",
    ID,
    "--step",
    "idea-review",
    "--role",
    "critic",
  ).json;
  assert.match(
    critic.message ?? "",
    /nothing for a critic yet\. Run `pnpm creative:pool --project film --kind ideas` first/,
    "a critic too early is told the command",
  );
  const pooled = cli(film.root, "scripts/creative-pool.ts", "--project", ID, "--kind", "ideas");
  assert.equal(pooled.status, 0);
  assert.equal(pooled.json.metadata["sealed"], true);
  action = next();
  assert.deepEqual(
    [action["action"], action["agent"], action["fresh"], action["briefCommand"]],
    ["dispatch", "creative-director", true, `pnpm film:brief --project ${ID} --step idea-review --role critic`],
  );
  const director = cli(
    film.root,
    "scripts/film-brief.ts",
    "--project",
    ID,
    "--step",
    "idea-review",
    "--role",
    "critic",
    "--print",
  ).json.metadata["prompt"] as string;
  assert.match(director, /pools\/ideas\.json/);
  assert.doesNotMatch(
    director,
    /ideas-key|concepts\/[a-z]|metaphor|provocation/,
    "the director's brief names no key, team file or stance",
  );
  assert.match(director, /The frozen rubric v2 for ideas, quoted/, "a new project is scored with rubric v2");
  assert.match(director, /^- \.agents\/skills\/creative-studio\/references\/creative-rubric-v2\.md$/m);
  assert.match(director, /creative-lessons\.md/);
  writeReview(film.dir, "ideas", 1, () => 4);
  assert.equal(
    next()["commands"][0],
    `pnpm creative:rank --project ${ID} --kind ideas`,
    "an unranked review is ranked by code",
  );
  assert.equal(cli(film.root, "scripts/creative-rank.ts", "--project", ID, "--kind", "ideas").status, 0);
  action = next();
  assert.deepEqual([action["action"], action["step"], action["agent"]], ["dispatch", "concept", "creative-director"]);
  assert.equal(cli(film.root, "scripts/creative-pick.ts", "--project", ID, "--kind", "ideas").status, 0);
  writeBoards(film.dir);
  assert.equal(done("concept").status, 0);
  action = next();
  assert.equal(action["action"], "ask");
  assert.match(action["question"], /three ideas/);
  assert.ok(action["show"].includes(`public/projects/${ID}/pipeline/boards/boards.jpg`), "the user sees the boards");
  assert.equal(film.status("music"), "blocked", "the music step stays closed until the user picks an idea");
  assert.equal(
    cli(film.root, "scripts/film-brief.ts", "--project", ID, "--step", "music").json.error,
    "STAGE_INCOMPLETE",
  );
  assert.equal(approve("concept", "the first idea").status, 0);

  action = next();
  assert.deepEqual([action["step"], action["agent"]], ["music", "sound-director"]);
  film.place("music-shortlist.json");
  action = next();
  assert.equal(action["action"], "ask", "the shortlist goes to the user before any decision");
  assert.match(action["question"], /Listen/);
  assert.match(action["thenRun"][0], /pnpm music --action record --project film/);
  assert.equal(done("music").json.error, "STAGE_INCOMPLETE");
  assert.equal(approve("music").json.error, "STAGE_INCOMPLETE");

  film.place("music-decision.json");
  assert.match(done("music").json.message ?? "", /no file on disk/);
  mkdirSync(path.join(film.dir, "music"), { recursive: true });
  copyFileSync(path.join(FIXTURES, "track.wav"), path.join(film.dir, "music/track.wav"));
  assert.equal(done("music").status, 0);
  assert.equal(film.status("audio-map"), "blocked", "still closed: the gate has no approval");
  action = next();
  assert.deepEqual(
    action["commands"],
    [`pnpm film:approve --project ${ID} --step music --answer "the first one, it lifts at the end"`],
    "the user already answered, so they are not asked twice",
  );
  assert.equal(approve("music", "the first one, it lifts at the end").status, 0);

  action = next();
  assert.equal(action["action"], "run");
  assert.deepEqual(action["commands"], [
    `pnpm audio:map --input public/projects/${ID}/music/track.wav --output public/projects/${ID}/pipeline/audio-map.json --image public/projects/${ID}/pipeline/audio-map.png`,
    `pnpm film:done --project ${ID} --step audio-map`,
  ]);

  const status = cli(film.root, "scripts/film-status.ts", "--project", ID).json.metadata;
  assert.equal(status["currentStep"], "audio-map");
  assert.deepEqual(status["stale"], []);
  assert.equal(status["steps"].length, 23);
});

test("a changed music decision makes the audio map, script and everything after stale", (t) => {
  const film = setup(t);
  toBeatSheet(film);
  assert.equal(film.status("beat-sheet"), "done");
  film.edit("music-shortlist.json", (list) =>
    list["candidates"].push({
      id: "stock-3",
      route: "free-stock",
      provider: "fixture",
      title: "Three",
      originalPath: "music/track.wav",
      licence: { code: "CC0", commercial: "yes" },
    }),
  );
  film.edit("music-decision.json", (decision) => (decision["candidateId"] = "stock-3"));

  assert.equal(film.status("music"), "unsealed");
  for (const step of ["audio-map", "script", "look", "beat-sheet"]) assert.equal(film.status(step), "stale", step);
  for (const step of ["intake", "truth", "reference", "concept"]) assert.equal(film.status(step), "done", step);
  const status = cli(film.root, "scripts/film-status.ts", "--project", ID).json.metadata;
  assert.equal(status["currentStep"], "music");
  assert.deepEqual(
    status["stale"].map((item: { step: string }) => item.step),
    ["audio-map", "script-variants", "script-review", "script", "look", "beat-sheet"],
  );
  assert.match(status["stale"][0].because.join(" "), /music/);

  film.seal("music");
  assert.equal(film.status("music"), "awaiting-gate", "changing an approved artefact closes its gate again");
  film.approve("music");
  assert.equal(film.status("audio-map"), "stale");
  assert.match(
    deriveChain(film.project())
      .steps.find((step) => step.id === "audio-map")!
      .reasons.join(" "),
    /music-decision\.json changed/,
  );
  assert.equal(nextAction(film.project()).step, "audio-map");
  assert.throws(
    () => film.seal("audio-map"),
    /--unchanged-because/,
    "a stale step cannot be re-recorded without running again",
  );
  sealStep(film.project(), "audio-map", { unchangedBecause: "The user says the same file was chosen under a new id." });
  assert.ok(readUserWords(film.dir, "audio-map").some((line) => line.includes("same file")));
  assert.equal(film.status("script"), "stale", "its own input changed");
});

test("a changed choice with the old answer is asked again, not approved with the old words", (t) => {
  const film = setup(t);
  toMusicApproved(film);
  const words = "the first one, it lifts at the end";
  approveStep(film.project(), "music", words);
  film.edit("music-decision.json", (decision) => (decision["candidateId"] = "stock-1b"));
  film.edit("music-shortlist.json", (list) =>
    list["candidates"].push({
      id: "stock-1b",
      route: "free-stock",
      provider: "fixture",
      title: "One B",
      originalPath: "music/track.wav",
      licence: { code: "CC0", commercial: "yes" },
    }),
  );
  film.seal("music");
  const next = nextAction(film.project());
  assert.equal(next.action, "ask");
  assert.equal(next.commands, undefined);
});

test("a track changed on disk fails the map's done rule", (t) => {
  const film = setup(t);
  toMusicApproved(film);
  film.place("audio-map.json");
  film.seal("audio-map");
  writeFileSync(path.join(film.dir, "music/track.wav"), "another track");
  assert.equal(film.status("music"), "failing", "the decision's cut is no longer on disk");
  assert.match(
    deriveChain(film.project())
      .steps.find((step) => step.id === "music")!
      .reasons.join(" "),
    /not the cut the decision recorded/,
  );
  assert.notEqual(film.status("audio-map"), "done");
  assert.throws(() => film.seal("audio-map"), /another file|music is not closed/);
});

test("changing an approved concept closes its gate and stales the music", (t) => {
  const film = setup(t);
  toMusicApproved(film);
  assert.equal(film.status("concept"), "done");
  film.edit("concept.json", (concept) => (concept["selectedId"] = concept["candidates"][1]["id"]));
  assert.equal(film.status("concept"), "unsealed");
  film.seal("concept");
  assert.equal(film.status("concept"), "awaiting-gate");
  assert.equal(nextAction(film.project()).action, "ask");
  assert.equal(film.status("music"), "stale");
});

test("the old approve entry opens the intake gate only for a brief no newer than it", (t) => {
  const film = setup(t);
  film.place("brief.json");
  film.seal("intake");
  // A film started before film:init stopped writing pipeline-state.json keeps its old approve entries.
  const now = new Date().toISOString();
  writeFileSync(
    path.join(film.pipeline, "pipeline-state.json"),
    JSON.stringify({
      projectId: ID,
      version: "1",
      revision: 1,
      stages: Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, { status: "pending", attempts: 0 }])),
      history: [],
      createdAt: now,
      updatedAt: now,
    }),
  );
  film.edit("pipeline-state.json", (state) =>
    state["history"].push({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      stage: "brief",
      action: "approve",
    }),
  );
  assert.equal(film.status("intake"), "done");
  film.edit(
    "pipeline-state.json",
    (state) => (state["history"] = [{ timestamp: "2020-01-01T00:00:00.000Z", stage: "brief", action: "approve" }]),
  );
  assert.equal(film.status("intake"), "awaiting-gate");
});

test("an embedded track needs its original and a commercial licence; silence skips the map", (t) => {
  const film = setup(t);
  toMusicApproved(film);
  film.edit("music-decision.json", (decision) => (decision["candidateId"] = "stock-2"));
  assert.equal(film.status("music"), "failing");
  assert.match(deriveChain(film.project()).current!.reasons.join(" "), /original.*commercial use/);
  film.edit("music-decision.json", (decision) =>
    Object.assign(decision, { candidateId: undefined, route: "silence", delivery: "none" }),
  );
  film.seal("music");
  film.approve("music");
  assert.equal(film.status("audio-map"), "skipped");
  assert.equal(nextAction(film.project()).step, "script-variants");
  const brief = buildBrief(film.project(), "script-variants", { lane: "a" }).prompt;
  assert.doesNotMatch(brief, /audio-map\.json: /);
  assert.match(brief, /music-decision\.json: /);
  // Silence has no cue sheet to hold sound decisions, so sfx:cues is not asked to check cuts against the plan.
  const sfxCues = FILM_CHAIN.find((step) => step.id === "build")!.commands.find(
    (command) => command.alias === "sfx:cues",
  )!;
  const silent = renderCommand(sfxCues, baseTokens(film.project()));
  assert.doesNotMatch(silent, /--motion-plan|--cue-sheet/);
  assert.match(
    renderCommand(sfxCues, {
      ...baseTokens(film.project()),
      decidedPlan: "p/motion-plan.json",
      cueSheet: "p/cue-sheet.json",
    }),
    /--motion-plan p\/motion-plan\.json --cue-sheet p\/cue-sheet\.json/,
  );
});

// --- Briefs ---

test("a brief is the full prompt, byte-identical for the same capability snapshot, with the music and reference as inputs", (t) => {
  const film = setup(t);
  toMusicApproved(film);
  film.place("audio-map.json");
  film.seal("audio-map");
  const first = buildBrief(film.project(), "script-variants", { lane: "b" });
  const second = buildBrief(film.project(), "script-variants", { lane: "b" });
  assert.equal(first.prompt, second.prompt);
  const viaCli = cli(
    film.root,
    "scripts/film-brief.ts",
    "--project",
    ID,
    "--step",
    "script-variants",
    "--variant",
    "b",
    "--print",
  );
  const withTools = buildBrief(film.project(), "script-variants", {
    lane: "b",
    localTools: { localTools: viaCli.json.metadata["localTools"] },
  });
  assert.equal(viaCli.json.metadata["prompt"], withTools.prompt);
  assert.ok(withTools.prompt.startsWith(first.prompt), "host affordances retain the complete portable brief");
  assert.equal(readFileSync(path.join(film.root, viaCli.json.outputs[0]!), "utf8"), withTools.prompt);
  const prompt = first.prompt;
  for (const needed of [
    ".agents/agents/script-writer.md",
    "design-reference/creative-standards.md",
    "design-reference/creative-lessons.md",
    `public/projects/${ID}/pipeline/music-decision.json`,
    `public/projects/${ID}/pipeline/audio-map.json`,
    `public/projects/${ID}/music/track.wav`,
    `public/projects/${ID}/pipeline/film-targets.json`,
    `public/projects/${ID}/pipeline/scripts/b.json`,
    "You are variant b",
    "## Done when",
    "## Stop when",
    "## Report",
    "technique lists",
  ])
    assert.ok(prompt.includes(needed), needed);
  assert.doesNotMatch(prompt, /\{[a-zA-Z]+\}/);
  assert.doesNotMatch(prompt, new RegExp(film.root.replaceAll("/", "\\/")));
  assert.match(prompt, /- concept: yes to concept/, "the user's approvals travel with the brief");
});

test("each brief lists only the rules its step needs", () => {
  for (const id of Object.keys(STEP_RULES)) assert.ok(id === "fixer" || FILM_CHAIN.some((step) => step.id === id), id);
  for (const id of ["build", "animatic", "fixer"]) {
    assert.ok(STEP_RULES[id]!.includes("design-reference/craft-rules.md"), id);
    assert.ok(STEP_RULES[id]!.includes("library"), id);
    assert.ok(!STEP_RULES[id]!.some((rule) => rule === "spine" || rule.endsWith("creative-lessons.md")), id);
  }
  for (const id of ["music", "sound"]) assert.deepEqual(STEP_RULES[id], ["docs/audio-integrations.md"]);
  for (const guide of [
    "docs/audio-integrations.md",
    ".agents/skills/model-and-asset-production/SKILL.md",
    "docs/higgsfield-prompting.md",
  ])
    assert.ok(STEP_RULES.material!.includes(guide));
  for (const id of ["intake", "truth", "critic"]) assert.equal(STEP_RULES[id], undefined, id);
});

test("music is locked before the plan, the plan places blocks for cue sounds, and sound mixes them to social loudness", () => {
  const index = (id: string) => FILM_CHAIN.findIndex((step) => step.id === id);
  assert.ok(
    index("music") < index("audio-map") &&
      index("audio-map") < index("script") &&
      index("script") < index("beat-sheet"),
  );
  const beatSheet = FILM_CHAIN[index("beat-sheet")]!;
  assert.ok(beatSheet.outputs.some((output) => output.path.endsWith("cue-placements.json")));
  assert.ok(
    beatSheet.commands.some(
      (command) =>
        command.alias === "edit:snap" && command.args["cues"] !== undefined && /downbeat/.test(command.purpose),
    ),
  );
  const build = FILM_CHAIN[index("build")]!;
  assert.ok(
    build.commands.some(
      (command) => command.alias === "sfx:cues" && String(command.args["placements"]).endsWith("cue-placements.json"),
    ),
  );
  assert.ok(
    !build.commands.some((command) => command.alias === "capture:app"),
    "real UI is captured at the material step, by the ui-demo route",
  );
  const sound = FILM_CHAIN[index("sound")]!.commands;
  const cues = sound.findIndex((command) => command.alias === "sfx:cues");
  const mix = sound.findIndex((command) => command.alias === "audio:mix");
  assert.ok(cues >= 0 && cues < mix, "cue sounds are merged before the mix");
  assert.equal(sound[mix]!.args["preset"], "social");
  for (const id of ["beat-sheet", "look", "build"])
    assert.ok(
      STEP_RULES[id]!.includes("design-reference/craft-rules.md"),
      `${id} gets the block-choice and sync rules`,
    );
});

test("the film type routes the chain: material runs only for types made of outside media, and briefs carry the type's tools", (t) => {
  const untyped = setup(t);
  toScriptApproved(untyped);
  assert.equal(untyped.status("material"), "skipped", "an old brief with no type routes as motion-graphics");
  assert.equal(untyped.status("look"), "ready");
  const untypedNext = nextAction(untyped.project());
  assert.equal(untypedNext.filmType, "motion-graphics");
  assert.ok(untypedNext.advisories?.some((line) => /filmType is not set/.test(line)));
  assert.doesNotMatch(buildBrief(untyped.project(), "look").prompt, /material\.json/);
  assert.match(buildBrief(untyped.project(), "look").prompt, /Tools for a motion graphics film[\s\S]*blender-plate/);
  assert.match(
    buildBrief(untyped.project(), "intake").prompt,
    new RegExp(FILM_TYPES.map((type) => `\`${type}\``).join("[\\s\\S]*")),
  );

  const demo = setup(t, undefined, { filmType: "ui-demo" });
  toScriptApproved(demo);
  assert.equal(nextAction(demo.project()).step, "narration", "a ui demo may have a voice");
  skipStep(demo.project(), "narration", "This demo has no voice.");
  assert.equal(demo.status("material"), "ready");
  assert.equal(demo.status("look"), "blocked", "the look waits for the material");
  const next = nextAction(demo.project());
  assert.equal(next.step, "material");
  assert.equal(next.agent, "asset-planner");
  assert.equal(next.advisories, undefined);
  assert.ok(next.tools?.some((line) => line.includes("capture:app")));
  assert.match(buildBrief(demo.project(), "material").prompt, /Tools for a ui demo film \(ui-demo\)[\s\S]*capture:app/);

  const asset = path.join(path.relative(demo.root, demo.dir), "assets/capture/home.mp4");
  demo.blob(asset, "frames");
  const item = {
    id: "home",
    shots: ["b1"],
    what: "home screen",
    kind: "ui-capture",
    route: "capture",
    status: "acquired",
    path: asset,
    provenance: "capture:app of the staging app",
    licence: "own product",
  };
  writeFileSync(
    path.join(demo.pipeline, "material.json"),
    JSON.stringify({
      schemaVersion: 1,
      filmType: "ui-demo",
      items: [
        item,
        {
          ...item,
          id: "hero",
          route: "generated",
          kind: "generated-image",
          status: "pending",
          path: undefined,
          referencePlan: { mode: "none", reason: "A text-only key frame: no person, product or place to hold." },
        },
      ],
    }),
  );
  assert.equal(demo.status("material"), "failing");
  assert.match(
    deriveChain(demo.project())
      .steps.find((step) => step.id === "material")!
      .reasons.join(" "),
    /hero is generated and has no maxCostUsd/,
  );
  // AC16 (RFC 0003): without referencePlan none or a shot in references.json, the generated item names refs:plan.
  demo.edit("material.json", (material) => delete material["items"][1]["referencePlan"]);
  assert.match(
    deriveChain(demo.project())
      .steps.find((step) => step.id === "material")!
      .reasons.join(" "),
    /hero is generated and has no shot in pipeline\/references\.json: pnpm refs:plan --project \S+ --action draft --shot b1 --material-item hero/,
  );
  assert.match(
    nextAction(demo.project()).why,
    /hero is generated and has no shot in pipeline\/references\.json: pnpm refs:plan/,
  );
  demo.edit("material.json", (material) =>
    Object.assign(material["items"][1], {
      referencePlan: { mode: "none", reason: "A text-only key frame: no person, product or place to hold." },
    }),
  );
  demo.edit("material.json", (material) => (material["items"][1]["maxCostUsd"] = 0.2));
  demo.seal("material");
  assert.equal(demo.status("material"), "awaiting-gate");
  demo.approve("material");
  assert.equal(demo.status("material"), "failing", "the approved paid item must now be generated");
  assert.match(
    deriveChain(demo.project())
      .steps.find((step) => step.id === "material")!
      .reasons.join(" "),
    /hero is approved and still pending/,
  );
  assert.equal(nextAction(demo.project()).agent, "asset-planner");
  const made = path.join(path.relative(demo.root, demo.dir), "assets/generated/hero.png");
  demo.blob(made, "png");
  demo.edit("material.json", (material) =>
    Object.assign(material["items"][1], {
      status: "acquired",
      path: made,
      costUsd: 0.04,
      provenance: "generate:image flux-schnell, operation hero-1",
    }),
  );
  demo.seal("material");
  assert.equal(demo.status("material"), "awaiting-gate", "the user sees what was made");
  demo.approve("material");
  assert.equal(demo.status("material"), "done");
  assert.equal(demo.status("look"), "ready");
  assert.match(buildBrief(demo.project(), "look").prompt, /material\.json: /);
});

test("targets from a reference must name a library entry that passes, and resolve its blueprint", (t) => {
  const film = setup(t);
  film.place("brief.json");
  film.seal("intake");
  film.approve("intake");
  film.place("product-truth.json");
  film.seal("truth");
  film.place("film-targets.json");
  film.edit("film-targets.json", (targets) => Object.assign(targets, { source: "reference", referenceId: "ref-one" }));
  assert.equal(film.status("reference"), "failing");
  film.blob("design-reference/library/ref-one/notes.txt", "x");
  assert.equal(film.status("reference"), "failing");
  assert.match(deriveChain(film.project()).current!.reasons.join(" "), /measured layer/);
  assert.equal(
    fill("{library}/{referenceId}/blueprint.json", baseTokens(film.project())),
    "design-reference/library/ref-one/blueprint.json",
  );
});

test("an agent not yet defined gets a brief that says so; a defined one is told to read its file", (t) => {
  const film = setup(t);
  film.place("brief.json");
  film.seal("intake");
  film.approve("intake");
  assert.match(buildBrief(film.project(), "intake").prompt, /You are brief-collector\. Read your definition first/);
  const truth = film.project();
  assert.match(
    buildBrief(truth, "truth").prompt,
    existsSync(path.join(REPO, ".agents/agents/concept-director.md"))
      ? /Read your definition first/
      : /not in this repository yet/,
  );
});

test("--note records the user's words in the spine once, and the brief carries them", (t) => {
  const film = setup(t);
  const words = "make it feel like a morning, not a pitch";
  const first = cli(
    film.root,
    "scripts/film-brief.ts",
    "--project",
    ID,
    "--step",
    "intake",
    "--note",
    words,
    "--print",
  );
  assert.equal(first.status, 0, first.json.message ?? "");
  assert.ok(first.json.metadata["prompt"].includes(words));
  const again = cli(
    film.root,
    "scripts/film-brief.ts",
    "--project",
    ID,
    "--step",
    "intake",
    "--note",
    words,
    "--print",
  );
  assert.equal(again.json.metadata["prompt"], first.json.metadata["prompt"]);
  assert.equal(readFileSync(path.join(film.pipeline, "spine.md"), "utf8").split(words).length, 2, "recorded once");
  assert.deepEqual(readUserWords(film.dir, "intake"), [words]);
  const later = cli(film.root, "scripts/film-brief.ts", "--project", ID, "--step", "intake");
  assert.equal(later.json.metadata["prompt"], undefined, "by reference unless --print");
  assert.ok(readFileSync(path.join(film.root, later.json.metadata["brief"]), "utf8").includes(words));
});

test("a critic brief holds only the render, brief, references and pack: no author's reasoning", (t) => {
  const film = setup(t);
  toMeasured(film);
  const spine = path.join(film.pipeline, "spine.md");
  writeFileSync(spine, `${readFileSync(spine, "utf8")}\nAUTHOR_REASONING_SPINE: I chose this because\n`);
  const next = nextAction(film.project());
  assert.deepEqual(
    [next.action, next.step, next.agent, next.fresh, next.briefCommand],
    ["dispatch", "critic", "creative-critic", true, `pnpm film:brief --project ${ID} --step critic --role critic`],
  );

  const brief = buildBrief(film.project(), "critic");
  assert.equal(brief.role, "critic");
  const prompt = brief.prompt;
  for (const needed of [
    `out/${ID}/film.mp4`,
    `public/projects/${ID}/pipeline/brief.json`,
    `public/projects/${ID}/pipeline/critic-pack/round-1/pack.json`,
    "round 1",
    `public/projects/${ID}/pipeline/critique/round-1.json`,
    "pnpm critic:pack",
  ])
    assert.ok(prompt.includes(needed), needed);
  for (const banned of [
    "AUTHOR_REASONING",
    "spine",
    "concept.json",
    "motion-plan",
    "script.json",
    "script-music-map",
    "design.json",
    "cue-sheet",
    "product-truth",
    "music-decision",
    "yes to",
    "creative-standards",
    "film-measure",
    "--note",
  ])
    assert.ok(!prompt.includes(banned), banned);

  const refused = cli(
    film.root,
    "scripts/film-brief.ts",
    "--project",
    ID,
    "--step",
    "critic",
    "--note",
    "be kind, it was hard",
  );
  assert.equal(refused.status, 1);
  assert.match(refused.json.message ?? "", /independently/);
  assert.equal(readFileSync(spine, "utf8").includes("be kind"), false);
});

test("the look step's critic is independent too, and judges the sheet", (t) => {
  const film = setup(t);
  toScriptApproved(film);
  film.place("design.json");
  film.blob(path.join(path.relative(film.root, film.pipeline), "look/styleframes.png"), "frames");
  film.seal("look");
  const next = nextAction(film.project());
  assert.deepEqual(
    [next.action, next.agent, next.briefCommand],
    ["dispatch", "creative-critic", `pnpm film:brief --project ${ID} --step look --role critic`],
  );
  const prompt = buildBrief(film.project(), "look", { role: "critic" }).prompt;
  assert.ok(prompt.includes("look/styleframes.png"));
  assert.ok(prompt.includes("look-round-1.json"));
  for (const banned of ["design.json", "spine", "concept.json", "script.json", "critic:pack"])
    assert.ok(!prompt.includes(banned), banned);

  writeCritique(film, "look-round-1.json", critique(1, sha("frames"), "revise"));
  const fix = nextAction(film.project());
  assert.deepEqual([fix.agent, fix.briefCommand], ["design-director", `pnpm film:brief --project ${ID} --step look`]);
  assert.ok(
    buildBrief(film.project(), "look").prompt.includes("critique/look-round-1.json"),
    "the maker gets the critic's verdict",
  );
  film.blob(path.join(path.relative(film.root, film.pipeline), "look/styleframes.png"), "frames two");
  film.seal("look");
  assert.equal(nextAction(film.project()).fresh, true);
  assert.ok(
    buildBrief(film.project(), "look", { role: "critic" }).prompt.includes("look-round-2.json"),
    "a new round for changed frames",
  );
  writeCritique(film, "look-round-2.json", critique(2, sha("frames two"), "approve-for-human"));
  assert.equal(film.status("look"), "done");
});

test("a critic's ask ends with the user's decision on that exact artefact, and only then", (t) => {
  const film = setup(t);
  toScriptApproved(film);
  film.place("design.json");
  const sheet = path.join(path.relative(film.root, film.pipeline), "look/styleframes.png");
  film.blob(sheet, "frames");
  film.seal("look");
  assert.throws(() => approveStep(film.project(), "look", "go on"), /with its critic/);
  writeCritique(film, "look-round-1.json", critique(1, sha("frames"), "rethink-idea"));
  const ask = nextAction(film.project());
  assert.equal(ask.action, "ask");
  assert.ok(ask.thenRun?.some((command) => command.includes("film:approve")));
  approveStep(film.project(), "look", "go on");
  assert.equal(film.status("look"), "done");
  film.blob(sheet, "other frames");
  film.seal("look");
  assert.notEqual(film.status("look"), "done", "the decision covers the frames it saw");
});

test("the critic loop: fixer, new render, new critic, a limit of three, then the user decides", (t) => {
  const film = setup(t);
  toMeasured(film);
  writeCritique(film, "round-1.json", critique(1, sha("render-1"), "revise", 3));
  const fix = nextAction(film.project());
  assert.deepEqual(
    [fix.agent, fix.briefCommand],
    ["fixer", `pnpm film:brief --project ${ID} --step critic --role fixer`],
  );
  const fixer = buildBrief(film.project(), "critic", { role: "fixer" }).prompt;
  assert.ok(fixer.includes("critique/round-1.json"));
  assert.ok(
    fixer.includes(
      `pnpm motion:check --composition FilmFixture --project ${ID} --safe-zone vertical > public/projects/${ID}/pipeline/motion-check.json`,
    ),
  );
  assert.ok(
    fixer.includes("pnpm film:render") && fixer.includes("pnpm film:measure") && fixer.includes("--step measure"),
  );
  assert.ok(fixer.includes("music-decision.json"), "the fixer works from the music too");

  film.blob(`out/${ID}/film.mp4`, "render-2");
  assert.equal(film.status("measure"), "failing", "a measurement of the old render does not count");
  assert.equal(nextAction(film.project()).action, "run");
  writeFileSync(path.join(film.pipeline, "film-measure.json"), JSON.stringify(measureFor("render-2", "fail")));
  assert.equal(nextAction(film.project()).agent, "fixer", "a failing measurement goes to the fixer");
  buildBrief(film.project(), "measure", { role: "fixer" });
  film.blob(`out/${ID}/film.mp4`, "render-2b");
  writeFileSync(path.join(film.pipeline, "film-measure.json"), JSON.stringify(measureFor("render-2b", "pass")));
  film.seal("measure");
  const second = nextAction(film.project());
  assert.deepEqual([second.agent, second.fresh], ["creative-critic", true]);
  const prompt = buildBrief(film.project(), "critic").prompt;
  assert.ok(prompt.includes("round 2") && prompt.includes("--previous-critique"));

  writeCritique(film, "round-2.json", critique(2, sha("render-2b"), "revise", 3));
  const stuck = nextAction(film.project());
  assert.equal(stuck.action, "ask", "no higher score in two rounds: the user decides");
  assert.match(stuck.question ?? "", /No progress/);

  writeCritique(film, "round-2.json", critique(2, sha("render-2b"), "revise", 4));
  assert.equal(nextAction(film.project()).agent, "fixer");
  film.blob(`out/${ID}/film.mp4`, "render-3");
  writeFileSync(path.join(film.pipeline, "film-measure.json"), JSON.stringify(measureFor("render-3", "pass")));
  film.seal("measure");
  writeCritique(film, "round-3.json", critique(3, sha("render-3"), "revise", 5));
  const limit = nextAction(film.project());
  assert.equal(limit.action, "ask");
  assert.match(limit.question ?? "", /3 critic rounds used/);

  writeCritique(film, "round-3.json", critique(3, sha("render-3"), "approve-for-human", 5));
  assert.equal(film.status("critic"), "done");
  const human = nextAction(film.project());
  assert.deepEqual([human.action, human.step, human.show], ["ask", "human", [`out/${ID}/film.mp4`]]);
  film.approve("human");
  assert.equal(nextAction(film.project()).action, "stop");

  film.blob(`out/${ID}/film.mp4`, "render-4");
  assert.equal(film.status("human"), "blocked", "an accepted film that changes needs measuring and judging again");
});

test("repeated measure failures stop at the limit and go to the user", (t) => {
  const film = setup(t);
  toMeasured(film);
  for (const text of ["bad-1", "bad-2", "bad-3"]) {
    film.blob(`out/${ID}/film.mp4`, text);
    writeFileSync(path.join(film.pipeline, "film-measure.json"), JSON.stringify(measureFor(text, "fail")));
    assert.equal(nextAction(film.project()).agent, "fixer", text);
    buildBrief(film.project(), "measure", { role: "fixer" });
  }
  assert.equal(nextAction(film.project()).action, "ask");
});

test("brief refusals: unknown steps, wrong roles, the user's own step", (t) => {
  const film = setup(t);
  assert.throws(() => buildBrief(film.project(), "nope"), /Unknown step/);
  assert.throws(() => buildBrief(film.project(), "intake", { role: "critic" }), /no critic/);
  assert.throws(() => buildBrief(film.project(), "intake", { role: "fixer" }), /no fixer/);
  assert.throws(() => buildBrief(film.project(), "human"), /belongs to the user/);
  assert.throws(() => sealStep(film.project(), "critic"), /no film:done/);
  assert.throws(() => approveStep(film.project(), "truth", "yes"), /none gate/);
});

test("renderCommand drops an optional flag with no value and leaves the owner's placeholders", () => {
  const command = {
    alias: "music" as const,
    purpose: "p",
    args: { action: "options", reference: "?{referenceId}", other: "<x y>", flag: true as const, phrase: "two words" },
  };
  assert.equal(renderCommand(command, {}), `pnpm music --action options --other <x y> --flag --phrase "two words"`);
  assert.equal(
    renderCommand(command, { referenceId: "r" }),
    `pnpm music --action options --reference r --other <x y> --flag --phrase "two words"`,
  );
});

// --- pipeline-check ---

test("filmFindings stays quiet on old and template projects", () => {
  const fixtures = path.join(REPO, "tests/fixtures/creative-checks");
  assert.deepEqual(filmFindings(path.join(fixtures, "legacy/project"), { rootDir: path.join(fixtures, "legacy") }), []);
  assert.deepEqual(filmFindings(path.join(fixtures, "absent")), []);
});

test("filmFindings reports stale, invalid and open gates by code, in the pipeline-check shape", (t) => {
  const film = setup(t);
  toScriptApproved(film);
  film.edit("music-decision.json", (decision) => (decision["reason"] = "changed"));
  const findings = filmFindings(film.dir, { rootDir: film.root });
  const byStage = Object.fromEntries(findings.map((finding) => [finding.stage, finding]));
  assert.equal(byStage["music"]?.code, "FILM_STEP_UNRECORDED");
  assert.equal(byStage["audio-map"]?.code, "FILM_STEP_STALE");
  assert.equal(byStage["audio-map"]?.severity, "error");
  assert.match(byStage["audio-map"]?.message ?? "", /Fix:/);
  writeFileSync(path.join(film.pipeline, "concept.json"), "{}");
  const again = filmFindings(film.dir, { rootDir: film.root });
  assert.ok(again.some((finding) => finding.code === "FILM_OUTPUT_INVALID" && finding.stage === "concept"));
  for (const finding of again) assert.ok((FILM_FINDING_CODES as readonly string[]).includes(finding.code));
});

test("docs/production-chain.md and its sections quote only flags the film commands declare", () => {
  const sections = readdirSync(path.join(REPO, "docs/production-chain"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/production-chain/${name}`);
  assert.ok(sections.length >= 5, "the chain's sections live in docs/production-chain/");
  const doc = ["docs/production-chain.md", ...sections]
    .map((file) => readFileSync(path.join(REPO, file), "utf8"))
    .join("\n");
  const scripts = {
    "film:init": "scripts/film-init.ts",
    "film:status": "scripts/film-status.ts",
    "film:next": "scripts/film-next.ts",
    "film:brief": "scripts/film-brief.ts",
    "film:approve": "scripts/film-approve.ts",
    "film:done": "scripts/film-done.ts",
  };
  for (const [alias, script] of Object.entries(scripts)) {
    assert.ok(doc.includes(alias), `${alias} is documented`);
    const help = spawnSync(process.execPath, [TSX, path.join(REPO, script), "--help"], { cwd: REPO, encoding: "utf8" });
    const known = new Set([...help.stderr.matchAll(/--([a-z0-9-]+)/g)].map((match) => match[1]));
    for (const line of doc.split("\n").filter((text) => text.includes(`${alias} --`))) {
      const after = line.slice(line.indexOf(`${alias} --`));
      const command = after.split("`")[0]!;
      for (const match of command.matchAll(/--([a-z0-9-]+)/g))
        assert.ok(known.has(match[1]!), `${alias} --${match[1]}`);
    }
  }
});

test("the film commands accept a bespoke project, which has no project.json", () => {
  const id = `zz-bespoke-${process.pid}`;
  const dir = path.join(REPO, "public/projects", id, "pipeline");
  mkdirSync(dir, { recursive: true });
  try {
    assert.throws(() => requireProject(id), /not found/);
    writeFileSync(path.join(dir, "brief.json"), JSON.stringify({ renderMode: "bespoke" }));
    const cwd = process.cwd();
    process.chdir(REPO);
    try {
      assert.doesNotThrow(() => requireProject(id));
    } finally {
      process.chdir(cwd);
    }
    assert.doesNotThrow(() => readAssetRegistry(id, REPO));
  } finally {
    rmSync(path.join(REPO, "public/projects", id), { recursive: true, force: true });
  }
});

// --- Shot tournaments ---

/** A decided tournament for shot `hook` whose winner is `composition`. */
function decidedTournament(film: Temp, composition: string) {
  const variant = (label: string, name: string) => ({
    label,
    composition: name,
    render: `out/${ID}/tournament/hook/variant-${label}.mp4`,
    renderSha256: sha(label),
    sensors: [{ id: "motion:check", status: "pass", value: 0, message: "ok" }],
    failed: false,
    corpus: { distance: 0, features: [], unavailable: [] },
    measured: { durationSec: 5 },
  });
  mkdirSync(path.join(film.pipeline, "tournament"), { recursive: true });
  writeFileSync(
    path.join(film.pipeline, "tournament/hook.json"),
    JSON.stringify({
      schemaVersion: 1,
      projectId: ID,
      shotId: "hook",
      weight: "hero",
      frames: { start: 0, end: 149 },
      fps: 30,
      seed: "0123456789abcdef",
      variants: [variant("A", composition), variant("B", "OtherVariant")],
      packets: [],
      decision: {
        winner: "A",
        composition,
        net: { A: 1, B: -1 },
        excluded: [],
        decidedBy: "pairwise",
        rationale: "A won both orders",
        at: "2026-11-15T00:00:00.000Z",
      },
    }),
  );
}

test("build: a hero shot needs a decided tournament for the composition the build mounts; film:done records the film's blocks", (t) => {
  const film = setup(t);
  toBeatSheet(film, (plan) => {
    plan.shots[0].weight = "hero";
    plan.shots[0].blocks = ["mask-reveal"];
  });
  film.blob(`out/${ID}/animatic.mp4`, "animatic");
  film.seal("animatic");
  film.approve("animatic");
  film.place("build.json", "motion-check.json");
  const build = stepState(film, "build");
  assert.equal(build.status, "failing");
  assert.match(build.reasons.join(" "), /hero shot hook has no tournament/);
  decidedTournament(film, "AnotherComposition");
  assert.match(
    stepState(film, "build").reasons.join(" "),
    /the build mounts FilmFixture, the tournament chose A \(AnotherComposition\)/,
  );
  decidedTournament(film, "FilmFixture");
  assert.notEqual(stepState(film, "build").status, "failing", stepState(film, "build").reasons.join(" "));
  const done = cli(film.root, "scripts/film-done.ts", "--project", ID, "--step", "build");
  assert.equal(done.json.ok, true, done.json.message ?? "");
  // The child writes where the test's memory root points (AGENTBROS_MEMORY_ROOT under pnpm test, else <root>/memory).
  const usage = JSON.parse(readFileSync(path.join(usageDir(film.root), `${ID}.json`), "utf8"));
  assert.deepEqual(
    usage.blocks
      .filter((block: { weight: string }) => block.weight === "hero")
      .map((block: { id: string }) => block.id),
    ["mask-reveal"],
  );
});

test("in promo, an undecided hero tournament is advisory", (t) => {
  const film = setup(t, "promo");
  toBeatSheet(film, (plan) => {
    plan.shots[0].weight = "hero";
  });
  film.blob(`out/${ID}/animatic.mp4`, "animatic");
  film.seal("animatic");
  film.approve("animatic");
  film.place("build.json", "motion-check.json");
  const build = stepState(film, "build");
  assert.notEqual(build.status, "failing", build.reasons.join(" "));
  assert.ok(build.advisories?.some((line) => line.includes("hero shot hook has no tournament")));
});

test("animatic and build fail on render-lint findings in the film's src/projects code, with file:line and the fix", (t) => {
  const film = setup(t);
  toBeatSheet(film);
  film.blob(`out/${ID}/animatic.mp4`, "animatic");
  const code = `src/projects/${ID}/Film.tsx`;
  film.blob(
    code,
    `export const Film = () => { const r = Math.random(); return <img src="a.png" style={{ opacity: r }} />; };\n`,
  );
  const animatic = stepState(film, "animatic");
  assert.equal(animatic.status, "failing");
  assert.ok(
    animatic.reasons.some((line) =>
      /^src\/projects\/film\/Film\.tsx:1 UNSEEDED_RANDOM: .+\. Fix: use random\('a-seed'\) from remotion\.$/.test(line),
    ),
    animatic.reasons.join("\n"),
  );
  assert.ok(
    animatic.reasons.some(
      (line) => line.startsWith(`${code}:1 NATIVE_MEDIA:`) && line.includes("Fix: use <Img src={staticFile("),
    ),
    animatic.reasons.join("\n"),
  );
  const refused = cli(film.root, "scripts/film-done.ts", "--project", ID, "--step", "animatic");
  assert.equal(refused.json.ok, false, "film:done refuses to seal over lint findings");
  assert.match(JSON.stringify(refused.json), /Film\.tsx:1 UNSEEDED_RANDOM/);
  film.blob(
    code,
    `import { Img, random, staticFile } from "remotion";\nexport const Film = () => <Img src={staticFile("projects/film/a.png")} style={{ opacity: random("film") }} />;\n`,
  );
  assert.notEqual(stepState(film, "animatic").status, "failing", stepState(film, "animatic").reasons.join(" "));
  film.seal("animatic");
  film.approve("animatic");
  film.place("build.json", "motion-check.json");
  film.edit("build.json", (json) => {
    json.entry = "src/projects/film-code/index.ts";
  });
  film.blob("src/projects/film-code/index.ts", `export { Plate } from "./Plate";\n`);
  film.blob(
    "src/projects/film-code/Plate.tsx",
    `export const Plate = () => <div style={{ backgroundImage: "url(projects/film/a.png)" }} />;\n`,
  );
  const build = stepState(film, "build");
  assert.equal(build.status, "failing", build.reasons.join("\n"));
  assert.ok(
    build.reasons.some((line) => line.startsWith("src/projects/film-code/Plate.tsx:1 CSS_BG_IMAGE:")),
    build.reasons.join("\n"),
  );
  assert.equal(
    stepState(film, "animatic").status,
    "done",
    "the approved animatic does not reopen over code the build is still editing",
  );
});

test("in promo, plan:check's signature-element is advisory; outside promo it blocks", (t) => {
  const finding = (dimension: string, status: string, score: number) => ({
    dimension,
    status,
    score,
    value: 1,
    message: `${dimension} ${status}`,
    shotIds: [],
  });
  const report = JSON.stringify({
    schemaVersion: 1,
    planProjectId: ID,
    verdict: "fail",
    riskScore: 0,
    stats: {},
    findings: [
      finding("signature-element", "fail", 3),
      finding("cross-film-repetition", "pass", 0),
      finding("entrance-variety", "pass", 0),
    ],
  });
  for (const profile of [undefined, "promo"] as const) {
    const film = setup(t, profile);
    toBeatSheet(film);
    writeFileSync(path.join(film.pipeline, "plan-check.json"), report);
    const state = stepState(film, "beat-sheet");
    if (profile) {
      assert.notEqual(state.status, "failing", state.reasons.join(" "));
      assert.ok(state.advisories?.some((line) => line.includes("signature-element")));
    } else assert.equal(state.status, "failing");
  }
});

// --- The promo profile and brief telemetry ---

const stepState = (film: Temp, id: string) => deriveChain(film.project()).steps.find((step) => step.id === id)!;

test("film:init --profile promo writes the profile into the brief, and refuses an unknown one", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "film-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = cli(root, "scripts/film-init.ts", "--project", ID, "--profile", "promo");
  assert.equal(init.status, 0, init.json.message ?? "");
  assert.equal(init.json.metadata["profile"], "promo");
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "public/projects", ID, "pipeline/brief.json"), "utf8")).profile,
    "promo",
  );
  assert.equal(
    cli(root, "scripts/film-init.ts", "--project", "other", "--profile", "fast").json.error,
    "INVALID_INPUT",
  );
});

test("in promo, film:measure's reference-number legs are advisory and technical legs still block", (t) => {
  const legs = (...ids: string[]) =>
    ids.map((id) => ({ id, status: "fail", value: 1, message: `${id} missed`, evidence: [] }));
  for (const profile of [undefined, "promo"] as const) {
    const film = setup(t, profile);
    toMeasured(film, "render-1");
    writeFileSync(
      path.join(film.pipeline, "film-measure.json"),
      JSON.stringify({ ...measureFor("render-1", "fail"), legs: legs("cuts-per-minute", "shot-length-median") }),
    );
    const state = stepState(film, "measure");
    if (profile) {
      assert.notEqual(state.status, "failing", state.reasons.join(" "));
      assert.ok(state.advisories?.some((line) => line.includes("cuts-per-minute")));
      assert.ok(nextAction(film.project()).advisories?.some((line) => line.startsWith("measure: ")));
      writeFileSync(
        path.join(film.pipeline, "film-measure.json"),
        JSON.stringify({ ...measureFor("render-1", "fail"), legs: legs("cuts-per-minute", "true-peak") }),
      );
      const technical = stepState(film, "measure");
      assert.equal(technical.status, "failing");
      assert.deepEqual(technical.reasons, ["true-peak: true-peak missed"]);
    } else {
      assert.equal(state.status, "failing");
      assert.equal(state.advisories, undefined);
    }
  }
});

test("in promo, plan:check's pace findings are advisory; a craft failure still blocks", (t) => {
  const finding = (dimension: string, status: string, score: number) => ({
    dimension,
    status,
    score,
    value: 1,
    message: `${dimension} ${status}`,
    shotIds: [],
  });
  const report = (...findings: unknown[]) =>
    JSON.stringify({ schemaVersion: 1, planProjectId: ID, verdict: "fail", riskScore: 3, stats: {}, findings });
  for (const profile of [undefined, "promo"] as const) {
    const film = setup(t, profile);
    toBeatSheet(film);
    writeFileSync(
      path.join(film.pipeline, "plan-check.json"),
      report(finding("shot-count", "fail", 4), finding("entrance-variety", "pass", 0)),
    );
    const state = stepState(film, "beat-sheet");
    if (profile) {
      assert.notEqual(state.status, "failing", state.reasons.join(" "));
      assert.ok(state.advisories?.some((line) => line.includes("shot-count")));
      writeFileSync(
        path.join(film.pipeline, "plan-check.json"),
        report(finding("shot-count", "fail", 4), finding("carries", "fail", 4)),
      );
      assert.equal(stepState(film, "beat-sheet").status, "failing");
    } else assert.equal(state.status, "failing");
  }
});

test("every brief handed out is logged with its bytes, and film:status shows the totals", (t) => {
  const film = setup(t);
  toScriptApproved(film);
  const brief = buildBrief(film.project(), "look");
  const totals = dispatchTotals(film.project());
  const bytes = Buffer.byteLength(brief.prompt);
  assert.equal(totals.dispatches, 1);
  assert.equal(totals.bytes, bytes);
  assert.equal(totals.approxTokens, Math.ceil(bytes / 4));
  assert.deepEqual(totals.byStep["look"], { dispatches: 1, bytes, approxTokens: Math.ceil(bytes / 4) });
  assert.equal(buildBrief(film.project(), "look").prompt, brief.prompt, "logging does not change the brief");
  const status = cli(film.root, "scripts/film-status.ts", "--project", ID);
  assert.equal(status.json.metadata["briefs"].dispatches, 2);
  assert.equal(status.json.metadata["briefs"].bytes, bytes * 2);
  assert.equal(status.json.metadata["profile"], "full");
});

// --- The user's feedback as a step input ---

function toAccepted(film: Temp) {
  toMeasured(film);
  writeCritique(film, "round-1.json", critique(1, sha("render-1"), "approve-for-human"));
  film.approve("human");
  assert.equal(nextAction(film.project()).action, "stop");
}

const feedbackItems = (film: Temp, items: unknown[]) => {
  const file = path.join(film.root, "items.json");
  writeFileSync(file, JSON.stringify({ verdict: "revise", items }));
  return file;
};

test("feedback: a preview writes nothing; --confirm reopens the routed step and everything after it, not before", (t) => {
  const film = setup(t);
  toAccepted(film);
  const file = feedbackItems(film, [
    { quote: "музыка слишком весёлая для этой темы", aspect: "music", severity: "must", at: { fromSec: 0, toSec: 8 } },
  ]);
  const preview = cli(film.root, "scripts/feedback.ts", "--project", ID, "--file", file);
  assert.equal(preview.status, 0, JSON.stringify(preview.json));
  assert.equal(preview.json.metadata["confirmed"], false);
  assert.equal(preview.json.metadata["items"][0].routedTo, "music");
  assert.ok(preview.json.metadata["reopens"].some((reopen: { step: string }) => reopen.step === "human"));
  assert.ok(preview.json.metadata["owners"].includes("sound-director"));
  assert.equal(existsSync(path.join(film.pipeline, "feedback")), false, "a preview writes nothing");
  assert.equal(nextAction(film.project()).action, "stop");

  const confirmed = cli(film.root, "scripts/feedback.ts", "--project", ID, "--file", file, "--confirm");
  assert.equal(confirmed.status, 0, JSON.stringify(confirmed.json));
  assert.ok(
    existsSync(path.join(film.pipeline, "feedback/fb-001.json")) &&
      existsSync(path.join(film.pipeline, "feedback/open/music.json")),
  );
  assert.ok(
    confirmed.json.metadata["capture"].commands.some(
      (command: string) =>
        command.includes("--step music") &&
        command.includes("--axis musicFit") &&
        command.includes('--quote "<the user\'s words>"'),
    ),
  );

  const states = deriveChain(film.project()).steps;
  const at = states.findIndex((state) => state.id === "music");
  for (const state of states.slice(0, at))
    assert.ok(
      ["done", "skipped"].includes(state.status),
      `${state.id} is ${state.status}: steps before the feedback stay closed`,
    );
  assert.equal(states[at]!.status, "stale");
  for (const state of states.slice(at + 1).filter((item) => !["narration", "material"].includes(item.id)))
    assert.equal(
      state.status,
      ["critic", "human"].includes(state.id) ? "blocked" : "stale",
      `${state.id}: ${state.reasons.join(" ")}`,
    );

  const next = nextAction(film.project());
  assert.deepEqual([next.action, next.step, next.agent], ["dispatch", "music", "sound-director"]);
  const prompt = buildBrief(film.project(), "music").prompt;
  assert.ok(
    prompt.includes("pipeline/feedback/open/music.json") && prompt.includes("музыка слишком весёлая для этой темы"),
    "the owner's brief carries the user's words",
  );
  assert.throws(
    () => sealStep(film.project(), "music"),
    /outputs did not change/,
    "an unchanged result does not answer the user's feedback",
  );

  film.edit("music-shortlist.json", (json) => {
    json["note"] = "a calmer shortlist";
  });
  sealStep(film.project(), "music");
  assert.equal(
    existsSync(path.join(film.pipeline, "feedback/open/music.json")),
    false,
    "a changed result clears the open file",
  );
  const record = JSON.parse(readFileSync(path.join(film.pipeline, "feedback/fb-001.json"), "utf8"));
  assert.equal(record.items[0].status, "addressed");
  assert.equal(film.status("music"), "awaiting-gate", "the changed choice goes back to the user");
  film.approve("music");
  const again = nextAction(film.project());
  assert.deepEqual(
    [again.action, again.step],
    ["ask", "human"],
    "downstream receipts stand again, but the user's revise verdict withdrew their acceptance",
  );
  assert.match(again.why, /fb-001/);
  film.approve("human");
  assert.equal(nextAction(film.project()).action, "stop");
});

test("feedback: the same aspect twice on a step asks the user; their clarification lets the owner go on; --unchanged-because declines", (t) => {
  const film = setup(t);
  toAccepted(film);
  assert.equal(
    cli(
      film.root,
      "scripts/feedback.ts",
      "--project",
      ID,
      "--file",
      feedbackItems(film, [{ quote: "the track is too busy", aspect: "music" }]),
      "--confirm",
    ).status,
    0,
  );
  film.edit("music-shortlist.json", (json) => {
    json["note"] = "round two";
  });
  sealStep(film.project(), "music");
  film.approve("music");
  assert.equal(
    cli(
      film.root,
      "scripts/feedback.ts",
      "--project",
      ID,
      "--file",
      feedbackItems(film, [{ quote: "still too busy under the voice", aspect: "music" }]),
      "--confirm",
    ).status,
    0,
  );
  const ask = nextAction(film.project());
  assert.deepEqual([ask.action, ask.step], ["ask", "music"]);
  assert.match(ask.why, /same objection/);
  assert.ok(ask.thenRun?.some((command) => command.includes("--clarify")));
  const clarified = cli(
    film.root,
    "scripts/feedback.ts",
    "--project",
    ID,
    "--step",
    "music",
    "--clarify",
    "only piano, no drums",
  );
  assert.equal(clarified.status, 0, JSON.stringify(clarified.json));
  assert.deepEqual(
    [nextAction(film.project()).action, nextAction(film.project()).agent],
    ["dispatch", "sound-director"],
  );
  sealStep(film.project(), "music", { unchangedBecause: "the shortlist has no calmer licensed track" });
  const record = JSON.parse(readFileSync(path.join(film.pipeline, "feedback/fb-002.json"), "utf8"));
  assert.deepEqual(
    [record.items[0].status, record.items[0].declinedBecause],
    ["declined", "the shortlist has no calmer licensed track"],
  );
  assert.equal(film.status("music"), "done");
  assert.deepEqual(
    [nextAction(film.project()).action, nextAction(film.project()).step],
    ["ask", "human"],
    "a declined item goes back to the user's verdict",
  );
});

test("feedback: refused without the exact render, from a proxy, or without the user's words", (t) => {
  const film = setup(t);
  toAccepted(film);
  const run = (body: unknown) => {
    writeFileSync(path.join(film.root, "bad.json"), JSON.stringify(body));
    return cli(film.root, "scripts/feedback.ts", "--project", ID, "--file", path.join(film.root, "bad.json"));
  };
  assert.match(run({ items: [{ quote: "x", aspect: "music" }] }).json.message ?? "", /quote/);
  assert.match(
    run({ source: { kind: "proxy" }, items: [{ quote: "too loud", aspect: "sfx-mix" }] }).json.message ?? "",
    /proxy/,
  );
  assert.match(
    run({ watched: { sha256: "0".repeat(64) }, items: [{ quote: "too loud", aspect: "sfx-mix" }] }).json.message ?? "",
    /changed since the user watched/,
  );
  const unclear = run({
    items: [
      { quote: "something feels off", aspect: "unclear" },
      { quote: "the headline is wrong somehow", aspect: "unclear" },
    ],
  });
  assert.equal(unclear.status, 0);
  assert.deepEqual(
    unclear.json.metadata["items"].map((item: { routedTo: string }) => item.routedTo),
    ["ask", "ask"],
  );
  assert.deepEqual(unclear.json.metadata["reopens"], []);
  assert.equal(
    cli(film.root, "scripts/feedback.ts", "--project", ID, "--file", path.join(film.root, "bad.json"), "--confirm")
      .status,
    0,
  );
  assert.deepEqual(
    [nextAction(film.project()).action, nextAction(film.project()).step],
    ["ask", "human"],
    "a confirmed revise that reopens nothing still withdraws the acceptance",
  );
});

// --- Feedback and upstream changes reopen the blind pools ---

const confirmFeedback = (film: Temp, items: { quote: string; aspect: string }[]) => {
  const plan = planFeedback(film.project(), { verdict: "revise", items });
  writeFeedback(film.project(), plan);
  return plan;
};

test("feedback on the concept reopens the idea pool: a new round with the user's words, a new review, a new pick", (t) => {
  const film = setup(t);
  toAccepted(film);
  const quote = "the idea is too abstract, show the phone in a real hand";
  const plan = confirmFeedback(film, [{ quote, aspect: "concept" }]);
  assert.equal(plan.record.items[0]!.routedTo, "ideas");
  assert.ok(plan.warnings.some((warning) => /pool reopens for a new blind round/.test(warning)));
  assert.equal(stepState(film, "ideas").status, "stale");
  const before = JSON.parse(readFileSync(path.join(film.pipeline, "concept.json"), "utf8"));

  let next = nextAction(film.project());
  assert.deepEqual([next.action, next.step], ["dispatch", "ideas"]);
  assert.equal(next.dispatches!.length, 3, "every team writes again, not none of them");
  assert.match(next.why, /reopens for round 2 \(the user's feedback\)/);
  assert.equal(existsSync(reopensFile(film.dir, "ideas")), false, "film:next writes nothing");

  const brief = buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt;
  assert.match(brief, /Write round 2/);
  assert.ok(brief.includes(`"${quote}"`), "the brief carries the user's words verbatim");
  assert.match(brief, /What the user rejected, the previous winning idea: "/);
  assert.doesNotMatch(brief, /fell below the threshold/, "round 1 passed: no notes to answer");
  assert.equal(poolReopens(film.dir, "ideas").length, 1);
  buildBrief(film.project(), "ideas", { lane: "provocation" });
  assert.equal(poolReopens(film.dir, "ideas").length, 1, "one reopen per round, however many briefs");
  next = nextAction(film.project());
  assert.equal(next.dispatches!.length, 3, "round 1 files are old now");

  writeTeams(film.dir, 2);
  film.seal("ideas");
  const record = JSON.parse(readFileSync(path.join(film.pipeline, "feedback/fb-001.json"), "utf8"));
  assert.equal(record.items[0].status, "addressed");
  assert.deepEqual(nextAction(film.project()).commands, [`pnpm creative:pool --project ${ID} --kind ideas`]);
  buildPool(film.dir, ID, "ideas");
  film.seal("idea-review");
  next = nextAction(film.project());
  assert.deepEqual([next.step, next.agent, next.fresh], ["idea-review", "creative-director", true]);
  assert.match(buildBrief(film.project(), "idea-review", { role: "critic" }).prompt, /ideas-round-2\.json/);
  writeReview(film.dir, "ideas", 2, () => 4);
  rankLatest(film.dir, "ideas");
  assert.equal(stepState(film, "idea-review").status, "done");
  assert.ok(existsSync(path.join(film.pipeline, "rounds/ideas-1/pool.json")), "round 1 is kept as history");

  assert.equal(nextAction(film.project()).step, "concept");
  pickIdeas(film.dir);
  const after = JSON.parse(readFileSync(path.join(film.pipeline, "concept.json"), "utf8"));
  assert.notDeepEqual(after.candidates, before.candidates, "the pick reruns on the new pool");
  writeBoards(film.dir);
  film.seal("concept");
  assert.equal(film.status("concept"), "awaiting-gate", "the user chooses again");
  film.approve("concept");
  const states = deriveChain(film.project()).steps;
  for (const id of ["script-variants", "script", "build", "human"])
    assert.ok(
      !["done", "skipped"].includes(states.find((state) => state.id === id)!.status),
      `${id} reopens downstream`,
    );

  confirmFeedback(film, [{ quote: "still abstract", aspect: "concept" }]);
  const ask = nextAction(film.project());
  assert.deepEqual([ask.action, ask.step], ["ask", "ideas"], "the same objection twice goes to the user");
  assert.match(ask.why, /same objection/);
});

test("feedback on the words reopens the script variants; the review and the pick run again", (t) => {
  const film = setup(t);
  toAccepted(film);
  const quote = "the second line sounds like an ad, say it plainly";
  const plan = confirmFeedback(film, [{ quote, aspect: "words" }]);
  assert.equal(plan.record.items[0]!.routedTo, "script-variants");
  const next = nextAction(film.project());
  assert.deepEqual([next.action, next.step, next.dispatches?.length], ["dispatch", "script-variants", 3]);
  const brief = buildBrief(film.project(), "script-variants", { lane: "a" }).prompt;
  assert.match(brief, /Write round 2/);
  assert.ok(brief.includes(`"${quote}"`));
  assert.match(brief, /What the user rejected, the previous winning script: hook line "hook /);

  writeVariants(film.dir, 2);
  film.seal("script-variants");
  buildPool(film.dir, ID, "scripts");
  film.seal("script-review");
  assert.equal(nextAction(film.project()).agent, "creative-director");
  writeReview(film.dir, "scripts", 2, (index) => 5 - index);
  rankLatest(film.dir, "scripts");
  assert.equal(nextAction(film.project()).step, "script");
  pickScript(film.dir);
  assert.match(readFileSync(path.join(film.pipeline, "script.json"), "utf8"), /round 2/);
  film.seal("script");
  assert.equal(film.status("script"), "awaiting-gate");
});

test("audience feedback reaches the concept teams verbatim through the strategy; the blind director never sees it", (t) => {
  const film = setup(t);
  toAccepted(film);
  const quote = "это для мам в декрете, а не для офисных менеджеров";
  const plan = confirmFeedback(film, [{ quote, aspect: "audience" }]);
  assert.equal(plan.record.items[0]!.routedTo, "strategy");
  assert.equal(nextAction(film.project()).step, "strategy");
  assert.ok(buildBrief(film.project(), "strategy").prompt.includes(quote), "the strategist reads the user's words");
  writeStrategy(film.dir, { audience: { who: "mothers on parental leave", moment: "the baby's first nap" } });
  film.seal("strategy");
  film.approve("strategy");
  const next = nextAction(film.project());
  assert.deepEqual([next.action, next.step], ["dispatch", "ideas"]);
  const lane = buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt;
  assert.ok(lane.includes(`- "${quote}"`), "the concept team's brief carries the user's words verbatim");
  assert.match(lane, /They are a constraint/);
  const reopen = poolReopens(film.dir, "ideas")[0]!;
  assert.deepEqual([reopen.cause, reopen.feedbackIds], ["upstream", ["fb-001"]], "an upstream reopen, with the quote");
  assert.ok(buildBrief(film.project(), "ideas", { lane: "provocation" }).prompt.includes(quote), "every team");
  writeTeams(film.dir, 2);
  film.seal("ideas");
  buildPool(film.dir, ID, "ideas");
  film.seal("idea-review");
  const director = buildBrief(film.project(), "idea-review", { role: "critic" }).prompt;
  assert.ok(!director.includes(quote), "the blind director judges on the strategy and rubric, not the user's quote");
});

test("claim feedback reaches the truth owner and then the concept teams verbatim", (t) => {
  const film = setup(t);
  toAccepted(film);
  const quote = "it does not sync with Outlook, do not say it does";
  assert.equal(confirmFeedback(film, [{ quote, aspect: "claim" }]).record.items[0]!.routedTo, "truth");
  assert.equal(nextAction(film.project()).step, "truth");
  assert.ok(buildBrief(film.project(), "truth").prompt.includes(quote), "the concept director's truth brief");
  film.edit("product-truth.json", (json) => {
    json["claims"].push({ text: "Syncs with Outlook", status: "unverified" });
  });
  film.seal("truth");
  sealStep(film.project(), "strategy", { unchangedBecause: "the proposition does not rest on Outlook" });
  assert.equal(nextAction(film.project()).step, "ideas");
  assert.ok(buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt.includes(`- "${quote}"`));
});

test("an upstream change after a passed script review reopens the variants instead of leaving the chain stuck", (t) => {
  const film = setup(t);
  toScriptApproved(film);
  film.edit("music-decision.json", (json) => {
    json["askedUser"]["answer"] = "the second track after all";
  });
  film.seal("music");
  film.approve("music");
  assert.equal(film.status("audio-map"), "stale", "the map reads the decision");
  sealStep(film.project(), "audio-map", { unchangedBecause: "the cut is the same file" });
  assert.equal(film.status("script-variants"), "stale");
  const next = nextAction(film.project());
  assert.deepEqual([next.action, next.step, next.dispatches?.length], ["dispatch", "script-variants", 3]);
  assert.match(next.why, /round 2 \(an upstream change\)/);
  const brief = buildBrief(film.project(), "script-variants", { lane: "b" }).prompt;
  assert.match(brief, /inputs changed after the last round: Input .*music-decision\.json changed/);
  assert.match(brief, /The previous winning script, written before the change/);
  assert.equal(poolReopens(film.dir, "scripts")[0]!.cause, "upstream");
  writeVariants(film.dir, 2);
  film.seal("script-variants");
  assert.doesNotThrow(() => buildPool(film.dir, ID, "scripts"), "the passed round no longer closes the pool");
});

test("a truth change after a passed script review reopens the ideas, then the variants: the chain is never stuck", (t) => {
  const film = setup(t);
  toScriptApproved(film);
  film.edit("product-truth.json", (json) => {
    json["claims"].push({ text: "Syncs with the calendar", status: "working" });
  });
  film.seal("truth");
  assert.equal(nextAction(film.project()).step, "strategy");
  sealStep(film.project(), "strategy", { unchangedBecause: "the new claim does not change the proposition" });
  let next = nextAction(film.project());
  assert.deepEqual([next.action, next.step, next.dispatches?.length], ["dispatch", "ideas", 3]);
  assert.match(next.why, /round 2 \(an upstream change\)/);
  assert.match(buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt, /product-truth\.json changed/);
  writeTeams(film.dir, 2);
  film.seal("ideas");
  buildPool(film.dir, ID, "ideas");
  film.seal("idea-review");
  writeReview(film.dir, "ideas", 2, () => 4);
  rankLatest(film.dir, "ideas");
  pickIdeas(film.dir);
  writeBoards(film.dir);
  film.seal("concept");
  film.approve("concept");
  assert.equal(nextAction(film.project()).step, "music", "the track's brief reads the idea");
  sealStep(film.project(), "music", { unchangedBecause: "the chosen track still fits the new idea" });
  next = nextAction(film.project());
  assert.deepEqual([next.action, next.step, next.dispatches?.length], ["dispatch", "script-variants", 3]);
  assert.match(next.why, /round 2 \(an upstream change\)/);
  buildBrief(film.project(), "script-variants", { lane: "a" });
  writeVariants(film.dir, 2);
  film.seal("script-variants");
  assert.doesNotThrow(() => buildPool(film.dir, ID, "scripts"), "the passed round no longer closes the pool");
});

test("a pool the user's feedback reopened twice asks them before a third blind round, until they clarify", (t) => {
  const film = setup(t);
  toAccepted(film);
  mkdirSync(path.dirname(reopensFile(film.dir, "ideas")), { recursive: true });
  const earlier = {
    round: 1,
    cause: "feedback",
    changed: [],
    quotes: ["x"],
    supersedes: {},
    at: "2026-01-01T00:00:00Z",
  };
  writeFileSync(
    reopensFile(film.dir, "ideas"),
    JSON.stringify({ schemaVersion: 1, kind: "ideas", reopens: [earlier, { ...earlier, at: "2026-01-02T00:00:00Z" }] }),
  );
  confirmFeedback(film, [{ quote: "a different kind of idea", aspect: "concept" }]);
  const ask = nextAction(film.project());
  assert.deepEqual([ask.action, ask.step], ["ask", "ideas"]);
  assert.match(ask.why, /already reopened the ideas pool 2 times/);
  assert.throws(() => buildBrief(film.project(), "ideas", { lane: "metaphor" }), /already reopened/);
  clarifyFeedback(film.project(), "ideas", "show the phone ringing on a kitchen table");
  const go = nextAction(film.project());
  assert.deepEqual([go.action, go.step], ["dispatch", "ideas"]);
  assert.ok(buildBrief(film.project(), "ideas", { lane: "metaphor" }).prompt.includes("kitchen table"));
  assert.equal(poolReopens(film.dir, "ideas").at(-1)!.round, 2);
});

// --- Frame feedback (RFC 0004 WP9, A17): a frame and a region reach the build and the fixer ---

test("feedback --frame --region: one item with the frame, its time and the area, routed to build and in the fixer's brief", (t) => {
  const film = setup(t);
  toAccepted(film);
  const words = "-h the logo here is cut off at the edge";
  const args = ["--project", ID, "--frame", "45", "--region", "0.1,0.2,0.3,0.25", `--answer=${words}`, "--fps", "30"];
  const preview = cli(film.root, "scripts/feedback.ts", ...args);
  assert.equal(preview.status, 0, JSON.stringify(preview.json));
  assert.equal(preview.json.metadata["confirmed"], false);
  assert.equal(preview.json.metadata["frame"], 45);
  assert.equal(preview.json.metadata["items"][0].routedTo, "build");
  assert.equal(existsSync(path.join(film.pipeline, "feedback")), false, "a preview writes nothing");

  const confirmed = cli(film.root, "scripts/feedback.ts", ...args, "--confirm");
  assert.equal(confirmed.status, 0, JSON.stringify(confirmed.json));
  const record = JSON.parse(readFileSync(path.join(film.pipeline, "feedback/fb-001.json"), "utf8"));
  assert.equal(record.verdict, "revise");
  assert.deepEqual(record.watched, { path: `out/${ID}/film.mp4`, sha256: sha("render-1") });
  assert.deepEqual(
    {
      quote: record.items[0].quote,
      aspect: record.items[0].aspect,
      frame: record.items[0].frame,
      at: record.items[0].at,
      region: record.items[0].region,
    },
    {
      quote: words,
      aspect: "shot",
      frame: 45,
      at: { fromSec: 1.5, toSec: 1.5 },
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 },
    },
  );
  const open = JSON.parse(readFileSync(path.join(film.pipeline, "feedback/open/build.json"), "utf8"));
  assert.equal(open.items[0].frame, 45);
  assert.deepEqual(open.items[0].region, { x: 0.1, y: 0.2, w: 0.3, h: 0.25 });
  assert.equal(stepState(film, "build").status, "stale");
  const where = "at frame 45 (1.5s), region x=0.1 y=0.2 w=0.3 h=0.25 of the frame";
  assert.ok(readUserWords(film.dir, "build").some((line) => line.includes(where) && line.includes(words)));

  // Next round the build's owner answers it (the real dispatch, with its readiness check) and sees where the user
  // pointed; the critic's fixer cannot run while the build is open, and the critic stays blind.
  const next = nextAction(film.project());
  assert.deepEqual([next.action, next.step], ["dispatch", "build"]);
  assert.ok(buildBrief(film.project(), "build").prompt.includes(where));
  assert.throws(() => buildBrief(film.project(), "critic", { role: "fixer" }));
  const fixer = renderBrief(film.project(), "critic", { role: "fixer" }).prompt;
  assert.match(fixer, /## The user's feedback on the film/);
  assert.ok(fixer.includes(where) && fixer.includes(words) && fixer.includes("feedback/open/build.json"));
  assert.ok(
    !renderBrief(film.project(), "critic", { role: "critic" }).prompt.includes(words),
    "the critic stays blind",
  );
});

test("ref:rate on a styleframe reaches the look owner's brief and reopens nothing", (t) => {
  const film = setup(t);
  toAccepted(film);
  const before = deriveChain(film.project()).steps.map((step) => [step.id, step.status]);
  const note = "this one feels like us, warm light";
  const rated = cli(
    film.root,
    "scripts/ref-rate.ts",
    "--project",
    ID,
    "--path",
    "pipeline/look/styleframes.png",
    "--score",
    "4",
    `--note=${note}`,
  );
  assert.equal(rated.status, 0, JSON.stringify(rated.json));
  assert.deepEqual(
    deriveChain(film.project()).steps.map((step) => [step.id, step.status]),
    before,
  );
  assert.equal(nextAction(film.project()).action, "stop");
  const look = renderBrief(film.project(), "look").prompt;
  assert.match(look, /## The user's ratings of the styleframes/);
  assert.ok(look.includes(`pipeline/look/styleframes.png: 4/5, "${note}"`));
  assert.ok(!renderBrief(film.project(), "look", { role: "critic" }).prompt.includes(note), "the critic stays blind");
});

test("feedback --frame: refuses missing words, a bad region or frame, a mix with --step, and a changed render", (t) => {
  const film = setup(t);
  toAccepted(film);
  const run = (...args: string[]) => cli(film.root, "scripts/feedback.ts", "--project", ID, ...args);
  const cases: [string[], string, RegExp][] = [
    [["--frame", "10"], "INVALID_INPUT", /--frame goes with --answer/],
    [["--region", "0,0,1,1", "--answer=bigger"], "INVALID_INPUT", /--frame goes with --answer/],
    [["--frame", "-1", "--answer=make it bigger"], "INVALID_INPUT", /frame number from 0/],
    [["--frame", "2.5", "--answer=make it bigger"], "INVALID_INPUT", /frame number from 0/],
    [["--frame", "3", "--region", "0.5,0.5,0.6,0.1", "--answer=make it bigger"], "INVALID_INPUT", /inside the frame/],
    [["--frame", "3", "--region", "a,b,c,d", "--answer=make it bigger"], "INVALID_INPUT", /four numbers/],
    [["--frame", "3", "--step", "build", "--answer=make it bigger"], "INVALID_INPUT", /its own feedback/],
    [["--frame", "3", "--answer=<the user's words>"], "INVALID_INPUT", /placeholder/],
    [
      ["--frame", "3", "--expect", sha("render-0"), "--answer=make it bigger", "--confirm"],
      "STAGE_INCOMPLETE",
      /changed since/,
    ],
    [
      ["--frame", "3", "--watched", `out/${ID}/missing.mp4`, "--answer=make it bigger"],
      "STAGE_INCOMPLETE",
      /does not exist/,
    ],
  ];
  for (const [args, error, message] of cases) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.json.error, error, `${args.join(" ")}: ${result.json.message}`);
    assert.match(result.json.message!, message, args.join(" "));
  }
  assert.equal(existsSync(path.join(film.pipeline, "feedback")), false, "nothing was written");
});

test("frame feedback timing: the render's rate and frame count bound the frame; no rate is never assumed; --watched stays in the project", (t) => {
  const film = setup(t);
  toAccepted(film);
  const probe = () => ({ fps: 25, frameCount: 50 });
  const words = "the cut lands late here";
  // The render's own rate (25 fps) times the frame when the viewer names none.
  const plan = planFrameFeedback(film.project(), { frame: 49, words }, probe);
  assert.deepEqual(plan.timing, { fps: 25, fpsFrom: "render", frameCount: 50 });
  assert.deepEqual(plan.record.items[0]!.at, { fromSec: 1.96, toSec: 1.96 });
  assert.throws(
    () => planFrameFeedback(film.project(), { frame: 50, words }, probe),
    /past the render's last frame \(50 frames/,
  );
  // A viewer rate counts frames in that rate: 2 s of render is 60 frames at 30 fps.
  assert.equal(planFrameFeedback(film.project(), { frame: 59, words, fps: 30 }, probe).timing.frameCount, 60);
  assert.throws(
    () => planFrameFeedback(film.project(), { frame: 60, words, fps: 30 }, probe),
    /past the render's last frame/,
  );
  // Without ffprobe, the film plan's rate; without either, refused.
  const none = () => undefined;
  assert.deepEqual(planFrameFeedback(film.project(), { frame: 3, words }, none).timing, { fps: 30, fpsFrom: "plan" });
  rmSync(path.join(film.pipeline, "cue-sheet.json"));
  film.edit("motion-plan.json", (json) => delete json["fps"]);
  assert.throws(() => planFrameFeedback(film.project(), { frame: 3, words }, none), /frame rate is unknown.*--fps/);
  // The render watched is the project's own.
  for (const watched of ["package.json", `public/projects/other/film.mp4`, `out/other/film.mp4`, `out/${ID}/../x.mp4`])
    assert.throws(
      () => planFrameFeedback(film.project(), { frame: 1, words, watched, fps: 30 }, none),
      /outside the project/,
      watched,
    );
  const cliRefusal = cli(
    film.root,
    "scripts/feedback.ts",
    "--project",
    ID,
    "--frame",
    "1",
    "--watched",
    "../../etc/hosts",
    "--fps",
    "30",
    "--answer=too dark",
  );
  assert.equal(cliRefusal.json.error, "STAGE_INCOMPLETE");
  assert.match(cliRefusal.json.message!, /outside the project/);
});
