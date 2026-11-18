import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { captureHtml, HtmlCaptureSchema } from "../src/lib/backends/html";
import { mediaProbe } from "../src/lib/audio/analysis";
import { digest } from "../src/lib/jobs/model-artifacts";
const browserTests = process.env.RUN_HTML_CAPTURE_TESTS === "1";
const fixture = (script: string, body = '<canvas id="canvas" width="1920" height="1920"></canvas>') =>
  `<!doctype html><style>html,body{margin:0;overflow:hidden}canvas{position:absolute;inset:0}</style>${body}<script>${script}</script>`;
test("HTML schema rejects unbounded dimensions/frame batches and duplicate frames", () => {
  assert.throws(() =>
    HtmlCaptureSchema.parse({
      htmlFile: "x",
      assetRoot: ".",
      width: 9999,
      height: 1080,
      frames: [0],
    }),
  );
  assert.throws(() =>
    HtmlCaptureSchema.parse({
      htmlFile: "x",
      assetRoot: ".",
      width: 1080,
      height: 1080,
      frames: [1, 1],
    }),
  );
});
test(
  "real HTML pixels are deterministic by absolute frame, __hf adapter and three dimensions publish hashes",
  { skip: !browserTests, timeout: 120000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "html-test-"));
    const file = path.join(root, "index.html");
    writeFileSync(
      file,
      fixture(
        `window.AGENTBROS_CAPTURE={version:1,seek(f,c){const ctx=canvas.getContext('2d');ctx.fillStyle=f===0?'red':'blue';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle='white';ctx.fillRect(f*5,20,10,10);}}`,
      ),
    );
    const base = {
      htmlFile: file,
      assetRoot: root,
      fps: 30,
      width: 1080,
      height: 1080,
    };
    try {
      const random = await captureHtml({ ...base, frames: [6, 0, 3] }, path.join(root, "out"));
      const sequential = await captureHtml({ ...base, frames: [0, 3, 6] }, path.join(root, "out"));
      for (const a of random.frames) {
        assert.equal(a.sha256, sequential.frames.find((b) => b.frame === a.frame)!.sha256);
        assert.equal(digest(readFileSync(a.path)), a.sha256);
      }
      assert.notEqual(random.frames[0].sha256, random.frames[1].sha256);
      const repeat = await captureHtml({ ...base, frames: [6, 0, 3] }, path.join(root, "out"));
      assert.equal(repeat.manifest, random.manifest);
      for (const [width, height] of [
        [1080, 1920],
        [1920, 1080],
      ]) {
        const result = await captureHtml({ ...base, width, height, frames: [3] }, path.join(root, "out"));
        const bytes = readFileSync(result.outputs[0]);
        assert.equal(bytes.readUInt32BE(16), width);
        assert.equal(bytes.readUInt32BE(20), height);
      }
      writeFileSync(
        file,
        fixture(
          `window.__hf={duration:2,seek(t){const ctx=canvas.getContext('2d');ctx.fillStyle=t===0?'red':'blue';ctx.fillRect(0,0,1080,1080)}}`,
        ),
      );
      const hf = await captureHtml({ ...base, protocol: "hyperframes-seek", frames: [0, 15] }, path.join(root, "out"));
      assert.notEqual(hf.frames[0].sha256, hf.frames[1].sha256);
      assert.equal(JSON.parse(readFileSync(hf.manifest, "utf8")).protocol, "hyperframes-seek");
      await assert.rejects(
        captureHtml({ ...base, protocol: "hyperframes-seek", frames: [60] }, path.join(root, "out")),
        /duration/,
      );
      const encoded = await captureHtml(
        {
          ...base,
          protocol: "hyperframes-seek",
          encode: "mp4",
          frames: [0, 1, 2],
        },
        path.join(root, "out"),
      );
      const receipt = JSON.parse(readFileSync(encoded.manifest, "utf8"));
      assert.equal(digest(readFileSync(receipt.video.path)), receipt.video.sha256);
      const probe = mediaProbe(receipt.video.path);
      assert.ok(Math.abs(Number(probe.format.duration) - 0.1) < 0.02);
      assert.equal(
        probe.streams.some((s) => s.codec_type === "audio"),
        false,
      );
      assert.throws(() => HtmlCaptureSchema.parse({ ...base, encode: "mp4", frames: [0, 2] }));
      assert.notEqual(encoded.manifest, random.manifest);
      const cliRequest = path.join(root, "cli-request.json");
      writeFileSync(cliRequest, JSON.stringify({ ...base, protocol: "hyperframes-seek", frames: [0] }));
      const stdout = execFileSync(
        process.execPath,
        [
          path.resolve("node_modules/tsx/dist/cli.mjs"),
          path.resolve("scripts/capture-html.ts"),
          "--request",
          cliRequest,
          "--output",
          path.join(root, "cli-out"),
        ],
        { encoding: "utf8" },
      );
      assert.equal(stdout.trim().split("\n").length, 1);
      assert.equal(JSON.parse(stdout).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test(
  "real worker rejects escaped assets, external network/clocks, missing protocol and supports cancellation",
  { skip: !browserTests, timeout: 60000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "html-reject-")),
      file = path.join(root, "index.html");
    const base = {
      htmlFile: file,
      assetRoot: root,
      width: 64,
      height: 64,
      frames: [0],
    };
    try {
      writeFileSync(
        file,
        fixture('window.AGENTBROS_CAPTURE={version:1,seek(){}};fetch("https://example.com/key").catch(()=>{})'),
      );
      await assert.rejects(captureHtml(base, path.join(root, "out")), /fetch|violation/);
      writeFileSync(file, fixture("window.AGENTBROS_CAPTURE={version:1,seek(){setTimeout(()=>{},10)}}"));
      await assert.rejects(captureHtml(base, path.join(root, "out")), /setTimeout/);
      writeFileSync(
        file,
        fixture("window.AGENTBROS_CAPTURE={version:1,seek(){}}", '<img src="https://example.com/key">'),
      );
      await assert.rejects(captureHtml(base, path.join(root, "out")), /violation|EncodingError|decode/);
      writeFileSync(file, fixture('window.AGENTBROS_CAPTURE={version:1,seek(){new WebSocket("wss://example.com")}}'));
      await assert.rejects(captureHtml(base, path.join(root, "out")), /WebSocket/);
      writeFileSync(file, fixture("window.AGENTBROS_CAPTURE={version:1,seek(){}}", '<audio src="clip.mp3"></audio>'));
      await assert.rejects(captureHtml(base, path.join(root, "out")), /Audio|Blocked capture request/);
      writeFileSync(file, fixture("window.AGENTBROS_CAPTURE={version:1,seek(){}}", "<audio></audio>"));
      await assert.rejects(captureHtml(base, path.join(root, "out")), /Audio/);
      writeFileSync(file, fixture(""));
      await assert.rejects(captureHtml(base, path.join(root, "out")), /seek contract/);
      await assert.rejects(captureHtml({ ...base, assets: ["../secret.png"] }, path.join(root, "out")), /Unsafe/);
      writeFileSync(path.join(root, "asset.png"), "invalid");
      symlinkSync(path.join(root, "asset.png"), path.join(root, "alias.png"));
      await assert.rejects(captureHtml({ ...base, assets: ["alias.png"] }, path.join(root, "out")), /Symlink/);
      const controller = new AbortController();
      writeFileSync(file, fixture("window.AGENTBROS_CAPTURE={version:1,ready:new Promise(()=>{}),seek(){}}"));
      const promise = captureHtml({ ...base, timeoutMs: 15000 }, path.join(root, "cancel"), {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 500);
      await assert.rejects(promise, /cancelled/);
      assert.equal(existsSync(path.join(root, "cancel")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test(
  "local video uses exact FFmpeg source-time frames and records timing",
  { skip: !browserTests, timeout: 60000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "html-media-")),
      file = path.join(root, "index.html");
    try {
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=red:s=64x64:r=30:d=1",
        "-f",
        "lavfi",
        "-i",
        "color=blue:s=64x64:r=30:d=1",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0",
        "-c:v",
        "libvpx",
        "-y",
        path.join(root, "clip.webm"),
      ]);
      writeFileSync(
        file,
        fixture(
          "window.AGENTBROS_CAPTURE={version:1,seek(){}}",
          '<video src="clip.webm" style="width:64px;height:64px" data-avc-source-start-sec="0.5" data-avc-rate="2"></video>',
        ),
      );
      const result = await captureHtml(
        {
          htmlFile: file,
          assetRoot: root,
          assets: ["clip.webm"],
          width: 64,
          height: 64,
          fps: 30,
          frames: [0, 15],
        },
        path.join(root, "out"),
      );
      assert.notEqual(result.frames[0].sha256, result.frames[1].sha256);
      const receipt = JSON.parse(readFileSync(result.manifest, "utf8"));
      assert.deepEqual(
        receipt.media.map((m: { timeSec: number }) => m.timeSec),
        [0.5, 1.5],
      );
      const pixels = (file: string) =>
        execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
      const red = pixels(result.frames[0].path),
        blue = pixels(result.frames[1].path);
      assert.ok(red[0] > 200 && red[2] < 50);
      assert.ok(blue[2] > 200 && blue[0] < 50);
      writeFileSync(
        file,
        fixture("window.__hf={duration:3,seek(){}}", '<video src="clip.webm" data-start="1"></video>'),
      );
      await assert.rejects(
        captureHtml(
          {
            htmlFile: file,
            assetRoot: root,
            assets: ["clip.webm"],
            protocol: "hyperframes-seek",
            width: 64,
            height: 64,
            frames: [0],
          },
          path.join(root, "unsupported"),
        ),
        /Native Hyperframes media timing/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("snapshot limits reject before oversized HTML/asset reads; nonfiles and parent links reject", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "html-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "index.html");
  writeFileSync(file, fixture("window.AGENTBROS_CAPTURE={version:1,seek(){}}"));
  const base = {
    htmlFile: file,
    assetRoot: root,
    width: 64,
    height: 64,
    frames: [0],
  };
  const oversizedHtml = path.join(root, "oversized.html"),
    asset = path.join(root, "big.png"),
    aggregateLast = path.join(root, "c.png");
  for (const [target, size] of [
    [oversizedHtml, 1024 * 1024 + 1],
    [asset, 32 * 1024 * 1024 + 1],
    [path.join(root, "a.png"), 32 * 1024 * 1024],
    [path.join(root, "b.png"), 32 * 1024 * 1024],
    [aggregateLast, 1],
  ] as const) {
    const descriptor = fs.openSync(target, "w");
    fs.ftruncateSync(descriptor, size);
    fs.closeSync(descriptor);
  }
  const nativeRead = fs.readFileSync;
  const mocked = t.mock.method(fs, "readFileSync", (target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(target) === oversizedHtml || String(target) === asset || String(target) === aggregateLast)
      throw new Error("Oversized input read attempted");
    return Reflect.apply(nativeRead, fs, [target, ...args]);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      captureHtml({ ...base, htmlFile: oversizedHtml }, path.join(root, "out")),
      /HTML exceeds 1MiB/,
    );
    await assert.rejects(
      captureHtml({ ...base, assets: ["big.png"] }, path.join(root, "out")),
      /snapshot exceeds limits/,
    );
    await assert.rejects(
      captureHtml({ ...base, assets: ["a.png", "b.png", "c.png"] }, path.join(root, "out")),
      /snapshot exceeds limits/,
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  fs.mkdirSync(path.join(root, "directory.png"));
  await assert.rejects(captureHtml({ ...base, assets: ["directory.png"] }, path.join(root, "out")), /regular files/);
  fs.mkdirSync(path.join(root, "actual/child"), { recursive: true });
  fs.mkdirSync(path.join(root, "lexical"));
  symlinkSync(path.join(root, "actual"), path.join(root, "lexical/link"));
  await assert.rejects(captureHtml(base, path.join(root, "lexical/link/child")), /Symlink/);
  writeFileSync(path.join(root, "actual/child/index.html"), fixture("window.AGENTBROS_CAPTURE={version:1,seek(){}}"));
  await assert.rejects(
    captureHtml({ ...base, htmlFile: path.join(root, "lexical/link/child/index.html") }, path.join(root, "out")),
    /Symlink/,
  );
});

test(
  "actual Chromium rejects unsupported elements appended during seek and accepts allowlisted CSS",
  { skip: !browserTests, timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "html-dynamic-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "index.html");
    const base = {
      htmlFile: file,
      assetRoot: root,
      width: 64,
      height: 64,
      frames: [0],
    };
    for (const body of [
      "<audio></audio>",
      '<svg width="64" height="64"><rect width="64" height="64" fill="red"><animate attributeName="fill" values="red;blue" dur="1s" repeatCount="indefinite"/></rect></svg>',
    ]) {
      writeFileSync(
        file,
        fixture(`window.AGENTBROS_CAPTURE={version:1,seek(){document.body.innerHTML=${JSON.stringify(body)}}}`),
      );
      await assert.rejects(captureHtml(base, path.join(root, "out")), /unsupported after seek/);
      assert.equal(existsSync(path.join(root, "out")), false);
    }
    writeFileSync(path.join(root, "style.css"), "html,body{margin:0;background:rgb(255,0,0)}");
    writeFileSync(
      file,
      '<link rel="stylesheet" href="style.css"><script>window.AGENTBROS_CAPTURE={version:1,seek(){}}</script>',
    );
    const result = await captureHtml({ ...base, assets: ["style.css"] }, path.join(root, "css-output"));
    const pixels = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      result.frames[0].path,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    const offset = (32 * 64 + 32) * 3;
    assert.ok(
      pixels[offset] > 240 && pixels[offset + 1] < 10 && pixels[offset + 2] < 10,
      "Local allowlisted CSS must style the actual captured frame",
    );
  },
);

test(
  "decoded media uses reserved route despite a colliding legacy generated asset name",
  { skip: !browserTests, timeout: 60000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "html-collision-"));
    try {
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
        "color=blue:s=16x16",
        "-frames:v",
        "1",
        "-y",
        path.join(root, "__capture-0-0.png"),
      ]);
      writeFileSync(
        path.join(root, "index.html"),
        fixture(
          "window.AGENTBROS_CAPTURE={version:1,seek(){}}",
          '<video src="source.mp4" style="position:absolute;inset:0;width:64px;height:64px"></video>',
        ),
      );
      const base = {
        htmlFile: path.join(root, "index.html"),
        assetRoot: root,
        width: 64,
        height: 64,
        fps: 10,
        frames: [0],
      };
      const good = await captureHtml({ ...base, assets: ["source.mp4"] }, path.join(root, "a"));
      const collision = await captureHtml(
        { ...base, assets: ["source.mp4", "__capture-0-0.png"] },
        path.join(root, "b"),
      );
      assert.equal(
        good.frames[0].sha256,
        collision.frames[0].sha256,
        "allowlisted fake PNG must not replace decoded source frame",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
