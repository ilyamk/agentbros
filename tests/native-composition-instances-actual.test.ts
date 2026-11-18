import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { captureHtml, HtmlCaptureSchema } from "../src/lib/backends/html";
import { HYPERFRAMES_INSTANCES_PIN } from "../src/lib/backends/native-composition-instances-prelude";
import { HYPERFRAMES_PLAYER_PIN } from "../src/lib/backends/hyperframes-player";
import { digest } from "../src/lib/jobs/model-artifacts";
import { mixNativeAudio } from "../src/lib/backends/html-audio";
import type { NativeMediaDescriptor } from "../src/lib/backends/hyperframes-player-media";
const enabled = process.env.RUN_HYPERFRAMES_INSTANCES_TESTS === "1";
const runtime = process.env.HYPERFRAMES_INSTANCES_ENGINE_FILE,
  gsap = process.env.HYPERFRAMES_GSAP_FILE;
const rootHtml = (extra = "") =>
  `<!doctype html><html><head></head><body><div id="root" data-composition-id="root" data-start="0" data-duration="2" data-width="64" data-height="64" data-fps="8" style="position:relative;width:64px;height:64px;background-color:#000000"><div id="first" data-composition-id="first" data-composition-src="leaf.html" data-start="0" data-duration="1" style="position:absolute;left:0px;top:0px;width:32px;height:32px"></div><div id="second" data-composition-id="second" data-composition-src="leaf.html" data-start="1" data-duration="1" data-media-start="0.25" style="position:absolute;left:32px;top:0px;width:32px;height:32px"></div><span id="anchor" style="opacity:0;width:0px;height:0px"></span><script>const timeline=gsap.timeline({paused:true});timeline.to("#anchor",{opacity:1,duration:2,ease:"none"},0);window.__timelines["root"]=timeline;${extra}</script></div></body></html>`;
const leafHtml = `<!doctype html><html><head></head><body><div id="leaf" data-composition-id="leaf" data-start="0" data-duration="2" style="position:relative"><span id="box" style="position:absolute;width:32px;height:32px;background-color:#00ff00"></span><video id="footage" src="footage.mp4" data-start="0.5" data-duration="0.25" data-media-start="0.25" data-playback-rate="2" style="position:absolute;width:16px;height:16px"></video><audio id="voice" src="voice.wav" data-start="0.5" data-duration="0.25" data-volume="0.5"></audio><script>const timeline=gsap.timeline({paused:true});timeline.to("#box",{backgroundColor:"#0000ff",duration:1,ease:"none"},0);window.__timelines["leaf"]=timeline;</script></div></body></html>`;
const ffmpeg = (args: string[]) =>
  execFileSync("ffmpeg", ["-v", "error", "-protocol_whitelist", "file,pipe", ...args], {
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
  });

