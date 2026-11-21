import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { planProjectRender, validatePublicAsset } from "../src/lib/render-plan";

const config = () => ({
  name: "It's $a `film`",
  formats: ["vertical", "square", "landscape"],
  productName: "test",
  colors: {},
  musicVolume: 0,
  scenes: [{ id: "hook", text: "test", visualType: "title", headline: "hello", durationInFrames: 90 }],
});
function fixture(t: test.TestContext, data: unknown = config()) {
  const root = mkdtempSync(path.join(tmpdir(), "render-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/new-project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "project.json"), JSON.stringify(data));
  return { root, dir };
}
function errorCode(code: string) {
  return (error: unknown) => (error as { code: string }).code === code;
}

test("arbitrary project renders all formats with canonical props and literal argv", (t) => {
  const { root } = fixture(t);
  const plan = planProjectRender("new-project", undefined, root);
  assert.deepEqual(
    plan.jobs.map((j) => j.compositionId),
    ["ProjectVertical", "ProjectSquare", "ProjectLandscape"],
  );
  assert.equal(plan.jobs[0].props.scenes[0].headline, "hello");
  assert.equal(plan.jobs[0].command, "pnpm");
  assert.equal(plan.jobs[0].args.at(-1), JSON.stringify(plan.jobs[0].props));
  assert.equal(planProjectRender("new-project", "landscape", root).jobs.length, 1);
});

test("full talking-head defaults, crops and embedded audio survive props loading", (t) => {
  const data = {
    ...config(),
    talkingHead: {
      enabled: true,
      presenterVideo: "projects/new-project/talking-head/full.mp4",
      audioSource: "embedded",
      presenterCrop: { square: "20% 40%" },
      captionStyle: { fontSize: 45 },
    },
  };
  const { root, dir } = fixture(t, data);
  mkdirSync(path.join(dir, "talking-head"));
  writeFileSync(path.join(dir, "talking-head/full.mp4"), "fixture");
  mkdirSync(path.join(dir, "voiceover"));
  writeFileSync(path.join(dir, "voiceover/hook.mp3"), "stale");
  const props = planProjectRender("new-project", "square", root).jobs[0].props;
  assert.equal(props.talkingHead?.audioSource, "embedded");
  assert.equal(props.talkingHead?.presenterCrop?.square, "20% 40%");
  assert.equal(props.talkingHead?.captionStyle.fontSize, 45);
  assert.equal(props.voiceoverEnabled, false);
});

test("invalid IDs/configs/empty scenes rejected before renderer", (t) => {
  const { root, dir } = fixture(t);
  for (const id of ["../escape", "a/b", "$(touch bad)", "--help"])
    assert.throws(() => planProjectRender(id, undefined, root), errorCode("INVALID_INPUT"));
  assert.throws(() => planProjectRender("missing", undefined, root), errorCode("PROJECT_NOT_FOUND"));
  writeFileSync(path.join(dir, "project.json"), "{");
  assert.throws(() => planProjectRender("new-project", undefined, root), errorCode("VALIDATION"));
  writeFileSync(path.join(dir, "project.json"), JSON.stringify({ ...config(), scenes: [] }));
  assert.throws(() => planProjectRender("new-project", undefined, root), errorCode("VALIDATION"));
});

test("missing assets, partial audio and escaping asset symlinks rejected", (t) => {
  const data = config();
  data.scenes.push({ ...data.scenes[0], id: "other" });
  const { root, dir } = fixture(t, data);
  mkdirSync(path.join(dir, "voiceover"));
  writeFileSync(path.join(dir, "voiceover/hook.mp3"), "audio");
  assert.throws(() => planProjectRender("new-project", undefined, root), errorCode("FILE_NOT_FOUND"));
  assert.throws(() => validatePublicAsset("../project.json", root), errorCode("INVALID_INPUT"));
  writeFileSync(path.join(root, "outside"), "private");
  symlinkSync(path.join(root, "outside"), path.join(root, "public/leak"));
  assert.throws(() => validatePublicAsset("leak", root), errorCode("INVALID_INPUT"));
  validatePublicAsset("https://example.test/image.png", root);
});

test("CLI dry-run returns one JSON envelope without child/network", (t) => {
  const { root } = fixture(t);
  const script = path.resolve("scripts/render-project.ts");
  const runner = path.resolve("node_modules/tsx/dist/cli.mjs");
  const result = spawnSync(process.execPath, [runner, script, "--project", "new-project", "--dry-run"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.metadata.dryRun, true);
  assert.deepEqual(envelope.outputs, []);
  const clean = spawnSync(
    process.execPath,
    [runner, script, "--project", "new-project", "--format", "square", "--captions", "off", "--dry-run"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(clean.status, 0, clean.stderr);
  const cleanJob = JSON.parse(clean.stdout).metadata.jobs[0];
  assert.equal(cleanJob.props.captionsEnabled, false);
  assert.match(cleanJob.outputFile, /square-clean\.mp4$/);
  const invalid = spawnSync(process.execPath, [runner, script, "--project", "../escape", "--dry-run"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error, "INVALID_INPUT");
});

test("child renderer receives literal props and both child streams stay off stdout", (t) => {
  const { root } = fixture(t, { ...config(), productName: "$(touch never) ' quoted `literal`" });
  const binaryDir = path.join(root, "bin");
  mkdirSync(binaryDir);
  const fake = path.join(binaryDir, "pnpm");
  writeFileSync(
    fake,
    `#!/usr/bin/env node\nconst fs = require('node:fs'); const args = process.argv.slice(2); const props = JSON.parse(args.find((arg) => arg.startsWith('{'))); fs.writeFileSync('received.json', JSON.stringify({args, props})); fs.mkdirSync(require('node:path').dirname(args[4]), {recursive:true}); fs.writeFileSync(args[4], 'local mocked renderer bytes'); console.log('renderer stdout'); console.error('renderer stderr'); process.exit(process.env.RENDER_TEST_FAIL ? 7 : 0);\n`,
    { mode: 0o755 },
  );
  const runner = path.resolve("node_modules/tsx/dist/cli.mjs");
  const script = path.resolve("scripts/render-project.ts");
  const env = { ...process.env, PATH: `${binaryDir}${path.delimiter}${process.env.PATH}` };
  const rendered = spawnSync(process.execPath, [runner, script, "--project", "new-project", "--format", "vertical"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(JSON.parse(rendered.stdout).ok, true);
  assert.match(rendered.stderr, /renderer stdout/);
  assert.match(rendered.stderr, /renderer stderr/);
  const failed = spawnSync(process.execPath, [runner, script, "--project", "new-project", "--format", "vertical"], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, RENDER_TEST_FAIL: "1" },
  });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).ok, false);
  assert.match(JSON.parse(failed.stdout).message, /exit 7/);
});

test("clean deliverable uses explicit caption suppression and a distinct output filename", (t) => {
  const { root } = fixture(t);
  const clean = planProjectRender("new-project", "square", root, { captions: "off" }).jobs[0];
  assert.equal(clean.props.captionsEnabled, false);
  assert.match(clean.outputFile, /square-clean\.mp4$/);
  const standard = planProjectRender("new-project", "square", root).jobs[0];
  assert.equal(standard.props.captionsEnabled, true);
  assert.match(standard.outputFile, /square\.mp4$/);
});

test("localized speech cannot bypass readiness by suppressing words or voiceover", (t) => {
  const { root, dir } = fixture(t, {
    ...config(),
    voiceoverEnabled: false,
    scenes: [{ ...config().scenes[0], text: "" }],
  });
  mkdirSync(path.join(dir, "pipeline"));
  writeFileSync(
    path.join(dir, "pipeline/localization.json"),
    JSON.stringify({ audioStale: true, alignmentStale: true, productionReady: false }),
  );
  assert.throws(
    () => planProjectRender("new-project", "square", root, { captions: "off" }),
    errorCode("STAGE_INCOMPLETE"),
  );
});
