/**
 * Remotion Studio on request (RFC 0004 §17, D21 as amended 2026-11-18): target resolution (film, project, campaign,
 * missing, entry traversal and symlink escape), props equal to the render's, state and identity (stale state, pid
 * reuse, owner), the per-key lock, port choice, the launch argv, and `studio:open`'s CLI contract with the pause
 * (refused for an agent, admitted with the console grant). Nothing here starts Remotion; the gated end-to-end run is
 * tests/studio-open-e2e.test.ts.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { planProjectRender } from "../src/lib/render-plan";
import {
  checkEntry,
  checkFilmProps,
  choosePort,
  isOurStudio,
  listStates,
  nodeOptionsWith,
  openStudio,
  propsFileOf,
  readState,
  rendersTimeline,
  resolveStudioTarget,
  stateFileOf,
  stopConsoleStudios,
  stopProjectStudios,
  stopStudio,
  stopSupersededStudios,
  studioArgv,
  studioEnv,
  studioKey,
  studioStatus,
  takeOverStaleLock,
  targetKey,
  withStudioLock,
  writeState,
  writeStudioProps,
  type ProcessInfo,
  type StudioState,
} from "../src/lib/console/studio";
import { writeControl } from "../src/lib/console/control";
import { consoleGrantEnv } from "../src/lib/console/grant";
import { loadOrCreateSessionToken } from "../src/lib/console/session";
import { CONTROL_ALIASES } from "../src/lib/step-lease/lease";
import { StudioStatusResponseSchema } from "../src/types/console";
import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const DEMO = JSON.parse(readFileSync(path.join(REPO, "tests/fixtures/legacy/demo/project.json"), "utf8"));

function workspace(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-studio-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A project.json project with no media (music off), so the render plan needs no files. */
function addProject(root: string, id: string, overrides: Record<string, unknown> = {}) {
  const dir = path.join(root, "public/projects", id);
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  writeFileSync(path.join(dir, "project.json"), JSON.stringify({ ...DEMO, musicVolume: 0, ...overrides }, null, 2));
  return dir;
}

function addFilm(root: string, id: string, build?: unknown) {
  const dir = path.join(root, "public/projects", id);
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  writeFileSync(path.join(dir, "pipeline/brief.json"), JSON.stringify({ renderMode: "bespoke" }));
  if (build !== undefined) writeFileSync(path.join(dir, "pipeline/build.json"), JSON.stringify(build));
  return dir;
}

test("a bespoke film opens build.json's composition and entry (default src/index.ts); --format does not apply", (t) => {
  const root = workspace(t);
  addFilm(root, "film-a", { composition: "FilmA-Main", entry: "src/index.ts", extra: true });
  addFilm(root, "film-b", { composition: "FilmB" });
  const a = resolveStudioTarget(root, "film-a");
  assert.deepEqual(a, { available: true, target: { kind: "film", entry: "src/index.ts", composition: "FilmA-Main" } });
  const b = resolveStudioTarget(root, "film-b");
  assert.equal(b.available && b.target.entry, "src/index.ts");
  const formatted = resolveStudioTarget(root, "film-a", { format: "square" });
  assert.equal(formatted.available, false);
});

test("a project.json project opens its format's composition with a props file; default the first format", (t) => {
  const root = workspace(t);
  addProject(root, "demo-one", { formats: ["square", "vertical"] });
  const first = resolveStudioTarget(root, "demo-one");
  assert.ok(first.available);
  assert.deepEqual(first.target, {
    kind: "project",
    entry: "src/index.ts",
    composition: "ProjectSquare",
    format: "square",
  });
  assert.deepEqual(first.formats, ["square", "vertical"]);
  assert.equal(first.propsFile, path.join(root, "out/console/studio/demo-one/props.square.json"));
  const vertical = resolveStudioTarget(root, "demo-one", { format: "vertical" });
  assert.equal(vertical.available && vertical.target.composition, "ProjectVertical");
  const landscape = resolveStudioTarget(root, "demo-one", { format: "landscape" });
  assert.equal(landscape.available, false);
  assert.match(!landscape.available ? landscape.reason : "", /not configured for landscape/);
});

