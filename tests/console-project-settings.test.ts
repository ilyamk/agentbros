import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileDataSource } from "../src/lib/console/default-source";
import { notImplementedActions } from "../src/lib/console/data";
import { appendEvent, projectTarget } from "../src/lib/console/journal";
import { logFileOf, stateFileOf, writeState } from "../src/lib/console/studio";
import { ulid } from "../src/lib/console/ulid";
import { projectFootprint } from "../src/lib/pipeline/paths";
import { PROJECT_DISPLAY_FILE, readProjectTitle } from "../src/lib/project-display";
import { makeRoot, postHeaders, PROJECT, raw, removeRoot, startTestServer } from "./helpers/console-server";
import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";

const repo = path.resolve(import.meta.dirname, "..");
const fixtures = "public/projects";
const endpoint = `/api/projects/${PROJECT}`;

function setup(t: TestContext) {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  const project = path.join(root, fixtures, PROJECT);
  return { root, project };
}

test("project rename keeps the ID, config and links, and persists across server restarts", async (t) => {
  const { root, project } = setup(t);
  const config = readFileSync(path.join(project, "project.json"), "utf8");
  const server = await startTestServer(root);
  t.after(() => server.close());
  const get = (url: string) => raw(server.port, { path: url, headers: { "x-console-token": server.token } });
  const rename = (title: string) =>
    raw(server.port, {
      method: "POST",
      path: `${endpoint}/rename`,
      headers: postHeaders(server),
      body: JSON.stringify({ title }),
    });

  assert.equal((await get("/api/projects")).json().projects[0].title, "Demo film");
  assert.equal((await rename(" \t ")).status, 400);
  assert.equal((await rename("a".repeat(201))).status, 400);
  assert.equal((await rename("one\ntwo")).status, 400);
  assert.equal(existsSync(path.join(project, PROJECT_DISPLAY_FILE)), false);
  assert.deepEqual((await rename("  Промо студии  ")).json(), { ok: true });
  assert.equal((await get("/api/projects")).json().projects[0].title, "Промо студии");
  const view = (await get(`${endpoint}/view`)).json();
  assert.equal(view.project.title, "Промо студии");
  assert.equal(view.project.id, PROJECT);
  assert.equal(readFileSync(path.join(project, "project.json"), "utf8"), config);
  await server.close();

  const restarted = await startTestServer(root);
  t.after(() => restarted.close());
  const projects = await raw(restarted.port, {
    path: "/api/projects",
    headers: { "x-console-token": restarted.token },
  });
  assert.equal(projects.json().projects[0].title, "Промо студии");
  assert.equal((await createFileDataSource(root).view(PROJECT))?.project.title, "Промо студии");
});