test(
  "actual genuine repeated leaf instances: source clocks/unique registry+media, sequential/random/repeat PNG, ancestor PCM and physical short movie",
  { skip: !enabled, timeout: 180000 },
  async () => {
    assert.ok(runtime && gsap, "Exact retained runtime/GSAP required; never download");
    assert.equal(digest(readFileSync(runtime)), HYPERFRAMES_INSTANCES_PIN.runtimeSha256);
    assert.equal(digest(readFileSync(gsap)), HYPERFRAMES_PLAYER_PIN.gsapSha256);
    const artifactRoot = process.env.AGENTBROS_INSTANCES_ARTIFACT_ROOT ?? path.join(tmpdir(), "avc-instances-actual");
    mkdirSync(artifactRoot, { recursive: true });
    const directory = mkdtempSync(path.join(artifactRoot, "positive-"));
    copyFileSync(runtime, path.join(directory, "runtime.js"));
    copyFileSync(gsap, path.join(directory, "gsap.js"));
    writeFileSync(path.join(directory, "root.html"), rootHtml());
    writeFileSync(path.join(directory, "leaf.html"), leafHtml);
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=16x16:rate=8:duration=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-y",
      path.join(directory, "footage.mp4"),
    ]);
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=400:sample_rate=48000:duration=2",
      "-c:a",
      "pcm_s16le",
      "-y",
      path.join(directory, "voice.wav"),
    ]);
    const originals = Object.fromEntries(
      ["root.html", "leaf.html", "footage.mp4", "voice.wav"].map((name) => [
        name,
        digest(readFileSync(path.join(directory, name))),
      ]),
    );
    const base = {
      protocol: "hyperframes-player",
      htmlFile: path.join(directory, "root.html"),
      assetRoot: directory,
      assets: ["runtime.js", "gsap.js", "leaf.html", "footage.mp4", "voice.wav"],
      width: 64,
      height: 64,
      fps: 8,
      timeoutMs: 120000,
      playerRuntime: {
        runtimeAsset: "runtime.js",
        gsapAsset: "gsap.js",
        mediaProfile: "native-local-media-v1",
        compositionProfile: "static-local-instances-v1",
      },
    };
    const sequential = await captureHtml({ ...base, frames: [0, 4, 5, 8, 10, 12, 15] }, path.join(directory, "output"));
    const random = await captureHtml({ ...base, frames: [15, 8, 0, 12, 4, 10, 5] }, path.join(directory, "output"));
    const repeated = await captureHtml({ ...base, frames: [0, 4, 10] }, path.join(directory, "output"));
    for (const captured of [...random.frames, ...repeated.frames])
      assert.equal(captured.sha256, sequential.frames.find((frame) => frame.frame === captured.frame)!.sha256);
    assert.notEqual(
      sequential.frames[0].sha256,
      sequential.frames[4].sha256,
      "Distinct host phase changes visible state",
    );
    const manifest = JSON.parse(readFileSync(sequential.manifest, "utf8"));
    assert.equal(manifest.staticCompositionInstances.instances.length, 2);
    assert.equal(
      manifest.staticCompositionInstances.instances[0].sourceSha256,
      manifest.staticCompositionInstances.instances[1].sourceSha256,
    );
    const framePath = (frame: number) => sequential.frames.find((value) => value.frame === frame)!.path;
    const pixel = (file: string, x: number, y: number) => [
      ...ffmpeg(["-i", file, "-vf", `crop=1:1:${x}:${y},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"]),
    ];
    const firstColor = pixel(framePath(4), 24, 24),
      secondColor = pixel(framePath(10), 56, 24);
    assert.deepEqual(secondColor, firstColor, "Independent host in-point seeks identical leaf source phase .5");
    assert.ok(Math.abs(firstColor[1] - 128) <= 1 && Math.abs(firstColor[2] - 128) <= 1 && firstColor[0] === 0);
    const sourceFrame = path.join(directory, "physical-source-frame2.png");
    ffmpeg(["-i", path.join(directory, "footage.mp4"), "-vf", "select=eq(n\\,2)", "-frames:v", "1", "-y", sourceFrame]);
    assert.deepEqual(
      pixel(framePath(4), 8, 8),
      pixel(sourceFrame, 8, 8),
      "Native original sourceFrame2 displayed at rate2 cue start",
    );
    assert.deepEqual(
      pixel(framePath(10), 40, 8),
      pixel(sourceFrame, 8, 8),
      "Second instance uses independent host origin and same physical source at its cue start",
    );
    const descriptors = manifest.nativeAudioDescriptors as NativeMediaDescriptor[];
    assert.equal(descriptors.length, 2);
    assert.notEqual(descriptors[0].id, descriptors[1].id);
    assert.equal(descriptors[0].volume, 0.5);
    assert.equal(descriptors[1].volume, 0.5);
    assert.deepEqual(
      descriptors.map((d) => [d.startSec, d.endSec]),
      [
        [0.5, 0.75],
        [1.25, 1.5],
      ],
    );
    const media = manifest.media.filter((d: { kind: string }) => d.kind === "video");
    assert.ok(
      media.some(
        (d: { frame: number; rate: number; sourceFrame: number }) =>
          d.frame === 4 && d.rate === 2 && d.sourceFrame === 2,
      ),
      "Genuine rate2 + source trim uses original physical source frame2",
    );
    const video = await captureHtml(
      { ...base, frames: Array.from({ length: 16 }, (_, i) => i), encode: "mp4" },
      path.join(directory, "output"),
    );
    const encoded = JSON.parse(readFileSync(video.manifest, "utf8")).video;
    assert.ok(encoded.audio);
    const assetMap = {
      "voice.wav": { path: path.join(directory, "voice.wav"), sha256: originals["voice.wav"], mime: "audio/wav" },
    };
    const replay = path.join(directory, "pcm-replay");
    mkdirSync(replay);
    const replayVideo = path.join(replay, "video.mp4");
    copyFileSync(encoded.path, replayVideo);
    const measured = mixNativeAudio(
      {
        ...HtmlCaptureSchema.parse({ ...base, frames: Array.from({ length: 16 }, (_, i) => i), encode: "mp4" }),
        directory: replay,
        ownershipToken: "test-only",
        html: rootHtml(),
        assetMap,
      },
      descriptors,
      replayVideo,
    );
    const samples = ffmpeg(["-i", path.join(replay, "mix.wav"), "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"]);
    assert.equal(digest(samples), measured.pcmSha256);
    assert.equal(measured.pcmSha256, JSON.parse(readFileSync(video.manifest, "utf8")).audio.pcmSha256);
    assert.equal(samples.length, 2 * 48000 * 2 * 4);
    const peaks = (start: number, end: number) => {
      let peak = 0;
      for (let i = Math.round(start * 48000) * 2; i < Math.round(end * 48000) * 2; i++)
        peak = Math.max(peak, Math.abs(samples.readFloatLE(i * 4)));
      return peak;
    };
    assert.equal(peaks(0, 0.5), 0);
    assert.ok(peaks(0.5, 0.75) > 0.001);
    assert.equal(peaks(0.75, 1.25), 0);
    assert.ok(peaks(1.25, 1.5) > 0.001);
    assert.equal(peaks(1.5, 2), 0);
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-count_frames",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          encoded.path,
        ],
        { timeout: 10000, encoding: "utf8" },
      ),
    );
    const stream = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    assert.equal(Number(stream.nb_read_frames), 16);
    assert.equal(stream.r_frame_rate, "8/1");
    assert.equal(Number(probe.format.duration), 2);
    ffmpeg(["-xerror", "-i", encoded.path, "-map", "0", "-f", "null", "-"]);
    for (const [name, sha] of Object.entries(originals))
      assert.equal(digest(readFileSync(path.join(directory, name))), sha);
    writeFileSync(
      path.join(directory, "acceptance.json"),
      JSON.stringify(
        {
          sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          runtime: HYPERFRAMES_INSTANCES_PIN,
          originals,
          frameHashes: sequential.frames,
          descriptors,
          pcm: { bytes: samples.length, sha256: digest(samples), measuredOutsideAncestors: true },
          probe,
          fullDecode: "exit0/all-streams/-xerror; nonencoded PCM is not AAC byte acceptance",
        },
        null,
        2,
      ),
    );
  },
);

test(
  "actual inert instance rejection occurs before authored marker for missing origin, end/private attributes, unsupported script/AST/source",
  { skip: !enabled, timeout: 90000 },
  async () => {
    assert.ok(runtime && gsap);
    const artifactRoot = process.env.AGENTBROS_INSTANCES_ARTIFACT_ROOT ?? path.join(tmpdir(), "avc-instances-denial");
    mkdirSync(artifactRoot, { recursive: true });
    const directory = mkdtempSync(path.join(artifactRoot, "negative-"));
    copyFileSync(runtime, path.join(directory, "runtime.js"));
    copyFileSync(gsap, path.join(directory, "gsap.js"));
    writeFileSync(
      path.join(directory, "leaf.html"),
      leafHtml.replace(/<video[\s\S]*?<\/video>|<audio[\s\S]*?<\/audio>/g, ""),
    );
    const base = {
      protocol: "hyperframes-player",
      htmlFile: path.join(directory, "root.html"),
      assetRoot: directory,
      assets: ["runtime.js", "gsap.js", "leaf.html"],
      width: 64,
      height: 64,
      fps: 8,
      frames: [0],
      timeoutMs: 10000,
      playerRuntime: {
        runtimeAsset: "runtime.js",
        gsapAsset: "gsap.js",
        mediaProfile: "native-local-media-v1",
        compositionProfile: "static-local-instances-v1",
      },
    };
    const results = [];
    for (const [name, html] of [
      ["missing-start", rootHtml().replace('data-start="0"', "")],
      ["composition-end", rootHtml().replace('data-duration="2"', 'data-duration="2" data-end="2"')],
      ["private-attribute", rootHtml().replace('data-duration="2"', 'data-duration="2" data-hf-authored-duration="2"')],
      ["script-marker", rootHtml('throw Error("AUTHORED_MARKER_EXECUTED");')],
      ["unknown-source", rootHtml().replace("leaf.html", "absent.html")],
    ]) {
      writeFileSync(base.htmlFile, html);
      const output = path.join(directory, name);
      let message = "";
      try {
        await captureHtml(base, output);
        assert.fail("Unsupported source accepted");
      } catch (error) {
        message = String(error);
        assert.ok(
          !message.includes("AUTHORED_MARKER_EXECUTED"),
          "Raw marker syntax belongs only to AST source; worker must report inert rejection, not author execution",
        );
        assert.match(message, /Instance|instance|unsupported/i);
      }
      assert.equal(existsSync(output), false);
      results.push({ name, message });
    }
    writeFileSync(path.join(directory, "denials.json"), JSON.stringify(results, null, 2));
  },
);

test(
  "actual instance cancellation reaps only authenticated owned Chrome group and leaves unrelated owned test child alive",
  { skip: !enabled || process.platform === "win32", timeout: 30000 },
  async () => {
    assert.ok(runtime && gsap);
    const artifactRoot = process.env.AGENTBROS_INSTANCES_ARTIFACT_ROOT ?? path.join(tmpdir(), "avc-instances-cancel");
    mkdirSync(artifactRoot, { recursive: true });
    const directory = mkdtempSync(path.join(artifactRoot, "cancel-"));
    copyFileSync(runtime, path.join(directory, "runtime.js"));
    copyFileSync(gsap, path.join(directory, "gsap.js"));
    writeFileSync(path.join(directory, "root.html"), rootHtml());
    writeFileSync(
      path.join(directory, "leaf.html"),
      leafHtml.replace(/<video[\s\S]*?<\/video>|<audio[\s\S]*?<\/audio>/g, ""),
    );
    const { spawn } = await import("node:child_process");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }),
      signal = new AbortController(),
      owned: number[] = [];
    try {
      await assert.rejects(
        captureHtml(
          {
            protocol: "hyperframes-player",
            htmlFile: path.join(directory, "root.html"),
            assetRoot: directory,
            assets: ["runtime.js", "gsap.js", "leaf.html"],
            width: 64,
            height: 64,
            fps: 8,
            frames: [0],
            timeoutMs: 10000,
            playerRuntime: {
              runtimeAsset: "runtime.js",
              gsapAsset: "gsap.js",
              mediaProfile: "native-local-media-v1",
              compositionProfile: "static-local-instances-v1",
            },
          },
          path.join(directory, "output"),
          {
            signal: signal.signal,
            onOwnedBrowser: (pid) => {
              owned.push(pid);
              signal.abort();
            },
          },
        ),
        /cancel/i,
      );
      assert.ok(owned.length);
      process.kill(unrelated.pid!, 0);
      const groups = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 2000 });
      for (const id of owned)
        assert.ok(
          !groups.split("\n").some((line) => {
            const columns = line.trim().split(/\s+/);
            return Number(columns[1]) === id && !columns[2]?.startsWith("Z");
          }),
          "Owned native group leaked",
        );
      assert.equal(existsSync(path.join(directory, "output")), false);
      writeFileSync(
        path.join(directory, "cancellation.json"),
        JSON.stringify(
          { owned, unrelatedPid: unrelated.pid, unrelatedAlive: true, ownedGroupsReleased: true },
          null,
          2,
        ),
      );
    } finally {
      unrelated.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (unrelated.exitCode !== null || unrelated.signalCode !== null) resolve();
        else unrelated.once("exit", () => resolve());
      });
    }
  },
);
