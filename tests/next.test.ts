import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FILM_CHAIN } from "../src/lib/film/chain";
import { STEP } from "../src/lib/footage/next";
import { addMemory } from "../src/lib/memory";
import {
  detectRoute,
  filmRead,
  FOOTAGE_STEP_READ,
  footageRead,
  playbookSuggest,
  ROUTE_COMMANDS,
  TIMELINE_STEP_READ,
  timelineRead,
} from "../src/lib/pipeline/route";
import { TIMELINE_STEPS } from "../src/lib/pipeline/timeline-next";

// Memory comes from each temporary workspace, never from a memory folder set in the environment.
delete process.env.AGENTBROS_MEMORY_ROOT;
const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");

function cli(script: string, args: string[], cwd: string) {
  // Playbooks come from the checkout; AGENTBROS_PLAYBOOKS_ROOT points these runs at the workspace's fixture playbooks.
  const env = existsSync(path.join(cwd, "playbooks")) ? { ...process.env, AGENTBROS_PLAYBOOKS_ROOT: cwd } : process.env;
  const run = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `${script}: one JSON line\n${run.stdout}\n${run.stderr}`);
  return { status: run.status, envelope: JSON.parse(lines[0]!) };
}

function workspace(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "public/projects"), { recursive: true });
  return dir;
}

/** Every file under the workspace with its size and mtime: next must leave it unchanged, but for the step lease (docs/step-lease.md). */
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => !file.split(path.sep).join("/").includes("pipeline/session"))
    .sort()
    .map((file) => {
      const stat = statSync(path.join(dir, file));
      return `${file} ${stat.isDirectory() ? "dir" : `${stat.size} ${stat.mtimeMs}`}`;
    });

function next(projectId: string, cwd: string) {
  const before = snapshot(cwd);
  const result = cli("scripts/next.ts", ["--project", projectId], cwd);
  assert.deepEqual(snapshot(cwd), before, "next wrote nothing");
  return result;
}

const assertReadable = (read: unknown, guide: string) => {
  assert.ok(Array.isArray(read) && read.includes(guide), `read names ${guide}: ${JSON.stringify(read)}`);
  for (const file of read as string[]) assert.ok(existsSync(path.join(REPO, file)), file);
};

test("every read path exists, and every film step, footage step and timeline step has an entry", () => {
  const files = new Set([
    ...FILM_CHAIN.flatMap((step) => filmRead(step.id)),
    ...Object.values(STEP).flatMap(([id]) => footageRead(id)),
    ...Object.keys(TIMELINE_STEPS).flatMap((step) => timelineRead(step)),
    ...Object.values(ROUTE_COMMANDS).flatMap((route) => [route.script, route.guide]),
  ]);
  for (const file of files) assert.ok(existsSync(file), file);
  assert.deepEqual(
    Object.keys(FOOTAGE_STEP_READ).sort(),
    Object.values(STEP)
      .map(([id]) => id)
      .sort(),
  );
  assert.deepEqual(Object.keys(TIMELINE_STEP_READ).sort(), Object.keys(TIMELINE_STEPS).sort());
  assert.ok(filmRead("build").includes("src/motion/library/AGENTS.md"));
  assert.ok(filmRead("sound").includes("src/lib/audio/AGENTS.md"));
});

test("next routes a bespoke film to film:next with its read list", (t) => {
  const cwd = workspace(t);
  assert.equal(
    cli("scripts/film-init.ts", ["--project", "film-a", "--type", "motion-graphics"], cwd).envelope.ok,
    true,
  );
  const { status, envelope } = next("film-a", cwd);
  assert.equal(status, 0, JSON.stringify(envelope));
  assert.equal(envelope.metadata.route, "film");
  assert.match(envelope.metadata.detectedBy, /renderMode "bespoke"/);
  assert.equal(envelope.metadata.command, "pnpm film:next --project film-a");
  assert.equal(envelope.metadata.next.step, "intake");
  assertReadable(envelope.metadata.next.read, "docs/production-chain.md");
});

