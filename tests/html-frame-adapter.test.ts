import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { openBrowser, ensureBrowser } from "@remotion/renderer";
import { captureHtml, HtmlCaptureSchema } from "../src/lib/backends/html";
import { digest } from "../src/lib/jobs/model-artifacts";

const require = createRequire(import.meta.url);
const { buildSync } = require(require.resolve("esbuild", { paths: [require.resolve("tsx")] })) as {
  buildSync: (options: object) => { outputFiles: { text: string }[] };
};
const enabled = process.env.RUN_HTML_CAPTURE_TESTS === "1";
const gsapFile = process.env.HYPERFRAMES_GSAP_FILE;
const vendor = path.resolve("vendor/hyperframes");
const provenance = JSON.parse(readFileSync(path.join(vendor, "provenance.json"), "utf8"));
function fixture(script: string) {
  return `<!doctype html><style>html,body{margin:0;overflow:hidden}#tile{width:64px;height:64px;background:red}</style><div id="tile"></div><script>${script}</script>`;
}
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "hf-frame-"));
  return {
    root,
    file: path.join(root, "index.html"),
    base: {
      assetRoot: root,
      htmlFile: path.join(root, "index.html"),
      width: 64,
      height: 64,
      fps: 10,
      protocol: "hyperframes-frame-adapter",
      timeoutMs: 30000,
    },
  };
}
test("copied native adapter source and Apache licence match pinned upstream checksums", () => {
  assert.equal(provenance.revision, "9e9b613ccf867f98838617f7424967e056e63de2");
  assert.equal(provenance.licence, "Apache-2.0");
  for (const [name, value] of Object.entries(provenance.files) as [string, { sha256: string }][])
    assert.equal(digest(readFileSync(path.join(vendor, name))), value.sha256);
  assert.equal(
    HtmlCaptureSchema.parse({
      htmlFile: "x",
      assetRoot: ".",
      width: 64,
      height: 64,
      frames: [0],
      protocol: "hyperframes-frame-adapter",
    }).protocol,
    "hyperframes-frame-adapter",
  );
});
test(
  "explicit async FrameAdapter init, absolute seek and destroy are awaited; failures publish nothing",
  { skip: !enabled, timeout: 120000 },
  async () => {
    const { root, file, base } = setup();
    try {
      writeFileSync(
        file,
        fixture(
          `let initialized=false;window.AGENTBROS_FRAME_ADAPTER={id:'authored-async-contract',async init(c){await Promise.resolve();initialized=c.fps===10;},getDurationFrames(){return 10;},async seekFrame(f){await Promise.resolve();if(!initialized)throw Error('init not awaited');tile.style.background=f===0?'red':'blue';},async destroy(){await Promise.resolve();}}`,
        ),
      );
      const a = await captureHtml({ ...base, frames: [5, 0, 2] }, path.join(root, "out"));
      const b = await captureHtml({ ...base, frames: [0, 2, 5] }, path.join(root, "out"));
      for (const f of a.frames) assert.equal(f.sha256, b.frames.find((x) => x.frame === f.frame)!.sha256);
      const report = JSON.parse(readFileSync(a.manifest, "utf8"));
      assert.equal(report.frameAdapters.length, 3);
      await assert.rejects(captureHtml({ ...base, frames: [10] }, path.join(root, "outside")), /duration/);
      writeFileSync(
        file,
        fixture(
          `window.AGENTBROS_FRAME_ADAPTER={id:'broken-cleanup',getDurationFrames(){return 10;},seekFrame(){},async destroy(){throw Error('cleanup rejected');}}`,
        ),
      );
      await assert.rejects(captureHtml({ ...base, frames: [0] }, path.join(root, "failed")), /cleanup rejected/);
      writeFileSync(
        file,
        fixture(
          `window.__player={};window.AGENTBROS_FRAME_ADAPTER={id:'not-full-runtime',getDurationFrames(){return 10;},seekFrame(){}}`,
        ),
      );
      await assert.rejects(
        captureHtml({ ...base, frames: [0] }, path.join(root, "full")),
        /Full Hyperframes __player runtime unsupported/,
      );
      writeFileSync(
        file,
        fixture(
          `window.AGENTBROS_FRAME_ADAPTER={id:'pending',getDurationFrames(){return 10;},seekFrame(){return new Promise(()=>{});}}`,
        ),
      );
      await assert.rejects(
        captureHtml({ ...base, timeoutMs: 2000, frames: [0] }, path.join(root, "timeout")),
        /timeout/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test(
  "actual pinned upstream GSAP FrameAdapter seeks actual GSAP 3.15.0 without ticking; PNG and MP4 deterministic",
  { skip: !enabled || !gsapFile, timeout: 120000 },
  async () => {
    const { root, file, base } = setup();
    try {
      const gsap = readFileSync(gsapFile!);
      assert.equal(digest(gsap), "01effe0e121c22ba0f885a3f091f3dc6d1f0d445c4fba37dcb298e314eca5cfb");
      const adapter = buildSync({
        entryPoints: [path.join(vendor, "gsap.ts")],
        bundle: true,
        write: false,
        platform: "browser",
        format: "iife",
        globalName: "UpstreamFrameAdapter",
        target: "es2020",
      }).outputFiles[0].text;
      writeFileSync(path.join(root, "gsap.js"), gsap);
      writeFileSync(
        file,
        fixture(
          `${adapter}\nconst timeline=gsap.timeline({paused:true}).to('#tile',{backgroundColor:'blue',duration:1,ease:'none'});window.AGENTBROS_FRAME_ADAPTER=UpstreamFrameAdapter.createGSAPFrameAdapter({timeline,fps:10});`,
        ).replace("<script>", '<script src="gsap.js"></script><script>'),
      );
      const a = await captureHtml({ ...base, assets: ["gsap.js"], frames: [8, 0, 4] }, path.join(root, "out"));
      const b = await captureHtml({ ...base, assets: ["gsap.js"], frames: [0, 4, 8] }, path.join(root, "out"));
      for (const f of a.frames) assert.equal(f.sha256, b.frames.find((x) => x.frame === f.frame)!.sha256);
      assert.notEqual(a.frames[0].sha256, a.frames[1].sha256);
      const mp4 = await captureHtml(
        { ...base, assets: ["gsap.js"], frames: [0, 1, 2, 3], encode: "mp4" },
        path.join(root, "out"),
      );
      const report = JSON.parse(readFileSync(mp4.manifest, "utf8"));
      assert.equal(report.video.audio, false);
      assert.equal(report.frameAdapters[0].id, "gsap");
      assert.equal(report.frameAdapters[0].durationFrames, 10);
      assert.equal(report.provenance.assets["gsap.js"].sha256, digest(gsap));
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=red:s=16x16:r=10:d=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-y",
        path.join(root, "source.mp4"),
      ]);
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=1",
        "-y",
        path.join(root, "sound.wav"),
      ]);
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          '<div id="tile"></div>',
          '<div id="tile"></div><video id="clip" src="source.mp4" style="position:absolute;left:0;top:0;width:16px;height:16px"></video>',
        ),
      );
      const mixed = await captureHtml(
        {
          ...base,
          assets: ["gsap.js", "source.mp4", "sound.wav"],
          frames: [0, 1, 2, 3],
          encode: "mp4",
          timing: {
            version: 1,
            nodes: [
              { id: "parent", startFrame: 0, durationFrames: 4, rate: 2 },
              {
                id: "media",
                parent: "parent",
                startFrame: 1,
                durationFrames: 4,
                selector: "#clip",
                audioAsset: "sound.wav",
                sourceStartSec: 0.1,
                rate: 1,
              },
            ],
          },
        },
        path.join(root, "out"),
      );
      const mixedReport = JSON.parse(readFileSync(mixed.manifest, "utf8"));
      assert.equal(mixedReport.video.audio, true);
      assert.equal(mixedReport.audio.pcmSamples, 19200);
      assert.ok(mixedReport.media.some((m: { timeSec: number }) => Math.abs(m.timeSec - 0.2) < 1e-6));
      await assert.rejects(
        captureHtml({ ...base, protocol: "avc-frame", assets: ["gsap.js"], frames: [0] }, path.join(root, "legacy")),
        /Unsupported allowlisted asset type/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "pending init/seek/destroy and cancellation reap only authenticated owned detached Chrome groups",
  { skip: !enabled || process.platform === "win32", timeout: 120000 },
  async () => {
    const { root, file, base } = setup();
    const installed = await ensureBrowser({
      logLevel: "error",
      onBrowserDownload: () => {
        throw Error("Offline installed browser required");
      },
    });
    assert.ok("path" in installed);
    const unrelated = await openBrowser("chrome", { logLevel: "error", browserExecutable: installed.path });
    const survivor = await unrelated.newPage({
      context: () => null,
      logLevel: "error",
      indent: false,
      pageIndex: 0,
      onBrowserLog: null,
      onLog: () => {},
    });
    const liveGroup = (pid: number) => {
      const rows = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" }).trim().split("\n");
      return rows.some((row) => {
        const parts = row.trim().split(/\s+/);
        return Number(parts[1]) === pid && !parts[2]?.startsWith("Z");
      });
    };
    try {
      for (const phase of ["init", "seekFrame", "destroy"]) {
        const hooks = { init: "async init(){}", seekFrame: "async seekFrame(){}", destroy: "async destroy(){}" };
        hooks[phase as keyof typeof hooks] = `async ${phase}(){await new Promise(()=>{});}`;
        writeFileSync(
          file,
          fixture(
            `window.AGENTBROS_FRAME_ADAPTER={id:'pending-${phase}',getDurationFrames(){return 10;},${Object.values(hooks).join(",")}}`,
          ),
        );
        const owned: number[] = [];
        await assert.rejects(
          captureHtml({ ...base, timeoutMs: 4000, frames: [0] }, path.join(root, phase), {
            onOwnedBrowser: (pid) => owned.push(pid),
          }),
          /timeout/,
        );
        assert.ok(owned.length > 0, "real Chrome ownership handshake was observed");
        for (const pid of owned)
          assert.equal(liveGroup(pid), false, `owned detached group ${pid} remains after ${phase}`);
        assert.equal(await survivor.evaluate(() => 1 + 1), 2, "unrelated Chrome must survive");
      }
      writeFileSync(
        file,
        fixture(
          `window.AGENTBROS_FRAME_ADAPTER={id:'cancel',getDurationFrames(){return 10;},async seekFrame(){await new Promise(()=>{});}}`,
        ),
      );
      for (const delay of [0, 500]) {
        const controller = new AbortController(),
          owned: number[] = [];
        await assert.rejects(
          captureHtml({ ...base, frames: [0] }, path.join(root, "cancel-" + delay), {
            signal: controller.signal,
            onOwnedBrowser: (pid) => {
              owned.push(pid);
              if (delay === 0) controller.abort();
              else setTimeout(() => controller.abort(), delay);
            },
          }),
          /cancelled/,
        );
        assert.ok(owned.length > 0);
        for (const pid of owned) assert.equal(liveGroup(pid), false, "owned Chrome remains after cancellation");
        assert.equal(await survivor.evaluate(() => 2 + 2), 4);
      }
    } finally {
      await survivor.close();
      await unrelated.close({ silent: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "changed actual private worker implementation creates a new immutable generation; stable pin repeats",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const { root, file, base } = setup(),
      clone = path.join(root, "private-backend");
    try {
      mkdirSync(clone);
      cpSync(path.resolve("src"), path.join(clone, "src"), { recursive: true });
      mkdirSync(path.join(clone, "scripts/workers"), { recursive: true });
      const worker = path.join(clone, "scripts/workers/html-capture.ts");
      cpSync(path.resolve("scripts/workers/html-capture.ts"), worker);
      cpSync(path.resolve("package.json"), path.join(clone, "package.json"));
      symlinkSync(path.resolve("node_modules"), path.join(clone, "node_modules"), "dir");
      const backend = (await import(
        pathToFileURL(path.join(clone, "src/lib/backends/html.ts")).href
      )) as typeof import("../src/lib/backends/html");
      writeFileSync(file, fixture(`window.AGENTBROS_CAPTURE={version:1,seek(){tile.style.background='red';}}`));
      const request = { ...base, protocol: "avc-frame", frames: [0] };
      const first = await backend.captureHtml(request, path.join(root, "captures"));
      const original = readFileSync(first.frames[0].path),
        oldManifest = readFileSync(first.manifest);
      const firstReport = JSON.parse(oldManifest.toString());
      assert.equal(firstReport.provenance.implementation.sources.worker, digest(readFileSync(worker)));
      writeFileSync(
        worker,
        "// Private test-only semantic no-op implementation revision.\n" + readFileSync(worker, "utf8"),
      );
      const second = await backend.captureHtml(request, path.join(root, "captures"));
      const repeat = await backend.captureHtml(request, path.join(root, "captures"));
      assert.notEqual(second.manifest, first.manifest);
      assert.equal(second.manifest, repeat.manifest);
      assert.deepEqual(readFileSync(first.frames[0].path), original);
      assert.deepEqual(readFileSync(first.manifest), oldManifest);
      assert.equal(second.frames[0].sha256, first.frames[0].sha256);
      const secondReport = JSON.parse(readFileSync(second.manifest, "utf8"));
      assert.notEqual(
        secondReport.provenance.implementation.sources.worker,
        firstReport.provenance.implementation.sources.worker,
      );
      assert.equal(secondReport.provenance.implementation.sources.worker, digest(readFileSync(worker)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