test("campaign containers, missing projects and projects with nothing to open are unavailable, with a reason", (t) => {
  const root = workspace(t);
  const campaign = addProject(root, "spring-campaign");
  mkdirSync(path.join(campaign, "pipeline/campaign-production"), { recursive: true });
  writeFileSync(
    path.join(campaign, "pipeline/campaign-production/owner.json"),
    JSON.stringify({ version: 1, campaignId: "spring-campaign" }),
  );
  addFilm(root, "no-build");
  mkdirSync(path.join(root, "public/projects/empty"), { recursive: true });
  const cases: [string, string, RegExp][] = [
    ["spring-campaign", "INVALID_INPUT", /campaign container/],
    ["no-build", "STAGE_INCOMPLETE", /bespoke film with no build yet/],
    ["empty", "STAGE_INCOMPLETE", /neither pipeline\/build.json nor project.json/],
    ["absent", "PROJECT_NOT_FOUND", /not found/],
  ];
  for (const [id, code, reason] of cases) {
    const resolution = resolveStudioTarget(root, id);
    assert.equal(resolution.available, false, id);
    if (!resolution.available) {
      assert.equal(resolution.code, code, id);
      assert.match(resolution.reason, reason, id);
    }
    const status = StudioStatusResponseSchema.parse(id === "absent" ? studioStatus(root, id) : studioStatus(root, id));
    assert.equal(status.available, false);
  }
});

test("build.json entries must be repository files: traversal, absolute, backslash, non-scripts and symlink escapes refused", (t) => {
  const root = workspace(t);
  const code = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-studio-code-")));
  t.after(() => rmSync(code, { recursive: true, force: true }));
  mkdirSync(path.join(code, "src"), { recursive: true });
  writeFileSync(path.join(code, "src/index.ts"), "export {};\n");
  writeFileSync(path.join(code, "src/notes.txt"), "x");
  mkdirSync(path.join(code, "src/dir.ts"));
  const outside = path.join(root, "outside.ts");
  writeFileSync(outside, "export {};\n");
  symlinkSync(outside, path.join(code, "src/link.ts"));
  symlinkSync(path.join(code, "src/index.ts"), path.join(code, "src/inner-link.ts"));
  assert.deepEqual(checkEntry(code, "src/index.ts"), { entry: "src/index.ts" });
  assert.deepEqual(checkEntry(code, "./src/index.ts"), { entry: "src/index.ts" });
  assert.deepEqual(
    checkEntry(code, "src/inner-link.ts"),
    { entry: "src/inner-link.ts" },
    "a link inside stays allowed",
  );
  for (const entry of [
    "../outside.ts",
    "src/../../outside.ts",
    outside,
    "/etc/passwd",
    "src\\index.ts",
    "C:/x.ts",
    "src//index.ts",
    "src/notes.txt",
    "src/missing.ts",
    "src/dir.ts",
    "src/link.ts",
    "-r.ts",
    "src/-x/index.ts",
    "--inspect=0.ts",
    "",
    42,
  ])
    assert.ok("reason" in checkEntry(code, entry), `accepted ${String(entry)}`);
  for (const build of [
    { composition: "Film", entry: "../outside.ts" },
    { composition: "Film", entry: "src/link.ts" },
    { composition: "../Film" },
    { composition: "Film/x" },
    { composition: "" },
    { entry: "src/index.ts" },
  ]) {
    addFilm(root, "film-x", build);
    const resolution = resolveStudioTarget(root, "film-x", { codeRoot: code });
    assert.equal(resolution.available, false, JSON.stringify(build));
  }
  writeFileSync(path.join(root, "public/projects/film-x/pipeline/build.json"), "{ not json");
  assert.equal(resolveStudioTarget(root, "film-x", { codeRoot: code }).available, false);
  writeFileSync(path.join(code, "src/-dash.ts"), "export {};\n");
  assert.match((checkEntry(code, "src/-dash.ts") as { reason: string }).reason, /starting with "-"/);
});

