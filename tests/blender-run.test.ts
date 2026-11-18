import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  blenderArguments,
  parseResolution,
  readCameraExport,
  validateBlenderRun,
  type BlenderRunRequest,
} from "../src/lib/backends/blender-run";
import { probeBlender, probeHyperframesCli, probeYtDlp, type ProcessRunner } from "../src/lib/backends/probe";
import { probeVideo } from "../src/lib/vision/media";

const root = process.cwd();
const runner = path.join(root, "node_modules/tsx/dist/cli.mjs");
const script = path.join(root, "scripts/blender-run.ts");
const FAKE_PNG_WRITER = `#!/bin/sh
case "$1" in --version) echo "Blender 5.2.3 LTS"; exit 0;; esac
here=$(dirname "$0")
[ -f "$here/control.env" ] && . "$here/control.env"
echo "$@" > "$here/args.txt"
[ -n "$FAKE_EXIT" ] && { echo "fake failure text"; exit "$FAKE_EXIT"; }
[ -n "$FAKE_HANG" ] && exec sleep 30
[ -n "$FAKE_NO_RESULT" ] && exit 0
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "tests/fixtures/fake-blender-run.mjs"))}
`;

function workspace(work: (directory: string, fake: string) => void | Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), "blender-run-"));
  const fake = path.join(directory, "fake-blender");
  writeFileSync(fake, FAKE_PNG_WRITER);
  chmodSync(fake, 0o755);
  writeFileSync(path.join(directory, "scene.py"), "# scene");
  return Promise.resolve(work(directory, fake)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

// The runner passes Blender a minimal environment, so the fake reads its behaviour from a file beside it.
function control(directory: string, vars: Record<string, string> = {}) {
  writeFileSync(
    path.join(directory, "control.env"),
    Object.entries(vars)
      .map(([key, value]) => `export ${key}=${value}\n`)
      .join(""),
  );
}

function cli(args: string[], cwd = root) {
  const result = spawnSync(process.execPath, [runner, script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH!, HOME: process.env.HOME ?? "", TMPDIR: tmpdir() },
  });
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, result.stdout + result.stderr);
  return { status: result.status, stderr: result.stderr, envelope: JSON.parse(lines[0]!) };
}

const request = (overrides: Partial<BlenderRunRequest>): BlenderRunRequest => ({
  script: path.join(root, "package.json"),
  output: "out",
  format: "png",
  device: "auto",
  factoryStartup: true,
  noRender: false,
  overwrite: false,
  resume: false,
  scriptArgs: [],
  timeoutSec: 60,
  ...overrides,
});

test("arguments disable auto-run before the file loads, make Python errors fatal and keep script arguments last", () => {
  const args = blenderArguments({ blend: "/tmp/a.blend", factoryStartup: true, scriptArgs: ["--mine", "1"] });
  assert.deepEqual(args.slice(0, 6), [
    "--background",
    "--factory-startup",
    "--disable-autoexec",
    "--offline-mode",
    "--python-exit-code",
    "1",
  ]);
  assert.ok(args.indexOf("/tmp/a.blend") > args.indexOf("--disable-autoexec"));
  assert.ok(args.indexOf("--python") > args.indexOf("/tmp/a.blend"));
  assert.ok(args[args.indexOf("--python") + 1]!.endsWith("scripts/workers/blender/avc_run.py"));
  assert.deepEqual(args.slice(args.indexOf("--")), ["--", "--mine", "1"]);
  assert.equal(blenderArguments({ factoryStartup: false, scriptArgs: [] }).includes("--factory-startup"), false);
});

test("invalid requests are refused before Blender starts", () => {
  assert.deepEqual(parseResolution("1920x1080"), [1920, 1080]);
  assert.throws(() => parseResolution("1920"), /--resolution/);
  assert.throws(() => validateBlenderRun(request({ script: undefined })), /--script, --blend/);
  assert.throws(() => validateBlenderRun(request({ script: "/nonexistent.py" })), /not found/);
  assert.throws(() => validateBlenderRun(request({ overwrite: true, resume: true })), /cannot be combined/);
  assert.throws(() => validateBlenderRun(request({ samples: 0 })), /--samples/);
  assert.throws(() => validateBlenderRun(request({ encode: "h264", filmTransparent: true })), /no alpha/);
  assert.throws(() => validateBlenderRun(request({ encode: "h264", format: "exr" })), /--format png/);
  assert.throws(() => validateBlenderRun(request({ encode: "h264", resolution: [101, 100] })), /even/);
  assert.throws(() => validateBlenderRun(request({ noRender: true, encode: "h264" })), /--no-render/);
});

