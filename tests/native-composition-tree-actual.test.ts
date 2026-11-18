import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { captureHtml, HtmlCaptureSchema } from "../src/lib/backends/html";
import { mixNativeAudio } from "../src/lib/backends/html-audio";
import { digest } from "../src/lib/jobs/model-artifacts";
import { HYPERFRAMES_TREE_PIN } from "../src/lib/backends/native-composition-tree-prelude";
const runtime = process.env.HYPERFRAMES_TREE_ENGINE_FILE,
  gsap = process.env.HYPERFRAMES_GSAP_FILE;
const enabled = process.env.RUN_HTML_CAPTURE_TESTS === "1" && !!runtime && !!gsap;
const artifactRoot = process.env.AGENTBROS_TREE_ARTIFACT_ROOT || path.join(tmpdir(), "avc-tree-actual");
function setup(label: string) {
  mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(path.join(artifactRoot, label + "-"));
  copyFileSync(runtime!, path.join(root, "runtime.js"));
  copyFileSync(gsap!, path.join(root, "gsap.js"));
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=32x32:r=8:d=0.25",
      "-f",
      "lavfi",
      "-i",
      "color=blue:s=32x32:r=8:d=0.75",
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
    ],
    { timeout: 10000 },
  );
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000:duration=1",
      "-c:a",
      "pcm_s16le",
      "-y",
      path.join(root, "voice.wav"),
    ],
    { timeout: 10000 },
  );
  const timeline = (id: string, duration: number) =>
    `<div id="${id}Anchor"></div><script>window.__timelines.${id}=gsap.timeline({paused:true}).to('#${id}Anchor',{opacity:1,duration:${duration}});</script>`;
  const leaf = `<video id="movie" src="video.mp4" data-start="0" data-duration="0.25" data-media-start="0.125" data-playback-rate="2" style="width:32px;height:32px"></video><audio id="voice" src="voice.wav" data-start="0" data-duration="0.25" data-media-start="0.125" data-playback-rate="2" data-volume="0.5"></audio>${timeline("leaf", 0.5)}`;
  writeFileSync(path.join(root, "leaf.html"), leaf);
  writeFileSync(
    path.join(root, "grand.html"),
    `<div data-composition-id="leaf" data-composition-src="leaf.html" data-start="0" data-duration="0.5"></div>${timeline("grand", 0.5)}`,
  );
  writeFileSync(
    path.join(root, "child.html"),
    `<div data-composition-id="grand" data-composition-src="grand.html" data-start="0.125" data-duration="0.5"></div>${timeline("child", 0.75)}`,
  );
  const html = (extra = "", start: string | null = "0") =>
    `<!doctype html><style>html,body{margin:0;background:white}video{display:block}</style><div data-composition-id="main" ${start === null ? "" : `data-start="${start}"`} data-duration="1" data-width="64" data-height="64" data-fps="8"><div data-composition-id="child" data-composition-src="child.html" data-start="0.125" data-duration="0.75"></div><div id="mainAnchor"></div></div><script>window.__timelines.main=gsap.timeline({paused:true}).to('#mainAnchor',{opacity:1,duration:1});${extra}</script>`;
  const file = path.join(root, "index.html");
  writeFileSync(file, html());
  const request = {
    assetRoot: root,
    htmlFile: file,
    width: 64,
    height: 64,
    fps: 8,
    timeoutMs: 20000,
    protocol: "hyperframes-player",
    playerRuntime: {
      runtimeAsset: "runtime.js",
      gsapAsset: "gsap.js",
      mediaProfile: "native-local-media-v1",
      compositionProfile: "static-local-tree-v1",
    },
    assets: ["runtime.js", "gsap.js", "video.mp4", "voice.wav", "child.html", "grand.html", "leaf.html"],
  };
  return { root, file, html, leaf, request };
}
const report = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const pixel = (file: string) => [
  ...execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-vf", "crop=1:1:8:8,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "pipe:1"],
    { timeout: 5000 },
  ),
];
function liveGroup(pid: number) {
  return execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 5000 })
    .trim()
    .split("\n")
    .some((row) => {
      const cols = row.trim().split(/\s+/);
      return Number(cols[1]) === pid && !cols[2]?.startsWith("Z");
    });
}

