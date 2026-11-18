import { pythonArgs, pythonEnvironment, pythonUv } from "../src/lib/python";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { opencvPose, normaliseCamera, projectPoint } from "../src/lib/vork/camera";
import { VorkVfxSchema } from "../src/types/vork";
import { runProcess } from "../src/lib/vork/runtime";
import { vfxAction } from "../src/lib/vork/vfx";

test("OpenCV poses map camera axes and metre translation without a second coordinate conversion", () => {
  const pose = opencvPose([1, 0, 0, 0, 0, 1, 0, -1, 0], [0, 0, 2]);
  assert.deepEqual(
    pose.translation.map((n) => n || 0),
    [0, 2, 0],
  );
  assert.ok(Math.abs(Math.hypot(...pose.rotation) - 1) < 1e-8);
  assert.ok(Math.abs(Math.abs(pose.rotation[0]!) - Math.SQRT1_2) < 1e-8);
  const camera = normaliseCamera(
    {
      K: [320, 0, 320, 0, 320, 180, 0, 0, 1],
      image_size: [640, 360],
      R: [1, 0, 0, 0, 0, 1, 0, -1, 0],
      t: [0, 0, 2],
      frames: [{}, {}],
    },
    24,
  );
  assert.equal(camera.frames[1]!.time, 1 / 24);
  assert.throws(() => normaliseCamera({ ...camera, dist: [0.1, 0, 0, 0, 0] }, 24), /undistorted/);
  assert.throws(() => normaliseCamera({ ...camera, K: [320, 0, 320, 0, 300, 180, 0, 0, 1] }, 24), /square pixels/);
  assert.throws(() => opencvPose([1, 0.1, 0, 0.1, 1, 0, 0, 0, 1], [0, 0, 0]), /orthonormal/);
  assert.throws(
    () => VorkVfxSchema.parse({ schemaVersion: 1, plate: "a.mp4", width: 640, height: 360, duration: 1, fps: 24 }),
    /camera/,
  );
  const native = {
    version: 2,
    fps: "24",
    frame_start: 0,
    K: [
      [320, 0, 320],
      [0, 320, 180],
      [0, 0, 1],
    ],
    R: [
      [1, 0, 0],
      [0, 0, 1],
      [0, -1, 0],
    ],
    t: [0, 0, 2],
    image_size: [640, 360],
    frames: [{}, {}],
  };
  const decoded = normaliseCamera(native, 24);
  const broadcast = 30000 / 1001;
  const stored = normaliseCamera({ ...native, fps: 30 / Math.fround(1.001) }, broadcast);
  assert.equal(stored.frames[1]!.time, 1 / broadcast);
  assert.deepEqual(decoded.frames, camera.frames);
  assert.throws(() => normaliseCamera({ ...native, fps: "25" }, 24), /clock/);
  assert.throws(() => normaliseCamera({ ...native, frame_start: 8 }, 24), /clock/);
  const centre = projectPoint([0, 0, 0], decoded.frames[0]!, decoded.K, decoded.image_size);
  assert.ok(centre.every((value) => Math.abs(value - 0.5) < 1e-8));
});
test("fractional-FPS VFX build accepts native camera matrices and explicit contact approximation", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "vork-vfx-clock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await runProcess("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=s=16x16:r=30000/1001:d=0.1",
    "-c:v",
    "libx264",
    path.join(root, "plate.mp4"),
  ]);
  const fps = 30000 / 1001;
  writeFileSync(
    path.join(root, "camera.json"),
    JSON.stringify({
      version: 2,
      fps: "30000/1001",
      frame_start: 0,
      K: [
        [16, 0, 8],
        [0, 16, 8],
        [0, 0, 1],
      ],
      R: [
        [1, 0, 0],
        [0, 0, 1],
        [0, -1, 0],
      ],
      t: [0, 0, 2],
      image_size: [16, 16],
      frames: [{}, {}, {}],
    }),
  );
  writeFileSync(
    path.join(root, "request.json"),
    JSON.stringify({
      schemaVersion: 1,
      plate: "plate.mp4",
      width: 16,
      height: 16,
      fps,
      duration: 0.1,
      camera: "camera.json",
      shadowMode: "contact",
    }),
  );
  const built = await vfxAction("build", path.join(root, "request.json"), path.join(root, "source"));
  const scene = JSON.parse(readFileSync(built.outputs[0]!, "utf8"));
  assert.equal(scene.render.fps, fps);
  assert.equal(
    scene.nodes.some((node: { is_shadow_catcher?: boolean }) => node.is_shadow_catcher),
    false,
  );
  assert.match(readFileSync(built.outputs[2]!, "utf8"), /projected contact approximation/);
});
test(
  "known moving-plane footage recovers independent tracks and a camera trajectory",
  { skip: process.env.RUN_VORK_VFX_TESTS !== "1", timeout: 120000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "vork-vfx-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    await runProcess(pythonUv(), pythonArgs("vork", [path.resolve("examples/vork/calibrated-fixture.py"), root]), {
      env: pythonEnvironment("vork"),
      timeoutSec: 120,
    });
    await vfxAction("solve", path.join(root, "request.json"), path.join(root, "solve"));
    const camera = JSON.parse(readFileSync(path.join(root, "solve/camera.json"), "utf8")) as {
      frames: Array<{ translation: number[] }>;
    };
    const report = JSON.parse(readFileSync(path.join(root, "solve/tracking-report.json"), "utf8")) as {
      frames: Array<{ heldOutP95Px: number }>;
    };
    assert.equal(camera.frames.length, 24);
    assert.ok(
      Math.max(...report.frames.map((f) => f.heldOutP95Px)) < 1,
      "held-out error must stay below one pixel in the original synthetic fixture",
    );
    assert.ok(Math.abs(camera.frames[0]!.translation[1]! - 2) < 0.02);
    assert.ok(Math.abs(camera.frames.at(-1)!.translation[0]! - -0.00125 * 23) < 0.02);
  },
);

test(
  "installed VFX OpenCV also preserves reference optical-flow measurements",
  { skip: process.env.RUN_VORK_VFX_TESTS !== "1", timeout: 120000 },
  async () => {
    const script = `import json,runpy,sys
import cv2
import numpy as np
functions=runpy.run_path(sys.argv[1])
source=np.random.default_rng(42).integers(30,220,(240,320),dtype=np.uint8)
source=cv2.GaussianBlur(source,(3,3),0)
following=cv2.warpAffine(source,np.array([[1,0,5],[0,1,-3]],np.float32),(320,240),borderMode=cv2.BORDER_REFLECT)
dx,dy,scale,roll,valid=functions['camera_step'](source,following,None)
assert valid,(dx,dy,scale,roll,valid)
assert abs(dx+5/320)<.0005 and abs(dy-3/320)<.0005,(dx,dy)
assert abs(scale)<.002 and abs(roll)<.002,(scale,roll)
assert not functions['camera_step'](source,following,np.zeros_like(source))[-1]
print(json.dumps({'dx':dx,'dy':dy,'scale':scale,'roll':roll}))`;
    const result = await runProcess(
      pythonUv(),
      pythonArgs("vork", ["-c", script, path.resolve("scripts/workers/reference-moves.py")]),
      { env: pythonEnvironment("vork"), timeoutSec: 120 },
    );
    assert.ok(Number.isFinite(JSON.parse(result.stdout).dx));
  },
);
