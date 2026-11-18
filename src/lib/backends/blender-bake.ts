import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { bakeBlenderScene } from "./blender-scene";
import { ROTATIONAL_SPHERE_SOLVER, verifyRotationalReadback } from "./rotational-sphere-contacts";
import { digest, immutableWrite } from "../jobs/model-artifacts";
import { ensureFfmpeg } from "../cli";
import { inspectAsset } from "../assets/inspect";
import { importAsset } from "../assets/registry";
import type { AssetRightsInput } from "../../types/assets";
const worker = fileURLToPath(new URL("../../../scripts/workers/blender_scene.py", import.meta.url));
function checkedFile(file: string, limit: number, bytes = true): Buffer | string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("File exceeds bounded regular-file contract");
    const hash = createHash("sha256"),
      chunks: Buffer[] = [];
    const buffer = Buffer.alloc(65536);
    let total = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > limit) throw new Error("File size changed beyond bound");
      const part = buffer.subarray(0, count);
      hash.update(part);
      if (bytes) chunks.push(Buffer.from(part));
    }
    if (fstatSync(fd).size !== stat.size || total !== stat.size) throw new Error("File changed during read");
    return bytes ? Buffer.concat(chunks) : hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
export function readBlenderSceneRequest(file: string): unknown {
  return JSON.parse((checkedFile(file, 1024 * 1024) as Buffer).toString("utf8"));
}
function directory(file: string) {
  const absolute = path.resolve(file);
  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  // Cache and output must not traverse symlinks, even in their ancestors.
  for (let current = ancestor; ; current = path.dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error("Symlink directory is forbidden");
    if (path.dirname(current) === current) break;
  }
  mkdirSync(absolute, { recursive: true });
  return absolute;
}
function writeChecked(file: string, bytes: Buffer | string) {
  if (existsSync(file)) checkedFile(file, 32 * 1024 * 1024);
  immutableWrite(file, bytes);
}
export async function runBlenderSceneProcess(executable: string, args: string[], timeoutMs: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "LANG"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
      ),
    });
    let stdout = "",
      length = 0;
    let failure: Error | undefined;
    const kill = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
    };
    const timer = setTimeout(() => {
      failure = new Error("Blender worker timeout");
      kill();
    }, timeoutMs);
    child.stdout.on("data", (data: Buffer) => {
      length += data.length;
      if (length > 8 * 1024 * 1024) {
        failure = new Error("Blender worker output limit exceeded");
        kill();
      } else stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      length += data.length;
      if (length > 8 * 1024 * 1024) {
        failure = new Error("Blender worker output limit exceeded");
        kill();
      }
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      kill();
      if (failure || code !== 0) reject(failure ?? new Error(`Blender worker failed (${code})`));
      else resolve(stdout);
    });
  });
}
function png(file: string, width: number, height: number) {
  const bytes = checkedFile(file, 32 * 1024 * 1024) as Buffer;
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  )
    throw new Error("Invalid cached/rendered PNG dimensions or signature");
  const inspected = inspectAsset(file);
  if (inspected.kind !== "image" || inspected.media.width !== width || inspected.media.height !== height)
    throw new Error("PNG decode validation failed");
  return { bytes, sha256: digest(bytes) };
}
/** Trusted administrator executable only; scene requests cannot select code, .blend or files. */
export async function captureBakedBlender(
  input: unknown,
  options: { executable: string; cacheDirectory: string; outputDirectory: string; timeoutMs?: number },
) {
  const started = performance.now();
  const bake = bakeBlenderScene(input);
  const timeoutMs = options.timeoutMs ?? 180000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000)
    throw new Error("Timeout must be 100–600000ms");
  let executable: string;
  let versionOutput: string;
  try {
    executable = realpathSync(options.executable);
    versionOutput = await runBlenderSceneProcess(executable, ["--version"], Math.min(timeoutMs, 30000));
  } catch {
    return {
      state: "unavailable" as const,
      outputs: [],
      reason: "Trusted local Blender executable unavailable; no installation or fallback attempted",
    };
  }
  const version = versionOutput.match(/Blender (\d+\.\d+\.\d+)/)?.[1];
  if (version !== "4.5.14")
    return {
      state: "unavailable" as const,
      outputs: [],
      reason: "Baked scene worker currently accepts verified Blender 4.5.14 only",
      version,
    };
  const pins = {
    executableSha256: checkedFile(executable, 1024 * 1024 * 1024, false) as string,
    version,
    versionProbeSha256: digest(versionOutput),
    workerSha256: checkedFile(worker, 1024 * 1024, false) as string,
    bakeImplementationSha256: checkedFile(
      fileURLToPath(new URL("./blender-scene.ts", import.meta.url)),
      1024 * 1024,
      false,
    ) as string,
    sphereImplementationSha256: checkedFile(
      fileURLToPath(new URL("./sphere-contacts.ts", import.meta.url)),
      1024 * 1024,
      false,
    ) as string,
    ...(bake.scene.physics?.solver === ROTATIONAL_SPHERE_SOLVER
      ? {
          rotationalSphereImplementationSha256: checkedFile(
            fileURLToPath(new URL("./rotational-sphere-contacts.ts", import.meta.url)),
            1024 * 1024,
            false,
          ) as string,
        }
      : {}),
    captureImplementationSha256: checkedFile(fileURLToPath(import.meta.url), 1024 * 1024, false) as string,
  };
  const { frames, ...sceneDefinition } = bake.scene;
  const key = digest(JSON.stringify({ scene: sceneDefinition, bakeSha256: bake.sha256, pins }));
  const cache = directory(path.join(options.cacheDirectory, key));
  const output = directory(options.outputDirectory);
  const lock = path.join(cache, ".lock");
  const lockFd = openSync(lock, "wx", 0o600);
  const temporary = mkdtempSync(path.join(tmpdir(), "avc-baked-blender-"));
  try {
    const bakeBytes = JSON.stringify(bake.data);
    const bakePath = path.join(cache, "bake.json");
    if (existsSync(bakePath) && digest(checkedFile(bakePath, 32 * 1024 * 1024) as Buffer) !== bake.sha256)
      throw new Error("Cached bake checksum mismatch");
    writeChecked(bakePath, bakeBytes);
    const rotational = bake.scene.physics?.solver === ROTATIONAL_SPHERE_SOLVER;
    const native = new Map<number, { bytes: Buffer; sha256: string }>();
    const readNative = (file: string, frame: number) => {
      const bytes = checkedFile(file, 32768) as Buffer;
      verifyRotationalReadback(JSON.parse(bytes.toString("utf8")), bake.data.states[frame]!);
      return { bytes, sha256: digest(bytes) };
    };
    const missing: number[] = [];
    const cached = new Map<number, { sha256: string; bytes: Buffer }>();
    for (const frame of frames) {
      const file = path.join(cache, `frame-${String(frame).padStart(6, "0")}.png`),
        receipt = `${file}.json`;
      if (existsSync(file) || existsSync(receipt)) {
        if (!existsSync(file) || !existsSync(receipt))
          throw new Error("Incomplete cached frame; use a fresh cache directory for recovery");
        const record = JSON.parse((checkedFile(receipt, 4096) as Buffer).toString()) as {
          key: string;
          frame: number;
          sha256: string;
          nativeSha256?: string;
        };
        if (rotational) {
          const proof = readNative(path.join(cache, `frame-${String(frame).padStart(6, "0")}.rotation.json`), frame);
          if (record.nativeSha256 !== proof.sha256)
            throw new Error("Cached native rotational readback checksum mismatch");
          native.set(frame, proof);
        }
        const checked = png(file, bake.scene.width, bake.scene.height);
        if (record.key !== key || record.frame !== frame || record.sha256 !== checked.sha256)
          throw new Error("Cached frame checksum/pins mismatch");
        cached.set(frame, checked);
      } else missing.push(frame);
    }
    if (missing.length) {
      const requestFile = path.join(temporary, "request.json");
      writeFileSync(
        requestFile,
        JSON.stringify({
          scene: bake.scene,
          states: missing.map((frame) => bake.data.states[frame]),
          directory: temporary,
        }),
        { flag: "wx" },
      );
      await runBlenderSceneProcess(
        executable,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--threads",
          "2",
          "--python",
          worker,
          "--",
          requestFile,
        ],
        timeoutMs,
      );
      if (
        checkedFile(executable, 1024 * 1024 * 1024, false) !== pins.executableSha256 ||
        checkedFile(worker, 1024 * 1024, false) !== pins.workerSha256
      )
        throw new Error("Runtime or worker changed during capture");
      for (const frame of missing) {
        const name = `frame-${String(frame).padStart(6, "0")}.png`;
        const checked = png(path.join(temporary, name), bake.scene.width, bake.scene.height);
        if (rotational) {
          const proof = readNative(
            path.join(temporary, `frame-${String(frame).padStart(6, "0")}.rotation.json`),
            frame,
          );
          writeChecked(path.join(cache, `frame-${String(frame).padStart(6, "0")}.rotation.json`), proof.bytes);
          native.set(frame, proof);
        }
        writeChecked(path.join(cache, name), checked.bytes);
        writeChecked(
          path.join(cache, `${name}.json`),
          JSON.stringify({
            key,
            frame,
            sha256: checked.sha256,
            ...(rotational ? { nativeSha256: native.get(frame)!.sha256 } : {}),
          }),
        );
        cached.set(frame, checked);
      }
    }
    const sequence = [...frames]
      .sort((a, b) => a - b)
      .map((frame) => {
        const checked = cached.get(frame)!;
        const file = path.join(output, `${key}-frame-${String(frame).padStart(6, "0")}.png`);
        writeChecked(file, checked.bytes);
        return { frame, path: file, sha256: checked.sha256 };
      });
    const nativeTransforms = rotational
      ? [...frames]
          .sort((a, b) => a - b)
          .map((frame) => {
            const proof = native.get(frame)!;
            const file = path.join(output, `${key}-frame-${String(frame).padStart(6, "0")}.rotation.json`);
            writeChecked(file, proof.bytes);
            return { frame, path: file, sha256: proof.sha256 };
          })
      : undefined;
    const publishedBake = path.join(output, `${key}.bake.json`);
    writeChecked(publishedBake, bakeBytes);
    const manifest = {
      version: 1,
      scene: sceneDefinition,
      bake: publishedBake,
      solver: bake.data.solver,
      backend: "blender-bake",
      state: "candidate",
      key,
      pins,
      bakeSha256: bake.sha256,
      fps: bake.scene.fps,
      durationFrames: bake.scene.durationFrames,
      sequence,
      ...(nativeTransforms ? { nativeTransforms } : {}),
      contiguous: sequence.length === bake.scene.durationFrames && sequence.every((f, i) => f.frame === i),
      billing: { kind: "local", providerSpendUsd: 0 },
      rights: "owned-procedural-geometry-user-material-colors",
      reviewRequired: true,
      limitations:
        bake.scene.physics?.solver === ROTATIONAL_SPHERE_SOLVER
          ? [
              "owned-discrete-solid-sphere-angular-contacts",
              "ideal-isotropic-inertia",
              "no-rolling-resistance",
              "decorative-non-collider-primitives",
              "no-kinematic-or-mesh-collisions",
              "no-arbitrary-blend-or-python",
              "no-cross-version-pixel-equivalence",
            ]
          : bake.scene.physics
            ? [
                "owned-translational-sphere-contacts-only",
                "sliding-not-rolling-friction",
                "decorative-non-collider-primitives",
                "no-kinematic-or-mesh-collisions",
                "no-arbitrary-blend-or-python",
                "no-cross-version-pixel-equivalence",
              ]
            : [
                "owned-floor-solver-only",
                "no-inter-body-collision",
                "no-arbitrary-blend-or-python",
                "no-cross-version-pixel-equivalence",
              ],
    };
    const manifestPath = path.join(
      output,
      `${key}-${digest(JSON.stringify(frames.slice().sort((a, b) => a - b))).slice(0, 16)}.sequence.json`,
    );
    const manifestBytes = JSON.stringify(manifest, null, 2);
    writeChecked(manifestPath, manifestBytes);
    return {
      state: "candidate" as const,
      outputs: [
        ...sequence.map((f) => f.path),
        ...(nativeTransforms?.map((f) => f.path) ?? []),
        publishedBake,
        manifestPath,
      ],
      manifest: manifestPath,
      manifestSha256: digest(manifestBytes),
      key,
      renderedFrames: missing.length,
      cacheHits: frames.length - missing.length,
      elapsedMs: Math.round(performance.now() - started),
      sequence,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    closeSync(lockFd);
    rmSync(lock);
  }
}

