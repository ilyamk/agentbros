import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { HtmlCaptureSchema, captureHtml } from "../src/lib/backends/html";
import { probeNativeMedia } from "../src/lib/backends/hyperframes-media-probe";
import mediaReceipt from "./fixtures/hyperframes-engine/media-provenance.json";
import visualReceipt from "./fixtures/hyperframes-engine/patched-provenance.json";
import { HYPERFRAMES_MEDIA_PIN } from "../src/lib/backends/hyperframes-player-media";
import { importAsset } from "../src/lib/assets/registry";
import { digest } from "../src/lib/jobs/model-artifacts";
const enabled = process.env.RUN_HTML_CAPTURE_TESTS === "1";
const runtime = process.env.HYPERFRAMES_MEDIA_ENGINE_FILE,
  gsap = process.env.HYPERFRAMES_GSAP_FILE;
function fixture(root: string) {
  const video = path.join(root, "video.mp4"),
    audio = path.join(root, "voice.wav");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=32x32:r=20:d=0.4",
    "-f",
    "lavfi",
    "-i",
    "color=blue:s=32x32:r=20:d=0.6",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map",
    "[v]",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    video,
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1000:sample_rate=48000:duration=1",
    "-c:a",
    "pcm_s16le",
    "-y",
    audio,
  ]);
  return { video, audio };
}
function html(media: string, extra = "") {
  return `<!doctype html><style>html,body{margin:0;background:white}video{width:32px;height:32px}</style><div data-composition-id="main" data-duration="1" data-width="64" data-height="64"><div id="anchor"></div>${media}</div><script>window.__timelines.main=gsap.timeline({paused:true}).to('#anchor',{opacity:1,duration:1});${extra}</script>`;
}
test("separate native media receipt preserves every visual adaptation and binds genuine private cache/window callbacks", () => {
  assert.equal(mediaReceipt.engineSha256, HYPERFRAMES_MEDIA_PIN.runtimeSha256);
  assert.equal(mediaReceipt.visualEngineSha256, visualReceipt.engineSha256);
  let extra = 0;
  for (const [file, base] of Object.entries(visualReceipt.patches)) {
    const media = mediaReceipt.patches[file as keyof typeof mediaReceipt.patches];
    assert.equal(media.originalSha256, base.originalSha256);
    const extras = media.replacements.filter(
      (r) => r.text.includes("mediaResolver") || r.text === "Promise.resolve(false)",
    );
    extra += extras.length;
    assert.deepEqual(
      media.replacements.filter((r) => !extras.includes(r)),
      base.replacements,
    );
  }
  assert.equal(extra, 2);
  assert.equal(
    digest(readFileSync(path.resolve("tests/fixtures/hyperframes-engine/prepare-media.cjs"))),
    mediaReceipt.patchToolSha256,
  );
  assert.throws(() =>
    HtmlCaptureSchema.parse({
      htmlFile: "x",
      assetRoot: ".",
      width: 64,
      height: 64,
      frames: [0],
      playerRuntime: { runtimeAsset: "r", gsapAsset: "g", mediaProfile: "native-local-media-v1" },
    }),
  );
});
test("native local source probes establish exact zero-origin CFR/PCM clocks without Chrome", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hf-native-probe-"));
  try {
    const files = fixture(root),
      assets = Object.fromEntries(
        Object.entries(files).map(([key, file]) => [
          path.basename(file),
          { path: file, mime: key === "video" ? "video/mp4" : "audio/wav", sha256: digest(readFileSync(file)) },
        ]),
      );
    const probes = probeNativeMedia(assets);
    assert.equal(probes["video.mp4"].sourceFps, 20);
    assert.equal(probes["video.mp4"].durationSec, 1);
    assert.equal(probes["voice.wav"].durationSec, 1);
    const offset = path.join(root, "offset.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-i", files.video, "-c", "copy", "-output_ts_offset", "0.2", "-y", offset]);
    assert.throws(
      () => probeNativeMedia({ "offset.mp4": { path: offset, mime: "video/mp4", sha256: "fixture" } }),
      /zero-origin/,
    );
    const aac = path.join(root, "voice.m4a");
    execFileSync("ffmpeg", ["-v", "error", "-i", files.audio, "-c:a", "aac", "-y", aac]);
    assert.throws(() => probeNativeMedia({ "voice.m4a": { path: aac, mime: "audio/mp4", sha256: "fixture" } }), /PCM/);
    const embedded = path.join(root, "embedded.mp4");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      files.video,
      "-i",
      files.audio,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-y",
      embedded,
    ]);
    assert.throws(
      () => probeNativeMedia({ "embedded.mp4": { path: embedded, mime: "video/mp4", sha256: "fixture" } }),
      /isolated/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test(
  "actual pinned native cache captures constant-rate local video and measured audio",
  { skip: !enabled || !runtime || !gsap, timeout: 120000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hf-native-media-"));
    try {
      fixture(root);
      copyFileSync(runtime!, path.join(root, "runtime.js"));
      copyFileSync(gsap!, path.join(root, "gsap.js"));
      const file = path.join(root, "index.html");
      const base = {
        assetRoot: root,
        htmlFile: file,
        width: 64,
        height: 64,
        fps: 10,
        timeoutMs: 20000,
        protocol: "hyperframes-player",
        playerRuntime: { runtimeAsset: "runtime.js", gsapAsset: "gsap.js", mediaProfile: "native-local-media-v1" },
        assets: ["runtime.js", "gsap.js", "video.mp4", "voice.wav", "child.html"],
      };
      const content =
        '<video id="movie" src="video.mp4" data-start=".2" data-duration=".4" data-media-start=".1" data-playback-rate="2"></video><audio id="voice" src="voice.wav" data-start=".2" data-duration=".4" data-media-start=".1" data-volume=".5"></audio>';
      writeFileSync(
        path.join(root, "child.html"),
        '<!doctype html><div id=childAnchor></div><script>window.__timelines.child=gsap.timeline({paused:true}).to("#childAnchor",{opacity:1,duration:.6});</script>',
      );
      writeFileSync(file, html(content));
      const a = await captureHtml({ ...base, frames: [4, 0, 2, 6] }, path.join(root, "out")),
        b = await captureHtml({ ...base, frames: [0, 2, 4, 6] }, path.join(root, "out"));
      for (const f of a.frames) assert.equal(f.sha256, b.frames.find((x) => x.frame === f.frame)!.sha256);
      const pixel = (f: number) => [
        ...execFileSync("ffmpeg", [
          "-v",
          "error",
          "-i",
          a.frames.find((x) => x.frame === f)!.path,
          "-vf",
          "crop=1:1:8:8,format=rgb24",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "pipe:1",
        ]),
      ];
      assert.deepEqual(pixel(0), [255, 255, 255]);
      assert.ok(pixel(2)[0] > 240);
      assert.ok(pixel(4)[2] > 240);
      assert.deepEqual(pixel(6), [255, 255, 255]);
      const report = JSON.parse(readFileSync(a.manifest, "utf8"));
      assert.equal(report.nativeMediaPin.profile, "native-local-media-v1");
      assert.equal(report.media.find((m: any) => m.frame === 4).timeSec, 0.5);
      assert.equal(report.media.find((m: any) => m.frame === 4).sourceFrame, 10);
      const mp4 = await captureHtml(
        { ...base, frames: Array.from({ length: 10 }, (_, i) => i), encode: "mp4" },
        path.join(root, "out"),
      );
      const mix = JSON.parse(readFileSync(mp4.manifest, "utf8"));
      assert.equal(mix.audio.pcmSamples, 48000);
      assert.equal(mix.audio.tracks[0].startSample, 9600);
      assert.equal(mix.audio.tracks[0].lengthSamples, 19200);
      assert.equal(mix.audio.tracks[0].volume, 0.5);
      assert.equal(mix.video.audio, true);
      mkdirSync(path.join(root, "public/projects/native-import"), { recursive: true });
      writeFileSync(path.join(root, "public/projects/native-import/project.json"), "{}");
      const imported = importAsset({
        rootDir: root,
        projectId: "native-import",
        sourceFile: mp4.outputs.at(-1)!,
        provenance: { origin: "manual" },
      });
      assert.equal(imported.asset.hash, mix.video.sha256);
      assert.equal(imported.asset.status, "candidate");
      assert.equal(imported.asset.media.hasAudio, true);

      const pcm = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        mp4.outputs.at(-1)!,
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
      const source = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        path.join(root, "voice.wav"),
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "f32le",
        "pipe:1",
      ]);
      let maxDifference = 0,
        peak = 0,
        squaredError = 0;
      for (let i = 0; i < 48000; i++) {
        const actual = pcm.readFloatLE(i * 8),
          expected = i >= 9600 && i < 28800 ? source.readFloatLE((i - 9600 + 4800) * 8) * 0.5 : 0;
        maxDifference = Math.max(maxDifference, Math.abs(actual - expected));
        squaredError += (actual - expected) ** 2;
        peak = Math.max(peak, Math.abs(actual));
      }
      assert.ok(
        Math.sqrt(squaredError / 48000) < 0.002,
        `AAC waveform RMS differs: ${Math.sqrt(squaredError / 48000)} / max ${maxDifference}`,
      );
      assert.ok(peak > 0.04 && peak < 0.06);
      assert.ok(mix.audio.pcmPeak > 0.04 && mix.audio.pcmPeak < 0.05);
      writeFileSync(
        path.join(root, "child.html"),
        '<video id="nestedMovie" src="video.mp4" data-start="0" data-duration=".4" data-media-start=".1" data-playback-rate="2"></video><div id="childAnchor"></div><script>window.__timelines.child=gsap.timeline({paused:true}).to("#childAnchor",{opacity:1,duration:.6});</script>',
      );
      writeFileSync(
        file,
        html(
          '<div data-composition-id="child" data-composition-src="child.html" data-start=".2" data-duration=".4" data-media-start=".1"></div>',
        ),
      );
      const nested = await captureHtml({ ...base, frames: [2, 3, 5] }, path.join(root, "nested"));
      const nestedReport = JSON.parse(readFileSync(nested.manifest, "utf8"));
      const nestedRandom = await captureHtml({ ...base, frames: [5, 3, 2] }, path.join(root, "nested"));
      for (const f of nested.frames)
        assert.equal(f.sha256, nestedRandom.frames.find((x) => x.frame === f.frame)!.sha256);
      assert.equal(nestedReport.frameAdapters[0].childLoads, 1);
      const mapped = nestedReport.media.find((m: any) => m.frame === 2);
      assert.ok(Math.abs(mapped.startSec - 0.2) < 1e-8);
      assert.ok(Math.abs(mapped.originSec - 0.1) < 1e-8);
      assert.ok(Math.abs(mapped.timeSec - 0.3) < 1e-8);
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=red:s=32x32:r=30000/1001:d=0.2002",
        "-f",
        "lavfi",
        "-i",
        "color=blue:s=32x32:r=30000/1001:d=0.8008",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-y",
        path.join(root, "video.mp4"),
      ]);
      writeFileSync(file, html('<video id="fractional" src="video.mp4" data-start="0" data-duration=".4"></video>'));
      const fractional = await captureHtml({ ...base, frames: [2, 3] }, path.join(root, "fractional"));
      const fractionalReport = JSON.parse(readFileSync(fractional.manifest, "utf8"));
      assert.equal(fractionalReport.nativeMediaSources["video.mp4"].sourceFps, 30000 / 1001);
      assert.equal(fractionalReport.media.find((m: any) => m.frame === 2).sourceFrame, 5);
      assert.equal(fractionalReport.media.find((m: any) => m.frame === 3).sourceFrame, 8);
      const fPixel = (f: number) => [
        ...execFileSync("ffmpeg", [
          "-v",
          "error",
          "-i",
          fractional.frames.find((x) => x.frame === f)!.path,
          "-vf",
          "crop=1:1:8:8,format=rgb24",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "pipe:1",
        ]),
      ];
      assert.ok(fPixel(2)[0] > 240);
      assert.ok(fPixel(3)[2] > 240);
      for (const attrs of [
        "loop",
        "autoplay",
        'data-fade-in=".1"',
        'data-automation="{}"',
        'data-fx-chain="[]"',
        'data-audio-group="bus"',
      ]) {
        writeFileSync(
          file,
          html(`<video id="movie" src="video.mp4" data-start="0" data-duration=".4" ${attrs}></video>`),
        );
        await assert.rejects(captureHtml({ ...base, frames: [0] }, path.join(root, "denied")), /unsupported/);
      }
      writeFileSync(
        file,
        html(
          content,
          `gsap.to('#voice',{volume:.2,duration:.4,paused:true});window.__timelines.main.to('#voice',{volume:.2,duration:.4},0);`,
        ),
      );
      await assert.rejects(captureHtml({ ...base, frames: [2] }, path.join(root, "denied")), /property animation/);
      writeFileSync(
        file,
        html(content, `Object.defineProperty(document.querySelector('#voice'),'duration',{value:2});`),
      );
      await assert.rejects(captureHtml({ ...base, frames: [2] }, path.join(root, "denied")), /cache outside|manifest/);
      writeFileSync(file, html('<video id="movie" src="missing.mp4" data-start="0" data-duration=".4"></video>'));
      await assert.rejects(
        captureHtml({ ...base, frames: [0] }, path.join(root, "denied")),
        /snapshot allowlist|Blocked/,
      );
      for (const mute of ["muted", 'data-volume="0"']) {
        writeFileSync(
          file,
          html(
            `<audio id="silent" src="voice.wav" data-start="0" data-duration=".4" ${mute}></audio><video id="silentMovie" src="video.mp4" data-start="0" data-duration=".4" muted></video>`,
          ),
        );
        const silent = await captureHtml(
          { ...base, frames: Array.from({ length: 10 }, (_, i) => i), encode: "mp4" },
          path.join(root, "silent"),
        );
        const silence = JSON.parse(readFileSync(silent.manifest, "utf8"));
        assert.equal(silence.audio.pcmPeak, 0);
        assert.equal(silence.nativeAudioDescriptors[0].volume, 0);
        assert.equal(silence.nativeAudioDescriptors[0].authoredMuted, mute === "muted");
        const decoded = execFileSync("ffmpeg", [
          "-v",
          "error",
          "-i",
          silent.outputs.at(-1)!,
          "-map",
          "0:a:0",
          "-f",
          "f32le",
          "-ac",
          "1",
          "pipe:1",
        ]);
        for (let i = 0; i < decoded.length; i += 4) assert.equal(decoded.readFloatLE(i), 0);
      }
      writeFileSync(
        file,
        html(
          '<audio id="propertyMute" src="voice.wav" data-start="0" data-duration=".4" data-volume=".5"></audio>',
          `document.querySelector('#propertyMute').muted=true;`,
        ),
      );
      const propertySilent = await captureHtml(
        { ...base, frames: Array.from({ length: 10 }, (_, i) => i), encode: "mp4" },
        path.join(root, "property-mute"),
      );
      const propertyReport = JSON.parse(readFileSync(propertySilent.manifest, "utf8"));
      assert.equal(propertyReport.nativeAudioDescriptors[0].authoredMuted, true);
      assert.equal(propertyReport.audio.pcmPeak, 0);
      const propertyPcm = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        propertySilent.outputs.at(-1)!,
        "-map",
        "0:a:0",
        "-f",
        "f32le",
        "-ac",
        "1",
        "pipe:1",
      ]);
      for (let i = 0; i < propertyPcm.length; i += 4) assert.equal(propertyPcm.readFloatLE(i), 0);
      writeFileSync(
        file,
        html(
          '<audio id="overrideMute" src="voice.wav" data-start="0" data-duration=".4" data-volume=".5" muted></audio>',
          `document.querySelector('#overrideMute').muted=false;`,
        ),
      );
      const propertyAudible = await captureHtml(
        { ...base, frames: Array.from({ length: 10 }, (_, i) => i), encode: "mp4" },
        path.join(root, "property-unmute"),
      );
      const overrideReport = JSON.parse(readFileSync(propertyAudible.manifest, "utf8"));
      assert.equal(overrideReport.nativeAudioDescriptors[0].authoredMuted, false);
      assert.ok(overrideReport.audio.pcmPeak > 0.04 && overrideReport.audio.pcmPeak < 0.05);
      writeFileSync(file, html(content, `window.__timelines.main.set('#voice',{defaultMuted:true},.1);`));
      await assert.rejects(captureHtml({ ...base, frames: [2] }, path.join(root, "dynamic-mute")), /mute changed/);
      writeFileSync(
        file,
        html(
          '<audio id="fastVoice" src="voice.wav" data-start=".2" data-duration=".4" data-media-start=".1" data-playback-rate="2" data-volume=".5"></audio>',
        ),
      );
      const fast = await captureHtml(
        { ...base, frames: Array.from({ length: 10 }, (_, i) => i), encode: "mp4" },
        path.join(root, "fast-audio"),
      );
      const fastReport = JSON.parse(readFileSync(fast.manifest, "utf8"));
      assert.equal(fastReport.nativeAudioDescriptors[0].rate, 2);
      assert.ok(Math.abs(fastReport.nativeAudioDescriptors[0].sourceEndSec - 0.9) < 1e-8);
      assert.equal(fastReport.audio.tracks[0].lengthSamples, 19200);
      assert.ok(fastReport.audio.pcmPeak > 0.04 && fastReport.audio.pcmPeak < 0.05);
      writeFileSync(
        file,
        html(content, `window.__hf=window.__hf||{};window.__hf.buildReady={pending:new Promise(()=>{})};`),
      );
      const owned: number[] = [];
      await assert.rejects(
        captureHtml({ ...base, frames: [0], timeoutMs: 4000 }, path.join(root, "timeout"), {
          onOwnedBrowser: (pid) => owned.push(pid),
        }),
        /timeout/,
      );
      assert.ok(owned.length > 0);
      const liveGroup = (pid: number) =>
        execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" })
          .trim()
          .split("\n")
          .some((row) => {
            const cols = row.trim().split(/\s+/);
            return Number(cols[1]) === pid && !cols[2]?.startsWith("Z");
          });
      for (const pid of owned) assert.equal(liveGroup(pid), false, "owned native Chrome survives deadline");
      writeFileSync(file, html(content));
      const cancel = new AbortController(),
        cancelOwned: number[] = [];
      await assert.rejects(
        captureHtml({ ...base, frames: [0] }, path.join(root, "cancel"), {
          signal: cancel.signal,
          onOwnedBrowser: (pid) => {
            cancelOwned.push(pid);
            cancel.abort();
          },
        }),
        /cancelled/,
      );
      assert.ok(cancelOwned.length > 0);
      for (const pid of cancelOwned) assert.equal(liveGroup(pid), false, "owned native Chrome survives cancellation");
      writeFileSync(file, html(content));
      await assert.rejects(
        captureHtml(
          { ...base, playerRuntime: { runtimeAsset: "runtime.js", gsapAsset: "gsap.js" }, frames: [0] },
          path.join(root, "denied"),
        ),
        /runtime snapshot differs/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
