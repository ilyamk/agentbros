import { isNativeTransportCancellation } from "../src/lib/backends/native-request-cancellation";
import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  appendFileSync,
  copyFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HtmlCaptureSchema } from "../src/lib/backends/html-types";
import { nativeFilePin, readNativeJson } from "../src/lib/backends/native-media-files";
import { verifyNativePreparedMedia } from "../src/lib/backends/native-media-preparation";
import { runNativeNormalizationTool } from "../src/lib/backends/native-media-normalization";
import { runBoundedRenderWorker } from "../src/lib/longform/bounded-worker";
const enabled = process.env.RUN_NATIVE_NORMALIZATION_TESTS === "1";
test("normalization is explicit and valid only for genuine native media profile", () => {
  const request = {
    htmlFile: "x",
    assetRoot: ".",
    width: 64,
    height: 64,
    frames: [0],
    assets: ["r", "g"],
    protocol: "hyperframes-player",
    playerRuntime: { runtimeAsset: "r", gsapAsset: "g" },
  };
  assert.equal(HtmlCaptureSchema.safeParse(request).success, true);
  assert.equal(
    HtmlCaptureSchema.safeParse({
      ...request,
      playerRuntime: { ...request.playerRuntime, normalization: "decoded-source-proxy-v1" },
    }).success,
    false,
  );
  assert.equal(
    HtmlCaptureSchema.safeParse({
      ...request,
      playerRuntime: {
        ...request.playerRuntime,
        mediaProfile: "native-local-media-v1",
        normalization: "decoded-source-proxy-v1",
      },
    }).success,
    true,
  );
  assert.equal(
    HtmlCaptureSchema.safeParse({
      ...request,
      playerRuntime: { ...request.playerRuntime, mediaProfile: "native-local-media-v1", normalization: "injected" },
    }).success,
    false,
  );
});
test("native descriptor reads refuse FIFO/symlinks/escape/oversize and bounded growing originals", () => {
  const root = fs.realpathSync(mkdtempSync(path.join(tmpdir(), "native-fd-"))),
    file = path.join(root, "receipt.json");
  try {
    writeFileSync(file, '{"ok":true}\n');
    assert.deepEqual(readNativeJson(file, root), { ok: true });
    assert.throws(() => nativeFilePin(file, root, 1));
    assert.throws(() => nativeFilePin(path.join(root, "..", "other"), root));
    const link = path.join(root, "link");
    symlinkSync(file, link);
    assert.throws(() => readNativeJson(link, root), /symlink/);
    if (process.platform !== "win32") {
      const fifo = path.join(root, "fifo");
      execFileSync("mkfifo", [fifo]);
      assert.throws(() => readNativeJson(fifo, root), /regular/);
    }
    const previous = fs.readSync;
    let calls = 0;
    fs.readSync = ((...args: any[]) => {
      const result = (previous as any)(...args);
      if (++calls === 1) appendFileSync(file, "growth");
      return result;
    }) as typeof fs.readSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => nativeFilePin(file, root), /changed/);
      assert.ok(calls <= 2);
    } finally {
      fs.readSync = previous;
      syncBuiltinESMExports();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test(
  "native preparation worker ACK precedes first tool; AAC embedded VFR receipts/proxies and corruption replay",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const root = fs.realpathSync(
      mkdtempSync(path.join(process.env.NATIVE_PREPARATION_ARTIFACTS ?? tmpdir(), "native-production-")),
    );
    let preserve = false;
    try {
      mkdirSync(path.join(root, "assets"));
      const video = path.join(root, "base.mp4"),
        audio = path.join(root, "base.m4a"),
        source = path.join(root, "assets/0.mp4");
      const ff = (args: string[], file: string) =>
        runNativeNormalizationTool("ffmpeg", ["-v", "error", "-threads", "1", ...args], { outputFile: file });
      await ff(
        [
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=64x64:rate=30:duration=3",
          "-vf",
          "select=eq(n\\,0)+eq(n\\,1)+eq(n\\,4)+eq(n\\,9)+eq(n\\,19)+eq(n\\,29)+eq(n\\,59)+eq(n\\,69)+eq(n\\,89)",
          "-fps_mode",
          "vfr",
          "-c:v",
          "libx264",
          "-bf",
          "0",
          video,
        ],
        video,
      );
      await ff(["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=3", "-c:a", "aac", audio], audio);
      await ff(
        [
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          video,
          "-i",
          audio,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c",
          "copy",
          source,
        ],
        source,
      );
      copyFileSync(audio, path.join(root, "assets/1.m4a"));
      const isolated = path.join(root, "assets/1.m4a");
      const request = {
        directory: root,
        assetMap: {
          "source.mp4": { path: source, sha256: nativeFilePin(source, root).sha256, mime: "video/mp4" },
          "music.m4a": { path: isolated, sha256: nativeFilePin(isolated, root).sha256, mime: "audio/mp4" },
        },
      };
      const file = path.join(root, "request.json");
      writeFileSync(file, JSON.stringify(request));
      let activated = false;
      await runBoundedRenderWorker(
        process.execPath,
        [
          "--import",
          path.resolve("node_modules/tsx/dist/loader.mjs"),
          path.resolve("scripts/workers/native-media-preparation.ts"),
          file,
        ],
        root,
        {
          timeoutMs: 10000,
          stallTimeoutMs: 10000,
          onRegisteredRoot: async () => {
            assert.equal(
              fs.existsSync(path.join(root, "native-preparation")),
              false,
              "No preparation side effect before trusted ACK",
            );
            await new Promise((r) => setTimeout(r, 30));
            activated = true;
          },
        },
      );
      assert.equal(activated, true);
      const receipt = readNativeJson(path.join(root, "native-preparation/receipt.json"), root),
        sources = verifyNativePreparedMedia(receipt, root),
        s = sources["source.mp4"];
      assert.equal(s.durationSec, 3);
      assert.equal(s.normalization.video?.frameCount, 9);
      assert.equal(s.normalization.audio?.outputSamples, 144000);
      assert.equal(sources["music.m4a"].kind, "audio");
      assert.equal(sources["music.m4a"].normalization.audio?.outputSamples, 144000);
      assert.deepEqual(
        readFileSync(path.join(root, s.normalization.audio!.pcm.path)),
        readFileSync(path.join(root, sources["music.m4a"].normalization.audio!.pcm.path)),
        "Standalone and embedded identical AAC preserve identical decoded PCM",
      );
      const bad = structuredClone(receipt);
      bad["source.mp4"].normalization.video.clock.pts[1] += 1;
      assert.throws(() => verifyNativePreparedMedia(bad, root), /mapping/);
      bad["source.mp4"].normalization.video.clockHash = "0".repeat(64);
      assert.throws(() => verifyNativePreparedMedia(bad, root));
      const pcm = path.join(root, s.normalization.audio!.pcm.path),
        original = readFileSync(pcm);
      appendFileSync(pcm, "changed");
      assert.throws(() => verifyNativePreparedMedia(receipt, root), /receipt/);
      writeFileSync(pcm, original);
      const proxy = path.join(root, s.normalization.video!.proxy.path),
        bytes = readFileSync(proxy);
      unlinkSync(proxy);
      symlinkSync(pcm, proxy);
      assert.throws(() => verifyNativePreparedMedia(receipt, root), /symlink/);
      unlinkSync(proxy);
      writeFileSync(proxy, bytes);
      verifyNativePreparedMedia(receipt, root);
      writeFileSync(
        path.join(root, "acceptance.json"),
        JSON.stringify(
          {
            sources,
            ackBeforeFirstTool: true,
            corruptionRejected: true,
            limits: "3s64px CPU preparation only; native capture and creative acceptance pending",
          },
          null,
          2,
        ),
      );
      preserve = Boolean(process.env.NATIVE_PREPARATION_ARTIFACTS);
    } finally {
      if (!preserve) rmSync(root, { recursive: true, force: true });
    }
  },
);

test("only exact matched browser-canceled registered native fulfillment avoids a policy failure", () => {
  const error = Object.assign(new Error("Protocol error (Fetch.fulfillRequest): Invalid InterceptionId."), {
    name: "ProtocolError",
    originalMessage: "Invalid InterceptionId.",
  });
  const valid = {
    mediaProfile: "native-local-media-v1",
    registeredAsset: "voice.wav",
    requestUrl: "https://avc.invalid/voice.wav",
    networkId: "123",
    canceledNetworkId: "123",
    canceled: true,
    cancellation: "net::ERR_ABORTED",
    error,
  };
  assert.equal(isNativeTransportCancellation(valid), true);
  for (const bad of [
    { ...valid, mediaProfile: undefined },
    { ...valid, registeredAsset: undefined },
    { ...valid, networkId: undefined },
    { ...valid, canceledNetworkId: "456" },
    { ...valid, canceled: false },
    { ...valid, cancellation: undefined },
    { ...valid, cancellation: "net::ERR_FAILED" },
    { ...valid, requestUrl: "https://evil.invalid/voice.wav" },
    { ...valid, requestUrl: "https://avc.invalid/missing.wav" },
    { ...valid, requestUrl: "https://avc.invalid/voice.wav?spoof=1" },
    { ...valid, requestUrl: "https://avc.invalid/voice.wav#spoof" },
    { ...valid, requestUrl: "https://avc.invalid/%zz" },
    { ...valid, error: new Error(error.message) },
    { ...valid, error: { name: error.name, message: error.message, originalMessage: error.originalMessage } },
    {
      ...valid,
      error: Object.assign(new Error("Protocol error (Fetch.failRequest): Invalid InterceptionId."), {
        name: "ProtocolError",
        originalMessage: "Invalid InterceptionId.",
      }),
    },
    { ...valid, error: Object.assign(new Error(error.message), { name: "ProtocolError", originalMessage: "wrong" }) },
  ])
    assert.equal(isNativeTransportCancellation(bad), false);
});
