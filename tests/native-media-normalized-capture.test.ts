import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { captureHtml } from "../src/lib/backends/html";
import { runNativeNormalizationTool, nativeDecodedFrameAt } from "../src/lib/backends/native-media-normalization";
const enabled = process.env.RUN_NATIVE_NORMALIZED_CAPTURE === "1";
test(
  "genuine native cache captures normalized VFR/embedded AAC, exact mapped pixels, gain/mute/rate and random seeks",
  { skip: !enabled, timeout: 120000 },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(process.env.NATIVE_CAPTURE_ARTIFACTS ?? tmpdir(), "normalized-capture-")),
    );
    let preserve = false;
    try {
      const runtime = process.env.HYPERFRAMES_MEDIA_ENGINE_FILE!,
        gsap = process.env.HYPERFRAMES_GSAP_FILE!,
        sourceFixture = process.env.NATIVE_CAPTURE_SOURCE!;
      assert.ok(runtime && gsap && sourceFixture, "Explicit installed pinned files required");
      copyFileSync(runtime, path.join(root, "runtime.js"));
      copyFileSync(gsap, path.join(root, "gsap.js"));
      copyFileSync(sourceFixture, path.join(root, "source.mp4"));
      const file = path.join(root, "index.html"),
        html = (muted = false) =>
          `<!doctype html><style>html,body{margin:0;background:white}video{position:absolute;left:0;top:0;width:64px;height:64px}</style><div data-composition-id="main" data-duration="3" data-width="64" data-height="64"><div id="anchor"></div><video id="movie" src="source.mp4" data-start=".2" data-duration=".4" data-media-start=".1" data-playback-rate="2" data-volume=".5"></video></div><script>window.__timelines.main=gsap.timeline({paused:true}).to('#anchor',{opacity:1,duration:3});${muted ? 'document.querySelector("video").muted=true;' : ""}</script>`;
      writeFileSync(file, html());
      const request = {
        htmlFile: file,
        assetRoot: root,
        assets: ["runtime.js", "gsap.js", "source.mp4"],
        width: 64,
        height: 64,
        fps: 10,
        timeoutMs: 30000,
        protocol: "hyperframes-player",
        playerRuntime: {
          runtimeAsset: "runtime.js",
          gsapAsset: "gsap.js",
          mediaProfile: "native-local-media-v1",
          normalization: "decoded-source-proxy-v1",
        },
      };
      const a = await captureHtml({ ...request, frames: [4, 0, 2, 6] }, path.join(root, "out")),
        b = await captureHtml({ ...request, frames: [0, 2, 4, 6] }, path.join(root, "out"));
      for (const frame of a.frames) assert.equal(frame.sha256, b.frames.find((f) => f.frame === frame.frame)!.sha256);
      const manifest = JSON.parse(readFileSync(a.manifest, "utf8")),
        source = manifest.nativeMediaSources["source.mp4"];
      assert.equal(source.durationSec, 3);
      assert.equal(source.normalization.video.frameCount, 9);
      assert.equal(source.normalization.audio.outputSamples, 144000);
      for (const outputFrame of [2, 4]) {
        const mapped = manifest.media.find((m: any) => m.frame === outputFrame);
        assert.equal(mapped.sourceFrame, nativeDecodedFrameAt(source.normalization.video.clock, mapped.timeSec));
        const actual = execFileSync("ffmpeg", [
          "-v",
          "error",
          "-i",
          a.frames.find((f) => f.frame === outputFrame)!.path,
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ]);
        const expected = execFileSync("ffmpeg", [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          path.join(path.dirname(a.manifest), source.normalization.video.proxy.path),
          "-vf",
          `select=eq(n\\,${mapped.sourceFrame})`,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ]);
        assert.deepEqual(actual, expected, "Capture must show the exact original-clock selected proxy picture");
      }
      const encoded = await captureHtml(
          { ...request, frames: Array.from({ length: 10 }, (_, i) => i), encode: "mp4" },
          path.join(root, "encoded"),
        ),
        mix = JSON.parse(readFileSync(encoded.manifest, "utf8"));
      assert.equal(mix.nativeAudioDescriptors.length, 1);
      assert.equal(mix.nativeAudioDescriptors[0].kind, "video");
      assert.equal(mix.audio.tracks.length, 1);
      assert.equal(mix.audio.tracks[0].volume, 0.5);
      assert.equal(mix.audio.tracks[0].rate, 2);
      assert.equal(mix.audio.tracks[0].startSample, 9600);
      assert.equal(mix.audio.tracks[0].lengthSamples, 19200);
      const original = await runNativeNormalizationTool("ffmpeg", [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        path.join(root, "source.mp4"),
        "-map",
        "0:a:0",
        "-af",
        "atrim=start=0.1:end=0.9,asetpts=PTS-STARTPTS,atempo=2,aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo,apad,atrim=end_sample=19200,volume=.5",
        "-f",
        "f32le",
        "pipe:1",
      ]);
      const decoded = await runNativeNormalizationTool("ffmpeg", [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        encoded.outputs.at(-1)!,
        "-map",
        "0:a:0",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "f32le",
        "pipe:1",
      ]);
      let error = 0;
      for (let i = 0; i < 48000; i++) {
        const expected = i >= 9600 && i < 28800 ? original.readFloatLE((i - 9600) * 8) : 0;
        error += (decoded.readFloatLE(i * 8) - expected) ** 2;
      }
      const rms = Math.sqrt(error / 48000);
      assert.ok(rms < 0.002, `Decoded AAC RMS against independently trimmed original AAC: ${rms}`);
      writeFileSync(file, html(true));
      const silent = await captureHtml(
        { ...request, frames: Array.from({ length: 10 }, (_, i) => i), encode: "mp4" },
        path.join(root, "silent"),
      );
      const pcm = await runNativeNormalizationTool("ffmpeg", [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        silent.outputs.at(-1)!,
        "-map",
        "0:a:0",
        "-f",
        "f32le",
        "pipe:1",
      ]);
      for (let i = 0; i < pcm.length; i += 4) assert.equal(pcm.readFloatLE(i), 0);
      writeFileSync(
        path.join(root, "child.html"),
        '<video id="nestedMovie" src="source.mp4" data-start="0" data-duration=".4" data-media-start=".1" data-playback-rate="2" data-volume=".5"></video><div id="childAnchor"></div><script>window.__timelines.child=gsap.timeline({paused:true}).to("#childAnchor",{opacity:1,duration:.6});</script>',
      );
      writeFileSync(
        file,
        `<!doctype html><style>html,body{margin:0}video{position:absolute;width:64px;height:64px;left:0;top:0}</style><div data-composition-id="main" data-duration="3" data-width="64" data-height="64"><div id="anchor"></div><div data-composition-id="child" data-composition-src="child.html" data-start=".2" data-duration=".4" data-media-start=".1"></div></div><script>window.__timelines.main=gsap.timeline({paused:true}).to('#anchor',{opacity:1,duration:3});</script>`,
      );
      const nestedRequest = { ...request, assets: [...request.assets, "child.html"] },
        nested = await captureHtml({ ...nestedRequest, frames: [2, 3, 5] }, path.join(root, "nested")),
        nestedRepeat = await captureHtml({ ...nestedRequest, frames: [5, 3, 2] }, path.join(root, "nested"));
      const nestedReport = JSON.parse(readFileSync(nested.manifest, "utf8"));
      assert.equal(nestedReport.frameAdapters[0].childLoads, 1);
      const nestedMapped = nestedReport.media.find((m: any) => m.frame === 2);
      assert.ok(Math.abs(nestedMapped.originSec - 0.1) < 1e-8);
      assert.ok(Math.abs(nestedMapped.timeSec - 0.3) < 1e-8);
      for (const f of nested.frames) {
        assert.equal(f.sha256, nestedRepeat.frames.find((x) => x.frame === f.frame)!.sha256);
        const mapped = nestedReport.media.find((m: any) => m.frame === f.frame),
          source = nestedReport.nativeMediaSources["source.mp4"];
        if (f.frame === 5) {
          assert.equal(mapped, undefined, "Exact nested child terminal is excluded");
        } else {
          assert.ok(mapped);
          assert.equal(mapped.sourceFrame, nativeDecodedFrameAt(source.normalization.video.clock, mapped.timeSec));
          const actual = execFileSync("ffmpeg", [
              "-v",
              "error",
              "-i",
              f.path,
              "-f",
              "rawvideo",
              "-pix_fmt",
              "rgb24",
              "pipe:1",
            ]),
            expected = execFileSync("ffmpeg", [
              "-v",
              "error",
              "-protocol_whitelist",
              "file,pipe",
              "-i",
              path.join(path.dirname(nested.manifest), source.normalization.video.proxy.path),
              "-vf",
              `select=eq(n\\,${mapped.sourceFrame})`,
              "-frames:v",
              "1",
              "-f",
              "rawvideo",
              "-pix_fmt",
              "rgb24",
              "pipe:1",
            ]);
          assert.deepEqual(actual, expected, "Nested original-clock picture equals selected proxy");
        }
      }
      writeFileSync(
        path.join(root, "acceptance.json"),
        JSON.stringify(
          {
            manifest: a.manifest,
            mix: encoded.manifest,
            silent: silent.manifest,
            originalClockPixelsEqual: true,
            randomSeeksEqual: true,
            embeddedAudioOwners: 1,
            nested: nested.manifest,
            nestedOriginSec: nestedMapped.originSec,
            nestedTimeSec: nestedMapped.timeSec,
            cancellations: mix.nativeRequestCancellations,
            rms,
            limits: "3s64px source/1s master; synthetic diagnostic; no FullHD/human/rights/API acceptance",
          },
          null,
          2,
        ),
      );
      preserve = Boolean(process.env.NATIVE_CAPTURE_ARTIFACTS);
    } finally {
      if (!preserve) rmSync(root, { recursive: true, force: true });
    }
  },
);