test("confirmed removal runs the guarded cleanup script and removes the whole local footprint from the console", async (t) => {
  const { root, project } = setup(t);
  const server = await startTestServer(root);
  t.after(() => server.close());
  const footprints = projectFootprint(PROJECT);
  for (const footprint of footprints) {
    const file = path.join(root, footprint.endsWith(".json") ? footprint : path.join(footprint, "data.txt"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "owned");
  }
  const session = path.join(project, "pipeline/session");
  mkdirSync(session);
  writeFileSync(path.join(session, "control.json"), JSON.stringify({ v: 1, state: "paused" }));
  writeFileSync(path.join(session, "lease.json"), "invalid lease");
  writeFileSync(path.join(project, "pipeline/policy.json"), JSON.stringify({ mode: "autonomous" }));
  const other = path.join(root, fixtures, "other-film");
  mkdirSync(other);
  writeFileSync(path.join(other, "project.json"), "{}");
  const post = (body: unknown, headers = postHeaders(server), url = `${endpoint}/remove`) =>
    raw(server.port, { method: "POST", path: url, headers, body: JSON.stringify(body) });

  assert.equal((await post({ confirm: PROJECT }, { ...postHeaders(server), "x-console-token": "" })).status, 403);
  assert.equal((await post({ confirm: PROJECT }, postHeaders(server, { Origin: "https://example.test" }))).status, 403);
  assert.equal((await post({ confirm: "other-film" })).status, 400);
  assert.equal((await post({ confirm: PROJECT, allowTracked: true })).status, 400);
  assert.equal((await post({ confirm: PROJECT }, postHeaders(server), "/api/projects/%2e%2e/remove")).status, 400);
  assert.equal((await post({ confirm: "console" }, postHeaders(server), "/api/projects/console/remove")).status, 400);
  assert(footprints.every((file) => existsSync(path.join(root, file))));

  const get = (url: string) => raw(server.port, { path: url, headers: { "x-console-token": server.token } });
  assert((await get("/api/projects")).json().projects.some(({ id }: { id: string }) => id === PROJECT));
  const key = "abc0123456789def";
  writeState(root, {
    v: 1,
    key,
    project: PROJECT,
    pid: 2_000_000_000,
    port: 3001,
    entry: path.join(root, "src/Root.tsx"),
    composition: "Demo",
    startedAt: new Date().toISOString(),
    owner: "console",
  });
  writeFileSync(logFileOf(root, key), "old studio log");
  const deleted = await post({ confirm: PROJECT });
  assert.equal(deleted.status, 200, deleted.text);
  assert.deepEqual(deleted.json(), { ok: true });
  assert(footprints.every((file) => !existsSync(path.join(root, file))));
  assert.equal(existsSync(stateFileOf(root, key)), false);
  assert.equal(existsSync(logFileOf(root, key)), false);
  assert.deepEqual(
    (await get("/api/projects")).json().projects.map(({ id }: { id: string }) => id),
    ["other-film"],
  );
  assert.equal((await get(`${endpoint}/view`)).status, 404);
  assert.equal((await post({ confirm: PROJECT })).status, 404);
  assert.equal(existsSync(path.join(root, "out/console/dist/app.js")), true);
});

test("delete refuses while another console tab is writing to the project", async (t) => {
  const { root, project } = setup(t);
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  let finishWrite!: () => void;
  const finish = new Promise<void>((resolve) => (finishWrite = resolve));
  const server = await startTestServer(root, {
    actions: {
      ...notImplementedActions,
      async control() {
        signalStarted();
        await finish;
        const control = {
          v: 1,
          state: "paused",
          by: "user",
          channel: "console",
          at: new Date().toISOString(),
        } as const;
        writeFileSync(path.join(project, "control-test.json"), JSON.stringify(control));
        return { ok: true, control: { ...control, history: [] } };
      },
    },
  });
  t.after(() => server.close());
  const post = (action: string, body: unknown) =>
    raw(server.port, {
      method: "POST",
      path: `${endpoint}/${action}`,
      headers: postHeaders(server),
      body: JSON.stringify(body),
    });
  const control = post("control", { state: "paused", answer: "Pause this project" });
  try {
    await Promise.race([
      started,
      control.then((response) => assert.fail(`Control failed before starting: ${response.text}`)),
    ]);
    const refused = await post("remove", { confirm: PROJECT });
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.json().message, /project action is still running/);
    assert(existsSync(project));
  } finally {
    finishWrite();
  }
  assert.equal((await control).status, 200);
  assert.equal((await post("remove", { confirm: PROJECT })).status, 200);
  assert.equal(existsSync(project), false);
});

test("delete refuses while a journalled project command is still active", async (t) => {
  const { root, project } = setup(t);
  const server = await startTestServer(root);
  t.after(() => server.close());
  const target = projectTarget(root, PROJECT)!;
  const runId = ulid();
  const run = { v: 1, project: PROJECT, runId, alias: "render", actor: "agent", channel: "cli" } as const;
  assert(
    appendEvent(target, {
      ...run,
      id: ulid(),
      at: new Date().toISOString(),
      kind: "cli.start",
      data: { pid: process.pid },
    }),
  );
  const remove = () =>
    raw(server.port, {
      method: "POST",
      path: `${endpoint}/remove`,
      headers: postHeaders(server),
      body: JSON.stringify({ confirm: PROJECT }),
    });
  const refused = await remove();
  assert.equal(refused.status, 409, refused.text);
  assert.match(refused.json().message, /Project command render is still running/);
  assert(existsSync(project));
  assert(
    appendEvent(target, { ...run, id: ulid(), at: new Date().toISOString(), kind: "cli.end", ok: true, elapsedMs: 1 }),
  );
  assert.equal((await remove()).status, 200);
});