test(
  "actual genuine three-level tree: exact random/repeated PNG, native rate/trim clock, ancestor-bounded measured PCM",
  { skip: !enabled, timeout: 120000 },
  async () => {
    const f = setup("positive");
    assert.equal(digest(readFileSync(path.join(f.root, "runtime.js"))), HYPERFRAMES_TREE_PIN.runtimeSha256);
    const inputs = Object.fromEntries(
      f.request.assets.map((name) => [name, digest(readFileSync(path.join(f.root, name)))]),
    );
    inputs["index.html"] = digest(readFileSync(f.file));
    const sequential = await captureHtml(
      { ...f.request, frames: [0, 1, 2, 3, 4, 5, 6, 7], encode: "mp4" },
      path.join(f.root, "sequential"),
    );
    const random = await captureHtml({ ...f.request, frames: [7, 3, 1, 6, 0, 2] }, path.join(f.root, "random"));
    const repeated = await captureHtml({ ...f.request, frames: [3] }, path.join(f.root, "repeat"));
    assert.equal(repeated.frames[0].sha256, sequential.frames.find((s) => s.frame === 3)!.sha256);
    for (const frame of random.frames)
      assert.equal(
        frame.sha256,
        sequential.frames.find((s) => s.frame === frame.frame)!.sha256,
        "Absolute/random/repeated pixels differ",
      );
    assert.deepEqual(pixel(sequential.frames.find((s) => s.frame === 0)!.path), [255, 255, 255]);
    assert.ok(pixel(sequential.frames.find((s) => s.frame === 2)!.path)[0] > 240);
    assert.ok(pixel(sequential.frames.find((s) => s.frame === 3)!.path)[2] > 240);
    assert.deepEqual(pixel(sequential.frames.find((s) => s.frame === 4)!.path), [255, 255, 255]);
    const evidence = report(sequential.manifest);
    assert.equal(evidence.staticCompositionTree.nodes.length, 3);
    assert.deepEqual(
      evidence.staticCompositionTree.nodes.map((n: any) => n.depth),
      [1, 2, 3],
    );
    assert.equal(evidence.nativeMediaPin.runtimeSha256, HYPERFRAMES_TREE_PIN.runtimeSha256);
    assert.ok(evidence.frameAdapters.every((a: any) => a.childLoads === 3));
    const mapped = evidence.media.find((m: any) => m.frame === 3);
    assert.equal(mapped.startSec, 0.25);
    assert.equal(mapped.originSec, 0.25);
    assert.equal(mapped.timeSec, 0.375);
    assert.equal(mapped.sourceFrame, 3);
    assert.equal(evidence.nativeAudioDescriptors[0].startSec, 0.25);
    assert.equal(evidence.nativeAudioDescriptors[0].endSec, 0.5);
    assert.equal(evidence.nativeAudioDescriptors[0].rate, 2);
    assert.equal(evidence.audio.tracks[0].startSample, 12000);
    assert.equal(evidence.audio.tracks[0].lengthSamples, 12000);
    assert.equal(evidence.audio.tracks[0].volume, 0.5);
    assert.equal(evidence.audio.pcmSamples, 48000);
    // Production retains the measured PCM hash, not its intermediate WAV. Rebuild
    // that bounded master from genuine descriptors/original bytes, require its exact
    // production hash, then measure silence. Do not claim AAC padding is PCM identity.
    const replay = path.join(f.root, "pcm-replay");
    mkdirSync(replay);
    const replayVideo = path.join(replay, "video.mp4");
    copyFileSync(sequential.outputs.at(-1)!, replayVideo);
    const measured = mixNativeAudio(
      {
        ...HtmlCaptureSchema.parse({ ...f.request, frames: [0, 1, 2, 3, 4, 5, 6, 7], encode: "mp4" }),
        directory: replay,
        ownershipToken: "test-only",
        html: readFileSync(f.file, "utf8"),
        assetMap: {
          "voice.wav": { path: path.join(f.root, "voice.wav"), sha256: inputs["voice.wav"], mime: "audio/wav" },
        },
      },
      evidence.nativeAudioDescriptors,
      replayVideo,
    );
    assert.equal(measured.pcmSha256, evidence.audio.pcmSha256);
    const pcm = execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", path.join(replay, "mix.wav"), "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"],
      { timeout: 10000 },
    );
    assert.equal(digest(pcm), evidence.audio.pcmSha256);
    let peak = 0;
    for (let i = 0; i < 48000; i++)
      for (let channel = 0; channel < 2; channel++) {
        const value = pcm.readFloatLE(i * 8 + channel * 4);
        if (i < 12000 || i >= 24000) assert.equal(value, 0, `Ancestor-external sound at sample${i}`);
        else peak = Math.max(peak, Math.abs(value));
      }
    assert.ok(peak > 0.04 && peak < 0.07);
    assert.ok(evidence.audio.pcmPeak > 0.04 && evidence.audio.pcmPeak < 0.07);
    for (const [name, sha] of Object.entries(inputs))
      assert.equal(digest(readFileSync(path.join(f.root, name))), sha, "Original immutable source mutated");
    writeFileSync(
      path.join(f.root, "acceptance.json"),
      JSON.stringify(
        {
          sourceCommit: process.env.AGENTBROS_TREE_SOURCE_COMMIT,
          inputs,
          runtime: HYPERFRAMES_TREE_PIN,
          sequential: sequential.manifest,
          random: random.manifest,
          pcmSha256: digest(pcm),
          peak,
          frames: sequential.frames,
        },
        null,
        2,
      ),
    );
  },
);