type PublishedSequence = {
  key: string;
  fps: number;
  durationFrames: number;
  sequence: { frame: number; path: string; sha256: string }[];
  contiguous: boolean;
};
function checkedManifest(result: {
  manifest: string;
  manifestSha256: string;
  key: string;
  sequence: PublishedSequence["sequence"];
}): PublishedSequence {
  const bytes = checkedFile(result.manifest, 1024 * 1024) as Buffer;
  if (digest(bytes) !== result.manifestSha256) throw new Error("Published manifest checksum changed");
  const manifest = JSON.parse(bytes.toString()) as PublishedSequence;
  if (manifest.key !== result.key || JSON.stringify(manifest.sequence) !== JSON.stringify(result.sequence))
    throw new Error("Published manifest capture pins mismatch");
  return manifest;
}

/** Explicit import of already checked candidate originals. Rights remain user-supplied/unknown. */
export function importBakedBlenderFrames(
  result: Extract<Awaited<ReturnType<typeof captureBakedBlender>>, { state: "candidate" }>,
  projectId: string,
  options: { rootDir?: string; rights?: AssetRightsInput } = {},
) {
  checkedManifest(result);
  for (const frame of result.sequence)
    if (digest(checkedFile(frame.path, 32 * 1024 * 1024) as Buffer) !== frame.sha256)
      throw new Error("Published frame checksum changed before import");
  return result.sequence.map((frame) => ({
    frame: frame.frame,
    ...importAsset({
      projectId,
      sourceFile: frame.path,
      rootDir: options.rootDir,
      rights: options.rights,
      provenance: {
        origin: "manual",
        tool: "avc-blender-bake",
        model: "Blender 4.5.14",
        generationJobId: result.key,
        billing: { status: "reported", apiUsd: 0, source: `${result.manifest} (sha256:${result.manifestSha256})` },
      },
    }),
  }));
}