test("probes search app bundles, report routes and never download", () => {
  const calls: string[][] = [];
  const blender: ProcessRunner = (executable, args) => {
    calls.push([executable, ...args]);
    return { status: 0, stdout: "Blender 5.2.3 LTS", stderr: "" };
  };
  const found = probeBlender("/Applications/Blender.app/Contents/MacOS/Blender", blender);
  assert.equal(found.available, true);
  assert.equal(found.path, "/Applications/Blender.app/Contents/MacOS/Blender");
  assert.ok(
    found.routes.includes("headless-run") &&
      found.routes.includes("mcp-official-eligible") &&
      found.routes.includes("gui"),
  );
  assert.equal(
    probeBlender("b", () => ({ status: 0, stdout: "Blender 5.0.1", stderr: "" })).routes.includes(
      "mcp-official-eligible",
    ),
    false,
  );
  assert.equal(probeBlender("b", () => ({ status: 0, stdout: "Blender 3.6.0", stderr: "" })).available, false);
  assert.equal(probeBlender("b", () => ({ status: 127, stdout: "", stderr: "" })).available, false);

  const seen: string[][] = [];
  const tools =
    (status: Record<string, number>): ProcessRunner =>
    (executable, args) => {
      seen.push([executable, ...args]);
      return { status: status[executable] ?? 127, stdout: "1.2.3\n", stderr: "" };
    };
  assert.deepEqual(probeYtDlp(tools({ "yt-dlp": 0 })).routes, ["path"]);
  const viaUvx = probeYtDlp((executable, args) => ({
    status: executable === "uv" && !args.includes("yt-dlp") ? 0 : 1,
    stdout: "",
    stderr: "",
  }));
  assert.equal(viaUvx.available, true);
  assert.equal(viaUvx.installed, false);
  assert.match(viaUvx.reason!, /ask the user/);
  assert.equal(probeYtDlp(tools({})).available, false);
  probeYtDlp(tools({ uv: 0 }));
  assert.ok(
    seen.filter((call) => call[0] === "uv" && call.includes("yt-dlp")).every((call) => call.includes("--offline")),
  );

  seen.length = 0;
  const hyperframes = probeHyperframesCli(tools({ npx: 0 }), "/nonexistent-home");
  assert.equal(hyperframes.backend, "hyperframes-cli");
  assert.equal(hyperframes.available, true);
  assert.deepEqual(seen.at(-1), ["npx", "--no", "--offline", "--", "hyperframes", "--version"]);
  assert.equal(probeHyperframesCli(tools({}), "/nonexistent-home").available, false);
});

test("--dry-run prints the exact command without running the scene", () =>
  workspace((directory, fake) => {
    const args = path.join(directory, "args.txt");
    const { envelope } = cli([
      "--script",
      path.join(directory, "scene.py"),
      "--output",
      path.join(directory, "out"),
      "--executable",
      fake,
      "--dry-run",
    ]);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.metadata.version, "5.2.3");
    assert.ok(envelope.metadata.argv.includes("--disable-autoexec"));
    assert.equal(existsSync(args), false);
    assert.equal(existsSync(path.join(directory, "out")), false);
  }));

test("a missing executable fails with guidance, not a fallback install", () =>
  workspace((directory) => {
    const { status, envelope } = cli([
      "--script",
      path.join(directory, "scene.py"),
      "--output",
      path.join(directory, "out"),
      "--executable",
      path.join(directory, "absent"),
    ]);
    assert.equal(status, 1);
    assert.equal(envelope.error, "FILE_NOT_FOUND");
    assert.match(envelope.message, /Ask the user before installing/);
  }));

test("failures, crashes and timeouts surface as typed errors with the log", () =>
  workspace((directory, fake) => {
    const base = ["--script", path.join(directory, "scene.py"), "--executable", fake];
    control(directory, { FAKE_EXIT: "3" });
    const failed = cli([...base, "--output", path.join(directory, "a")]);
    assert.equal(failed.envelope.error, "INTERNAL");
    assert.match(failed.envelope.message, /code 3/);
    assert.match(failed.envelope.message, /fake failure text/);
    assert.match(readFileSync(path.join(directory, "a/blender.log"), "utf8"), /fake failure text/);
    control(directory, { FAKE_NO_RESULT: "1" });
    const early = cli([...base, "--output", path.join(directory, "b")]);
    assert.match(early.envelope.message, /before the run finished/);
    control(directory, { FAKE_HANG: "1" });
    const slow = cli([...base, "--output", path.join(directory, "c"), "--timeout", "0.5"]);
    assert.equal(slow.envelope.error, "TIMEOUT");
  }));