test("next routes the user's own recording to footage:next without saving goals", (t) => {
  const cwd = workspace(t);
  const pipeline = path.join(cwd, "public/projects/talk/pipeline");
  mkdirSync(pipeline, { recursive: true });
  const goals = JSON.stringify({ version: 1, goals: ["recut"] });
  writeFileSync(path.join(pipeline, "footage-goals.json"), goals);
  const { status, envelope } = next("talk", cwd);
  assert.equal(status, 0, JSON.stringify(envelope));
  assert.equal(envelope.metadata.route, "footage");
  assert.equal(envelope.metadata.next.step, "0-source");
  assertReadable(envelope.metadata.next.read, "docs/footage-editing.md");
});

test("a recut project is footage even though it also has project.json", (t) => {
  const cwd = workspace(t);
  const dir = path.join(cwd, "public/projects/talk-recut");
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  writeFileSync(path.join(dir, "project.json"), "{}");
  writeFileSync(path.join(dir, "pipeline/recording-edit.json"), "{}");
  assert.equal(detectRoute(dir).route, "footage");
  rmSync(path.join(dir, "pipeline/recording-edit.json"));
  mkdirSync(path.join(dir, "pipeline/footage/talk"), { recursive: true });
  writeFileSync(
    path.join(dir, "pipeline/footage/talk/recut-request.json"),
    JSON.stringify({ workflow: "recording-edit" }),
  );
  assert.equal(detectRoute(dir).route, "footage");
  rmSync(path.join(dir, "pipeline/footage"), { recursive: true });
  assert.equal(detectRoute(dir).route, "timeline", "a bare project.json is rendered as it stands");
  writeFileSync(path.join(dir, "pipeline/pipeline-state.json"), "{}");
  assert.equal(detectRoute(dir).route, "timeline", "a leftover legacy pipeline state is ignored");
  assert.match(detectRoute(dir).detectedBy, /legacy template-mode pipeline\/pipeline-state\.json ignored/);
});

test("next routes a project.json with a leftover legacy pipeline-state.json to the timeline route", (t) => {
  const cwd = workspace(t);
  assert.equal(cli("scripts/create-project.ts", ["--project", "tmpl-a"], cwd).envelope.ok, true);
  mkdirSync(path.join(cwd, "public/projects/tmpl-a/pipeline"), { recursive: true });
  writeFileSync(
    path.join(cwd, "public/projects/tmpl-a/pipeline/pipeline-state.json"),
    JSON.stringify({ projectId: "tmpl-a", version: "1", revision: 3, stages: {}, history: [] }),
  );
  const { status, envelope } = next("tmpl-a", cwd);
  assert.equal(status, 0, JSON.stringify(envelope));
  assert.equal(envelope.metadata.route, "timeline");
  assert.equal(envelope.metadata.command, "pnpm next --project tmpl-a");
  assert.match(envelope.metadata.detectedBy, /pipeline-state\.json ignored/);
  assert.equal(envelope.metadata.legacy, undefined);
  assert.equal(envelope.metadata.next.step, "render");
});

test("next refuses an absent project and a folder with no route, naming the route options", (t) => {
  const cwd = workspace(t);
  const absent = cli("scripts/next.ts", ["--project", "nope"], cwd);
  assert.equal(absent.status, 1);
  assert.equal(absent.envelope.error, "PROJECT_NOT_FOUND");
  assert.match(absent.envelope.message, /film:init.*footage:next.*project:new/);
  assert.doesNotMatch(absent.envelope.message, /pipeline:init/, "template mode is not offered for new work");
  mkdirSync(path.join(cwd, "public/projects/bare"));
  const bare = cli("scripts/next.ts", ["--project", "bare"], cwd);
  assert.equal(bare.envelope.error, "INVALID_INPUT");
  assert.match(bare.envelope.message, /route is unknown/);
});

// --- Playbooks: binding a project and carrying the playbook in every next-step answer ---

const FOOTAGE_PLAYBOOK = JSON.parse(readFileSync(path.join(REPO, "playbooks/footage-edit/playbook.json"), "utf8"));

