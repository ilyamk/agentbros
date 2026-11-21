import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pythonArgs, pythonEnvironment, pythonUv } from "../src/lib/python";

// Imported per test, so this file still loads where camera-solve does not exist and the contract test itself fails there.
const camera = () => import("../src/lib/vfx/camera-solve");

test("camera:solve requests carry the worker and Blender contracts", async () => {
  const { solveParams, tracksRequest } = await camera();
  const tracks = tracksRequest("plate.mp4", "out/tracks.json", { frames: [0, 9], matteDir: "m" });
  assert.equal(tracks.matte_pattern, "frame-{:05d}.png");
  assert.deepEqual(tracks.frames, [0, 9]);
  assert.equal(tracks.epipolar_px, 1);
  assert.ok(path.isAbsolute(tracks.plate) && path.isAbsolute(tracks.matte_dir!));
  const params = solveParams("plate.mp4", "t.json", "out", { focalPx: 1500, keyframes: [20, 40] });
  assert.deepEqual(Object.keys(params).sort(), ["focal_px", "keyframes", "output", "plate", "tracks"]);
});

test(
  "camera:solve recovers a known synthetic camera",
  { skip: process.env.RUN_BLENDER_TESTS ? false : "Set RUN_BLENDER_TESTS=1 to run real Blender", timeout: 600_000 },
  async () => {
    const { cameraSolve } = await camera();
    const dir = mkdtempSync(path.join(tmpdir(), "camera-solve-"));
    const fixture = path.join(import.meta.dirname, "fixtures/vfx/synthetic-plate.py");
    const made = spawnSync(pythonUv(), pythonArgs("vork", [fixture, dir]), {
      env: pythonEnvironment("vork"),
      encoding: "utf8",
    });
    assert.equal(made.status, 0, made.stderr);
    const result = await cameraSolve({
      plate: path.join(dir, "plate.mp4"),
      output: path.join(dir, "solve"),
      tracks: { epipolarPx: 1.5 },
      solve: { focalPx: 700, cleanRounds: 2 },
    });
    const report = result.report;
    assert.ok(report.averageErrorPx < 1, `reprojection ${report.averageErrorPx}`);
    assert.ok(report.solvedFrames >= 0.9 * report.frames, `solved ${report.solvedFrames}/${report.frames}`);
    // a tracked focal is weakly constrained on short plates; it must land near the truth, not at the guess
    assert.ok(Math.abs(report.focalPx - 800) / 800 < 0.15, `focal ${report.focalPx}`);
    // the recovered motion matches the truth up to similarity: compare normalised camera-centre paths
    const truth = JSON.parse(readFileSync(path.join(dir, "truth.json"), "utf8"));
    const solved = JSON.parse(readFileSync(result.camera, "utf8"));
    const centres = (frames: { R: number[][]; t: number[] }[]) =>
      frames.map(({ R, t }) => [0, 1, 2].map((i) => -(R[0]![i]! * t[0]! + R[1]![i]! * t[1]! + R[2]![i]! * t[2]!)));
    const span = (c: number[][]) => Math.hypot(...c.at(-1)!.map((v, i) => v - c[0]![i]!));
    const a = centres(truth.frames),
      b = centres(solved.frames);
    const ratio = (c: number[][], k: number) => Math.hypot(...c[k]!.map((v, i) => v - c[0]![i]!)) / span(c);
    for (const k of [18, 36, 54]) assert.ok(Math.abs(ratio(a, k) - ratio(b, k)) < 0.05, `path at ${k}`);
  },
);
