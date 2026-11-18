import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { bakeBlenderScene, BlenderSceneSchema } from "../src/lib/backends/blender-scene";
import {
  captureBakedBlender,
  encodeBakedBlenderVideo,
  importBakedBlenderFrames,
  readBlenderSceneRequest,
} from "../src/lib/backends/blender-bake";
import { digest } from "../src/lib/jobs/model-artifacts";
const body = (id: string, location: number[], velocity: number[], extra = {}) => ({
  id,
  shape: "sphere",
  location,
  scale: [0.5, 0.5, 0.5],
  material: { color: id === "a" ? [1, 0.2, 0.1] : [0.1, 0.4, 1] },
  collider: { kind: "dynamic", radius: 0.5, mass: 1, velocity, restitution: 0.95, friction: 0, ...extra },
});
export const contactsFixture = {
  version: 1,
  width: 192,
  height: 128,
  fps: 30,
  durationFrames: 31,
  frames: [0, 15, 30],
  substeps: 8,
  physics: { solver: "avc-sphere-contacts-v1", gravity: 0, iterations: 8 },
  camera: { location: [0, -7, 4], target: [0, 0, 0.5] },
  lights: [{ location: [2, -3, 5], energy: 1000 }],
  objects: [
    body("a", [-1, 0, 0.5], [2, 0, 0]),
    body("b", [1, 0, 0.5], [-2, 0, 0]),
    { id: "floor", shape: "plane", scale: [4, 4, 1], material: { color: [0.8, 0.8, 0.8] } },
  ],
};
const final = (input: unknown) => bakeBlenderScene(input).data.contacts!.at(-1)!.bodies;
const close = (a: number, b: number, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("legacy absent-mode exact bake SHA remains byte-compatible", () => {
  const legacy = {
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
  const bake = bakeBlenderScene(legacy);
  assert.equal(bake.sha256, "615ca24a82dba6b07f97c0922516140f2b7bb14a594dda2e5fa5114d82cb3fb4");
  assert.equal(bake.data.solver, "avc-floor-euler-v1");
  assert.equal("contacts" in bake.data, false);
});
test("equal-mass head-on collision separates with restitution and bounded energy", () => {
  const bake = bakeBlenderScene(contactsFixture),
    end = bake.data.contacts!.at(-1)!.bodies;
  close(end[0]!.velocity[0]!, -1.9);
  close(end[1]!.velocity[0]!, 1.9);
  assert.ok(end[0]!.location[0]! < -0.5 && end[1]!.location[0]! > 0.5);
  for (const state of bake.data.contacts!) {
    const [a, b] = state.bodies;
    assert.ok(Math.hypot(...a!.location.map((n, i) => n - b!.location[i]!)) >= 1 - 1e-7);
    const energy = state.bodies.reduce((sum, b) => sum + b.velocity.reduce((s, v) => s + v * v, 0) / 2, 0);
    assert.ok(energy <= 4 + 1e-8);
  }
});
test("unequal masses conserve momentum and follow normal restitution", () => {
  const input = {
    ...contactsFixture,
    objects: [body("a", [-1, 0, 0.5], [2, 0, 0], { mass: 2 }), body("b", [1, 0, 0.5], [-2, 0, 0])],
  };
  const [a, b] = final(input);
  close(2 * a!.velocity[0]! + b!.velocity[0]!, 2);
  close(b!.velocity[0]! - a!.velocity[0]!, 3.8);
});
test("oblique collision creates transverse response; pair friction reduces tangential relative speed", () => {
  const input = {
    ...contactsFixture,
    objects: [body("a", [-1, -0.2, 1], [2, 0.3, 0]), body("b", [1, 0.2, 1], [-2, -0.3, 0])],
  };
  const end = final(input);
  assert.ok(Math.abs(end[0]!.velocity[1]! - 0.3) > 0.1);
  close(end[0]!.velocity[1]! + end[1]!.velocity[1]!, 0);
  const frictionless = final({
    ...contactsFixture,
    durationFrames: 2,
    frames: [0, 1],
    objects: [body("a", [-0.5, 0, 1], [1, 1, 0]), body("b", [0.5, 0, 1], [-1, -1, 0])],
  });
  const friction = final({
    ...contactsFixture,
    durationFrames: 2,
    frames: [0, 1],
    objects: [
      body("a", [-0.5, 0, 1], [1, 1, 0], { friction: 1 }),
      body("b", [0.5, 0, 1], [-1, -1, 0], { friction: 1 }),
    ],
  });
  assert.ok(
    Math.abs(friction[0]!.velocity[1]! - friction[1]!.velocity[1]!) <
      Math.abs(frictionless[0]!.velocity[1]! - frictionless[1]!.velocity[1]!),
  );
});
test("static obstacle is immovable and separating touch never attracts", () => {
  const end = final({
    ...contactsFixture,
    objects: [body("a", [-1, 0, 0.5], [2, 0, 0]), body("b", [1, 0, 0.5], [0, 0, 0], { kind: "static" })],
  });
  assert.deepEqual(end[1]!.location, [1, 0, 0.5]);
  assert.deepEqual(end[1]!.velocity, [0, 0, 0]);
  close(end[0]!.velocity[0]!, -1.9);
  const separating = final({
    ...contactsFixture,
    objects: [body("a", [-0.5, 0, 1], [-1, 0, 0]), body("b", [0.5, 0, 1], [1, 0, 0])],
  });
  close(separating[0]!.velocity[0]!, -1);
  close(separating[1]!.velocity[0]!, 1);
});
test("floor sliding friction slows and stops without reverse velocity; roughness is visual only", () => {
  const input = {
    ...contactsFixture,
    physics: { ...contactsFixture.physics, gravity: 9.81 },
    objects: [body("a", [0, 0, 0.5], [2, 0, 0], { restitution: 0, friction: 0.5 })],
  };
  const bake = bakeBlenderScene(input);
  close(bake.data.contacts!.at(-1)!.bodies[0]!.velocity[0]!, 0);
  for (const state of bake.data.contacts!) {
    const b = state.bodies[0]!;
    assert.ok(b.velocity[0]! >= 0);
    close(b.location[2]!, 0.5);
  }
  const noFriction = final({ ...input, objects: [body("a", [0, 0, 0.5], [2, 0, 0], { restitution: 0, friction: 0 })] });
  close(noFriction[0]!.velocity[0]!, 2);
  assert.equal(
    bake.sha256,
    bakeBlenderScene({
      ...input,
      objects: input.objects.map((o) => ({ ...o, material: { ...o.material, roughness: 0.9 } })),
    }).sha256,
  );
});
test("fixed-step states ignore requested render order and collider enumeration order", () => {
  const a = bakeBlenderScene(contactsFixture),
    b = bakeBlenderScene({ ...contactsFixture, frames: [30, 0, 15] });
  assert.equal(a.sha256, b.sha256);
  const shuffled = bakeBlenderScene({ ...contactsFixture, objects: [...contactsFixture.objects].reverse() });
  assert.deepEqual(a.data.contacts, shuffled.data.contacts);
  assert.notEqual(a.sha256, bakeBlenderScene({ ...contactsFixture, substeps: 16 }).sha256);
});
test("unsupported geometry, overlap, keyframes, motion, speeds and compute bounds fail closed", () => {
  const rejects = (input: unknown) => assert.throws(() => BlenderSceneSchema.parse(input));
  rejects({ ...contactsFixture, physics: undefined });
  rejects({ ...contactsFixture, durationFrames: 302 });
  rejects({
    ...contactsFixture,
    objects: Array.from({ length: 13 }, (_, i) => body(`b${i}`, [i * 2 - 12, 0, 1], [0, 0, 0])),
  });
  rejects({ ...contactsFixture, objects: [body("a", [0, 0, 1], [0, 0, 0]), body("b", [0.9, 0, 1], [0, 0, 0])] });
  const original = body("a", [0, 0, 1], [0, 0, 0]);
  for (const change of [
    { shape: "cube" },
    { scale: [0.5, 0.6, 0.5] },
    { keyframes: [{ frame: 1 }] },
    { motion: { kind: "gravity-floor", velocity: [0, 0, 0] } },
  ])
    rejects({ ...contactsFixture, objects: [{ ...original, ...change }] });
  rejects({ ...contactsFixture, objects: [body("a", [0, 0, 0.4], [0, 0, 0])] });
  rejects({ ...contactsFixture, objects: [body("a", [0, 0, 1], [1, 0, 0], { kind: "static" })] });
  for (const change of [
    { mass: 0 },
    { friction: 2 },
    { restitution: 1 },
    { radius: 0.4 },
    { velocity: [Infinity, 0, 0] },
  ])
    rejects({ ...contactsFixture, objects: [body("a", [0, 0, 1], [0, 0, 0], change)] });
  rejects({ ...contactsFixture, fps: 1, substeps: 1 });
  assert.throws(
    () =>
      bakeBlenderScene({
        ...contactsFixture,
        durationFrames: 301,
        frames: [0, 300],
        physics: { ...contactsFixture.physics, gravity: 30 },
        objects: [body("a", [0, 0, 90], [0, 0, 0])],
      }),
    /anti-tunneling/,
  );
  assert.throws(
    () =>
      bakeBlenderScene({
        ...contactsFixture,
        durationFrames: 301,
        frames: [0, 300],
        objects: [body("a", [99, 0, 1], [2, 0, 0])],
      }),
    /bounded domain/,
  );
});
test("regular-file bounded request reader refuses FIFO, symlinks and oversized input without blocking", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sphere-input-")));
  try {
    const request = path.join(root, "request.json");
    writeFileSync(request, JSON.stringify(contactsFixture));
    assert.deepEqual(readBlenderSceneRequest(request), contactsFixture);
    const link = path.join(root, "link.json");
    symlinkSync(request, link);
    assert.throws(() => readBlenderSceneRequest(link));
    const fifo = path.join(root, "pipe.json");
    execFileSync("mkfifo", [fifo]);
    execFileSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "-e",
        `import {readBlenderSceneRequest} from './src/lib/backends/blender-bake'; try {readBlenderSceneRequest(${JSON.stringify(fifo)});process.exit(2)}catch{}`,
      ],
      // A blocking FIFO read never returns; the bound is generous so a cold tsx start under a full suite fits.
      { timeout: 30000 },
    );
    const cli = JSON.parse(
      execFileSync(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "scripts/blender-scene.ts", "--request", request, "--dry-run"],
        { encoding: "utf8" },
      ),
    );
    assert.equal(cli.ok, true);
    writeFileSync(request, " ".repeat(1024 * 1024 + 1));
    assert.throws(() => readBlenderSceneRequest(request), /bounded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("missed grazing passage is refused rather than silently tunneling", () => {
  assert.throws(
    () =>
      bakeBlenderScene({
        ...contactsFixture,
        durationFrames: 2,
        frames: [0, 1],
        objects: [body("a", [-0.05, 0.9999, 1], [24, 0, 0]), body("b", [0, 0, 1], [0, 0, 0], { kind: "static" })],
      }),
    /Swept sphere passage/,
  );
});

test("crossed minimum with still-overlapping separating endpoint refuses missed contact", () => {
  assert.throws(
    () =>
      bakeBlenderScene({
        ...contactsFixture,
        durationFrames: 2,
        frames: [0, 1],
        objects: [body("a", [-0.1, 0.9999, 1], [26.4, 0, 0]), body("b", [0, 0, 1], [0, 0, 0], { kind: "static" })],
      }),
    /Swept sphere passage/,
  );
});

test("minimum-at-endpoint and roundoff-near-endpoint penetrating passages refuse; exact touch coasts", () => {
  for (const endpoint of [0, -1e-12, 1e-12]) {
    const velocity = (0.1 + endpoint) * 30 * 8;
    assert.throws(
      () =>
        bakeBlenderScene({
          ...contactsFixture,
          durationFrames: 2,
          frames: [0, 1],
          objects: [body("a", [-0.1, 0.998, 1], [velocity, 0, 0]), body("b", [0, 0, 1], [0, 0, 0], { kind: "static" })],
        }),
      /Swept sphere passage/,
    );
  }
  const touching = final({
    ...contactsFixture,
    objects: [body("a", [-0.5, 0, 1], [1, 0, 0]), body("b", [0.5, 0, 1], [1, 0, 0])],
  });
  close(touching[0]!.velocity[0]!, 1);
  close(touching[1]!.velocity[0]!, 1);
  close(touching[1]!.location[0]! - touching[0]!.location[0]!, 1);
  const approaching = final({
    ...contactsFixture,
    durationFrames: 2,
    frames: [0, 1],
    objects: [body("a", [-0.1, 0.998, 1], [12, 0, 0]), body("b", [0, 0, 1], [0, 0, 0], { kind: "static" })],
  });
  assert.ok(approaching[0]!.velocity[0]! < 12 && approaching[0]!.velocity[1]! > 0);
});

test("insufficient contact iterations refuse unresolved packed penetration; floor bounce respects restitution", () => {
  assert.throws(
    () =>
      bakeBlenderScene({
        ...contactsFixture,
        durationFrames: 2,
        frames: [0, 1],
        physics: { ...contactsFixture.physics, iterations: 1 },
        objects: [
          body("a", [-1, 0, 1], [1, 0, 0]),
          body("b", [0, 0, 1], [0, 0, 0]),
          body("c", [1, 0, 1], [0, 0, 0], { kind: "static" }),
        ],
      }),
    /Unresolved sphere pair penetration/,
  );
  const bake = bakeBlenderScene({
    ...contactsFixture,
    objects: [body("a", [0, 0, 2], [0, 0, -2], { restitution: 0.6 })],
  });
  close(bake.data.contacts!.at(-1)!.bodies[0]!.velocity[2]!, 1.2);
  assert.ok(bake.data.contacts!.every((s) => s.bodies[0]!.location[2]! >= 0.5));
});

test("actual retained Blender sphere collision/sliding: random seek, cache, immutable imports and silent MP4", async (context) => {
  const executable = process.env.AGENTBROS_BLENDER_EXECUTABLE,
    artifacts = process.env.AGENTBROS_SPHERE_ARTIFACT_ROOT;
  if (!executable || !artifacts || !existsSync(executable)) {
    context.skip("Explicit retained Blender/runtime artifact root required; no install/download");
    return;
  }
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sphere-actual-")));
  mkdirSync(artifacts, { recursive: true });
  const output = path.join(artifacts, "sampled");
  const actualScene = {
    ...contactsFixture,
    physics: { ...contactsFixture.physics, gravity: 9.81 },
    objects: contactsFixture.objects.map((o) =>
      "collider" in o ? { ...o, collider: { ...o.collider, friction: 0.1, restitution: 0.6 } } : o,
    ),
  };
  try {
    const options = {
      executable,
      cacheDirectory: path.join(root, "cache"),
      outputDirectory: output,
      timeoutMs: 180000,
    };
    const capture = await captureBakedBlender(actualScene, options);
    assert.equal(capture.state, "candidate");
    if (capture.state !== "candidate") throw new Error("Verified engine unavailable");
    const manifest = JSON.parse(readFileSync(capture.manifest, "utf8"));
    assert.equal(manifest.solver, "avc-sphere-contacts-v1");
    assert.ok(manifest.limitations.includes("sliding-not-rolling-friction"));
    assert.match(manifest.pins.sphereImplementationSha256, /^[a-f0-9]{64}$/);
    const bake = JSON.parse(readFileSync(manifest.bake, "utf8"));
    const midpoint = bake.contacts[3].bodies[0].velocity[0],
      end = bake.contacts.at(-1).bodies[0].velocity[0];
    assert.ok(midpoint > 0 && midpoint < 2);
    assert.ok(end < 0, "collision reverses first body");
    const repeat = await captureBakedBlender({ ...actualScene, frames: [30, 0, 15] }, options);
    if (repeat.state !== "candidate") throw new Error("Cache unavailable");
    assert.equal(repeat.renderedFrames, 0);
    assert.equal(repeat.cacheHits, 3);
    assert.equal(repeat.key, capture.key);
    const random = await captureBakedBlender(
      { ...actualScene, frames: [30, 0, 15] },
      { ...options, cacheDirectory: path.join(root, "random-cache"), outputDirectory: path.join(artifacts, "random") },
    );
    if (random.state !== "candidate") throw new Error("Random unavailable");
    assert.deepEqual(
      random.sequence.map((f) => f.sha256),
      capture.sequence.map((f) => f.sha256),
    );
    const changed = await captureBakedBlender(
      { ...actualScene, frames: [15], physics: { ...actualScene.physics, iterations: 7 } },
      options,
    );
    if (changed.state !== "candidate") throw new Error("Changed unavailable");
    assert.notEqual(changed.key, capture.key);
    assert.equal(changed.renderedFrames, 1);
    mkdirSync(path.join(root, "public/projects/pilot"), { recursive: true });
    writeFileSync(path.join(root, "public/projects/pilot/project.json"), "{}");
    const imported = importBakedBlenderFrames(capture, "pilot", { rootDir: root });
    assert.ok(
      imported.every(
        (f) =>
          f.asset.status === "candidate" &&
          f.asset.rights.commercialAllowed === "unknown" &&
          f.asset.hash === capture.sequence.find((s) => s.frame === f.frame)!.sha256,
      ),
    );
    assert.ok(importBakedBlenderFrames(capture, "pilot", { rootDir: root }).every((f) => f.duplicate));
    await assert.rejects(encodeBakedBlenderVideo(capture, output), /contiguous/);
    const complete = await captureBakedBlender(
      { ...actualScene, durationFrames: 12, frames: Array.from({ length: 12 }, (_, i) => i) },
      { ...options, outputDirectory: path.join(artifacts, "complete") },
    );
    if (complete.state !== "candidate") throw new Error("Complete unavailable");
    const video = await encodeBakedBlenderVideo(complete, path.join(artifacts, "complete"));
    assert.equal((await encodeBakedBlenderVideo(complete, path.join(artifacts, "complete"))).cacheHit, true);
    const probe = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", video.path], {
        encoding: "utf8",
      }),
    );
    assert.equal(probe.streams.length, 1);
    assert.equal(probe.streams[0].codec_name, "h264");
    close(Number(probe.format.duration), 0.4, 0.001);
    const receipt = path.join(root, "cache", capture.key, "frame-000000.png.json");
    writeFileSync(receipt, "{}");
    await assert.rejects(captureBakedBlender(actualScene, options), /checksum\/pins/);
    const fifoCache = path.join(root, "fifo-cache");
    mkdirSync(path.join(fifoCache, capture.key), { recursive: true });
    const fifo = path.join(fifoCache, capture.key, "bake.json");
    execFileSync("mkfifo", [fifo]);
    const started = performance.now();
    await assert.rejects(captureBakedBlender(actualScene, { ...options, cacheDirectory: fifoCache }), /regular-file/);
    assert.ok(performance.now() - started < 10000);
    const symlink = path.join(root, "symlink-cache");
    symlinkSync(path.join(root, "cache"), symlink);
    await assert.rejects(captureBakedBlender(actualScene, { ...options, cacheDirectory: symlink }), /Symlink/);
    const evidence = {
      version: 1,
      sourceCommit: process.env.AGENTBROS_SPHERE_SOURCE_COMMIT,
      actual: true,
      scene: actualScene,
      providerSpendUsd: 0,
      capture,
      random,
      complete,
      video,
      midpointVelocityX: midpoint,
      finalVelocityX: end,
      manifestSha256: digest(readFileSync(capture.manifest)),
      limitations: [
        "192x128 small owned translational spheres only",
        "sliding not rolling friction",
        "no native Blender physics/GPU/creative approval",
      ],
    };
    writeFileSync(path.join(artifacts, "acceptance.json"), JSON.stringify(evidence, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