/** Fixture playbooks in the workspace: the real footage-edit, a film one (motion-graphics + explainer) and a workflow one. */
function withPlaybooks(cwd: string): void {
  const write = (
    id: string,
    route: unknown,
    read: string[] = [],
    title = `Test ${id}`,
    alternatives: unknown[] = [],
  ) => {
    const dir = path.join(cwd, "playbooks", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "playbook.json"),
      JSON.stringify({ ...FOOTAGE_PLAYBOOK, id, title, notFor: [], alternatives, route, read }),
    );
    writeFileSync(path.join(dir, "AGENTS.md"), `# ${id}\n`);
  };
  write("footage-edit", FOOTAGE_PLAYBOOK.route, FOOTAGE_PLAYBOOK.read, FOOTAGE_PLAYBOOK.title);
  write(
    "test-film",
    {
      kind: "film",
      filmType: "motion-graphics",
      secondaryFilmType: "explainer",
      start: "pnpm film:init --project <id> --type motion-graphics --playbook test-film --product <path>",
    },
    ["docs/film-types.md"],
  );
  write("test-workflow", {
    kind: "workflow",
    workflow: "product-ad",
    start: "pnpm video:workflow --scenario product-ad --action plan --request <file>",
  });
  write("test-template", {
    kind: "template",
    recipe: "social-hook",
    start: "pnpm video:recipe --action preview --input <file>",
  });
  write(
    "test-tutorial",
    {
      kind: "film",
      filmType: "ui-demo",
      secondaryFilmType: "explainer",
      start: "pnpm film:init --project <id> --type ui-demo --playbook test-tutorial --product <path>",
    },
    [],
    "Test test-tutorial",
    [
      {
        when: "the user's own screencast",
        route: {
          kind: "footage",
          footageGoals: ["captions"],
          start: "pnpm footage:next --project <id> --playbook test-tutorial --source <file> --goal captions",
        },
      },
    ],
  );
  write(
    "test-screencast",
    {
      kind: "footage",
      footageGoals: ["recut"],
      start: "pnpm footage:next --project <id> --playbook test-screencast --source <file> --goal recut",
    },
    [],
    "Test test-screencast",
    [
      {
        when: "nothing recorded yet",
        route: {
          kind: "workflow",
          workflow: "product-ad",
          start: "pnpm video:workflow --scenario product-ad --action plan --request <file>",
        },
      },
      {
        when: "a designed film instead",
        route: {
          kind: "film",
          filmType: "collage",
          start: "pnpm film:init --project <id> --type collage --playbook test-screencast --product <path>",
        },
      },
    ],
  );
}

const binding = (cwd: string, id: string) =>
  JSON.parse(readFileSync(path.join(cwd, "public/projects", id, "pipeline/playbook.json"), "utf8"));

