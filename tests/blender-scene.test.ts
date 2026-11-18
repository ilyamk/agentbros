import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BlenderSceneSchema, bakeBlenderScene } from "../src/lib/backends/blender-scene";
import {
  captureBakedBlender,
  runBlenderSceneProcess,
  importBakedBlenderFrames,
  encodeBakedBlenderVideo,
} from "../src/lib/backends/blender-bake";
import { digest } from "../src/lib/jobs/model-artifacts";
import { captureBlender } from "../src/lib/backends/blender";
export const sceneFixture = {
  version: 1,
  width: 192,
  height: 128,
  fps: 30,
  durationFrames: 31,
  frames: [0, 15, 30],
  camera: { location: [7, -10, 6], target: [0, 0, 1] },
  lights: [
    { location: [3, -4, 7], energy: 1200 },
    { location: [-4, 1, 5], energy: 500, color: [0.4, 0.7, 1] },
  ],
  objects: [
    { id: "floor", shape: "plane", scale: [5, 5, 1], material: { color: [0.8, 0.8, 0.8] } },
    {
      id: "ball",
      shape: "sphere",
      location: [-1, 0, 4],
      scale: [0.5, 0.5, 0.5],
      material: { color: [1, 0.25, 0.1], metallic: 0.2 },
      motion: { kind: "gravity-floor", velocity: [1, 0, 0], radius: 0.5, restitution: 0.6 },
    },
    {
      id: "box",
      shape: "cube",
      location: [1.5, 0, 1],
      material: { color: [0.1, 0.4, 0.9] },
      keyframes: [{ frame: 30, location: [1.5, 0, 1], rotation: [0, 0, 1.2] }],
    },
  ],
};
test("strict scene limits reject code, duplicates, invalid duration/geometry/keyframes", () => {
  assert.throws(() => BlenderSceneSchema.parse({ ...sceneFixture, python: "arbitrary" }));
  assert.throws(() => BlenderSceneSchema.parse({ ...sceneFixture, frames: [0, 0] }));
  assert.throws(() => BlenderSceneSchema.parse({ ...sceneFixture, durationFrames: 30 }));
  assert.throws(() => BlenderSceneSchema.parse({ ...sceneFixture, objects: Array(25).fill(sceneFixture.objects[0]) }));
  assert.throws(() =>
    BlenderSceneSchema.parse({ ...sceneFixture, objects: [{ ...sceneFixture.objects[1], keyframes: [{ frame: 1 }] }] }),
  );
  assert.throws(() => BlenderSceneSchema.parse({ ...sceneFixture, camera: { location: [0, 0, 0] } }));
});
test("floor bake is repeatable, keyframes interpolate, arbitrary seek reads immutable frame states", () => {
  const a = bakeBlenderScene(sceneFixture),
    b = bakeBlenderScene({ ...sceneFixture, frames: [30, 0, 15] });
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.data.states.length, 31);
  assert.equal(a.data.states[15]!.objects[2]!.rotation[2], 0.6);
  assert.ok(a.data.states[30]!.objects[1]!.location[2]! >= 0.5);
  assert.ok(a.data.states[15]!.objects[1]!.location[2]! < 4);
  assert.deepEqual(a.data.states[30], b.data.states[30]);
  const still = bakeBlenderScene({ ...sceneFixture, substeps: 16 });
  assert.notEqual(still.sha256, a.sha256);
});
test("absent runtime does not manufacture availability, cache or fallback", async () => {
  const result = await captureBakedBlender(sceneFixture, {
    executable: "/not-installed/blender",
    cacheDirectory: "/not-written",
    outputDirectory: "/not-written",
  });
  assert.equal(result.state, "unavailable");
  assert.deepEqual(result.outputs, []);
});
test("process timeout kills spawned process group and bounded worker parse succeeds", async () => {
  await assert.rejects(runBlenderSceneProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], 100), /timeout/);
  execFileSync("python3", ["-c", 'import ast;ast.parse(open("scripts/workers/blender_scene.py").read())']);
});
test("actual Blender scene bakes/cache/random seek match, corruption fails and baseline measured", async (context) => {
  const executable = process.env.AGENTBROS_BLENDER_EXECUTABLE;
  if (!executable || !existsSync(executable)) {
    context.skip("Explicit installed Blender 4.5.14 executable required; no download");
    return;
  }
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "baked-scene-test-")));
  const artifactRoot = process.env.AGENTBROS_BLENDER_ARTIFACT_ROOT
    ? realpathSync(process.env.AGENTBROS_BLENDER_ARTIFACT_ROOT)
    : root;
  try {
    const options = {
      executable,
      cacheDirectory: path.join(root, "cache"),
      outputDirectory: path.join(artifactRoot, "advanced"),
      timeoutMs: 180000,
    };
    const first = await captureBakedBlender(sceneFixture, options);
    assert.equal(first.state, "candidate");
    if (first.state !== "candidate") throw new Error("Actual Blender capture unavailable");
    mkdirSync(path.join(root, "public/projects/pilot"), { recursive: true });
    writeFileSync(path.join(root, "public/projects/pilot/project.json"), "{}");
    const imported = importBakedBlenderFrames(first, "pilot", { rootDir: root });
    assert.equal(imported.length, 3);
    assert.ok(
      imported.every(
        (f) =>
          f.asset.status === "candidate" &&
          f.asset.rights.commercialAllowed === "unknown" &&
          f.asset.hash === first.sequence.find((s) => s.frame === f.frame)!.sha256,
      ),
    );
    assert.ok(importBakedBlenderFrames(first, "pilot", { rootDir: root }).every((f) => f.duplicate));
    assert.equal(first.renderedFrames, 3);
    assert.equal(first.cacheHits, 0);
    const cached = await captureBakedBlender({ ...sceneFixture, frames: [30, 0, 15] }, options);
    assert.equal(cached.state, "candidate");
    if (cached.state !== "candidate") throw new Error("Actual Blender capture unavailable");
    assert.equal(cached.renderedFrames, 0);
    assert.equal(cached.cacheHits, 3);
    assert.equal(cached.key, first.key);
    const random = await captureBakedBlender(
      { ...sceneFixture, frames: [30, 0, 15] },
      {
        ...options,
        cacheDirectory: path.join(root, "fresh-random-cache"),
        outputDirectory: path.join(artifactRoot, "random"),
      },
    );
    assert.equal(random.state, "candidate");
    if (random.state !== "candidate") throw new Error("Actual Blender capture unavailable");
    assert.equal(random.renderedFrames, 3);
    assert.deepEqual(
      random.sequence.map((f) => f.sha256),
      first.sequence.map((f) => f.sha256),
    );
    await assert.rejects(encodeBakedBlenderVideo(first, options.outputDirectory), /contiguous/);
    const full = await captureBakedBlender(
      {
        ...sceneFixture,
        durationFrames: 4,
        frames: [0, 1, 2, 3],
        objects: sceneFixture.objects.map((o) => ({ ...o, keyframes: [] })),
      },
      { ...options, outputDirectory: path.join(artifactRoot, "video-sequence") },
    );
    if (full.state !== "candidate") throw new Error("Complete capture unavailable");
    const originalFullManifest = readFileSync(full.manifest);
    const changedTiming = { ...JSON.parse(originalFullManifest.toString()), fps: 60 };
    writeFileSync(full.manifest, JSON.stringify(changedTiming));
    await assert.rejects(encodeBakedBlenderVideo(full, path.join(artifactRoot, "video-sequence")), /manifest checksum/);
    assert.throws(() => importBakedBlenderFrames(full, "pilot", { rootDir: root }), /manifest checksum/);
    writeFileSync(full.manifest, originalFullManifest);
    const video = await encodeBakedBlenderVideo(full, path.join(artifactRoot, "video-sequence"));
    assert.match(video.sha256, /^[a-f0-9]{64}$/);
    assert.equal((await encodeBakedBlenderVideo(full, path.join(artifactRoot, "video-sequence"))).cacheHit, true);
    const originalVideo = readFileSync(video.path);
    writeFileSync(full.manifest, JSON.stringify(changedTiming));
    await assert.rejects(encodeBakedBlenderVideo(full, path.join(artifactRoot, "video-sequence")), /manifest checksum/);
    assert.deepEqual(readFileSync(video.path), originalVideo, "Rejected timing mutation leaves cached video unchanged");
    writeFileSync(full.manifest, originalFullManifest);
    assert.equal((await encodeBakedBlenderVideo(full, path.join(artifactRoot, "video-sequence"))).cacheHit, true);
    assert.ok(imported.every((f) => f.asset.provenance.billing.source?.includes(first.manifestSha256)));
    const changed = await captureBakedBlender({ ...sceneFixture, substeps: 16, frames: [15] }, options);
    assert.equal(changed.state, "candidate");
    if (changed.state !== "candidate") throw new Error("Actual Blender capture unavailable");
    assert.notEqual(changed.key, first.key);
    assert.equal(changed.renderedFrames, 1);
    writeFileSync(path.join(root, "cache", first.key, "frame-000000.png.json"), "{}");
    await assert.rejects(captureBakedBlender(sceneFixture, options), /checksum\/pins/);
    writeFileSync(path.join(root, "cache", first.key, "bake.json"), "{}");
    await assert.rejects(captureBakedBlender(sceneFixture, options), /bake checksum/);
    const symlink = path.join(root, "linked-cache");
    symlinkSync(path.join(root, "cache"), symlink);
    await assert.rejects(captureBakedBlender(sceneFixture, { ...options, cacheDirectory: symlink }), /Symlink/);
    const originalManifest = JSON.parse(readFileSync(first.manifest, "utf8"));
    assert.equal(originalManifest.reviewRequired, true);
    assert.equal(originalManifest.scene.objects.length, 3);
    assert.equal(JSON.parse(readFileSync(originalManifest.bake, "utf8")).states.length, 31);
    assert.equal(originalManifest.contiguous, false);
    const baselineStart = performance.now();
    const baseline = captureBlender(
      { width: 192, height: 128, frames: [0, 15, 30] },
      path.join(artifactRoot, "baseline"),
      { executable },
    );
    assert.equal(baseline.state, "published");
    const evidence = {
      version: 1,
      blender: "4.5.14",
      actual: true,
      fixture: "3 objects / 2 lights / floor bake / 3 frames at 192x128",
      advancedMs: first.elapsedMs,
      cacheMs: cached.elapsedMs,
      randomFreshMs: random.elapsedMs,
      baselineMs: Math.round(performance.now() - baselineStart),
      advanced: first,
      random,
      baseline,
      limitations:
        "Small local pilot, not general performance or GPU claim. Timing includes runtime probing/hash verification; legacy baseline has no equivalent pin verification.",
    };
    writeFileSync(path.join(artifactRoot, "benchmark.json"), JSON.stringify(evidence, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("CLI validates bake locally with one JSON envelope and never chooses arbitrary worker code", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "baked-scene-cli-")));
  try {
    const request = path.join(root, "scene.json");
    writeFileSync(request, JSON.stringify(sceneFixture));
    const output = execFileSync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/blender-scene.ts", "--request", request, "--dry-run"],
      { encoding: "utf8" },
    );
    assert.equal(output.trim().split("\n").length, 1);
    const envelope = JSON.parse(output);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.metadata.providerSpendUsd, 0);
    assert.match(envelope.metadata.bakeSha256, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("timed-out trusted worker also stops its spawned descendant", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bake-process-tree-")));
  const tick = path.join(root, "tick");
  const grandchild = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(tick)},'started');setInterval(()=>fs.appendFileSync(${JSON.stringify(tick)},'.'),40)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  try {
    await assert.rejects(runBlenderSceneProcess(process.execPath, ["-e", parent], 2500), /timeout/);
    assert.ok(existsSync(tick), "Descendant started before timeout");
    const before = readFileSync(tick, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(readFileSync(tick, "utf8"), before, "Descendant stopped with process group");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest timing tamper rejects before encoder or registry access even without Blender installed", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bake-manifest-integrity-")));
  try {
    const sequence = [{ frame: 0, path: path.join(root, "not-a-real-frame.png"), sha256: "b".repeat(64) }];
    const manifest = path.join(root, "manifest.json");
    const bytes = JSON.stringify({ key: "a".repeat(64), fps: 30, durationFrames: 1, contiguous: true, sequence });
    // Synthetic capture receipt tests the integrity boundary only; no inference/render acceptance.
    const captured = {
      state: "candidate" as const,
      key: "a".repeat(64),
      sequence,
      manifest,
      manifestSha256: digest(bytes),
      outputs: [],
      renderedFrames: 0,
      cacheHits: 1,
      elapsedMs: 0,
    };
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(bytes), fps: 60 }));
    await assert.rejects(encodeBakedBlenderVideo(captured, root), /manifest checksum/);
    assert.throws(() => importBakedBlenderFrames(captured, "nonexistent", { rootDir: root }), /manifest checksum/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