test("a run verifies frames, hashes them, builds a contact sheet and keeps alpha in ProRes", () =>
  workspace((directory, fake) => {
    const output = path.join(directory, "run");
    const metadata = path.join(directory, "sidecar.json");
    writeFileSync(metadata, JSON.stringify({ sources: [{ id: "hdri", licence: "CC0-1.0" }] }));
    const base = [
      "--script",
      path.join(directory, "scene.py"),
      "--output",
      output,
      "--frames",
      "3-6",
      "--resolution",
      "64x36",
      "--executable",
      fake,
    ];
    const { envelope } = cli([
      ...base,
      "--film-transparent",
      "--encode",
      "prores4444",
      "--script-args",
      '["--mine"]',
      "--metadata",
      metadata,
    ]);
    assert.equal(envelope.ok, true, envelope.message);
    assert.equal(envelope.metadata.frames.length, 4);
    assert.match(envelope.metadata.frames[0].path, /frame-000003\.png$/);
    assert.match(envelope.metadata.frames[0].sha256, /^[a-f0-9]{64}$/);
    assert.ok(existsSync(envelope.metadata.review.sheet));
    assert.equal(probeVideo(envelope.metadata.review.preview).frameCount, 4);
    assert.deepEqual(envelope.metadata.review.sheetFrames, [3, 4, 5, 6]);
    const pixelFormat = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=pix_fmt",
        "-of",
        "csv=p=0",
        envelope.metadata.encoded.path,
      ],
      { encoding: "utf8" },
    ).stdout.trim();
    assert.match(pixelFormat, /^yuva444p/);
    assert.equal(envelope.metadata.encoded.alpha, true);
    assert.deepEqual(
      envelope.metadata.camera && { frames: envelope.metadata.camera.frames, first: envelope.metadata.camera.first },
      { frames: 4, first: 3 },
    );
    assert.deepEqual(envelope.metadata.sources, [{ id: "hdri", licence: "CC0-1.0" }]);
    assert.ok(existsSync(envelope.metadata.manifest));
    assert.match(readFileSync(path.join(directory, "args.txt"), "utf8"), /-- --mine$/m);

    const refused = cli(base);
    assert.equal(refused.envelope.error, "FILE_EXISTS");
    const plate = path.join(directory, "public", "plate.mp4");
    assert.equal(cli([...base, "--overwrite", "--encode-to", plate]).envelope.error, "INVALID_INPUT");
    const copied = cli([...base, "--overwrite", "--encode", "h264", "--encode-to", plate]);
    assert.equal(copied.envelope.ok, true, copied.envelope.message);
    assert.equal(copied.envelope.metadata.encodedCopy, plate);
    assert.equal(probeVideo(plate).frameCount, 4);
    control(directory, { FAKE_SKIP_FRAME: "7" });
    const missing = cli([...base.map((item) => (item === "3-6" ? "3-7" : item)), "--overwrite"]);
    assert.equal(missing.envelope.error, "VALIDATION");
    assert.match(missing.envelope.message, /did not write/);
    control(directory, { FAKE_TRUNCATE_FRAME: "5" });
    const truncated = cli([...base, "--overwrite"]);
    assert.match(truncated.envelope.message, /truncated/);
  }));

test("--import records provenance and rights, and suggests the timeline edit", () =>
  workspace((directory, fake) => {
    mkdirSync(path.join(directory, "public/projects/demo"), { recursive: true });
    writeFileSync(path.join(directory, "public/projects/demo/project.json"), "{}");
    const metadata = path.join(directory, "sidecar.json");
    writeFileSync(
      metadata,
      JSON.stringify({
        rights: { licence: "CC0-1.0", commercialAllowed: true, attributionRequired: false },
        sources: [{ id: "hdri", licence: "CC0-1.0" }],
      }),
    );
    const base = [
      "--script",
      path.join(directory, "scene.py"),
      "--frames",
      "1-4",
      "--resolution",
      "64x36",
      "--executable",
      fake,
      "--project",
      "demo",
      "--import",
    ];
    const { envelope } = cli(
      [...base, "--output", path.join(directory, "video"), "--encode", "h264", "--metadata", metadata],
      directory,
    );
    assert.equal(envelope.ok, true, envelope.message);
    assert.match(envelope.metadata.asset.path, /^public\/projects\/demo\/assets\/imported\/[a-f0-9]{64}\.mp4$/);
    const registry = JSON.parse(readFileSync(path.join(directory, envelope.metadata.asset.registryPath), "utf8"));
    const asset = registry.assets.find((item: { id: string }) => item.id === envelope.metadata.asset.id);
    assert.equal(asset.provenance.tool, "blender-run");
    assert.equal(asset.provenance.model, "Blender 5.2.3");
    assert.equal(asset.rights.licence, "CC0-1.0");
    assert.ok(
      envelope.metadata.timeline.commands.some((command: string) => command.includes(envelope.metadata.asset.id)),
    );
    assert.match(envelope.metadata.warnings[0], /outside public\/projects\/demo\/assets\/blender/);

    const sequence = cli([...base, "--output", path.join(directory, "frames")], directory);
    assert.match(sequence.envelope.message, /--import needs --encode/);
    const prores = cli([...base, "--output", path.join(directory, "prores"), "--encode", "prores4444"], directory);
    assert.equal(prores.envelope.error, "INVALID_INPUT");
    assert.match(prores.envelope.message, /ProRes/);
    assert.equal(existsSync(path.join(directory, "prores")), false);
    const unknownProject = cli(
      [
        "--script",
        path.join(directory, "scene.py"),
        "--output",
        path.join(directory, "x"),
        "--executable",
        fake,
        "--project",
        "absent",
        "--import",
      ],
      directory,
    );
    assert.equal(unknownProject.envelope.error, "PROJECT_NOT_FOUND");
  }));