test("a film's build.json props open with it, as film:render passes them: a file under public/, never outside", (t) => {
  const root = workspace(t);
  mkdirSync(path.join(root, "public/projects/film-p/viz"), { recursive: true });
  writeFileSync(path.join(root, "public/projects/film-p/viz/props.json"), "{}");
  writeFileSync(path.join(root, "outside.json"), "{}");
  symlinkSync(path.join(root, "outside.json"), path.join(root, "public/projects/film-p/viz/link.json"));
  mkdirSync(path.join(root, "public/projects/film-p/viz/-flag"), { recursive: true });
  writeFileSync(path.join(root, "public/projects/film-p/viz/-flag/p.json"), "{}");
  addFilm(root, "film-p", { composition: "FilmP", props: "projects/film-p/viz/props.json" });
  const film = resolveStudioTarget(root, "film-p");
  assert.deepEqual(film, {
    available: true,
    target: { kind: "film", entry: "src/index.ts", composition: "FilmP" },
    propsFile: path.join(root, "public/projects/film-p/viz/props.json"),
  });
  assert.deepEqual(checkFilmProps(root, "./projects/film-p/viz/props.json"), {
    propsFile: path.join(root, "public/projects/film-p/viz/props.json"),
  });
  for (const props of [
    "../outside.json",
    "projects/../../outside.json",
    path.join(root, "outside.json"),
    "projects/film-p/viz/link.json",
    "projects/film-p/viz/-flag/p.json",
    "-props.json",
    "projects/film-p/viz/missing.json",
    "projects/film-p/viz",
    "projects\\film-p\\viz\\props.json",
    "",
    7,
  ]) {
    addFilm(root, "film-p", { composition: "FilmP", props });
    const resolution = resolveStudioTarget(root, "film-p");
    assert.equal(resolution.available, false, `accepted ${String(props)}`);
    assert.match(!resolution.available ? resolution.reason : "", /props file/);
  }
});

test("the props file holds exactly the props pnpm render passes, is rewritten only on change and atomically", async (t) => {
  const root = workspace(t);
  const dir = addProject(root, "demo-props", { formats: ["vertical", "landscape"] });
  for (const format of ["vertical", "landscape"] as const) {
    const job = planProjectRender("demo-props", format, root, { timeline: false, captions: "on" }).jobs[0]!;
    const rendered = JSON.parse(job.args[job.args.indexOf("--props") + 1]!);
    const written = await writeStudioProps(root, "demo-props", format);
    assert.equal(written.file, propsFileOf(root, "demo-props", format));
    assert.equal(written.changed, true);
    assert.deepEqual(JSON.parse(readFileSync(written.file, "utf8")), rendered);
  }
  const again = await writeStudioProps(root, "demo-props", "vertical");
  assert.equal(again.changed, false, "unchanged props are not rewritten (no spurious reload)");
  const config = JSON.parse(readFileSync(path.join(dir, "project.json"), "utf8"));
  writeFileSync(path.join(dir, "project.json"), JSON.stringify({ ...config, tagline: "A new line" }));
  const changed = await writeStudioProps(root, "demo-props", "vertical");
  assert.equal(changed.changed, true);
  assert.equal(JSON.parse(readFileSync(changed.file, "utf8")).tagline, "A new line");
  assert.deepEqual(listStates(root), [], "no state written by props alone");

  assert.equal(
    spawnSync("ls", [path.dirname(changed.file)], { encoding: "utf8" }).stdout.includes(".tmp"),
    false,
    "no temp file left",
  );
});

test("the render's timeline decision: the journal when timeline-edit.json or workflow-render.json exists", (t) => {
  const root = workspace(t);
  const dir = addProject(root, "demo-tl");
  assert.equal(rendersTimeline(root, "demo-tl"), false);
  writeFileSync(path.join(dir, "pipeline/workflow-render.json"), "{}");
  assert.equal(rendersTimeline(root, "demo-tl"), true);
  rmSync(path.join(dir, "pipeline/workflow-render.json"));
  writeFileSync(path.join(dir, "pipeline/timeline-edit.json"), "{}");
  assert.equal(rendersTimeline(root, "demo-tl"), true);
});

const studioState = (root: string, overrides: Partial<StudioState> = {}): StudioState => ({
  v: 1,
  key: studioKey(root, "demo-one", "src/index.ts", propsFileOf(root, "demo-one", "square")),
  pid: process.pid,
  port: 3456,
  entry: "src/index.ts",
  composition: "ProjectSquare",
  propsFile: "out/console/studio/demo-one/props.square.json",
  project: "demo-one",
  format: "square",
  startedAt: new Date().toISOString(),
  owner: "console",
  ...overrides,
});

