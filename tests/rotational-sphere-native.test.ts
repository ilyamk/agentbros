import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { captureBakedBlender, encodeBakedBlenderVideo } from "../src/lib/backends/blender-bake";
import { bakeBlenderScene } from "../src/lib/backends/blender-scene";
import { ROTATIONAL_SPHERE_SOLVER, verifyRotationalReadback } from "../src/lib/backends/rotational-sphere-contacts";
import { digest } from "../src/lib/jobs/model-artifacts";

test(
  "actual installed Blender v2 quaternion/matrix readback, random seek/cache and silent eight-frame MP4",
  { timeout: 480000 },
  async (context) => {
    const executable = process.env.AGENTBROS_BLENDER_EXECUTABLE,
      artifacts = process.env.AGENTBROS_ROTATIONAL_ARTIFACT_ROOT;
    if (!executable || !artifacts || !existsSync(executable)) {
      context.skip("Explicit retained Blender and rotational artifact root required; no install/download");
      return;
    }
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "rotational-native-")));
    mkdirSync(artifacts, { recursive: true });
    const scene = {
      version: 1,
      width: 96,
      height: 64,
      fps: 8,
      durationFrames: 8,
      frames: [0, 1, 2, 3, 4, 5, 6, 7],
      substeps: 16,
      physics: { solver: ROTATIONAL_SPHERE_SOLVER, gravity: 9.81 },
      camera: { location: [0, -5, 3], target: [0.5, 0, 0.5] },
      lights: [{ location: [1, -3, 5], energy: 1000 }],
      objects: [
        {
          id: "ball",
          shape: "sphere",
          location: [0, 0, 0.5],
          rotation: [0.3, 0.4, 0.5],
          scale: [0.5, 0.5, 0.5],
          material: { color: [1, 0.2, 0.1] },
          collider: { kind: "dynamic", radius: 0.5, mass: 1, velocity: [1, 0, 0], restitution: 0, friction: 0.5 },
        },
        { id: "floor", shape: "plane", scale: [3, 3, 1], material: { color: [0.2, 0.2, 0.2] } },
      ],
    };
    try {
      const options = {
        executable,
        cacheDirectory: path.join(root, "cache"),
        outputDirectory: path.join(artifacts, "complete"),
        timeoutMs: 90000,
      };
      const first = await captureBakedBlender(scene, options);
      assert.equal(first.state, "candidate");
      if (first.state !== "candidate") throw new Error("Verified native engine unavailable");
      assert.equal(first.renderedFrames, 8);
      const baked = bakeBlenderScene(scene),
        manifest = JSON.parse(readFileSync(first.manifest, "utf8"));
      assert.equal(manifest.solver, ROTATIONAL_SPHERE_SOLVER);
      assert.match(manifest.pins.rotationalSphereImplementationSha256, /^[a-f0-9]{64}$/);
      assert.equal(manifest.nativeTransforms.length, 8);
      const proofHashes: string[] = [];
      for (const record of manifest.nativeTransforms) {
        const bytes = readFileSync(record.path);
        assert.equal(digest(bytes), record.sha256);
        proofHashes.push(record.sha256);
        verifyRotationalReadback(JSON.parse(bytes.toString()), baked.data.states[record.frame]!);
      }
      assert.notEqual(proofHashes[0], proofHashes[7]);
      assert.notDeepEqual(baked.data.states[0]!.objects[0]!.orientation, baked.data.states[7]!.objects[0]!.orientation);
      const cached = await captureBakedBlender({ ...scene, frames: [...scene.frames].reverse() }, options);
      if (cached.state !== "candidate") throw new Error("Cache unavailable");
      assert.equal(cached.renderedFrames, 0);
      assert.equal(cached.cacheHits, 8);
      assert.equal(cached.key, first.key);
      const random = await captureBakedBlender(
        { ...scene, frames: [7, 0, 3] },
        {
          ...options,
          cacheDirectory: path.join(root, "random-cache"),
          outputDirectory: path.join(artifacts, "random"),
        },
      );
      if (random.state !== "candidate") throw new Error("Random unavailable");
      assert.equal(random.renderedFrames, 3);
      assert.deepEqual(
        random.sequence.map((f) => f.sha256),
        [0, 3, 7].map((frame) => first.sequence.find((f) => f.frame === frame)!.sha256),
      );
      const randomManifest = JSON.parse(readFileSync(random.manifest, "utf8"));
      assert.deepEqual(
        randomManifest.nativeTransforms.map((f: { sha256: string }) => f.sha256),
        [0, 3, 7].map((frame) => manifest.nativeTransforms.find((f: { frame: number }) => f.frame === frame).sha256),
      );
      const video = await encodeBakedBlenderVideo(first, path.join(artifacts, "complete"));
      const probe = JSON.parse(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", video.path],
          { encoding: "utf8", timeout: 10000 },
        ),
      );
      assert.equal(probe.streams.length, 1);
      assert.equal(probe.streams[0].codec_name, "h264");
      assert.equal(Number(probe.streams[0].nb_read_frames), 8);
      assert.equal(Number(probe.format.duration), 1);
      execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", video.path, "-map", "0", "-f", "null", "-"], {
        stdio: "pipe",
        timeout: 30000,
      });
      const proof = path.join(root, "cache", first.key, "frame-000007.rotation.json"),
        receipt = path.join(root, "cache", first.key, "frame-000007.png.json");
      const originalProof = readFileSync(proof),
        originalReceipt = readFileSync(receipt);
      unlinkSync(proof);
      await assert.rejects(captureBakedBlender(scene, options), /ENOENT/);
      writeFileSync(proof, originalProof);
      writeFileSync(proof, "{}");
      await assert.rejects(captureBakedBlender(scene, options), /readback/);
      writeFileSync(proof, originalProof);
      writeFileSync(proof, Buffer.concat([originalProof, Buffer.from(" ")]));
      await assert.rejects(captureBakedBlender(scene, options), /checksum/);
      writeFileSync(proof, originalProof);
      const stale = JSON.stringify({ ...JSON.parse(originalProof.toString()), frame: 0 });
      writeFileSync(proof, stale);
      writeFileSync(
        receipt,
        JSON.stringify({ ...JSON.parse(originalReceipt.toString()), nativeSha256: digest(stale) }),
      );
      await assert.rejects(captureBakedBlender(scene, options), /frame\/count/);
      writeFileSync(proof, originalProof);
      writeFileSync(receipt, originalReceipt);
      writeFileSync(
        path.join(artifacts, "acceptance.json"),
        JSON.stringify(
          {
            version: 1,
            actual: true,
            sourceCommit: process.env.AGENTBROS_ROTATIONAL_SOURCE_COMMIT,
            providerSpendUsd: 0,
            scene,
            first,
            cached,
            random,
            video,
            probe,
            bakeSha256: baked.sha256,
            nativeTransforms: manifest.nativeTransforms,
            limits: [
              "ideal solid sphere numerical native orientation, not textured rolling pixel proof",
              "owned discrete solver, not native Blender dynamics/GPU/creative acceptance",
              "11 newly rendered tiny frames plus one silent8frame1secondMP4",
            ],
          },
          null,
          2,
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
