import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { separateReferenceStems } from "../src/lib/reference/audio";
import { STEM_NAMES } from "../src/lib/audio-map/stems";

test("reference stems retain their public paths through the shared soundfile worker", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "python-stems-contract-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const paths = Object.fromEntries(
    STEM_NAMES.map((name) => {
      const file = path.join(directory, name + ".wav");
      writeFileSync(file, name);
      return [name, file];
    }),
  ) as Record<(typeof STEM_NAMES)[number], string>;
  const result = separateReferenceStems("/input/source.mov", directory, (input) => {
    assert.equal(input, "/input/source.mov");
    return { model: "htdemucs", sha256: "fixture", dir: directory, cached: true, paths };
  });
  assert.equal(result.available, true);
  for (const name of STEM_NAMES) {
    assert.equal(result.paths[name], `media/stems/htdemucs/source/${name}.wav`);
    assert.equal(readFileSync(path.join(directory, result.paths[name]!), "utf8"), name);
  }
});

test("reference stem failures remain an explicit unavailable result", () => {
  const result = separateReferenceStems("/input/source.mov", "/unused", () => {
    throw new Error("runtime unavailable");
  });
  assert.equal(result.available, false);
  assert.match(result.unavailableReason!, /runtime unavailable/);
  assert.deepEqual(result.paths, {});
});

test("model acceptance refuses an unknown selector instead of skipping all checks", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, RUN_PYTHON_MODELS: "1", PYTHON_MODEL_PROFILE: "invalid-profile" };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/tsx/dist/cli.mjs",
      "--test",
      "--import",
      "./tests/helpers/memory-root.ts",
      "tests/python-models.test.ts",
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Unknown public model profile/);
});

test("affected profile selection drains a large diff under pipefail", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "python-ci-selection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = path.join(directory, "git");
  writeFileSync(
    git,
    '#!/usr/bin/env node\nif (process.argv[2] === "diff") process.stdout.write("pyproject.toml\\n" + "unrelated/file.ts\\n".repeat(20000));\n',
    { mode: 0o755 },
  );
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const block = /Select affected profiles[\s\S]*?run: \|\n((?: {10}.+\n)+)/.exec(workflow)?.[1];
  assert.ok(block, "the affected-profile step must have a runnable shell body");
  const script = block
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  const output = path.join(directory, "output");
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: directory + path.delimiter + process.env.PATH,
      BASE: "fixture",
      PROFILE_PATHS: "audio-map",
      GITHUB_OUTPUT: output,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8").trim(), "run=true");
});

test(
  "interrupting the quality runner terminates its active process groups",
  { skip: process.platform === "win32", timeout: 30_000 },
  async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "python-check-cancellation-"));
    const uv = path.join(directory, "uv");
    const pidsFile = path.join(directory, "pids");
    writeFileSync(
      uv,
      `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (process.argv[2] === 'lock') process.exit(0);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.appendFileSync(process.env.PYTHON_CHECK_PIDS, JSON.stringify({ parent: process.pid, child: child.pid, environment: process.env.UV_PROJECT_ENVIRONMENT, noSync: process.env.UV_NO_SYNC, virtualEnv: process.env.VIRTUAL_ENV }) + '\\n');
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    const runner = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/python-check.ts"], {
      stdio: "ignore",
      env: {
        ...process.env,
        AGENTBROS_UV: uv,
        PYTHON_CHECK_PIDS: pidsFile,
        UV_PROJECT_ENVIRONMENT: path.join(directory, "wrong-environment"),
        UV_NO_SYNC: "1",
        VIRTUAL_ENV: path.join(directory, "wrong-environment"),
      },
    });
    let pids: { parent: number; child: number; environment: string; noSync?: string; virtualEnv?: string }[] = [];
    t.after(() => {
      runner.kill("SIGKILL");
      for (const row of pids) {
        try {
          process.kill(-row.parent, "SIGKILL");
        } catch {
          /* Already terminated. */
        }
      }
      rmSync(directory, { recursive: true, force: true });
    });
    const limit = Date.now() + 15_000;
    while (Date.now() < limit) {
      if (existsSync(pidsFile))
        pids = readFileSync(pidsFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      if (pids.length === 4) break;
      await delay(30);
    }
    assert.equal(pids.length, 4, "every parallel check started");
    for (const row of pids) {
      assert.equal(row.environment, path.join(process.cwd(), ".venv"));
      assert.equal(row.noSync, undefined);
      assert.equal(row.virtualEnv, undefined);
    }
    const closed = once(runner, "exit");
    runner.kill("SIGTERM");
    await closed;
    for (const pid of pids.flatMap((row) => [row.parent, row.child])) {
      let active = true;
      while (active && Date.now() < limit) {
        const probe = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
        active = probe.status === 0 && !probe.stdout.trim().startsWith("Z");
        if (active) await delay(30);
      }
      assert.equal(active, false, `check process ${pid} terminated`);
    }
  },
);