const studioInfo =
  (command = "node (npx remotion studio)", offsetMs = 0): ProcessInfo =>
  () => ({ command, startedAt: Date.now() + offsetMs });

test("keys are stable per (project, entry, props file); state files are 0600 and malformed ones ignored", (t) => {
  const root = workspace(t);
  const square = studioKey(root, "demo-one", "src/index.ts", propsFileOf(root, "demo-one", "square"));
  assert.match(square, /^[0-9a-f]{16}$/);
  assert.equal(square, studioKey(root, "demo-one", "src/index.ts", propsFileOf(root, "demo-one", "square")));
  assert.notEqual(square, studioKey(root, "demo-one", "src/index.ts", propsFileOf(root, "demo-one", "vertical")));
  assert.notEqual(studioKey(root, "a", "src/index.ts"), studioKey(root, "a", "src/films/a.tsx"));
  assert.notEqual(studioKey(root, "film-a", "src/index.ts"), studioKey(root, "film-b", "src/index.ts"));
  const state = studioState(root);
  writeState(root, state);
  assert.equal(statSync(stateFileOf(root, state.key)).mode & 0o777, 0o600);
  assert.deepEqual(readState(root, state.key), state);
  writeFileSync(stateFileOf(root, state.key), JSON.stringify({ ...state, composition: "../x" }));
  assert.equal(readState(root, state.key), undefined);
  writeFileSync(stateFileOf(root, state.key), "{ broken");
  assert.equal(readState(root, state.key), undefined);
  writeFileSync(stateFileOf(root, "0000000000000000"), JSON.stringify(state));
  assert.equal(readState(root, "0000000000000000"), undefined, "a state under another key's name");
});

test("status: a live Studio of ours is running; a dead pid, a reused pid or another program is not", (t) => {
  const root = workspace(t);
  addProject(root, "demo-one", { formats: ["square", "vertical"] });
  const state = studioState(root);
  writeState(root, state);
  const live = studioStatus(root, "demo-one", { info: studioInfo() });
  StudioStatusResponseSchema.parse(live);
  assert.deepEqual(live.running, {
    url: "http://127.0.0.1:3456/ProjectSquare",
    startedAt: state.startedAt,
    format: "square",
  });
  assert.equal(live.target?.composition, "ProjectSquare");
  assert.equal(isOurStudio(state, studioInfo()), true);
  assert.equal(isOurStudio(state, studioInfo("node (npx remotion studio)", 60_000)), false, "pid reused later");
  assert.equal(isOurStudio(state, studioInfo("/usr/bin/vim notes.txt")), false, "another program");
  assert.equal(
    isOurStudio(state, () => undefined),
    false,
  );
  assert.equal(studioStatus(root, "demo-one", { info: studioInfo("bash") }).running, undefined);
  writeState(root, { ...state, pid: 2 ** 22 + 12_345 });
  assert.equal(studioStatus(root, "demo-one", { info: studioInfo() }).running, undefined, "dead pid");
});

test("stopping a stale or foreign state removes the file and never signals the process", async (t) => {
  const root = workspace(t);
  const state = studioState(root);
  writeState(root, state);
  // process.pid is alive but is not a Studio: it must survive and the state must go.
  assert.equal(await stopStudio(root, state, { info: studioInfo("node test-runner") }), false);
  assert.equal(existsSync(stateFileOf(root, state.key)), false);
  // A dead pid: the state goes.
  const dead = studioState(root, { pid: 2 ** 22 + 12_345 });
  writeState(root, dead);
  assert.equal(await stopStudio(root, dead, { info: studioInfo() }), false);
  assert.equal(existsSync(stateFileOf(root, dead.key)), false);
});

test("stopping when ps cannot tell keeps the state of a live pid (no orphan), and signals nothing", async (t) => {
  const root = workspace(t);
  const state = studioState(root);
  writeState(root, state);
  assert.equal(await stopStudio(root, state, { info: () => undefined }), false);
  assert.deepEqual(readState(root, state.key), state, "kept: a later stop can still find this Studio");
});

