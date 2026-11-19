import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBoundedRenderWorker } from "../src/lib/longform/bounded-worker";
import { CliErrorObject } from "../src/lib/cli";
import { educationFixture } from "./workflow-education-fixture";
import { runEducationWorkflow } from "../src/lib/workflows/education";
import { projectChapterPlan, renderChapters } from "../src/lib/longform/runner";
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitForDeath = async (pid: number) => {
  for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false, `Owned process ${pid} survived escalation`);
};

test(
  "stalled worker and detached descendant are bounded; unrelated sibling survives, no partial chapter/cache publication",
  { skip: process.platform === "win32", timeout: 20000 },
  async () => {
    const f = educationFixture(),
      directory = mkdtempSync(path.join(tmpdir(), "bounded-render-"));
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore" });
    let owned: { worker: number; detached: number } | undefined;
    try {
      const result = runEducationWorkflow(f.request, { action: "create", rootDir: f.root });
      const plan = projectChapterPlan(f.request.projectId, result.metadata.chapterManifest, {
        rootDir: f.root,
        codeDir: process.cwd(),
      });
      const started = Date.now(),
        pids = path.join(directory, "pids.json");
      await assert.rejects(
        renderChapters(plan, {
          dryRun: false,
          render: async (_job, output) => {
            await runBoundedRenderWorker(
              process.execPath,
              [path.resolve("tests/fixtures/stalled-render-worker.mjs"), pids, output],
              process.cwd(),
              { timeoutMs: 8000, stallTimeoutMs: 1000 },
            );
          },
        }),
        (error) =>
          error instanceof CliErrorObject &&
          error.code === "TIMEOUT" &&
          /no rendered\/encoded frame progress/.test(error.message),
      );
      assert.ok(Date.now() - started < 6000, "Repeated progress heartbeats cannot extend the stall deadline");
      owned = JSON.parse(readFileSync(pids, "utf8"));
      await waitForDeath(owned!.worker);
      await waitForDeath(owned!.detached);
      assert.equal(alive(unrelated.pid!), true, "Only isolated worker descendants may be killed");
      assert.ok(plan.jobs.every((job) => !existsSync(job.output)));
      assert.ok(
        !existsSync(plan.cacheFile) || Object.keys(JSON.parse(readFileSync(plan.cacheFile, "utf8"))).length === 0,
      );
      assert.ok(
        readdirSync(path.dirname(plan.cacheFile)).every(
          (name) => !name.includes(".tmp") && !name.endsWith(".worker.json"),
        ),
        "Failed temporary output is removed",
      );
    } finally {
      unrelated.kill("SIGKILL");
      if (owned) for (const pid of [owned.worker, owned.detached]) if (alive(pid)) process.kill(pid, "SIGKILL");
      f.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("absolute worker deadline is independent of increasing progress; successful workers finish and invalid bounds fail before spawn", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bounded-render-"));
  try {
    await runBoundedRenderWorker(
      process.execPath,
      ["-e", "process.send({renderedFrames:1,encodedFrames:1});process.disconnect();"],
      directory,
      { timeoutMs: 1000, stallTimeoutMs: 1000 },
    );
    const started = Date.now();
    await assert.rejects(
      runBoundedRenderWorker(
        process.execPath,
        [
          "-e",
          "let n=0;setInterval(()=>process.send({renderedFrames:++n,encodedFrames:n}),100);process.on('SIGTERM',()=>{});",
        ],
        directory,
        { timeoutMs: 1000, stallTimeoutMs: 5000 },
      ),
      (error) => error instanceof CliErrorObject && error.code === "TIMEOUT" && /deadline/.test(error.message),
    );
    assert.ok(Date.now() - started < 5000);
    assert.throws(() => runBoundedRenderWorker("nonexistent", [], directory, { timeoutMs: NaN }), /integer/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "acknowledged early worker exits sweep detached children on success/failure; unrelated process survives",
  { skip: process.platform === "win32", timeout: 10000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "early-render-")),
      pids = path.join(directory, "pid");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore" });
    let detached: number | undefined;
    try {
      for (const code of [0, 7]) {
        const task = runBoundedRenderWorker(
          process.execPath,
          [
            "--import",
            path.resolve("node_modules/tsx/dist/loader.mjs"),
            path.resolve("tests/fixtures/early-exit-render-worker.mjs"),
            pids,
            String(code),
          ],
          directory,
          { timeoutMs: 5000, stallTimeoutMs: 5000 },
        );
        if (code === 0) await task;
        else await assert.rejects(task, /exited 7/);
        detached = Number(readFileSync(pids, "utf8"));
        await waitForDeath(detached);
        assert.equal(alive(unrelated.pid!), true);
      }
    } finally {
      unrelated.kill("SIGKILL");
      if (detached && alive(detached)) process.kill(detached, "SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "worker cannot register an unrelated process as an owned cleanup target",
  { skip: process.platform === "win32", timeout: 10000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "false-render-owner-"));
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore" });
    try {
      const code =
        "const cp=require('node:child_process');const row=cp.execFileSync('ps',['-p',process.argv[1],'-o','pid=,ppid=,lstart='],{encoding:'utf8'}).trim().match(/^(\\d+)\\s+(\\d+)\\s+(.+)$/);process.send({type:'owned-processes',processes:[{pid:Number(row[1]),ppid:Number(row[2]),identity:row[3]}]});process.on('SIGTERM',()=>{});setInterval(()=>{},100);";
      await assert.rejects(
        runBoundedRenderWorker(process.execPath, ["-e", code, String(unrelated.pid)], directory, {
          timeoutMs: 5000,
          stallTimeoutMs: 5000,
        }),
        (error) =>
          error instanceof CliErrorObject &&
          error.code === "INTERNAL" &&
          /Invalid owned-process receipt/.test(error.message),
      );
      assert.equal(alive(unrelated.pid!), true);
    } finally {
      unrelated.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "late TERM-resistant detached child is swept on escalation; unrelated sibling survives and cache stays unpublished",
  { skip: process.platform === "win32", timeout: 20000 },
  async () => {
    const f = educationFixture(),
      directory = mkdtempSync(path.join(tmpdir(), "bounded-render-"));
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore" });
    let owned: { worker: number; detached: number; late: number } | undefined;
    try {
      const result = runEducationWorkflow(f.request, { action: "create", rootDir: f.root });
      const plan = projectChapterPlan(f.request.projectId, result.metadata.chapterManifest, {
        rootDir: f.root,
        codeDir: process.cwd(),
      });
      const started = Date.now(),
        pids = path.join(directory, "pids.json");
      await assert.rejects(
        renderChapters(plan, {
          dryRun: false,
          render: async (_job, output) => {
            await runBoundedRenderWorker(
              process.execPath,
              [path.resolve("tests/fixtures/stalled-render-worker.mjs"), pids, output, "late"],
              process.cwd(),
              { timeoutMs: 1000, stallTimeoutMs: 5000 },
            );
          },
        }),
        (error) => error instanceof CliErrorObject && error.code === "TIMEOUT" && /deadline/.test(error.message),
      );
      assert.ok(Date.now() - started < 6000, "Repeated progress heartbeats cannot extend the stall deadline");
      owned = JSON.parse(readFileSync(pids, "utf8"));
      assert.ok(owned!.late, "Fixture must spawn the late detached process");
      await waitForDeath(owned!.worker);
      await waitForDeath(owned!.detached);
      await waitForDeath(owned!.late);
      assert.equal(alive(unrelated.pid!), true, "Only isolated worker descendants may be killed");
      assert.ok(plan.jobs.every((job) => !existsSync(job.output)));
      assert.ok(
        !existsSync(plan.cacheFile) || Object.keys(JSON.parse(readFileSync(plan.cacheFile, "utf8"))).length === 0,
      );
      assert.ok(
        readdirSync(path.dirname(plan.cacheFile)).every(
          (name) => !name.includes(".tmp") && !name.endsWith(".worker.json"),
        ),
        "Failed temporary output is removed",
      );
    } finally {
      unrelated.kill("SIGKILL");
      if (owned)
        for (const pid of [owned.worker, owned.detached, owned.late]) if (alive(pid)) process.kill(pid, "SIGKILL");
      f.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "trusted root hook rejects or aborts before ACK without worker activation and unrelated process kills",
  { skip: process.platform === "win32", timeout: 15000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "root-hook-")),
      unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore" }),
      fixture = path.resolve("tests/fixtures/native-registration-worker.mjs");
    try {
      for (const mode of ["reject", "abort", "pending-abort"] as const) {
        const controller = new AbortController(),
          marker = path.join(directory, mode);
        let pid: number | undefined;
        await assert.rejects(
          runBoundedRenderWorker(
            process.execPath,
            ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), fixture, marker],
            directory,
            {
              timeoutMs: 5000,
              stallTimeoutMs: 5000,
              signal: controller.signal,
              onRegisteredRoot: async (root) => {
                pid = root;
                if (mode === "reject") throw Error("Trusted registration refused");
                controller.abort();
                if (mode === "pending-abort") await new Promise<void>(() => {});
              },
            },
          ),
          /registration refused|cancelled/,
        );
        assert.equal(existsSync(marker), false);
        if (pid) await waitForDeath(pid);
        assert.equal(alive(unrelated.pid!), true);
      }
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        runBoundedRenderWorker(process.execPath, [], directory, { signal: controller.signal }),
        /before launch/,
      );
    } finally {
      unrelated.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "outer cancellation before delayed child receipt awaits direct-spawn root cleanup",
  { skip: process.platform === "win32", timeout: 10000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "outer-pre-ack-")),
      pidFile = path.join(directory, "pid"),
      marker = path.join(directory, "activated");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore" });
    const outer = spawn(
      process.execPath,
      [
        "--import",
        path.resolve("node_modules/tsx/dist/loader.mjs"),
        path.resolve("tests/fixtures/native-preparation-outer.mjs"),
        pidFile,
        marker,
      ],
      { stdio: "ignore" },
    );
    let root: number | undefined;
    try {
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(existsSync(pidFile), "trusted root callback runs before delayed three-second receipt");
      root = Number(readFileSync(pidFile, "utf8"));
      assert.equal(alive(root), true);
      const started = Date.now();
      outer.kill("SIGTERM");
      await waitForDeath(outer.pid!);
      await waitForDeath(root);
      assert.ok(Date.now() - started < 3000, "outer cleanup finishes before the delayed receipt");
      assert.equal(existsSync(marker), false);
      assert.equal(alive(unrelated.pid!), true);
    } finally {
      outer.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      if (root && alive(root)) process.kill(root, "SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