test("film:init --playbook binds the project, takes the playbook's types as defaults, and refuses a non-film playbook", (t) => {
  const cwd = workspace(t);
  withPlaybooks(cwd);
  const init = cli("scripts/film-init.ts", ["--project", "pb-film", "--playbook", "test-film"], cwd).envelope;
  assert.equal(init.ok, true, JSON.stringify(init));
  assert.equal(init.metadata.filmType, "motion-graphics");
  assert.equal(init.metadata.secondaryFilmType, "explainer");
  assert.equal(init.metadata.typeFrom, "playbook");
  assert.deepEqual(init.metadata.playbook, { id: "test-film", title: "Test test-film" });
  assert.ok(!(init.metadata.warnings ?? []).some((w: string) => /No --type/.test(w)));
  assert.ok(init.outputs.includes("public/projects/pb-film/pipeline/playbook.json"));
  assert.equal(binding(cwd, "pb-film").by, "agent");

  const { envelope } = next("pb-film", cwd);
  assert.equal(envelope.metadata.route, "film");
  assert.deepEqual(envelope.metadata.playbook, { id: "test-film", title: "Test test-film" });
  assert.equal(envelope.metadata.playbookHint, undefined);
  const read = envelope.metadata.next.read as string[];
  assert.deepEqual(read.slice(0, 2), ["playbooks/test-film/AGENTS.md", "docs/film-types.md"]);
  assert.equal(new Set(read).size, read.length, "read is deduplicated");
  assert.ok(read.includes("docs/production-chain.md"));

  const explicit = cli(
    "scripts/film-init.ts",
    ["--project", "pb-film-2", "--playbook", "test-film", "--type", "collage", "--by", "user"],
    cwd,
  ).envelope;
  assert.equal(explicit.ok, true, JSON.stringify(explicit));
  assert.equal(explicit.metadata.filmType, "collage");
  assert.equal(explicit.metadata.secondaryFilmType, undefined);
  assert.ok(
    explicit.metadata.warnings.some((w: string) => /differs from playbook test-film's motion-graphics/.test(w)),
  );
  assert.equal(binding(cwd, "pb-film-2").by, "user");

  const footage = cli("scripts/film-init.ts", ["--project", "pb-film-3", "--playbook", "footage-edit"], cwd);
  assert.equal(footage.envelope.error, "INVALID_INPUT");
  assert.match(footage.envelope.message, /pnpm footage:next --project <id> --playbook footage-edit/);
  const unknown = cli("scripts/film-init.ts", ["--project", "pb-film-3", "--playbook", "nope"], cwd);
  assert.equal(unknown.envelope.error, "INVALID_INPUT");
  assert.match(
    unknown.envelope.message,
    /Known: footage-edit, test-film, test-screencast, test-template, test-tutorial, test-workflow/,
  );
  assert.equal(existsSync(path.join(cwd, "public/projects/pb-film-3")), false, "a refusal leaves no project");
});

test("footage:next --playbook binds the source project and defaults its goals; a film playbook is refused", (t) => {
  const cwd = workspace(t);
  withPlaybooks(cwd);
  mkdirSync(path.join(cwd, "public/projects/talk"), { recursive: true });
  const { status, envelope } = cli("scripts/footage-next.ts", ["--project", "talk", "--playbook", "footage-edit"], cwd);
  assert.equal(status, 0, JSON.stringify(envelope));
  assert.equal(binding(cwd, "talk").id, "footage-edit");
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(cwd, "public/projects/talk/pipeline/footage-goals.json"), "utf8")).goals,
    ["recut", "captions"],
  );
  assert.match(envelope.metadata.goalsFrom, /playbook footage-edit/);
  assert.deepEqual(envelope.metadata.playbook, { id: "footage-edit", title: FOOTAGE_PLAYBOOK.title });
  assert.deepEqual(envelope.metadata.read.slice(0, 2), ["playbooks/footage-edit/AGENTS.md", "docs/footage-editing.md"]);

  const explicitGoal = cli(
    "scripts/footage-next.ts",
    ["--project", "talk", "--playbook", "footage-edit", "--goal", "captions"],
    cwd,
  ).envelope;
  assert.equal(explicitGoal.ok, true);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(cwd, "public/projects/talk/pipeline/footage-goals.json"), "utf8")).goals,
    ["captions"],
  );
  assert.equal(explicitGoal.metadata.goalsFrom, undefined);

  const film = cli("scripts/footage-next.ts", ["--project", "talk", "--playbook", "test-film"], cwd).envelope;
  assert.equal(film.error, "INVALID_INPUT");
  assert.match(film.message, /pnpm film:init --project <id>/);

  const absent = cli("scripts/footage-next.ts", ["--project", "new-talk", "--playbook", "footage-edit"], cwd).envelope;
  assert.equal(absent.metadata.step, "setup");
  assert.equal(existsSync(path.join(cwd, "public/projects/new-talk")), false, "no binding before the project exists");
  assert.ok(absent.metadata.thenRun.some((c: string) => c.includes("--playbook footage-edit")));
});

test("an unbound project's next-step answers carry playbook null and a hint to bind one", (t) => {
  const cwd = workspace(t);
  assert.equal(cli("scripts/film-init.ts", ["--project", "plain", "--type", "motion-graphics"], cwd).envelope.ok, true);
  const hint = 'bind one: pnpm playbook --match "<request>" then pnpm playbook --use <id> --project plain';
  const viaNext = next("plain", cwd).envelope.metadata;
  assert.equal(viaNext.playbook, null);
  assert.equal(viaNext.playbookHint, hint);
  assert.equal(viaNext.next.playbookHint, hint);
  assert.equal(viaNext.playbookSuggest.by, "film type motion-graphics (pipeline/brief.json)");
  assert.ok(
    viaNext.playbookSuggest.playbooks.some((p: { id: string }) => p.id === "motion-design"),
    "the film type's owners are suggested",
  );
  assert.equal(viaNext.playbookSuggest.use, "pnpm playbook --use <id> --project plain");
  const film = cli("scripts/film-next.ts", ["--project", "plain"], cwd).envelope.metadata;
  assert.equal(film.playbook, null);
  assert.equal(film.read[0], "docs/production-chain.md");
});