/** A detached child whose title is Studio's, as Remotion sets it (`node (npx remotion studio)`). */
async function fakeStudio(t: TestContext): Promise<number> {
  const child = spawn(
    process.execPath,
    ["-e", "process.title = 'node (npx remotion studio)'; setInterval(() => {}, 1000);"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  t.after(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // stopped by the test
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  return child.pid!;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  "the console's shutdown stops only the Studios it started, by process group, after checking each is still ours",
  { skip: process.platform === "win32" ? "ps and process groups are POSIX" : false },
  async (t) => {
    const root = workspace(t);
    const consolePid = await fakeStudio(t);
    const cliPid = await fakeStudio(t);
    const startedAt = new Date().toISOString();
    writeState(root, studioState(root, { key: "aaaaaaaaaaaaaaaa", pid: consolePid, startedAt, owner: "console" }));
    writeState(root, studioState(root, { key: "bbbbbbbbbbbbbbbb", pid: cliPid, startedAt, owner: "cli" }));
    assert.equal(await stopConsoleStudios(root), 1);
    for (let i = 0; i < 20 && alive(consolePid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(consolePid), false, "the console's Studio stopped");
    assert.equal(alive(cliPid), true, "a Studio the user started from the CLI keeps running");
    assert.deepEqual(
      listStates(root).map((state) => state.owner),
      ["cli"],
    );
  },
);

test("the per-key lock serialises two openers and takes over a stale lock", async (t) => {
  const root = workspace(t);
  const order: string[] = [];
  const slow = (name: string) => async () => {
    order.push(`${name}:in`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    order.push(`${name}:out`);
    return name;
  };
  const results = await Promise.all([
    withStudioLock(root, "cccccccccccccccc", slow("a")),
    withStudioLock(root, "cccccccccccccccc", slow("b")),
  ]);
  assert.deepEqual(results, ["a", "b"]);
  assert.deepEqual(order, ["a:in", "a:out", "b:in", "b:out"]);
  const lock = path.join(root, "out/console/studio/dddddddddddddddd.lock");
  writeFileSync(lock, String(2 ** 22 + 54_321)); // a pid that is not running
  assert.equal(await withStudioLock(root, "dddddddddddddddd", async () => "taken", 1_000), "taken");
  assert.equal(existsSync(lock), false);
});

test("ports: the first free one, skipping recorded and busy ports, never the console's 4317", async (t) => {
  const server = createServer();
  const busy = await new Promise<number>((resolve) =>
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve((server.address() as { port: number }).port)),
  );
  t.after(() => server.close());
  const next = await choosePort(new Set(), busy, busy + 20);
  assert.ok(next > busy, `${next} > ${busy}`);
  const skipped = await choosePort(new Set([next]), busy, busy + 20);
  assert.notEqual(skipped, next);
  const console_ = await choosePort(new Set(), 4317, 4330);
  assert.notEqual(console_, 4317);
});

test("the launch: preload first, Remotion's studio with an explicit port, IPv4, no browser, a fresh server", () => {
  const argv = studioArgv({ codeRoot: REPO, entry: "src/index.ts", port: 3001, propsFile: "/x/props.json" });
  assert.equal(argv[0], "--require");
  assert.equal(argv[1], path.join(REPO, "scripts/studio/loopback.cjs"));
  assert.match(argv[2]!, /@remotion[/\\]cli[/\\]remotion-cli\.js$/);
  assert.deepEqual(argv.slice(3), [
    "studio",
    "src/index.ts",
    "--port",
    "3001",
    "--no-open",
    "--ipv4",
    "--force-new",
    "--props",
    "/x/props.json",
  ]);
  assert.ok(!studioArgv({ codeRoot: REPO, entry: "src/index.ts", port: 3001 }).includes("--props"));
  assert.equal(nodeOptionsWith("/a b/loop.cjs"), '--require "/a b/loop.cjs"');
  assert.equal(
    nodeOptionsWith('/a"b/l.cjs', "--max-old-space-size=4096"),
    '--max-old-space-size=4096 --require "/a\\"b/l.cjs"',
  );
});

test(
  "two films on one entry have their own Studios: status and --stop of one never see or stop the other's",
  { skip: process.platform === "win32" ? "ps and process groups are POSIX" : false },
  async (t) => {
    const root = workspace(t);
    addFilm(root, "film-a", { composition: "FilmA" });
    addFilm(root, "film-b", { composition: "FilmB" });
    const a = resolveStudioTarget(root, "film-a");
    const b = resolveStudioTarget(root, "film-b");
    assert.ok(a.available && b.available);
    const keyA = targetKey(root, "film-a", a);
    assert.notEqual(keyA, targetKey(root, "film-b", b));
    const pid = await fakeStudio(t);
    writeState(
      root,
      studioState(root, {
        key: keyA,
        pid,
        project: "film-a",
        composition: "FilmA",
        propsFile: undefined,
        format: undefined,
        startedAt: new Date().toISOString(),
      }),
    );
    assert.equal(studioStatus(root, "film-a").running?.url, "http://127.0.0.1:3456/FilmA", "open and status agree");
    assert.equal(studioStatus(root, "film-b").running, undefined);
    assert.equal(await stopProjectStudios(root, "film-b"), 0);
    assert.equal(alive(pid), true, "film-b's stop left film-a's Studio running");
    assert.equal(await stopProjectStudios(root, "film-a"), 1);
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(pid), false);
    assert.deepEqual(listStates(root), []);
  },
);

test(
  "a film whose build props changed: its earlier Studio is superseded and stopped; a project's other formats stay",
  { skip: process.platform === "win32" ? "ps and process groups are POSIX" : false },
  async (t) => {
    const root = workspace(t);
    mkdirSync(path.join(root, "public/projects/film-v/viz"), { recursive: true });
    for (const name of ["film-props-aaa.json", "film-props-bbb.json"])
      writeFileSync(path.join(root, "public/projects/film-v/viz", name), "{}");
    addFilm(root, "film-v", { composition: "FilmV", props: "projects/film-v/viz/film-props-aaa.json" });
    const before = resolveStudioTarget(root, "film-v");
    assert.ok(before.available);
    const oldPid = await fakeStudio(t);
    const film = { project: "film-v", composition: "FilmV", format: undefined, propsFile: undefined };
    writeState(
      root,
      studioState(root, {
        ...film,
        key: targetKey(root, "film-v", before),
        pid: oldPid,
        startedAt: new Date().toISOString(),
      }),
    );
    addFilm(root, "film-v", { composition: "FilmV", props: "projects/film-v/viz/film-props-bbb.json" });
    const after = resolveStudioTarget(root, "film-v");
    assert.ok(after.available);
    assert.notEqual(targetKey(root, "film-v", after), targetKey(root, "film-v", before));
    // A project's two formats: opening one never stops the other.
    addProject(root, "demo-one", { formats: ["square", "vertical"] });
    const squarePid = await fakeStudio(t);
    writeState(root, studioState(root, { pid: squarePid, startedAt: new Date().toISOString() }));
    const vertical = resolveStudioTarget(root, "demo-one", { format: "vertical" });
    assert.ok(vertical.available);
    assert.equal(await stopSupersededStudios(root, "demo-one", vertical), 0);
    assert.equal(alive(squarePid), true);
    assert.equal(await stopSupersededStudios(root, "film-v", after), 1);
    for (let i = 0; i < 20 && alive(oldPid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(oldPid), false);
    assert.deepEqual(
      listStates(root).map((state) => state.project),
      ["demo-one"],
    );
  },
);

test(
  "studio:open when ps cannot tell: a silent port is never replaced by a new launch, the state stays",
  { skip: process.platform === "win32" ? "process groups are POSIX" : false },
  async (t) => {
    const root = workspace(t);
    addProject(root, "demo-one", { formats: ["square"] });
    const silent = createServer(() => {});
    const port = await new Promise<number>((resolve) =>
      silent.listen(0, "127.0.0.1", () => resolve((silent.address() as { port: number }).port)),
    );
    t.after(() => silent.close());
    const pid = await fakeStudio(t);
    const state = studioState(root, { pid, port, startedAt: new Date().toISOString() });
    writeState(root, state);
    await assert.rejects(
      openStudio({
        rootDir: root,
        project: "demo-one",
        owner: "cli",
        identityTimeoutsMs: [100],
        info: () => undefined,
      }),
      (error: { code?: string; message?: string }) =>
        error.code === "TIMEOUT" && /ps gave no answer/.test(error.message!),
    );
    assert.equal(alive(pid), true);
    assert.deepEqual(readState(root, state.key), state);
    assert.equal(existsSync(path.join(root, "out/console/studio", `${state.key}.log`)), false, "nothing launched");
  },
);

test("a state recorded for another project under this key is never reported as this project's", (t) => {
  const root = workspace(t);
  addProject(root, "demo-one", { formats: ["square"] });
  writeState(root, studioState(root, { project: "someone-else" }));
  assert.equal(studioStatus(root, "demo-one", { info: studioInfo() }).running, undefined);
});

test(
  "a Studio of ours that does not answer its identity probes is not killed: studio:open reports TIMEOUT",
  { skip: process.platform === "win32" ? "ps and process groups are POSIX" : false },
  async (t) => {
    const root = workspace(t);
    addProject(root, "demo-one", { formats: ["square"] });
    // A port that accepts and never answers, like a Studio busy bundling.
    const silent = createServer(() => {});
    const port = await new Promise<number>((resolve) =>
      silent.listen(0, "127.0.0.1", () => resolve((silent.address() as { port: number }).port)),
    );
    t.after(() => silent.close());
    const pid = await fakeStudio(t);
    const state = studioState(root, { pid, port, startedAt: new Date().toISOString() });
    writeState(root, state);
    await assert.rejects(
      openStudio({ rootDir: root, project: "demo-one", owner: "cli", identityTimeoutsMs: [100, 150] }),
      (error: { code?: string; message?: string }) => error.code === "TIMEOUT" && /not answering/.test(error.message!),
    );
    assert.equal(alive(pid), true, "never killed on a timed-out probe");
    assert.deepEqual(readState(root, state.key), state, "its state stays");
  },
);

test("a stale lock is taken over atomically: a fresh lock created meanwhile is put back, nothing is left aside", (t) => {
  const root = workspace(t);
  const dir = path.join(root, "out/console/studio");
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "eeeeeeeeeeeeeeee.lock");
  writeFileSync(lock, "1");
  const judged = { ino: statSync(lock).ino, text: "1" };
  // Another opener replaced the stale lock with its own fresh one before we moved it.
  const fresh = path.join(dir, "fresh.tmp");
  writeFileSync(fresh, String(process.pid));
  renameSync(fresh, lock);
  assert.equal(takeOverStaleLock(lock, judged), false);
  assert.equal(readFileSync(lock, "utf8"), String(process.pid), "the fresh lock is back");
  // Same inode (a freed inode reused at once) but another holder's text: still put back.
  assert.equal(takeOverStaleLock(lock, { ino: statSync(lock).ino, text: "1" }), false);
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
  assert.equal(takeOverStaleLock(lock, { ino: statSync(lock).ino, text: String(process.pid) }), true);
  assert.equal(existsSync(lock), false);
  assert.equal(takeOverStaleLock(lock, judged), false, "already gone");
  assert.deepEqual(
    spawnSync("ls", ["-a", dir], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((name) => name.includes(".stale")),
    [],
  );
});

test("two openers waiting on one stale lock still run one at a time, and the holder removes only its own lock", async (t) => {
  const root = workspace(t);
  const lock = path.join(root, "out/console/studio/ffffffffffffffff.lock");
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, String(2 ** 22 + 54_321));
  let inside = 0;
  let overlap = false;
  const work = async () => {
    inside++;
    if (inside > 1) overlap = true;
    await new Promise((resolve) => setTimeout(resolve, 100));
    inside--;
  };
  await Promise.all([
    withStudioLock(root, "ffffffffffffffff", work, 5_000),
    withStudioLock(root, "ffffffffffffffff", work, 5_000),
  ]);
  assert.equal(overlap, false);
  assert.equal(existsSync(lock), false);
  // A holder whose lock was replaced (taken over after it ran too long) leaves the new holder's lock alone.
  await withStudioLock(root, "ffffffffffffffff", async () => {
    rmSync(lock);
    writeFileSync(lock, "999999");
  });
  assert.equal(readFileSync(lock, "utf8"), "999999");
});

test("Studio's environment carries no console grant, step admission, actor or channel claim", () => {
  const env = studioEnv(
    {
      PATH: "/bin",
      AGENTBROS_CONSOLE_GRANT: "g",
      AGENTBROS_CONSOLE_GRANT_AT: "1",
      AGENTBROS_STEP_ADMITTED: "x",
      AGENTBROS_ACTOR: "user",
      AGENTBROS_CHANNEL: "console",
      NODE_OPTIONS: "--max-old-space-size=4096",
    },
    "/repo/scripts/studio/loopback.cjs",
    "0123456789abcdef",
  );
  for (const name of [
    "AGENTBROS_CONSOLE_GRANT",
    "AGENTBROS_CONSOLE_GRANT_AT",
    "AGENTBROS_STEP_ADMITTED",
    "AGENTBROS_ACTOR",
    "AGENTBROS_CHANNEL",
  ])
    assert.equal(name in env, false, name);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.BROWSER, "none");
  assert.equal(env.AGENTBROS_STUDIO_KEY, "0123456789abcdef");
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096 --require "/repo/scripts/studio/loopback.cjs"');
});

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

function cli(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, AGENTBROS_NO_DOTENV: "1", AGENTBROS_EVENTS: "off" };
  delete base.AGENTBROS_CHANNEL;
  delete base.AGENTBROS_ACTOR;
  delete base.AGENTBROS_STEP_ADMITTED;
  const run = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/studio-open.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...base, ...env },
    timeout: SPAWN_TIMEOUT_MS,
  });
  const lines = run.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `one JSON line, got: ${run.stdout}\n${run.stderr}`);
  return { status: run.status, json: JSON.parse(lines[0]!) as Record<string, any> };
}

