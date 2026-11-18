import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vfxAction } from "../src/lib/vork/vfx";
import { renderHybridVfx } from "../src/lib/vork/hybrid";
import { assertVorkResult, renderVork } from "../src/lib/vork/render";
import { runProcess, writeNew, hashFile } from "../src/lib/vork/runtime";
import { runBlender } from "../src/lib/backends/blender-run";
import { projectPoint } from "../src/lib/vork/camera";
import { readRecipeFrame } from "../src/lib/blender-arsenal/recipes";
import { probeVideo } from "../src/lib/vision/media";

const native = process.env.RUN_VORK_HYBRID_TESTS === "1";
test(
  "real Cycles hand-off preserves source clock, projection, physical receiver and frame-zero preview",
  { skip: !native, timeout: 180000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "vork-cycles-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const fps of [25, 30, 30000 / 1001]) {
      const directory = path.join(root, String(fps)),
        first = 11;
      const theta = Math.atan2(0.35, 0.6),
        pose = { translation: [0, 0.4, 0.6], rotation: [-Math.sin(theta / 2), 0, 0, Math.cos(theta / 2)] };
      const cameraFile = writeNew(path.join(directory, "camera.json"), {
        fps,
        frame_start: 0,
        K: [160, 0, 80, 0, 160, 45, 0, 0, 1],
        image_size: [160, 90],
        frames: Array.from({ length: 3 }, (_, i) => ({ ...pose, translation: [i * 0.001, 0.4, 0.6], time: i / fps })),
      });
      const plate = path.join(directory, "plate.mp4");
      await runProcess("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `nullsrc=s=160x90:r=${fps}:d=${3 / fps},format=rgb24,geq=r=60+N*10:g=80+N*10:b=100+N*10`,
        "-frames:v",
        "3",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        plate,
      ]);
      mkdirSync(path.join(directory, "matte"));
      await runProcess("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=160x90:r=${fps},drawbox=x=74:y=20:w=12:h=55:color=white:t=fill`,
        "-frames:v",
        "3",
        "-start_number",
        "0",
        path.join(directory, "matte/frame-%05d.png"),
      ]);
      const request = writeNew(path.join(directory, "request.json"), {
        schemaVersion: 1,
        renderBackend: "blender-cycles",
        plate: "plate.mp4",
        camera: "camera.json",
        matte: "matte/frame-%05d.png",
        width: 160,
        height: 90,
        fps,
        duration: 3 / fps,
        receiver: { size: [0.6, 0.4], position: [0, 0, 0.05], roughness: 0.05, colour: [0.5, 0.5, 0.5] },
        lighting: {
          world: { colour: [0.6, 0.7, 0.85], strength: 0.3 },
          areas: [
            {
              name: "Authored key",
              position: [-1, 2, 1],
              target: [0, 0.05, 0],
              colour: [0.8, 0.9, 1],
              energy: 120,
              size: 2,
            },
          ],
        },
      });
      const built = await vfxAction("build", request, path.join(directory, "source"));
      assert.ok(built.job);
      const result = await renderHybridVfx(built.job, path.join(directory, "full"), {
        samples: 16,
        firstFrame: first,
        purpose: "production",
        device: "cpu",
      });
      assert.equal(result.receipt.engine, "vork-blender");
      assert.equal(result.receipt.settings.fps, fps);
      assert.equal(probeVideo(result.video).frameCount, 3);
      assert.equal(assertVorkResult(result.receipt, hashFile(result.video), process.cwd(), true).schemaVersion, 2);
      assert.equal(readdirSync(path.join(result.output, "linear")).filter((file) => file.endsWith(".exr")).length, 3);
      assert.equal(readdirSync(path.join(result.output, "masks")).filter((file) => file.endsWith(".png")).length, 3);
      await assert.rejects(
        renderVork({
          scene: path.join(directory, "source/geometry.json"),
          task: path.join(directory, "source/task.json"),
          output: path.join(directory, "wrong-renderer"),
          dryRun: true,
        }),
        /requires vork:vfx/,
      );
      const cameraProbe = path.join(directory, "camera-probe.py"),
        projectionFile = path.join(directory, "projection.json");
      writeFileSync(
        cameraProbe,
        `import bpy,json\nfrom bpy_extras.object_utils import world_to_camera_view\nfrom mathutils import Vector\ns=bpy.context.scene\nr=[]\nfor f in range(11,14):\n s.frame_set(f)\n p=world_to_camera_view(s,s.camera,Vector((0,0,.05)))\n r.append([p.x,1-p.y])\nopen(${JSON.stringify(projectionFile)},'w').write(json.dumps(r))\n`,
      );
      await runBlender({
        blend: path.join(result.output, "scene.blend"),
        script: cameraProbe,
        output: path.join(directory, "camera-probe"),
        format: "png",
        device: "cpu",
        factoryStartup: true,
        noRender: true,
        overwrite: false,
        resume: false,
        scriptArgs: [],
        timeoutSec: 60,
      });
      const projected = JSON.parse(readFileSync(projectionFile, "utf8")) as number[][];
      const camera = JSON.parse(readFileSync(cameraFile, "utf8"));
      for (let i = 0; i < 3; i++) {
        const expected = projectPoint([0, 0.05, 0], camera.frames[i], camera.K, camera.image_size);
        assert.ok(
          Math.hypot((projected[i]![0]! - expected[0]) * 160, (projected[i]![1]! - expected[1]) * 90) < 0.5,
          "Blender and source projection must agree within half a pixel",
        );
      }
      const preview = await renderHybridVfx(built.job, path.join(directory, "preview"), {
        samples: 16,
        firstFrame: first,
        frames: [1, 1],
        resolution: [96, 54],
        device: "cpu",
      });
      const sourceFrame = path.join(directory, "plate-frame.png");
      await runProcess("ffmpeg", [
        "-v",
        "error",
        "-i",
        plate,
        "-vf",
        "select='eq(n,1)',scale=96:54",
        "-frames:v",
        "1",
        sourceFrame,
      ]);
      const before = readRecipeFrame(sourceFrame, [96, 54]),
        after = readRecipeFrame(path.join(preview.output, "frames/frame-000012.png"), [96, 54]);
      for (const channel of [0, 1, 2])
        assert.ok(
          Math.abs(before.data[(24 * 96 + 48) * 3 + channel]! - after.data[(24 * 96 + 48) * 3 + channel]!) <= 3,
          "Foreground holdout must restore the original plate over CG and receiver interaction",
        );
      for (const channel of [0, 1, 2])
        assert.ok(
          Math.abs(before.data[(5 * 96 + 5) * 3 + channel]! - after.data[(5 * 96 + 5) * 3 + channel]!) <= 3,
          "Preview must show the complete correct source frame, not a centre crop or wrong movie index",
        );
      if (fps !== 25) continue;
      const baselineScript = path.join(directory, "without-hero.py");
      writeFileSync(
        baselineScript,
        `import bpy\nfor o in bpy.context.scene.objects:\n if o.type=='MESH' and not o.is_shadow_catcher:o.hide_render=True\nfor n in bpy.context.scene.compositing_node_group.nodes:\n if n.bl_idname=='CompositorNodeOutputFile':n.directory=${JSON.stringify(path.join(directory, "baseline-masks"))}\n`,
      );
      const baseline = await runBlender({
        blend: path.join(result.output, "scene.blend"),
        script: baselineScript,
        output: path.join(directory, "baseline"),
        frames: [11, 11],
        samples: 16,
        engine: "cycles",
        format: "png",
        device: "cpu",
        factoryStartup: true,
        noRender: false,
        overwrite: false,
        resume: false,
        scriptArgs: [],
        timeoutSec: 60,
      });
      const absent = readRecipeFrame(baseline.frames[0]!.path, [160, 90]),
        present = readRecipeFrame(path.join(result.output, "frames/frame-000011.png"), [160, 90]);
      const mask = readRecipeFrame(
        path.join(result.output, "masks", readdirSync(path.join(result.output, "masks")).sort()[0]!),
        [160, 90],
      );
      let changedReceiver = 0;
      for (let p = 0; p < 160 * 90; p++)
        if (
          mask.data[p * 3]! < 128 &&
          [0, 1, 2].some((c) => Math.abs(present.data[p * 3 + c]! - absent.data[p * 3 + c]!) > 3)
        )
          changedReceiver++;
      assert.ok(changedReceiver >= 5, "The physical receiver must change outside the direct hero silhouette");
      assert.equal(
        assertVorkResult(result.receipt, hashFile(result.video), process.cwd(), true).schemaVersion,
        2,
        "Baseline must not overwrite the original bound masks",
      );
    }
  },
);

test("static Cycles routes reject animated source geometry before tool execution", async (t) => {
  const { renderReturnedGeometry } = await import("../src/lib/vork/hybrid");
  const root = mkdtempSync(path.join(tmpdir(), "vork-static-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scene = writeNew(path.join(root, "scene.json"), {
    version: 2,
    nodes: [{ name: "hero", type: "mesh", geometry: { std: "box" } }],
    animation: [{ tracks: [] }],
  });
  const job = writeNew(path.join(root, "job.json"), {
    schemaVersion: 1,
    renderBackend: "blender-cycles",
    scene: "scene.json",
    task: "task.json",
    camera: "camera.json",
    plate: "plate.mp4",
    fps: 30,
    frames: 3,
    resolution: [160, 90],
    seed: 42,
    receiver: { size: 5, roughness: 0.3, colour: [0.4, 0.4, 0.4] },
  });
  await assert.rejects(renderHybridVfx(job, path.join(root, "hybrid")), /static hero/);
  await assert.rejects(renderReturnedGeometry(scene, path.join(root, "returned")), /refuses animation/);
});