test("a project with only a binding is answered by next: its route's start command, or its route", (t) => {
  const cwd = workspace(t);
  withPlaybooks(cwd);
  const bind = (id: string, playbook: string) => {
    mkdirSync(path.join(cwd, "public/projects", id, "pipeline"), { recursive: true });
    writeFileSync(
      path.join(cwd, "public/projects", id, "pipeline/playbook.json"),
      JSON.stringify({ version: 1, id: playbook, chosenAt: new Date().toISOString(), by: "user" }),
    );
  };
  bind("promo", "test-film");
  const film = next("promo", cwd);
  assert.equal(film.status, 0, JSON.stringify(film.envelope));
  assert.equal(film.envelope.metadata.route, null);
  assert.match(film.envelope.metadata.detectedBy, /binds the film playbook test-film/);
  assert.equal(
    film.envelope.metadata.command,
    "pnpm film:init --project promo --type motion-graphics --playbook test-film --product <path>",
  );
  assert.deepEqual(film.envelope.metadata.next.commands, [film.envelope.metadata.command]);
  assert.equal(film.envelope.metadata.next.read[0], "playbooks/test-film/AGENTS.md");

  bind("ad", "test-workflow");
  assert.match(next("ad", cwd).envelope.metadata.command, /^pnpm video:workflow --scenario product-ad/);

  bind("social", "test-template");
  const template = next("social", cwd);
  assert.equal(template.status, 0, JSON.stringify(template.envelope));
  assert.equal(template.envelope.metadata.command, "pnpm video:recipe --action preview --input <file>");

  bind("talk", "footage-edit");
  writeFileSync(path.join(cwd, "public/projects/talk/project.json"), "{}");
  const footage = next("talk", cwd).envelope.metadata;
  assert.equal(footage.route, "footage", "a footage binding outranks a bare project.json");
  assert.equal(footage.next.step, "setup", "goals are still the user's: next saves none");
  assert.equal(footage.next.read[0], "playbooks/footage-edit/AGENTS.md");
  assert.equal(
    existsSync(path.join(cwd, "public/projects/talk/pipeline/footage-goals.json")),
    false,
    "next saves no goals",
  );
});

test("pipeline:check is a stateless probe that carries the bound playbook first in its read list, and its memory", (t) => {
  const cwd = workspace(t);
  withPlaybooks(cwd);
  assert.equal(cli("scripts/create-project.ts", ["--project", "tmpl-b"], cwd).envelope.ok, true);
  mkdirSync(path.join(cwd, "public/projects/tmpl-b/pipeline"), { recursive: true });
  writeFileSync(
    path.join(cwd, "public/projects/tmpl-b/pipeline/playbook.json"),
    JSON.stringify({ version: 1, id: "test-workflow", chosenAt: new Date().toISOString(), by: "agent" }),
  );
  const memory = addMemory(
    {
      type: "decision",
      summary: "Workflow projects keep the topic the user gave",
      scope: { playbooks: ["test-workflow"] },
      source: { kind: "user", quote: "keep my topic" },
    },
    cwd,
  );
  const { envelope } = cli("scripts/pipeline-check.ts", ["--project", "tmpl-b", "--json-only"], cwd);
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.deepEqual(envelope.metadata.memory, [{ id: memory.id, type: "decision", summary: memory.summary }]);
  assert.deepEqual(envelope.metadata.playbook, { id: "test-workflow", title: "Test test-workflow" });
  assert.equal(envelope.metadata.summary.read[0], "playbooks/test-workflow/AGENTS.md");
  assert.equal(envelope.metadata.summary.nextAction, "Run: pnpm next --project tmpl-b");
  assert.equal(envelope.metadata.summary.currentStage, undefined, "no stage state");
});