test("blocked deletions keep every project file and explain the refusal", async (t) => {
  const { root, project } = setup(t);
  const server = await startTestServer(root);
  t.after(() => server.close());
  const remove = () =>
    raw(server.port, {
      method: "POST",
      path: `${endpoint}/remove`,
      headers: postHeaders(server),
      body: JSON.stringify({ confirm: PROJECT }),
    });
  const renders = path.join(root, "out", PROJECT);
  mkdirSync(renders);
  const render = path.join(renders, "render.mp4");
  writeFileSync(render, "local");
  writeFileSync(
    path.join(project, "pipeline/operations.json"),
    JSON.stringify({ jobs: { "pending-job": { state: "running", reservedMicros: 100 } } }),
  );
  mkdirSync(path.join(root, "shared", PROJECT), { recursive: true });
  mkdirSync(path.join(root, "src"));
  symlinkSync(path.join(root, "shared"), path.join(root, "src/projects"), "dir");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", path.relative(root, render)], { cwd: root });

  const refused = await remove();
  assert.equal(refused.status, 409, refused.text);
  assert.match(refused.json().message, /Paid operation pending-job is still open \(running\)/);
  assert.match(refused.json().message, /tracked by Git/);
  assert.match(refused.json().message, /symlink/);
  assert.equal(readFileSync(render, "utf8"), "local");
  assert(existsSync(path.join(root, "shared", PROJECT)));
  assert(existsSync(path.join(project, "project.json")));
});

test("published jobs with outstanding reservations report pending billing and block deletion", async (t) => {
  const { root, project } = setup(t);
  const server = await startTestServer(root);
  t.after(() => server.close());
  const operations = path.join(project, "pipeline/operations.json");
  const jobs = {
    "first-job": { state: "published", reservedMicros: 50_000 },
    "second-job": { state: "published", reservedMicros: 295_600 },
    "billed-job": { state: "published", reservedMicros: 0 },
  };
  writeFileSync(operations, JSON.stringify({ jobs }));

  const refused = await raw(server.port, {
    method: "POST",
    path: `${endpoint}/remove`,
    headers: postHeaders(server),
    body: JSON.stringify({ confirm: PROJECT }),
  });
  assert.equal(refused.status, 409, refused.text);
  const { message } = refused.json();
  assert.match(message, /Billing is still pending/);
  assert.match(message, /pnpm budget/);
  assert.match(message, /first-job \(published\)/);
  assert.match(message, /second-job \(published\)/);
  assert.doesNotMatch(message, /billed-job/);
  assert.deepEqual(JSON.parse(readFileSync(operations, "utf8")).jobs, jobs);
});

test("both creation commands accept a short Unicode title independently of the slug", async (t) => {
  const { root } = setup(t);
  for (const [script, id] of [
    ["create-project.ts", "camera-demo"],
    ["film-init.ts", "agent-promo"],
  ]) {
    const reply = execFileSync(
      process.execPath,
      [
        path.join(repo, "node_modules/tsx/dist/cli.mjs"),
        path.join(repo, "scripts", script!),
        "--project",
        id!,
        "--title",
        "  Обзор камеры  ",
      ],
      { cwd: root, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS, env: { ...process.env, AGENTBROS_CONSOLE: "off" } },
    );
    assert.equal(JSON.parse(reply).ok, true);
    assert.equal(readProjectTitle(path.join(root, fixtures, id!)), "Обзор камеры");
  }
});