test("camera exports must hold the frames they claim", () =>
  workspace((directory) => {
    const file = path.join(directory, "camera.json");
    const frame = (number: number) => ({
      frame: number,
      projectionMatrix: Array(16).fill(0),
      threeMatrixWorld: Array(16).fill(0),
    });
    writeFileSync(file, JSON.stringify({ frameStart: 1, frameEnd: 2, frames: [frame(1), frame(2)] }));
    assert.deepEqual(readCameraExport(file), { frames: 2, first: 1, last: 2 });
    writeFileSync(file, JSON.stringify({ frameStart: 1, frameEnd: 3, frames: [frame(1), frame(2)] }));
    assert.throws(() => readCameraExport(file), /inconsistent/);
  }));

test(
  "real Blender: script, overrides, alpha, camera export and script errors",
  { skip: process.env.RUN_BLENDER_TESTS ? false : "Set RUN_BLENDER_TESTS=1 to run real Blender" },
  () =>
    workspace((directory) => {
      const scene = path.join(directory, "scene.py");
      writeFileSync(
        scene,
        `
import sys
import bpy
import avc_export
assert sys.argv[sys.argv.index("--") + 1:] == ["hello"]
bpy.ops.wm.read_factory_settings(use_empty=False)
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, 3
cube = bpy.data.objects["Cube"]
cube.location = (0, 0, 0)
cube.keyframe_insert("location", frame=1)
cube.location = (1, 0, 0)
cube.keyframe_insert("location", frame=3)
avc_export.export_camera(anchors=["Cube"])
`,
      );
      const output = path.join(directory, "run");
      const first = spawnSync(
        process.execPath,
        [
          runner,
          script,
          "--script",
          scene,
          "--output",
          output,
          "--frames",
          "1-3",
          "--engine",
          "cycles",
          "--samples",
          "2",
          "--resolution",
          "96x54",
          "--film-transparent",
          "--device",
          "cpu",
          "--encode",
          "prores4444",
          "--script-args",
          '["hello"]',
        ],
        {
          encoding: "utf8",
          timeout: 300000,
          env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH!, HOME: process.env.HOME ?? "", TMPDIR: tmpdir() },
        },
      );
      const envelope = JSON.parse(first.stdout.trim());
      assert.equal(envelope.ok, true, envelope.message);
      assert.equal(envelope.metadata.render.engine, "CYCLES");
      assert.equal(envelope.metadata.render.samples, 2);
      assert.equal(envelope.metadata.render.width, 96);
      assert.equal(envelope.metadata.render.device, "CPU");
      assert.equal(envelope.metadata.frames.length, 3);
      assert.equal(envelope.metadata.encoded.alpha, true);
      assert.equal(readFileSync(envelope.metadata.frames[0].path)[25], 6, "PNG colour type is RGBA");
      assert.match(
        spawnSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=pix_fmt",
            "-of",
            "csv=p=0",
            envelope.metadata.encoded.path,
          ],
          { encoding: "utf8" },
        ).stdout,
        /^yuva444p/,
      );
      const camera = JSON.parse(readFileSync(envelope.metadata.camera.path, "utf8"));
      assert.equal(camera.width, 96);
      assert.equal(camera.frames.length, 3);
      assert.notEqual(camera.frames[0].anchors.Cube.x, camera.frames[2].anchors.Cube.x);
      assert.equal(camera.frames[0].anchors.Cube.visible, true);
      const failing = path.join(directory, "bad.py");
      writeFileSync(failing, 'raise RuntimeError("scene is broken")');
      const failed = spawnSync(
        process.execPath,
        [runner, script, "--script", failing, "--output", path.join(directory, "bad")],
        {
          encoding: "utf8",
          timeout: 120000,
          env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH!, HOME: process.env.HOME ?? "", TMPDIR: tmpdir() },
        },
      );
      assert.equal(failed.status, 1);
      assert.match(JSON.parse(failed.stdout.trim()).message, /scene is broken/);
    }),
);
