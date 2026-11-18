import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { compileViz } from "../src/lib/viz/compile";
import { exampleViz } from "../src/lib/viz/store";
import { prepareVizBlenderPlan, vizBlenderRanges } from "../src/lib/viz/blender-plan";
import { vizClippedPathPoints } from "../src/motion/viz/paths";
import { vizScreenTransform, vizObjectGeometry, vizElementState } from "../src/motion/viz/state";
import { runBlender } from "../src/lib/backends/blender-run";

test("Blender previews request three singleton frames and shared depth paths preserve endpoints", async () => {
  assert.deepEqual(vizBlenderRanges(150, true), [
    [1, 1],
    [76, 76],
    [150, 150],
  ]);
  assert.deepEqual(vizBlenderRanges(31, false), [[1, 31]]);
  const plan = await compileViz(exampleViz("network-3d"), "landscape");
  const prepared = prepareVizBlenderPlan(plan, (p) => p);
  assert.ok(prepared.paths.length);
  for (const path of prepared.paths) {
    assert.ok(path.points.length >= 2);
    assert.ok(path.points.every((point) => point[2] < -0.15));
    assert.equal(path.states.length, 150);
  }
});

test(
  "actual Blender all 3D recipes/formats match moving projected anchors and singleton frames",
  { skip: process.env.RUN_VIZ_BLENDER_TESTS !== "1", timeout: 900000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "viz-blender-parity-"));
    const evidence = path.resolve("out/qa/viz-blender-acceptance");
    mkdirSync(evidence, { recursive: true });
    try {
      for (const recipe of ["bars-3d", "network-3d", "process-3d"] as const)
        for (const format of ["landscape", "square", "vertical"] as const) {
          const spec = exampleViz(recipe);
          spec.durationFrames = 33;
          spec.camera = { ...spec.camera, move: "truck", amount: 0.15, endFrame: 3 };
          spec.layout = recipe === "network-3d" ? "force" : "layered";
          const plan = await compileViz(spec, format);
          const prepared = path.join(directory, `${recipe}-${format}.json`);
          writeFileSync(prepared, JSON.stringify(prepareVizBlenderPlan(plan, (p) => p)));
          const scale = 320 / Math.max(plan.width, plan.height),
            resolution: [number, number] = [Math.round(plan.width * scale), Math.round(plan.height * scale)];
          const result = await runBlender({
            script: path.resolve("scripts/blender/viz_scene.py"),
            output: path.join(directory, `${recipe}-${format}`),
            frames: [2, 2],
            samples: 1,
            resolution,
            engine: "cycles",
            filmTransparent: true,
            format: "png",
            device: "cpu",
            factoryStartup: true,
            noRender: false,
            overwrite: false,
            resume: true,
            scriptArgs: [prepared],
            timeoutSec: 120,
          });
          assert.equal(result.frames.length, 1);
          assert.equal(result.frames[0]!.frame, 2);
          assert.ok(readFileSync(result.frames[0]!.path).length > 100);
          copyFileSync(result.frames[0]!.path, path.join(evidence, `${recipe}-${format}.png`));
          copyFileSync(result.camera!.path, path.join(evidence, `${recipe}-${format}-camera.json`));
          const camera = JSON.parse(readFileSync(result.camera!.path, "utf8")) as {
            frames: Array<{ anchors: Record<string, { x: number; y: number }> }>;
          };
          const anchors = camera.frames[0]!.anchors;
          const [a, b, c, d, e, f] = vizScreenTransform(plan, 1);
          for (const primitive of plan.primitives.filter((p) => ["rect", "circle"].includes(p.kind))) {
            const geometry = vizObjectGeometry(plan, primitive);
            if (geometry.z !== 0) continue;
            const x = geometry.x * 200 + plan.width / 2,
              y = plan.height / 2 - geometry.y * 200;
            const anchor = anchors[primitive.id]!;
            assert.ok(
              Math.hypot(
                anchor.x - ((a * x + c * y + e) * resolution[0]) / plan.width,
                anchor.y - ((b * x + d * y + f) * resolution[1]) / plan.height,
              ) <= 1,
              `${recipe}/${format}/${primitive.id} anchor mismatch`,
            );
            for (const [suffix, sign] of [
              ["top", -1],
              ["bottom", 1],
            ] as const) {
              const py = y + (sign * geometry.height * 200 * vizElementState(plan, primitive, 1).progress) / 2;
              const corner = anchors[`${primitive.id}-${suffix}`]!;
              assert.ok(
                Math.hypot(
                  corner.x - ((a * x + c * py + e) * resolution[0]) / plan.width,
                  corner.y - ((b * x + d * py + f) * resolution[1]) / plan.height,
                ) <= 1,
                `${recipe}/${format}/${primitive.id} animated ${suffix} mismatch`,
              );
            }
          }
        }
      // A real sequence can resume its existing frame set without changing its extent.
      const plan = await compileViz({ ...exampleViz("bars-3d"), durationFrames: 31 }, "landscape");
      const file = path.join(directory, "sequence.json");
      writeFileSync(file, JSON.stringify(prepareVizBlenderPlan(plan, (p) => p)));
      const request = {
        script: path.resolve("scripts/blender/viz_scene.py"),
        output: path.join(directory, "sequence"),
        frames: [1, 31] as [number, number],
        samples: 1,
        resolution: [160, 90] as [number, number],
        engine: "cycles" as const,
        filmTransparent: true,
        format: "png" as const,
        device: "cpu" as const,
        factoryStartup: true,
        noRender: false,
        overwrite: false,
        resume: true,
        scriptArgs: [file],
        timeoutSec: 240,
      };
      const first = await runBlender(request),
        second = await runBlender(request);
      const isolated = await runBlender({ ...request, output: path.join(directory, "isolated"), frames: [16, 16] });
      const decode = (file: string) => {
        const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
        assert.equal(decoded.status, 0, decoded.stderr.toString());
        return decoded.stdout;
      };
      assert.deepEqual(
        decode(isolated.frames[0]!.path),
        decode(first.frames[15]!.path),
        "Fresh CPU singleton pixels must equal the sequence frame",
      );
      assert.equal(first.frames.length, 31);
      copyFileSync(first.frames[15]!.path, path.join(evidence, "sequence-middle.png"));
      writeFileSync(
        path.join(evidence, "sequence.json"),
        JSON.stringify({
          frames: first.frames.length,
          first: 1,
          last: 31,
          resumedFrames: second.frames.length,
          blender: first.render.blenderVersion,
        }),
      );
      assert.deepEqual(
        second.frames.map((f) => f.sha256),
        first.frames.map((f) => f.sha256),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("delayed path draws have no pre-event stub and interpolate fractional endpoints", () => {
  const points: Array<[number, number, number]> = [
    [0, 0, -0.17],
    [1, 0, -0.17],
    [2, 0, -0.17],
  ];
  assert.deepEqual(vizClippedPathPoints(points, 0), []);
  assert.deepEqual(vizClippedPathPoints(points, 0.125), [
    [0, 0, -0.17],
    [0.25, 0, -0.17],
  ]);
  assert.deepEqual(vizClippedPathPoints(points, 1), points);
});
