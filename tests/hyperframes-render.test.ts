import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildEnv,
  buildRenderArgs,
  buildSidecar,
  findBrowser,
  findTool,
  projectWarnings,
  toolRoot,
  validateAttribution,
  validateProject,
} from "../src/lib/hyperframes/render";
import { AssetProvenanceSchema, AssetRightsSchema } from "../src/types/assets";

const root = process.cwd();
const runner = path.join(root, "node_modules/tsx/dist/cli.mjs");
const script = path.join(root, "scripts/hyperframes-render.ts");

function temporary(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), "hyperframes-render-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function project(directory: string, html = "<!doctype html><html></html>") {
  const dir = path.join(directory, "project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.html"), html);
  return dir;
}

function cli(args: string[], home: string, cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [runner, script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    env: {
      AGENTBROS_NO_DOTENV: "1",
      PATH: path.dirname(process.execPath),
      TMPDIR: process.env.TMPDIR,
      HOME: home,
      ...extraEnv,
    },
  });
  assert.ifError(result.error);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `stdout must be one JSON line: ${result.stdout}`);
  return { status: result.status, envelope: JSON.parse(lines[0]!) as Record<string, any> };
}

test("render arguments are literal, strict and keep hostile values as single items", () => {
  const output = "/tmp/a b; rm -rf ~.mp4";
  const args = buildRenderArgs({
    projectDir: "/p q",
    output,
    composition: "c/$(x).html",
    fps: 30,
    quality: "looks",
    workers: 2,
  });
  assert.deepEqual(args, [
    "render",
    "/p q",
    "--output",
    output,
    "--fps",
    "30",
    "--quality",
    "looks",
    "--strict",
    "--no-best-effort",
    "--composition",
    "c/$(x).html",
    "--workers",
    "2",
  ]);
  assert.deepEqual(buildRenderArgs({ projectDir: "/p", output: "/o.mp4", fps: 24, quality: "draft" }).slice(-2), [
    "--strict",
    "--no-best-effort",
  ]);
  assert.equal(
    buildRenderArgs({ projectDir: "/p", output: "/o.mp4", fps: 24, quality: "draft", strict: false }).includes(
      "--strict",
    ),
    false,
  );
});

test("tool environment drops repository secrets and turns updates and telemetry off", () => {
  const env = buildEnv(
    { PATH: "/bin", HEYGEN_API_KEY: "k", ELEVENLABS_API_KEY: "k", HOME: ["", "home", "real"].join("/") },
    { browser: "/chrome", home: "/h" },
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HEYGEN_API_KEY, undefined);
  assert.equal(env.ELEVENLABS_API_KEY, undefined);
  assert.equal(env.HOME, path.join(toolRoot("/h"), "home"));
  assert.equal(env.HYPERFRAMES_BROWSER_PATH, "/chrome");
  for (const key of [
    "HYPERFRAMES_NO_UPDATE_CHECK",
    "HYPERFRAMES_NO_AUTO_INSTALL",
    "HYPERFRAMES_NO_TELEMETRY",
    "DO_NOT_TRACK",
    "HYPERFRAMES_SKIP_SKILLS",
  ])
    assert.equal(env[key], "1", key);
});

test("tool and browser discovery prefer explicit paths and never fall through silently", (t) => {
  const directory = temporary(t);
  const pinned = path.join(toolRoot(directory), "tool", "node_modules", ".bin", "hyperframes");
  assert.throws(() => findTool({ env: { PATH: "" }, home: directory }), /unavailable: Hyperframes CLI not found/);
  mkdirSync(path.dirname(pinned), { recursive: true });
  writeFileSync(pinned, "");
  assert.equal(findTool({ env: { PATH: "" }, home: directory }), pinned);
  assert.throws(
    () => findTool({ executable: "/missing/hf", env: {}, home: directory }),
    /unavailable: Hyperframes executable not found/,
  );
  assert.throws(() => findBrowser({ env: {}, root: directory }), /unavailable: no installed Chromium/);
  assert.throws(
    () => findBrowser({ browser: "/missing/chrome", env: {}, root: directory }),
    /unavailable: browser not found/,
  );
  const shell = path.join(
    directory,
    "node_modules/.remotion/chrome-headless-shell/mac-arm64/build/chrome-headless-shell",
  );
  mkdirSync(path.dirname(shell), { recursive: true });
  writeFileSync(shell, "");
  writeFileSync(path.join(directory, "node_modules/.remotion/chrome-headless-shell/VERSION"), "157");
  assert.equal(findBrowser({ env: {}, root: directory }), shell);
});