test(
  "actual tree inert root/graph denials precede author marker; dynamic source/timeline and ancestor leakage refuse",
  { skip: !enabled, timeout: 120000 },
  async () => {
    const f = setup("negative");
    const denied = (label: string) => path.join(f.root, "denied-" + label);
    for (const start of [null, "0.125", "0.0"]) {
      writeFileSync(f.file, f.html(`throw Error('AUTHOR_MARKER_EXECUTED');`, start));
      await assert.rejects(
        captureHtml({ ...f.request, frames: [0] }, denied("root-" + String(start))),
        /explicit root data-start/,
      );
      assert.equal(existsSync(denied("root-" + String(start))), false);
    }
    for (const attributeTarget of ['data-composition-id="main"', 'data-composition-src="child.html"']) {
      writeFileSync(
        f.file,
        f.html(`throw Error('AUTHOR_MARKER_EXECUTED');`).replace(attributeTarget, attributeTarget + ' data-end="1"'),
      );
      await assert.rejects(
        captureHtml({ ...f.request, frames: [0] }, denied("composition-end-" + attributeTarget.includes("main"))),
        /composition end attributes/,
      );
    }
    writeFileSync(f.file, f.html(`throw Error('AUTHOR_MARKER_EXECUTED');`));
    writeFileSync(
      path.join(f.root, "leaf.html"),
      '<div data-composition-id="cycle" data-composition-src="child.html" data-start="0" data-duration="0.5"></div>',
    );
    await assert.rejects(captureHtml({ ...f.request, frames: [0] }, denied("cycle")), /cycle|repeated/);
    writeFileSync(path.join(f.root, "leaf.html"), f.leaf);
    writeFileSync(
      f.file,
      f.html(`window.__timelines.main.set('[data-composition-id="child"]',{'attr':{'data-duration':'0.7'}},0.125);`),
    );
    await assert.rejects(captureHtml({ ...f.request, frames: [2] }, denied("metadata")), /timing metadata|changed/);
    writeFileSync(
      f.file,
      f.html(
        `Object.defineProperty(document.querySelector('#mainAnchor'),'swapTimeline',{get:()=>0,set:value=>{if(value===1)window.__timelines.child=gsap.timeline({paused:true}).to('#mainAnchor',{opacity:1,duration:1});}});window.__timelines.main.set('#mainAnchor',{swapTimeline:1},0.125);`,
      ),
    );
    await assert.rejects(
      captureHtml({ ...f.request, frames: [2] }, denied("timeline")),
      /timeline identity|registry|manifest/,
    );
    for (const attribute of ["data-hf-authored-duration", "data-hf-authored-end", "data-end"]) {
      writeFileSync(
        f.file,
        f.html(`window.__timelines.main.set('[data-composition-id="child"]',{attr:{'${attribute}':'0.7'}},0.125);`),
      );
      await assert.rejects(
        captureHtml({ ...f.request, frames: [2] }, denied(attribute)),
        /metadata|duration lifecycle/,
      );
    }
    writeFileSync(
      f.file,
      f
        .html(`throw Error('AUTHOR_MARKER_EXECUTED');`)
        .replace(
          'data-composition-src="child.html"',
          'data-composition-src="child.html" data-hf-authored-duration="0.75"',
        ),
    );
    await assert.rejects(
      captureHtml({ ...f.request, frames: [0] }, denied("private-spoof")),
      /private timing attributes/,
    );
    writeFileSync(
      f.file,
      f.html(
        `document.querySelector('[data-composition-id="child"]').setAttribute('data-composition-src','grand.html');`,
      ),
    );
    await assert.rejects(captureHtml({ ...f.request, frames: [0] }, denied("source")), /changed|unlisted|unplanned/);
    writeFileSync(f.file, f.html());
    writeFileSync(path.join(f.root, "leaf.html"), f.leaf.replaceAll('data-duration="0.25"', 'data-duration="0.75"'));
    await assert.rejects(
      captureHtml({ ...f.request, frames: [2] }, denied("ancestor")),
      /ancestor window|source|cache outside/,
    );
  },
);

