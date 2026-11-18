import { snapshotInstanceFile } from "./native-composition-instances-files";
import {
  isInstanceExecutionProfile,
  resolveInstancesPin,
  verifyInstanceExecutionProfile,
} from "./native-composition-instances-profile";
import { HYPERFRAMES_TREE_PIN } from "./native-composition-tree-prelude";
import { NativePreparationOwnership } from "./native-process-ownership";
import { verifyNativeNormalizationReceipt, verifyNativePreparedMedia } from "./native-media-preparation";
import { HYPERFRAMES_MEDIA_PIN } from "./hyperframes-player-media";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { ensureFfmpeg, ensureFfprobe } from "../cli";
import { digest } from "../jobs/model-artifacts";
import { HtmlCaptureSchema, type HtmlWorkerRequest } from "./html-types";
import { HYPERFRAMES_PLAYER_PIN } from "./hyperframes-player";
export { HtmlCaptureSchema } from "./html-types";
const MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".css": "text/css",
};
function within(root: string, file: string) {
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("HTML path escapes asset root");
}
/** Reject every lexical symlink component, except exact standard macOS aliases. */
function rejectSymlinkParents(file: string) {
  let part = path.resolve(file);
  for (;;) {
    if (existsSync(part) && lstatSync(part).isSymbolicLink()) {
      const systemAlias =
        process.platform === "darwin" &&
        ((part === "/var" && realpathSync(part) === "/private/var") ||
          (part === "/tmp" && realpathSync(part) === "/private/tmp"));
      if (!systemAlias) throw new Error("Symlink path components are forbidden");
    }
    const parent = path.dirname(part);
    if (parent === part) break;
    part = parent;
  }
}
function regularFileSize(file: string, limit: number, message: string) {
  const metadata = statSync(file);
  if (!metadata.isFile()) throw new Error("HTML inputs must be regular files");
  if (metadata.size > limit) throw new Error(message);
  return metadata.size;
}
const implementationFiles = {
  capture: "./html.ts",
  types: "./html-types.ts",
  worker: "../../../scripts/workers/html-capture.ts",
  timing: "./html-timing.ts",
  audio: "./html-audio.ts",
  player: "./hyperframes-player.ts",
  tree: "./native-composition-tree.ts",
  treePrelude: "./native-composition-tree-prelude.ts",
  instanceGraph: "./native-composition-instances.ts",
  instanceScript: "./native-instance-script.ts",
  instanceExtract: "./native-composition-instances-extract.ts",
  instancePrelude: "./native-composition-instances-prelude.ts",
  instanceFiles: "./native-composition-instances-files.ts",
  instanceReceipt: "./native-composition-instances-receipt.ts",
  instanceBuildReceipt: "../../../tests/fixtures/hyperframes-engine/instances-selection-provenance.json",
  instanceProduct: "./native-composition-instances-product.ts",
  instanceProductDescriptor: "../../../tests/fixtures/hyperframes-engine/instances-selection-product-v1.json",
  instanceBuildRecipe: "../../../tests/fixtures/hyperframes-engine/prepare-instances-selection.cjs",
  instanceSelectionContract: "../../../tests/fixtures/hyperframes-engine/instances-selection-contract.json",
  instanceProfile: "./native-composition-instances-profile.ts",
  instanceScriptHostProduct: "./native-composition-instances-script-host-product.ts",
  instanceScriptHostDescriptor: "../../../tests/fixtures/hyperframes-engine/instances-script-host-product-v1.json",
  instanceScriptHostReceipt: "../../../tests/fixtures/hyperframes-engine/instances-script-host-provenance.json",
  instanceScriptHostRecipe: "../../../tests/fixtures/hyperframes-engine/prepare-instances-script-host.cjs",
  instanceScriptHostContract: "../../../tests/fixtures/hyperframes-engine/instances-script-host-contract.json",
  playerMedia: "./hyperframes-player-media.ts",
  playerMediaProbe: "./hyperframes-media-probe.ts",
  nativeNormalization: "./native-media-normalization.ts",
  nativePreparation: "./native-media-preparation.ts",
  nativeFiles: "./native-media-files.ts",
  nativeOwnership: "./native-process-ownership.ts",
  nativeCancellation: "./native-request-cancellation.ts",
  nativeWorker: "../../../scripts/workers/native-media-preparation.ts",
  boundedWorker: "../longform/bounded-worker.ts",
} as const;
function implementationFingerprint() {
  return {
    version: 2,
    sources: Object.fromEntries(
      Object.entries(implementationFiles).map(([name, relative]) => {
        const file = fileURLToPath(new URL(relative, import.meta.url));
        regularFileSize(file, 256 * 1024, "HTML implementation source exceeds bounds");
        return [name, digest(readFileSync(file))];
      }),
    ),
  };
}
/** Executes HTML browser code only; never imports a project module into Node. */
export async function captureHtml(
  input: unknown,
  outputDirectory: string,
  options: { signal?: AbortSignal; onOwnedBrowser?: (pid: number) => void } = {},
) {
  const request = HtmlCaptureSchema.parse(input);
  if (request.playerRuntime?.normalization && process.platform !== "darwin")
    throw Error("Native normalization OS deny-network unavailable on this host");
  const implementation = implementationFingerprint();
  if (options.signal?.aborted) throw new Error("HTML capture cancelled");
  if (request.encode === "mp4" || request.assets.some((file) => /\.(mp4|webm)$/i.test(file))) ensureFfmpeg();
  if (request.encode === "mp4") ensureFfprobe();
  rejectSymlinkParents(request.assetRoot);
  rejectSymlinkParents(request.htmlFile);
  const lexicalRoot = path.resolve(request.assetRoot),
    root = realpathSync(lexicalRoot),
    htmlFile = realpathSync(request.htmlFile);
  within(lexicalRoot, path.resolve(request.htmlFile));
  within(root, htmlFile);
  if (lstatSync(request.htmlFile).isSymbolicLink()) throw new Error("Symlink HTML is forbidden");
  regularFileSize(htmlFile, 1024 * 1024, "HTML exceeds 1MiB");
  const instanceProfile = isInstanceExecutionProfile(request.playerRuntime?.compositionProfile)
    ? request.playerRuntime!.compositionProfile
    : undefined;
  const instanceInput = instanceProfile !== undefined;
  if (instanceProfile) verifyInstanceExecutionProfile(instanceProfile);
  const instancePin = instanceProfile ? resolveInstancesPin(instanceProfile) : undefined;
  const rawHtml = instanceInput ? snapshotInstanceFile(htmlFile, root, 1024 * 1024).data : undefined;
  const html = rawHtml ? rawHtml.toString("utf8") : readFileSync(htmlFile, "utf8");
  if (rawHtml && digest(rawHtml) !== digest(html)) throw Error("Instance root UTF-8 differs from original bytes");
  if (Buffer.byteLength(html) > 1024 * 1024) throw new Error("HTML exceeds 1MiB");
  rejectSymlinkParents(outputDirectory);
  const requestedOutput = path.resolve(outputDirectory);
  let ancestor = requestedOutput;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const output = path.join(realpathSync(ancestor), path.relative(ancestor, requestedOutput));
  const createdStaging = mkdtempSync(path.join(tmpdir(), "avc-html-"));
  const staging = instanceInput ? realpathSync(createdStaging) : createdStaging;
  const stagingBirth = instanceInput ? lstatSync(staging) : undefined;
  const stagingMatches = () => {
    try {
      const current = lstatSync(staging);
      return (
        current.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === stagingBirth!.dev &&
        current.ino === stagingBirth!.ino &&
        realpathSync(staging) === staging
      );
    } catch {
      return false;
    }
  };
  const assertStaging = () => {
    if (instanceInput && !stagingMatches()) throw Error("Instance staging directory identity changed");
  };
  const assets: HtmlWorkerRequest["assetMap"] = {};
  let total = 0;
  try {
    for (const name of request.assets) {
      if (
        name.includes("\\") ||
        name.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) ||
        path.isAbsolute(name)
      )
        throw new Error("Unsafe asset allowlist path");
      const file = path.resolve(root, name);
      rejectSymlinkParents(file);
      within(root, file);
      within(root, realpathSync(file));
      let part = file;
      while (part !== root) {
        if (lstatSync(part).isSymbolicLink()) throw new Error("Symlink assets are forbidden");
        part = path.dirname(part);
      }
      const mime = MIME[path.extname(file).toLowerCase()];
      const nativeScript =
        ["hyperframes-frame-adapter", "hyperframes-player"].includes(request.protocol) &&
        path.extname(file).toLowerCase() === ".js";
      const nativeHtml = request.protocol === "hyperframes-player" && path.extname(file).toLowerCase() === ".html";
      if (!mime && !nativeScript && !nativeHtml) throw new Error("Unsupported allowlisted asset type");
      const size = regularFileSize(file, 32 * 1024 * 1024, "HTML asset snapshot exceeds limits");
      if (total + size > 64 * 1024 * 1024) throw new Error("HTML asset snapshot exceeds limits");
      const bytes = instanceInput ? snapshotInstanceFile(file, root, 32 * 1024 * 1024).data : readFileSync(file);
      if (
        (mime === "image/png" && bytes.includes(Buffer.from("acTL"))) ||
        (mime === "image/webp" && bytes.includes(Buffer.from("ANIM"))) ||
        (mime === "image/svg+xml" && /<(?:script|animate\w*|set|foreignObject)\b/i.test(bytes.toString("utf8")))
      )
        throw new Error("Only static image assets are supported");
      total += bytes.length;
      if (bytes.length > 32 * 1024 * 1024 || total > 64 * 1024 * 1024)
        throw new Error("HTML asset snapshot exceeds limits");
      const target = path.join(staging, "assets", String(Object.keys(assets).length) + path.extname(file));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      assets[name] = {
        path: target,
        sha256: digest(bytes),
        mime: mime ?? (nativeHtml ? "text/html" : "text/javascript"),
      };
    }
    if (request.playerRuntime) {
      if (
        assets[request.playerRuntime.runtimeAsset].sha256 !==
          (instancePin
            ? instancePin.runtimeSha256
            : request.playerRuntime.compositionProfile === "static-local-tree-v1"
              ? HYPERFRAMES_TREE_PIN.runtimeSha256
              : request.playerRuntime.mediaProfile
                ? HYPERFRAMES_MEDIA_PIN.runtimeSha256
                : HYPERFRAMES_PLAYER_PIN.runtimeSha256) ||
        assets[request.playerRuntime.gsapAsset].sha256 !== HYPERFRAMES_PLAYER_PIN.gsapSha256
      )
        throw Error("Full player runtime snapshot differs from audited pin");
    }
    const workerRequest: HtmlWorkerRequest = {
      ...request,
      ownershipToken: randomUUID(),
      html,
      directory: staging,
      assetMap: assets,
    };
    const requestFile = path.join(staging, "request.json");
    writeFileSync(requestFile, JSON.stringify(workerRequest));
    await new Promise<void>((resolve, reject) => {
      const worker = fileURLToPath(new URL("../../../scripts/workers/html-capture.ts", import.meta.url));
      const child = spawn(
        process.execPath,
        [
          "--max-old-space-size=256",
          "--import",
          fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
          worker,
          requestFile,
        ],
        {
          detached: process.platform !== "win32",
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          env: { PATH: process.env.PATH ?? "", HOME: staging, TMPDIR: staging },
        },
      );
      let stderr = "",
        settled = false,
        stoppingError: Error | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const browsers = new Set<number>();
      const nativeOwnership = new NativePreparationOwnership();
      const nativeWatch = setInterval(() => {
        try {
          nativeOwnership.capture();
        } catch (e) {
          stop(e instanceof Error ? e : Error(String(e)));
        }
      }, 250);
      const killNative = () => {
        try {
          nativeOwnership.kill();
        } catch (error) {
          stoppingError ??= Error("Native owned process cleanup incomplete: " + String(error));
        }
      };
      const killOwnedBrowsers = () => {
        for (const pid of browsers) {
          try {
            if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
            else execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 2000, stdio: "ignore" });
          } catch {}
        }
      };
      const killWorker = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {}
      };
      const stop = (reason: Error) => {
        if (settled || stoppingError) return;
        stoppingError = reason;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        // Chromium is detached by Remotion: the worker group alone is insufficient.
        killOwnedBrowsers();
        killNative();
        killWorker("SIGTERM");
        forceTimer = setTimeout(() => {
          killOwnedBrowsers();
          killNative();
          killWorker("SIGKILL");
        }, 1000);
      };
      const timeout = setTimeout(() => stop(new Error("HTML capture timeout")), request.timeoutMs);
      const abort = () => stop(new Error("HTML capture cancelled"));
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(nativeWatch);
        clearTimeout(forceTimer);
        options.signal?.removeEventListener("abort", abort);
      };
      child.on("message", (message: unknown) => {
        const event = message as { token?: unknown; type?: unknown; pid?: unknown; owner?: unknown };
        if (
          !event ||
          event.token !== workerRequest.ownershipToken ||
          event.owner !== child.pid ||
          typeof event.pid !== "number" ||
          !Number.isSafeInteger(event.pid) ||
          event.pid <= 1 ||
          event.pid === child.pid
        )
          return;
        if (event.type === "html-native-preparation-owned") {
          try {
            nativeOwnership.register(event.pid, child.pid!);
            if (stoppingError) killNative();
            else
              child.send({
                type: "html-native-preparation-registered",
                pid: event.pid,
                token: workerRequest.ownershipToken,
              });
          } catch (error) {
            stop(error instanceof Error ? error : Error(String(error)));
          }
        } else if (event.type === "html-browser-owned") {
          browsers.add(event.pid);
          if (stoppingError) killOwnedBrowsers();
          else {
            try {
              options.onOwnedBrowser?.(event.pid);
            } catch (error) {
              stop(error instanceof Error ? error : new Error(String(error)));
            }
          }
        } else if (event.type === "html-browser-exited") browsers.delete(event.pid);
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stderr!.on("data", (data) => {
        stderr = (stderr + String(data)).slice(-4000);
      });
      child.once("error", stop);
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        killOwnedBrowsers();
        killNative();
        cleanup();
        if (stoppingError) reject(stoppingError);
        else if (code === 0) resolve();
        else reject(new Error("HTML worker failed: " + stderr));
      });
      if (options.signal?.aborted) abort();
    });
    if (JSON.stringify(implementationFingerprint()) !== JSON.stringify(implementation))
      throw new Error("HTML implementation changed during capture");
    const provenance = {
      implementation,
      htmlSha256: digest(html),
      assets: Object.fromEntries(Object.entries(assets).map(([name, a]) => [name, { sha256: a.sha256, mime: a.mime }])),
    };
    const identity = digest(
      JSON.stringify({
        request: {
          protocol: request.protocol,
          ...(request.playerRuntime?.compositionProfile
            ? { compositionProfile: request.playerRuntime.compositionProfile }
            : {}),
          encode: request.encode,
          width: request.width,
          height: request.height,
          fps: request.fps,
          frames: request.frames,
          ...(request.timing ? { timing: request.timing } : {}),
        },
        provenance,
      }),
    );
    const target = path.join(output, identity);
    if (existsSync(target) && lstatSync(target).isSymbolicLink())
      throw new Error("Capture publication cannot be a symlink");
    assertStaging();
    const workerMetadata = JSON.parse(readFileSync(path.join(staging, "worker.json"), "utf8"));
    const capturedInstanceFrames = instanceInput ? new Map<number, Buffer>() : undefined;
    let capturedFrameBytes = 0;
    const frames = request.frames.map((frame) => {
      const file = path.join(staging, `frame-${frame}.png`);
      const size = regularFileSize(file, 32 * 1024 * 1024, "HTML asset snapshot exceeds limits");
      if (total + capturedFrameBytes + size > 64 * 1024 * 1024) throw new Error("HTML asset snapshot exceeds limits");
      assertStaging();
      const bytes = instanceInput ? snapshotInstanceFile(file, staging, 32 * 1024 * 1024).data : readFileSync(file);
      assertStaging();
      if (bytes.length !== size) throw Error("HTML generated frame size changed after admission");
      if (total + capturedFrameBytes + bytes.length > 64 * 1024 * 1024)
        throw Error("HTML asset snapshot exceeds limits");
      capturedFrameBytes += bytes.length;
      if (
        bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        bytes.readUInt32BE(16) !== request.width ||
        bytes.readUInt32BE(20) !== request.height
      )
        throw new Error("Invalid captured PNG");
      capturedInstanceFrames?.set(frame, bytes);
      return {
        frame,
        path: path.join(target, `frame-${frame}.png`),
        sha256: digest(bytes),
      };
    });
    const video =
      request.encode === "mp4"
        ? {
            path: path.join(target, "video.mp4"),
            sha256: digest(readFileSync(path.join(staging, "video.mp4"))),
            ...workerMetadata.video,
          }
        : undefined;
    if (request.playerRuntime?.normalization)
      verifyNativeNormalizationReceipt(
        workerMetadata.nativeMediaSources,
        staging,
        workerMetadata.nativeNormalizationReceipt,
      );
    if (instanceProfile) verifyInstanceExecutionProfile(instanceProfile);
    if (instanceProfile && JSON.stringify(workerMetadata.nativeInstancesPin) !== JSON.stringify(instancePin))
      throw Error("Instance worker execution authority differs");
    const manifest = {
      ...(video ? { video } : {}),
      version: 1,
      backend: "html-seek-v1",
      protocol: workerMetadata.protocol,
      viewport: { width: request.width, height: request.height },
      fps: request.fps,
      provenance,
      frames,
      limits: {
        audio: Boolean(workerMetadata.video?.audio),
        timingVersion: request.timing?.version,
        hyperframesEngine: false,
        fullPlayerSubset: request.protocol === "hyperframes-player",
        ...(request.playerRuntime?.compositionProfile === "static-local-tree-v1"
          ? { staticLocalTreeSubset: true }
          : instancePin
            ? { staticLocalInstancesSubset: true }
            : {}),
        ...(request.playerRuntime?.mediaProfile ? { nativeMediaSubset: true } : {}),
        determinism: "same installed Chromium/OS and fonts; fresh-document absolute seek, verified pixel hashes",
      },
      ...(request.playerRuntime?.compositionProfile === "static-local-tree-v1"
        ? { staticCompositionTree: workerMetadata.staticCompositionTree }
        : instancePin
          ? { staticCompositionInstances: workerMetadata.staticCompositionInstances }
          : {}),
      media: workerMetadata.media,
      ...(workerMetadata.nativeAudioDescriptors
        ? {
            nativeAudioDescriptors: workerMetadata.nativeAudioDescriptors,
            nativeMediaSources: workerMetadata.nativeMediaSources,
            nativeRequestCancellations: workerMetadata.nativeRequestCancellations,
          }
        : {}),
      ...(workerMetadata.nativeNormalizationReceipt
        ? { nativeNormalizationReceipt: workerMetadata.nativeNormalizationReceipt }
        : {}),
      ...(request.protocol === "hyperframes-player"
        ? {
            fullPlayerPin: {
              ...HYPERFRAMES_PLAYER_PIN,
              ...(request.playerRuntime?.mediaProfile
                ? {
                    runtimeSha256: instancePin
                      ? instancePin.runtimeSha256
                      : request.playerRuntime.compositionProfile === "static-local-tree-v1"
                        ? HYPERFRAMES_TREE_PIN.runtimeSha256
                        : HYPERFRAMES_MEDIA_PIN.runtimeSha256,
                  }
                : {}),
            },
            ...(request.playerRuntime?.mediaProfile
              ? {
                  nativeMediaPin: {
                    ...HYPERFRAMES_MEDIA_PIN,
                    ...(instancePin
                      ? {
                          runtimeSha256: instancePin.runtimeSha256,
                          baseRuntimeSha256: HYPERFRAMES_MEDIA_PIN.runtimeSha256,
                        }
                      : request.playerRuntime?.compositionProfile === "static-local-tree-v1"
                        ? {
                            runtimeSha256: HYPERFRAMES_TREE_PIN.runtimeSha256,
                            baseRuntimeSha256: HYPERFRAMES_MEDIA_PIN.runtimeSha256,
                          }
                        : {}),
                  },
                  ...(request.playerRuntime?.compositionProfile === "static-local-tree-v1"
                    ? { nativeTreePin: HYPERFRAMES_TREE_PIN }
                    : instancePin
                      ? { nativeInstancesPin: instancePin }
                      : {}),
                }
              : {}),
          }
        : {}),
      ...(workerMetadata.frameAdapters ? { frameAdapters: workerMetadata.frameAdapters } : {}),
      ...(workerMetadata.audio ? { audio: workerMetadata.audio } : {}),
    };
    assertStaging();
    rejectSymlinkParents(output);
    mkdirSync(output, { recursive: true });
    const instanceManifestBytes = instanceInput ? Buffer.from(JSON.stringify(manifest, null, 2), "utf8") : undefined;
    const publication = mkdtempSync(path.join(output, ".html-"));
    try {
      if (request.playerRuntime?.normalization) {
        const sources = verifyNativePreparedMedia(workerMetadata.nativeMediaSources, staging);
        for (const source of Object.values(sources))
          for (const pin of [
            source.normalization.original,
            source.normalization.video?.proxy,
            source.normalization.audio?.pcm,
          ].filter((p) => p !== undefined)) {
            const destination = path.join(publication, pin.path);
            mkdirSync(path.dirname(destination), { recursive: true });
            copyFileSync(path.join(staging, pin.path), destination);
          }
        copyFileSync(
          path.join(staging, "native-preparation/receipt.json"),
          path.join(publication, "native-preparation/receipt.json"),
        );
        verifyNativeNormalizationReceipt(sources, publication, workerMetadata.nativeNormalizationReceipt);
        if (existsSync(target))
          verifyNativeNormalizationReceipt(sources, target, workerMetadata.nativeNormalizationReceipt);
      }
      for (const frame of frames)
        writeFileSync(
          path.join(publication, path.basename(frame.path)),
          capturedInstanceFrames
            ? capturedInstanceFrames.get(frame.frame)!
            : readFileSync(path.join(staging, path.basename(frame.path))),
        );
      if (video) writeFileSync(path.join(publication, "video.mp4"), readFileSync(path.join(staging, "video.mp4")));
      writeFileSync(path.join(publication, "capture.json"), instanceManifestBytes ?? JSON.stringify(manifest, null, 2));
      if (existsSync(target)) {
        if (
          (instanceManifestBytes
            ? !snapshotInstanceFile(
                path.join(target, "capture.json"),
                target,
                instanceManifestBytes.length,
              ).data.equals(instanceManifestBytes)
            : readFileSync(path.join(target, "capture.json"), "utf8") !== JSON.stringify(manifest, null, 2)) ||
          frames.some(
            (f) =>
              digest(
                instanceInput
                  ? snapshotInstanceFile(f.path, target, capturedInstanceFrames!.get(f.frame)!.length).data
                  : readFileSync(f.path),
              ) !== f.sha256,
          ) ||
          (video && digest(readFileSync(video.path)) !== video.sha256)
        )
          throw new Error("Immutable HTML capture conflict");
      } else renameSync(publication, target);
    } finally {
      rmSync(publication, { recursive: true, force: true });
    }
    return {
      state: "published" as const,
      outputs: [...frames.map((f) => f.path), ...(video ? [video.path] : [])],
      manifest: path.join(target, "capture.json"),
      frames,
    };
  } finally {
    // A replaced directory is foreign: preserve primary refusal and do not recursively remove it.
    if (!instanceInput || stagingMatches())
      rmSync(staging, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
  }
}