/** A full render of `format` with its receipt; `extra` adds receipt fields (a partial excerpt). */
function fakeRender(cwd: string, id: string, format: string, extra: Record<string, unknown> = {}): void {
  const out = path.join(cwd, "out", id);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, `${format}.mp4`), "mp4");
  writeFileSync(
    path.join(out, `${format}.mp4.receipt.json`),
    JSON.stringify({ version: 1, format, sources: [], ...extra }),
  );
}

/** Sets a file's mtime `seconds` from now, so freshness never depends on write order within a millisecond. */
const touch = (file: string, seconds: number) => {
  const time = new Date(Date.now() + seconds * 1000);
  utimesSync(file, time, time);
};

test("next routes a bare project.json to the timeline route: render, QA, delivery, done", (t) => {
  const cwd = workspace(t);
  assert.equal(cli("scripts/create-project.ts", ["--project", "plain-a"], cwd).envelope.ok, true);
  const project = path.join(cwd, "public/projects/plain-a");
  touch(path.join(project, "project.json"), -60);

  const render = next("plain-a", cwd);
  assert.equal(render.status, 0, JSON.stringify(render.envelope));
  assert.equal(render.envelope.metadata.route, "timeline");
  assert.match(render.envelope.metadata.detectedBy, /project.json exists: render, QA and delivery/);
  assert.doesNotMatch(render.envelope.metadata.detectedBy, /ignored/);
  assert.equal(render.envelope.metadata.command, "pnpm next --project plain-a");
  assert.equal(render.envelope.metadata.legacy, undefined);
  const step = render.envelope.metadata.next;
  assert.equal(step.step, "render");
  assert.equal(step.action, "run");
  assert.deepEqual(step.commands, ["pnpm render --project plain-a --format vertical"]);
  assert.deepEqual(step.state.formats, ["vertical", "square"]);
  assert.equal(step.playbook, null);
  assertReadable(step.read, "docs/delivery.md");

  fakeRender(cwd, "plain-a", "vertical");
  fakeRender(cwd, "plain-a", "square", { partial: { startFrame: 0, endFrame: 9, totalFrames: 90 } });
  const excerpt = next("plain-a", cwd).envelope.metadata.next;
  assert.equal(excerpt.step, "render", "an excerpt is not a render");
  assert.deepEqual(excerpt.commands, ["pnpm render --project plain-a --format square"]);

  fakeRender(cwd, "plain-a", "square");
  touch(path.join(project, "project.json"), 60);
  const stale = next("plain-a", cwd).envelope.metadata.next;
  assert.equal(stale.step, "render");
  assert.match(stale.why, /older than project\.json/);
  touch(path.join(project, "project.json"), -60);

  const qa = next("plain-a", cwd).envelope.metadata.next;
  assert.equal(qa.step, "qa");
  assert.deepEqual(qa.commands, [
    "pnpm qa:editorial --project plain-a --format vertical --render out/plain-a/vertical.mp4",
  ]);
  assert.ok(qa.read.includes(".agents/skills/qa-and-delivery/SKILL.md"));

  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  const report = path.join(project, "pipeline/editorial-qa.json");
  writeFileSync(report, JSON.stringify({ status: "failed", findings: [{ severity: "error" }] }));
  touch(report, 30);
  const fix = next("plain-a", cwd).envelope.metadata.next;
  assert.equal(fix.step, "qa");
  assert.equal(fix.action, "fix");

  writeFileSync(report, JSON.stringify({ status: "passed", findings: [] }));
  touch(report, 30);
  const delivery = next("plain-a", cwd).envelope.metadata.next;
  assert.equal(delivery.step, "delivery");
  assert.equal(delivery.action, "ask");
  assert.ok(
    delivery.commands[0].startsWith(
      "pnpm delivery --action snapshot --request public/projects/plain-a/pipeline/delivery/request.json",
    ),
  );
  assert.ok(delivery.userDecides.some((line: string) => /never written by an agent/.test(line)));

  const reports = path.join(project, "pipeline/delivery/reports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(path.join(reports, "snap-1.json"), JSON.stringify({ state: "production-ready" }));
  touch(path.join(reports, "snap-1.json"), 30);
  const done = next("plain-a", cwd).envelope.metadata.next;
  assert.equal(done.step, "done");
  assert.equal(done.action, "stop");
  assert.equal(done.capture.moment, "delivery");
});

test("a video:workflow project renders its timeline; a campaign recipe child is on the timeline route", (t) => {
  const cwd = workspace(t);
  assert.equal(cli("scripts/create-project.ts", ["--project", "edited"], cwd).envelope.ok, true);
  mkdirSync(path.join(cwd, "public/projects/edited/pipeline"), { recursive: true });
  writeFileSync(path.join(cwd, "public/projects/edited/pipeline/workflow-render.json"), "{}");
  assert.deepEqual(next("edited", cwd).envelope.metadata.next.commands, [
    "pnpm render --project edited --format vertical --timeline",
  ]);

  const child = path.join(cwd, "public/projects/batch-en");
  mkdirSync(path.join(child, "pipeline"), { recursive: true });
  writeFileSync(path.join(child, "project.json"), JSON.stringify({ formats: ["landscape"] }));
  writeFileSync(path.join(child, "pipeline/campaign-binding.json"), "{}");
  assert.equal(detectRoute(child).route, "timeline");
  const { status, envelope } = next("batch-en", cwd);
  assert.equal(status, 0, JSON.stringify(envelope));
  assert.equal(envelope.metadata.route, "timeline");
  assert.deepEqual(envelope.metadata.next.commands, ["pnpm render --project batch-en --format landscape"]);
});

test("a timeline project accepts any playbook, and a recipe project is suggested its recipe's owners", (t) => {
  const cwd = workspace(t);
  withPlaybooks(cwd);
  assert.equal(cli("scripts/create-project.ts", ["--project", "draft"], cwd).envelope.ok, true);
  const use = cli("scripts/playbook.ts", ["--use", "test-film", "--project", "draft"], cwd).envelope;
  assert.equal(use.ok, true, JSON.stringify(use));
  assert.equal(use.metadata.route, "timeline");
  const bound = next("draft", cwd).envelope.metadata;
  assert.equal(bound.route, "timeline", "a film binding does not reroute a project.json");
  assert.equal(bound.next.read[0], "playbooks/test-film/AGENTS.md");

  const recipe = path.join(cwd, "public/projects/draft-2");
  mkdirSync(path.join(recipe, "pipeline"), { recursive: true });
  writeFileSync(path.join(recipe, "project.json"), "{}");
  writeFileSync(path.join(recipe, "pipeline/recipe.json"), JSON.stringify({ request: { recipeId: "music-motion" } }));
  const suggest = playbookSuggest(recipe, REPO);
  assert.ok(
    suggest?.playbooks.some((playbook) => playbook.id === "motion-design"),
    "an owner with no template route is still suggested",
  );
  assert.equal(suggest?.use, "pnpm playbook --use motion-design --project draft-2");
});

test("--playbook accepts a playbook whose alternative has the command's route, with that alternative's defaults", (t) => {
  const cwd = workspace(t);
  withPlaybooks(cwd);
  mkdirSync(path.join(cwd, "public/projects/cast"), { recursive: true });
  const footage = cli("scripts/footage-next.ts", ["--project", "cast", "--playbook", "test-tutorial"], cwd).envelope;
  assert.equal(footage.ok, true, JSON.stringify(footage));
  assert.equal(binding(cwd, "cast").id, "test-tutorial");
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(cwd, "public/projects/cast/pipeline/footage-goals.json"), "utf8")).goals,
    ["captions"],
  );
  assert.equal(footage.metadata.read[0], "playbooks/test-tutorial/AGENTS.md");

  const film = cli("scripts/film-init.ts", ["--project", "cast-film", "--playbook", "test-screencast"], cwd).envelope;
  assert.equal(film.ok, true, JSON.stringify(film));
  assert.equal(film.metadata.filmType, "collage", "the first film alternative, past a workflow one");
  assert.equal(film.metadata.typeFrom, "playbook");

  const refused = cli("scripts/footage-next.ts", ["--project", "cast", "--playbook", "test-workflow"], cwd).envelope;
  assert.equal(refused.error, "INVALID_INPUT");
  assert.match(refused.message, /no footage alternative.*pnpm video:workflow --scenario product-ad/);
});