test(
  "actual tree pending readiness/cancellation release owned groups and preserve unrelated process; old omitted profiles retain captures",
  { skip: !enabled, timeout: 120000 },
  async () => {
    const f = setup("lifecycle");
    const unrelated = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
    try {
      writeFileSync(
        f.file,
        f.html(`window.__hf=window.__hf||{};window.__hf.buildReady={pending:new Promise(()=>{})};`),
      );
      const owned: number[] = [];
      await assert.rejects(
        captureHtml({ ...f.request, frames: [0], timeoutMs: 4000 }, path.join(f.root, "timeout"), {
          onOwnedBrowser: (pid) => owned.push(pid),
        }),
        /timeout/,
      );
      assert.ok(owned.length);
      for (const pid of owned) assert.equal(liveGroup(pid), false);
      assert.equal(liveGroup(unrelated.pid!), true, "Unrelated owned-by-test process killed");
      writeFileSync(f.file, f.html());
      const cancelled: number[] = [],
        controller = new AbortController();
      await assert.rejects(
        captureHtml({ ...f.request, frames: [0] }, path.join(f.root, "cancel"), {
          signal: controller.signal,
          onOwnedBrowser: (pid) => {
            cancelled.push(pid);
            controller.abort();
          },
        }),
        /cancelled/,
      );
      assert.ok(cancelled.length);
      for (const pid of cancelled) assert.equal(liveGroup(pid), false);
      assert.equal(liveGroup(unrelated.pid!), true);
      const oldRoot = path.dirname(runtime!);
      const oldRuntime =
        process.env.HYPERFRAMES_MEDIA_ENGINE_FILE ||
        path.join(oldRoot, "../hyperframes-engine/runtime-media-761ad67f.js");
      assert.ok(existsSync(oldRuntime), "Retained original native runtime missing");
      copyFileSync(oldRuntime, path.join(f.root, "runtime.js"));
      writeFileSync(
        f.file,
        '<!doctype html><div data-composition-id="main" data-duration="1" data-width="64" data-height="64"><div id="anchor"></div></div><script>window.__timelines.main=gsap.timeline({paused:true}).to("#anchor",{opacity:1,duration:1});</script>',
      );
      const { compositionProfile: _, ...oldProfile } = f.request.playerRuntime;
      const old = await captureHtml(
        { ...f.request, playerRuntime: oldProfile, frames: [0] },
        path.join(f.root, "old-native"),
      );
      assert.equal(report(old.manifest).staticCompositionTree, undefined);
      const visualRuntime =
        process.env.HYPERFRAMES_ENGINE_FILE || path.join(oldRoot, "../hyperframes-engine/runtime-b0a6873f.js");
      assert.ok(existsSync(visualRuntime));
      copyFileSync(visualRuntime, path.join(f.root, "runtime.js"));
      const { mediaProfile: __, ...visualProfile } = oldProfile;
      const visual = await captureHtml(
        { ...f.request, playerRuntime: visualProfile, assets: ["runtime.js", "gsap.js"], frames: [0] },
        path.join(f.root, "old-visual"),
      );
      assert.equal(report(visual.manifest).staticCompositionTree, undefined);
    } finally {
      unrelated.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (unrelated.exitCode !== null) resolve();
        else unrelated.once("exit", () => resolve());
      });
    }
  },
);