test("studio:open's JSON contract: --status, exclusive flags, invalid ids, unavailable targets", (t) => {
  const root = workspace(t);
  addProject(root, "demo-one", { formats: ["vertical"] });
  addFilm(root, "no-build");
  const status = cli(root, ["--project", "demo-one", "--status"]);
  assert.equal(status.status, 0);
  assert.equal(status.json.ok, true);
  assert.equal(status.json.metadata.available, true);
  assert.equal(status.json.metadata.target.composition, "ProjectVertical");
  const both = cli(root, ["--project", "demo-one", "--status", "--stop"]);
  assert.deepEqual([both.status, both.json.ok, both.json.error], [1, false, "INVALID_INPUT"]);
  const invalid = cli(root, ["--project", "../x"]);
  assert.deepEqual([invalid.status, invalid.json.error], [1, "INVALID_INPUT"]);
  const unavailable = cli(root, ["--project", "no-build"]);
  assert.deepEqual([unavailable.status, unavailable.json.error], [1, "STAGE_INCOMPLETE"]);
  assert.match(unavailable.json.message, /no build yet/);
  const stop = cli(root, ["--project", "demo-one", "--stop"]);
  assert.deepEqual([stop.status, stop.json.metadata.stopped], [0, 0]);
  assert.equal(existsSync(path.join(root, "out/console/studio/demo-one")), false, "status and stop write no props");
});

