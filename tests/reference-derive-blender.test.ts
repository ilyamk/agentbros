import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashFile, importAsset, readAssetRegistry } from "../src/lib/assets/registry";
import { runBlender } from "../src/lib/backends/blender-run";
import { probeBlender } from "../src/lib/backends/probe";
import { planDerivative, runDerivative } from "../src/lib/references/derive";
import { probeVideo } from "../src/lib/vision/media";
import { DerivativeReceiptSchema } from "../src/types/references";
import { hasFfmpeg } from "./helpers/reference-derive";

// Environment-gated (RFC 0003 AC10): runs wherever blender:run finds a supported Blender, skipped elsewhere.
const blender = probeBlender();
const gate = {
  skip: !hasFfmpeg ? "needs ffmpeg and ffprobe" : blender.available ? false : `needs Blender: ${blender.reason}`,
} as const;

/** A 64x64, 6-frame scene: a 1 m cube at the origin, a camera dollying from y = -5 to -4 looking along +Y. */
const BUILD = `
import json, sys
import bmesh, bpy
target = json.loads(sys.argv[sys.argv.index("--") + 1])["blend"]
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj)
scene = bpy.context.scene
scene.render.resolution_x = scene.render.resolution_y = 64
scene.render.fps = 30
scene.frame_start, scene.frame_end = 1, 6
mesh = bpy.data.meshes.new("cube")
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
bm.to_mesh(mesh)
bm.free()
scene.collection.objects.link(bpy.data.objects.new("cube", mesh))
camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
scene.collection.objects.link(camera)
scene.camera = camera
camera.rotation_euler = (1.5707963267948966, 0.0, 0.0)
for frame, y in ((1, -5.0), (6, -4.0)):
    camera.location = (0.0, y, 0.0)
    camera.keyframe_insert("location", frame=frame)
bpy.ops.wm.save_as_mainfile(filepath=target)
`;

test("blender-pass renders a depth sequence with a preview and a camera path as derivatives", gate, async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "reference-derive-blender-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const project = path.join(rootDir, "public/projects/demo");
  mkdirSync(path.join(project, "assets/blender"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const work = path.join(rootDir, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "build.py"), BUILD);
  const blend = path.join(project, "assets/blender/scene.blend");
  await runBlender({
    script: path.join(work, "build.py"),
    output: path.join(work, "build"),
    format: "png",
    device: "cpu",
    factoryStartup: true,
    noRender: true,
    overwrite: false,
    resume: false,
    scriptArgs: [JSON.stringify({ blend })],
    timeoutSec: 300,
  });
  assert.ok(existsSync(blend));
  // The target the passes match: 64x64, 6 frames at 30 fps.
  const plate = path.join(work, "plate.mp4");
  const made = spawnSync("ffmpeg", [
    ...["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=s=64x64:r=30", "-frames:v", "6"],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", plate],
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  const target = importAsset({
    rootDir,
    projectId: "demo",
    sourceFile: plate,
    provenance: { origin: "manual", tool: "offline-fixture" },
  }).asset;
  const spec = (id: string, pass: string, scene = "assets/blender/scene.blend") => ({
    schemaVersion: 1,
    id,
    input: { assetId: target.id },
    steps: [{ op: "blender-pass", scene, pass }],
    purpose: "Synthetic previs pass",
  });
  assert.throws(
    () => planDerivative("demo", spec("outside", "depth", "../escape.blend"), rootDir),
    /outside|within|escape/i,
  );
  assert.throws(
    () => planDerivative("demo", spec("missing", "depth", "assets/blender/none.blend"), rootDir),
    /not found/,
  );
  const planned = planDerivative("demo", spec("previs-depth", "depth"), rootDir);
  assert.deepEqual(
    planned.steps.map((step) => [step.op, step.engine, step.status, step.outputKind]),
    [["blender-pass", "blender", "ready", "video"]],
  );
  assert.equal(planned.spend, "none");

  const depth = await runDerivative("demo", spec("previs-depth", "depth"), rootDir);
  const receipt = DerivativeReceiptSchema.parse(
    JSON.parse(readFileSync(path.join(depth.directory, "receipt.json"), "utf8")),
  );
  assert.equal(receipt.engine.kind, "blender");
  assert.match(receipt.engine.version, /^Blender \d+\.\d+/);
  assert.equal(receipt.engine.modelSha256, hashFile(blend));
  assert.equal(receipt.costUsd, null);
  assert.equal(receipt.measurements.nearM, 3.5);
  assert.equal(receipt.measurements.farM, 4.5);
  assert.equal(receipt.measurements.frameCount, 6);
  assert.equal(receipt.measurements.sequenceBitDepth, 16);
  const preview = probeVideo(path.join(rootDir, "public", receipt.output.original));
  assert.deepEqual([preview.width, preview.height, preview.frameCount], [64, 64, 6]);
  const sequence = path.join(depth.directory, "sequence");
  const frames = readdirSync(sequence).filter((name) => name.endsWith(".png"));
  assert.equal(frames.length, 6);
  const probe = spawnSync("ffprobe", [
    ...["-v", "error", "-show_entries", "stream=pix_fmt,width,height", "-of", "csv=p=0"],
    path.join(sequence, frames[0]!),
  ]);
  assert.equal(String(probe.stdout).trim(), "64,64,gray16be");
  const pass = JSON.parse(readFileSync(path.join(sequence, "pass.json"), "utf8"));
  assert.equal(pass.pass, "depth");
  assert.equal(pass.frames, 6);
  assert.deepEqual([pass.nearM, pass.farM], [3.5, 4.5]);
  assert.match(pass.encoding, /nearM = 65535/);
  const depthAsset = readAssetRegistry("demo", rootDir).assets.find((asset) => asset.id === receipt.output.assetId)!;
  assert.equal(depthAsset.provenance.origin, "derivative");
  assert.equal(depthAsset.kind, "video");

  const camera = await runDerivative("demo", spec("previs-camera", "camera-path"), rootDir);
  assert.equal(camera.receipt.output.contentType, "application/json");
  assert.equal(camera.asset.kind, "json");
  assert.equal(camera.asset.provenance.origin, "derivative");
  const path_ = JSON.parse(readFileSync(path.join(rootDir, "public", camera.receipt.output.original), "utf8"));
  assert.deepEqual([path_.width, path_.height, path_.fps, path_.frames.length], [64, 64, 30, 6]);
  for (const key of ["location", "quaternionWxyz", "lensMm", "sensorWidthMm"]) assert.ok(key in path_.frames[0], key);
  assert.deepEqual(path_.frames[0].location, [0, -5, 0]);
  assert.deepEqual(path_.frames[5].location, [0, -4, 0]);
  assert.equal(path_.frames[0].quaternionWxyz.length, 4);
});
