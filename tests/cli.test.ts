import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, validateProjectId, assertPathWithin } from "../src/lib/cli";
import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";
const specs = [
  { name: "project", required: true, description: "project" },
  { name: "count", type: "number", description: "count" },
  { name: "clean", type: "boolean", default: true, description: "clean" },
] as const;
test("pnpm separator, inline values, negative numbers and boolean negation", () => {
  assert.deepEqual(parseArgs(specs, ["--", "--project=a", "--count", "-2", "--no-clean"]), {
    project: "a",
    count: -2,
    clean: false,
  });
  assert.equal(parseArgs(specs, ["--project", "hello world", "--clean=false"]).project, "hello world");
});
test("explicit legacy no-* flag names retain positive flag semantics", () => {
  assert.deepEqual(
    parseArgs([{ name: "no-directed", type: "boolean", description: "disable direction" }] as const, ["--no-directed"]),
    { "no-directed": true },
  );
});
test("bad numbers, unknown flags, absent values and boolean typos fail", () => {
  for (const argv of [
    ["--project"],
    ["--project", "--count", "2"],
    ["--project", "a", "--oops"],
    ["--project=a", "--count=3oops"],
    ["--project=a", "--count=Infinity"],
    ["--project=a", "--clean=perhaps"],
  ])
    assert.throws(() => parseArgs(specs, argv), { code: "INVALID_INPUT" });
});
test("project paths reject traversal even for short IDs and symlink ancestors", () => {
  for (const id of ["..", "/", "a/b", "a b", "x;echo", "-a", "a-"]) assert.throws(() => validateProjectId(id));
  validateProjectId("a");
  validateProjectId("btc-2026");
  const root = mkdtempSync(path.join(tmpdir(), "cli-path-"));
  try {
    mkdirSync(path.join(root, "safe"));
    mkdirSync(path.join(root, "outside"));
    symlinkSync(path.join(root, "outside"), path.join(root, "safe", "link"));
    assert.throws(() => assertPathWithin(path.join(root, "safe"), path.join(root, "safe", "link", "new.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("path guards refuse dangling symlinks and preserve safe new paths and internal aliases", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "cli-dangling-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const safe = path.join(root, "safe");
  mkdirSync(safe);
  symlinkSync("../missing.json", path.join(safe, "output.json"));
  symlinkSync("../missing-directory", path.join(safe, "directory"));
  for (const target of ["output.json", "directory/new.json"]) {
    assert.throws(() => assertPathWithin(safe, path.join(safe, target)), { code: "INVALID_INPUT" });
  }
  symlinkSync("loop", path.join(safe, "loop"));
  assert.throws(() => assertPathWithin(safe, path.join(safe, "loop/new.json")), { code: "INVALID_INPUT" });
  mkdirSync(path.join(safe, "actual"));
  symlinkSync("actual", path.join(safe, "alias"));
  assert.doesNotThrow(() => assertPathWithin(safe, path.join(safe, "alias/new.json")));
  assert.doesNotThrow(() => assertPathWithin(path.join(safe, "new"), path.join(safe, "new/nested/file.json")));
});
const repo = path.resolve(import.meta.dirname, "..");
const legacyBatchScripts = readdirSync(path.join(repo, "scripts")).filter((name) =>
  /^generate-.+-videos\.ts$/.test(name),
);
const tsx = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");
function invoke(script: string, args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [tsx, path.join(repo, "scripts", script), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, FAL_KEY: "", ELEVENLABS_API_KEY: "" },
  });
  assert.ok(result.stdout.endsWith("\n"), `${script}: missing newline ${result.stderr}`);
  assert.equal(result.stdout.trim().split("\n").length, 1, result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(typeof envelope.elapsedMs, "number");
  assert.equal(result.status, envelope.ok ? 0 : 1);
  return envelope;
}
test("every migrated script help emits one success envelope without API or filesystem mutations", () => {
  for (const script of [
    "create-project.ts",
    "list-projects.ts",
    "qa-screenshots.ts",
    "slice-talking-head.ts",
    "generate-ai-image.ts",
    "fal-models.ts",
    ...legacyBatchScripts,
  ])
    assert.equal(invoke(script, ["--", "--help"], repo).metadata.help, true);
});
test("creation positional compatibility, duplicate error, invalid IDs and listing JSON", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "cli project spaces "));
  try {
    const created = invoke("create-project.ts", ["--", "a"], cwd);
    assert.equal(created.metadata.projectId, "a");
    assert.equal(invoke("create-project.ts", ["a"], cwd).error, "FILE_EXISTS");
    assert.equal(invoke("create-project.ts", [".."], cwd).error, "INVALID_INPUT");
    assert.equal(invoke("list-projects.ts", [], cwd).metadata.projects[0].id, "a");
    assert.equal(
      invoke("generate-ai-image.ts", ["--prompt", "test", "--output", "x.png", "--provider", "fal"], cwd).error,
      "INVALID_INPUT",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("synthetic local video screenshots do not seek EOF and slicing handles paths with spaces", (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const cwd = mkdtempSync(path.join(tmpdir(), "cli media spaces "));
  try {
    invoke("create-project.ts", ["clip"], cwd);
    const configPath = path.join(cwd, "public/projects/clip/project.json");
    const config = {
      name: "Clip",
      formats: ["vertical"],
      productName: "Clip",
      tagline: "",
      colors: { accent: "#ffffff", background: "#000000", text: "#ffffff" },
      voice: "rachel",
      musicPrompt: "",
      musicVolume: 0.1,
      talkingHead: { enabled: true, presenterVideo: "projects/clip/talking-head/source file.mp4" },
      scenes: [{ id: "scene", text: "", visualType: "title", headline: "", presenterStartSec: 0, presenterEndSec: 1 }],
    };
    writeFileSync(configPath, JSON.stringify(config));
    const source = path.join(cwd, config.talkingHead.presenterVideo.replace("projects/", "public/projects/"));
    mkdirSync(path.dirname(source), { recursive: true });
    const media = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=64x64:r=30",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        source,
      ],
      { encoding: "utf8" },
    );
    assert.equal(media.status, 0, media.stderr);
    mkdirSync(path.join(cwd, "out/clip"), { recursive: true });
    // ffmpeg copies the local fixture, no download or external services.
    const copy = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      source,
      "-c",
      "copy",
      path.join(cwd, "out/clip/vertical.mp4"),
    ]);
    assert.equal(copy.status, 0);
    assert.equal(invoke("qa-screenshots.ts", ["--project", "clip", "--every", "1"], cwd).metadata.count, 2);
    assert.equal(invoke("slice-talking-head.ts", ["--project", "clip"], cwd).metadata.clipped, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("CLI aliases permit offline help and dry-run without an .env file", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "cli-no-env-"));
  try {
    assert.equal(invoke("generate-image.ts", ["--help"], cwd).metadata.help, true);
    assert.equal(
      invoke("generate-image.ts", ["--prompt", "fixture", "--output", "fixture.png", "--dry-run"], cwd).metadata.dryRun,
      true,
    );
    writeFileSync(path.join(cwd, ".env"), "CLI_OFFLINE_FIXTURE=local-only\n");
    assert.equal(invoke("generate-image.ts", ["--help"], cwd).metadata.help, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("AGENTBROS_NO_DOTENV stops runScript loading .env; the test import sets it for children", () => {
  assert.equal(process.env.AGENTBROS_NO_DOTENV, "1", "tests/helpers/memory-root.ts sets the opt-out");
  const cwd = mkdtempSync(path.join(tmpdir(), "cli-dotenv-"));
  try {
    writeFileSync(path.join(cwd, ".env"), "CLI_DOTENV_FIXTURE=from-dotenv\n");
    const probe = path.join(cwd, "probe.ts");
    writeFileSync(
      probe,
      `import { runScript } from ${JSON.stringify(path.resolve("src/lib/cli/index.ts"))}; runScript(async () => ({ metadata: { value: process.env.CLI_DOTENV_FIXTURE ?? null } }));`,
    );
    const run = (flag: string) => {
      const env: NodeJS.ProcessEnv = { ...process.env, AGENTBROS_NO_DOTENV: flag };
      delete env.CLI_DOTENV_FIXTURE;
      const child = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), probe], {
        cwd,
        env,
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
      });
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout).metadata.value;
    };
    assert.equal(run("1"), null);
    assert.equal(run(""), "from-dotenv");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the Node 24 exit guard is the CLI module's first import, so it runs before any other module", () => {
  // ESM evaluates imports in order: as the first one, the guard turns off background compilation before other code runs.
  const source = readFileSync(path.join(import.meta.dirname, "../src/lib/cli/index.ts"), "utf8");
  assert.equal(source.match(/^import .*$/m)?.[0], 'import "./exit-guard";');
  const guard = readFileSync(path.join(import.meta.dirname, "../src/lib/cli/exit-guard.ts"), "utf8");
  assert.match(guard, /"--no-concurrent-sparkplug"/);
  assert.match(guard, /"--no-maglev"/);
});