test("paused: an agent's studio:open is refused with PAUSED; the console's, signed for its argv, runs", (t) => {
  const root = workspace(t);
  loadOrCreateSessionToken(root);
  const dir = addFilm(root, "paused-film");
  writeControl(dir, { state: "paused", answer: "Hold on.", channel: "console" });
  assert.ok(!(CONTROL_ALIASES as readonly string[]).includes("studio:open"), "not a control command");
  const open = ["--project", "paused-film"];
  const agent = cli(root, open);
  assert.deepEqual([agent.status, agent.json.error], [1, "PAUSED"]);
  const user = cli(root, open, {
    AGENTBROS_ACTOR: "user",
    AGENTBROS_CHANNEL: "console",
    ...consoleGrantEnv(root, "paused-film", open),
  });
  // Past the pause: refused only because this film has no build yet.
  assert.deepEqual([user.status, user.json.error], [1, "STAGE_INCOMPLETE"]);
  const stop = ["--project", "paused-film", "--stop"];
  const stopped = cli(root, stop, consoleGrantEnv(root, "paused-film", stop));
  assert.deepEqual([stopped.status, stopped.json.ok], [0, true]);
  const forged = cli(root, stop, consoleGrantEnv(root, "paused-film", open));
  assert.equal(forged.json.error, "PAUSED", "a grant for another argv does not admit");
});