test("block licences are never assumed and the sidecar satisfies the asset schemas", () => {
  assert.throws(() => validateAttribution({ block: "kinetic-center-build" }), /--licence and --source/);
  validateAttribution({});
  const source = "https://github.com/heygen-com/hyperframes/tree/8c799eb/registry/components/kinetic-center-build";
  const sidecar = buildSidecar({
    block: "kinetic-center-build",
    licence: "MIT",
    source,
    version: "0.9.7",
    originalFilename: "a.mp4",
    checkedAt: "2026-11-03T00:00:00.000Z",
  });
  assert.equal(AssetProvenanceSchema.parse(sidecar.provenance).tool, "hyperframes@0.9.7");
  assert.equal(sidecar.provenance.model, "kinetic-center-build");
  const rights = AssetRightsSchema.parse(sidecar.rights);
  assert.equal(rights.licence, "MIT");
  assert.equal(rights.sourceUrl, source);
  assert.equal(rights.commercialAllowed, "unknown");
  assert.match(rights.attribution!, /Hyperframes 0\.9\.7 \(Apache-2\.0.*block kinetic-center-build \(MIT\)/);
  const authored = buildSidecar({ version: "0.9.7", originalFilename: "b.mp4", checkedAt: "2026-11-03T00:00:00.000Z" });
  assert.equal(authored.rights.licence, "unknown");
  assert.equal(authored.provenance.model, "composition");
});

test("project checks stay inside the project and report floating dependencies", (t) => {
  const directory = temporary(t);
  const dir = project(
    directory,
    '<script src="https://cdn.example/gsap.js"></script><script src="assets/local.js"></script>',
  );
  writeFileSync(
    path.join(dir, "hyperframes.json"),
    JSON.stringify({ registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry" }),
  );
  assert.throws(() => validateProject(dir, "missing.html"), /Composition not found/);
  writeFileSync(path.join(directory, "outside.html"), "");
  assert.throws(() => validateProject(dir, "../outside.html"), /must stay inside/);
  const warnings = projectWarnings(dir);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /pin it to a commit/);
  assert.match(warnings[1]!, /1 remote resource.*cdn\.example/);
});

test("missing tool yields one JSON error with install steps and installs nothing", (t) => {
  const directory = temporary(t);
  const home = path.join(directory, "home");
  mkdirSync(home);
  const dir = project(directory);
  const { status, envelope } = cli(["--project-dir", dir, "--output", path.join(directory, "o.mp4")], home, directory);
  assert.equal(status, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, "FILE_NOT_FOUND");
  assert.match(envelope.message, /^unavailable: /);
  assert.equal(envelope.details.state, "unavailable");
  assert.match(envelope.details.install[0], /--ignore-scripts --save-exact hyperframes@0\.9\.7/);
  assert.equal(existsSync(path.join(home, ".cache")), false);
});

test("a failing tool surfaces its exit code and tail without leaking the parent environment", (t) => {
  const directory = temporary(t);
  const dir = project(directory);
  const fake = path.join(directory, "fake-hyperframes");
  const record = path.join(directory, "env.txt");
  writeFileSync(
    fake,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.9.7; exit 0; fi\nenv > ${JSON.stringify(record)}\necho "bad flag" >&2\nexit 2\n`,
  );
  chmodSync(fake, 0o755);
  const browser = path.join(directory, "chrome");
  writeFileSync(browser, "");
  const args = [
    "--project-dir",
    dir,
    "--output",
    path.join(directory, "o.mp4"),
    "--executable",
    fake,
    "--browser",
    browser,
  ];
  const pathDirs = [path.dirname(process.execPath), "/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"].join(
    path.delimiter,
  );
  const { status, envelope } = cli(args, directory, directory, { PATH: pathDirs, HEYGEN_API_KEY: "secret" });
  assert.equal(status, 1);
  assert.equal(envelope.error, "INVALID_INPUT");
  assert.equal(envelope.details.exitCode, 2);
  assert.deepEqual(envelope.details.tail, ["bad flag"]);
  const seen = readFileSync(record, "utf8");
  assert.doesNotMatch(seen, /HEYGEN_API_KEY/);
  assert.match(seen, /HYPERFRAMES_NO_TELEMETRY=1/);
});

test("dry run reports the argument list and refuses an unattributed block", (t) => {
  const directory = temporary(t);
  const dir = project(directory);
  const fake = path.join(directory, "fake-hyperframes");
  const browser = path.join(directory, "chrome");
  writeFileSync(fake, "");
  writeFileSync(browser, "");
  const base = [
    "--project-dir",
    dir,
    "--output",
    path.join(directory, "o.mp4"),
    "--executable",
    fake,
    "--browser",
    browser,
    "--dry-run",
  ];
  const dry = cli(base, directory, directory);
  assert.equal(dry.envelope.ok, true);
  assert.equal(dry.envelope.metadata.state, "validated");
  assert.equal(dry.envelope.metadata.args[0], "render");
  const refused = cli([...base, "--block", "per-word-rise"], directory, directory);
  assert.equal(refused.envelope.error, "INVALID_INPUT");
});