/** A complete bounded sequence can be encoded as a silent local video for normal timeline use. */
export async function encodeBakedBlenderVideo(
  result: Extract<Awaited<ReturnType<typeof captureBakedBlender>>, { state: "candidate" }>,
  outputDirectory: string,
) {
  const manifest = checkedManifest(result);
  if (
    manifest.key !== result.key ||
    !manifest.contiguous ||
    manifest.sequence.length !== manifest.durationFrames ||
    manifest.durationFrames > 120 ||
    JSON.stringify(manifest.sequence) !== JSON.stringify(result.sequence)
  )
    throw new Error("Video encoding requires a pinned contiguous complete sequence of at most 120 frames");
  ensureFfmpeg();
  const ffmpegVersion = await runBlenderSceneProcess("ffmpeg", ["-version"], 30000);
  const temporary = mkdtempSync(path.join(tmpdir(), "avc-bake-video-"));
  const target = path.join(directory(outputDirectory), `${result.key}-${digest(ffmpegVersion).slice(0, 16)}.mp4`);
  const receipt = `${target}.json`;
  try {
    for (const frame of result.sequence) {
      const bytes = checkedFile(frame.path, 32 * 1024 * 1024) as Buffer;
      if (digest(bytes) !== frame.sha256) throw new Error("Sequence frame changed before encoding");
      if (bytes.readUInt32BE(16) % 2 || bytes.readUInt32BE(20) % 2)
        throw new Error("H264 video requires even dimensions");
      writeFileSync(path.join(temporary, `frame-${String(frame.frame).padStart(6, "0")}.png`), bytes, { flag: "wx" });
    }
    if (existsSync(target) || existsSync(receipt)) {
      if (!existsSync(target) || !existsSync(receipt)) throw new Error("Incomplete encoded video");
      const record = JSON.parse((checkedFile(receipt, 4096) as Buffer).toString()) as {
        key: string;
        sha256: string;
        sourceManifestSha256: string;
      };
      if (
        record.sourceManifestSha256 !== result.manifestSha256 ||
        record.key !== result.key ||
        digest(checkedFile(target, 128 * 1024 * 1024) as Buffer) !== record.sha256
      )
        throw new Error("Encoded video checksum mismatch");
      return { path: target, sha256: record.sha256, cacheHit: true };
    }
    const video = path.join(temporary, "sequence.mp4");
    await runBlenderSceneProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-framerate",
        String(manifest.fps),
        "-i",
        path.join(temporary, "frame-%06d.png"),
        "-frames:v",
        String(manifest.durationFrames),
        "-an",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        video,
      ],
      180000,
    );
    const inspected = inspectAsset(video);
    if (
      inspected.kind !== "video" ||
      inspected.media.hasAudio ||
      Math.abs(inspected.media.durationSec! - manifest.durationFrames / manifest.fps) > 1 / manifest.fps
    )
      throw new Error("Encoded sequence duration/audio validation failed");
    const bytes = checkedFile(video, 128 * 1024 * 1024) as Buffer;
    const sha256 = digest(bytes);
    writeChecked(target, bytes);
    writeChecked(
      receipt,
      JSON.stringify({
        key: result.key,
        sha256,
        sourceManifest: result.manifest,
        sourceManifestSha256: result.manifestSha256,
        silent: true,
      }),
    );
    return { path: target, sha256, cacheHit: false };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
