import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureHtml } from "../src/lib/backends/html";
const enabled = process.env.RUN_HTML_CAPTURE_TESTS === "1";
const runtime = process.env.HYPERFRAMES_PATCHED_ENGINE_FILE,
  gsap = process.env.HYPERFRAMES_GSAP_FILE;
function html(content = "", script = "") {
  return `<!doctype html><style>html,body{margin:0;overflow:hidden}#tile{width:64px;height:64px;background:red}</style><div data-composition-id="main" data-duration="1" data-width="64" data-height="64">${content}<div id="tile"></div></div><script>window.__timelines.main=gsap.timeline({paused:true}).to('#tile',{backgroundColor:'blue',duration:1,ease:'none'});${script}</script>`;
}
test(
  "actual owned worker captures pinned full player and child timelines deterministically and fails unsupported contracts",
  { skip: !enabled || !runtime || !gsap, timeout: 120000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hf-full-player-")),
      file = path.join(root, "index.html");
    const base = {
      assetRoot: root,
      htmlFile: file,
      width: 64,
      height: 64,
      fps: 10,
      timeoutMs: 20000,
      protocol: "hyperframes-player",
      playerRuntime: { runtimeAsset: "runtime.js", gsapAsset: "gsap.js" },
      assets: ["runtime.js", "gsap.js", "child.html"],
    };
    try {
      copyFileSync(runtime!, path.join(root, "runtime.js"));
      copyFileSync(gsap!, path.join(root, "gsap.js"));
      writeFileSync(
        path.join(root, "child.html"),
        `<!doctype html><style>#childtile{width:32px;height:32px;background:green}</style><div id="childtile"></div><script>window.__timelines.child=gsap.timeline({paused:true}).to('#childtile',{backgroundColor:'yellow',duration:.6,ease:'none'});</script>`,
      );
      writeFileSync(
        file,
        html(
          '<div data-composition-id="child" data-composition-src="child.html" data-start=".2" data-duration=".6"></div>',
        ),
      );
      const a = await captureHtml({ ...base, frames: [8, 0, 5, 2] }, path.join(root, "output"));
      const b = await captureHtml({ ...base, frames: [0, 2, 5, 8] }, path.join(root, "output"));
      for (const f of a.frames) assert.equal(f.sha256, b.frames.find((x) => x.frame === f.frame)!.sha256);
      assert.notEqual(a.frames[0].sha256, a.frames[1].sha256);
      const pixel = (frame: number) => [
        ...execFileSync("ffmpeg", [
          "-v",
          "error",
          "-i",
          a.frames.find((x) => x.frame === frame)!.path,
          "-vf",
          "crop=1:1:8:8,format=rgb24",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "pipe:1",
        ]),
      ];
      assert.deepEqual(pixel(2), [0, 128, 0], "native child starts green at its .2s host in-point");
      assert.deepEqual(pixel(5), [128, 192, 0], "native child advances its own .3s source clock");
      const again = await captureHtml({ ...base, frames: [8, 0, 5, 2] }, path.join(root, "output"));
      assert.equal(again.manifest, a.manifest);
      for (const f of a.frames) assert.equal(f.sha256, again.frames.find((x) => x.frame === f.frame)!.sha256);
      const video = await captureHtml({ ...base, frames: [0, 1, 2, 3], encode: "mp4" }, path.join(root, "output"));
      const report = JSON.parse(readFileSync(video.manifest, "utf8"));
      assert.equal(report.video.audio, false);
      assert.equal(report.video.fps, 10);
      assert.equal(report.video.width, 64);
      assert.equal(report.video.height, 64);
      assert.equal(report.video.durationSec, 0.4);
      assert.equal(report.limits.fullPlayerSubset, true);
      assert.equal(report.limits.hyperframesEngine, false);
      assert.equal(report.frameAdapters[0].durationFrames, 10);
      assert.equal(report.frameAdapters[0].childLoads, 1);
      assert.equal(report.frameAdapters[0].nativeManifest.fps.numerator, 10);
      writeFileSync(
        file,
        html(
          '<div data-composition-id="inline" data-start=".2" data-duration=".6"><div id="inlineTile" style="width:32px;height:32px;background:green"></div></div>',
          `window.__timelines.inline=gsap.timeline({paused:true}).to('#inlineTile',{backgroundColor:'yellow',duration:.6,ease:'none'});`,
        ),
      );
      const inline = await captureHtml({ ...base, frames: [2, 5] }, path.join(root, "inline"));
      assert.notEqual(inline.frames[0].sha256, inline.frames[1].sha256);
      const inlineReport = JSON.parse(readFileSync(inline.manifest, "utf8"));
      assert.equal(inlineReport.frameAdapters[0].childLoads, 0);
      assert.ok(inlineReport.frameAdapters[0].nativeManifest.clips.some((c: { id: string }) => c.id === "inline"));
      for (const script of [
        `window.__player={getDuration:()=>1,renderSeek:()=>{},pause:()=>{}};`,
        `window.__renderReady=true;`,
        `window.__clipManifest={};`,
        `window.__hfWaitForSeekCompletion=async()=>{};`,
        "gsap.ticker.add(()=>{});",
        "requestAnimationFrame(()=>{});",
        "setTimeout(()=>{},0);",
        `document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{},0));`,
        `fetch('https://denied.invalid/x');`,
      ]) {
        writeFileSync(file, html("", script));
        await assert.rejects(
          captureHtml({ ...base, frames: [0] }, path.join(root, "failure")),
          /guard|clock|network|Unsupported|shadowing/,
        );
      }
      for (const content of [
        '<div style="animation:example 1s infinite"></div><style>@keyframes example{from{opacity:0}to{opacity:1}}</style>',
        '<video src="source.mp4"></video>',
        "<audio></audio>",
        "<canvas></canvas>",
        '<div data-composition-id="missing" data-duration="1"></div>',
      ]) {
        writeFileSync(file, html(content));
        await assert.rejects(
          captureHtml({ ...base, frames: [0] }, path.join(root, "failure")),
          /unsupported|timeline not ready/i,
        );
      }
      writeFileSync(
        file,
        html('<div data-composition-id="child" data-composition-src="child.html" data-duration=".6"></div>'),
      );
      writeFileSync(
        path.join(root, "child.html"),
        '<div data-composition-id="grandchild" data-composition-src="child.html"></div>',
      );
      await assert.rejects(
        captureHtml({ ...base, frames: [0] }, path.join(root, "failure")),
        /Recursive|guard violation/,
      );
      for (const inherited of ["constructor", "toString", "hasOwnProperty"]) {
        writeFileSync(
          file,
          html(`<div data-composition-id="inherited" data-composition-src="${inherited}" data-duration=".6"></div>`),
        );
        await assert.rejects(
          captureHtml({ ...base, frames: [0] }, path.join(root, "failure")),
          /Full player denied child source/,
          "inherited object names must fail the explicit snapshot allowlist",
        );
      }
      writeFileSync(
        file,
        html(
          Array.from({ length: 33 }, (_, i) => `<div data-composition-id="many-${i}" data-duration="1"></div>`).join(
            "",
          ),
        ),
      );
      await assert.rejects(
        captureHtml({ ...base, frames: [0] }, path.join(root, "failure")),
        /composition count bound/,
      );
      writeFileSync(
        file,
        html(
          Array.from({ length: 9 }, (_, i) => `<div data-composition-id="deep-${i}" data-duration="1">`).join("") +
            "</div>".repeat(9),
        ),
      );
      await assert.rejects(
        captureHtml({ ...base, frames: [0] }, path.join(root, "failure")),
        /composition depth bound/,
      );
      writeFileSync(path.join(root, "child.html"), "x".repeat(128 * 1024 + 1));
      writeFileSync(
        file,
        html('<div data-composition-id="child" data-composition-src="child.html" data-duration=".6"></div>'),
      );
      await assert.rejects(
        captureHtml({ ...base, frames: [0] }, path.join(root, "failure")),
        /byte bound|guard violation/,
      );
      writeFileSync(path.join(root, "child.html"), "<div>child</div>");
      writeFileSync(
        file,
        html(
          Array.from(
            { length: 17 },
            (_, i) =>
              `<div data-composition-id="loads-${i}" data-composition-src="child.html" data-duration=".6"></div>`,
          ).join(""),
        ),
      );
      await assert.rejects(
        captureHtml({ ...base, frames: [0] }, path.join(root, "failure")),
        /denied child source|guard violation/,
      );
      writeFileSync(
        file,
        html(
          "",
          `window.__hf=window.__hf||{};window.__hf.buildReady={rejected:Promise.reject(Error('fixture rejection'))};`,
        ),
      );
      await assert.rejects(captureHtml({ ...base, frames: [0] }, path.join(root, "failure")), /build-ready rejected/);
      if (process.platform !== "win32") {
        writeFileSync(
          file,
          html("", `window.__hf=window.__hf||{};window.__hf.buildReady={pending:new Promise(()=>{})};`),
        );
        const owned: number[] = [];
        await assert.rejects(
          captureHtml({ ...base, timeoutMs: 4000, frames: [0] }, path.join(root, "failure"), {
            onOwnedBrowser: (pid) => owned.push(pid),
          }),
          /timeout/,
        );
        assert.ok(owned.length > 0);
        const rows = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" }).split("\n");
        for (const pid of owned)
          assert.equal(
            rows.some((row) => {
              const x = row.trim().split(/\s+/);
              return Number(x[1]) === pid && !x[2]?.startsWith("Z");
            }),
            false,
            "full-player pending build must reap exact owned Chrome",
          );
      }
      writeFileSync(file, html());
      await assert.rejects(captureHtml({ ...base, frames: [10] }, path.join(root, "failure")), /outside duration/);
      writeFileSync(path.join(root, "runtime.js"), "window.__player={};");
      await assert.rejects(captureHtml({ ...base, frames: [0] }, path.join(root, "failure")), /audited pin/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
