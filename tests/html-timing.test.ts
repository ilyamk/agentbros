import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { HtmlCaptureSchema, captureHtml } from "../src/lib/backends/html";
import { flattenHtmlTiming, HtmlTimingSchema } from "../src/lib/backends/html-timing";
import { importAsset } from "../src/lib/assets/registry";
import { mediaProbe } from "../src/lib/audio/analysis";
const base = {
  htmlFile: "x",
  assetRoot: ".",
  width: 64,
  height: 64,
  fps: 10,
  frames: [0],
  assets: ["tone.wav"],
  encode: "mp4",
};
test("nested graph validates parent clock, bounded rate/depth and explicit audio", () => {
  const timing = HtmlTimingSchema.parse({
    version: 1,
    nodes: [
      { id: "parent", startFrame: 10, durationFrames: 20, rate: 2 },
      { id: "child", parent: "parent", startFrame: 2, durationFrames: 4, rate: 0.5, selector: "#child" },
    ],
  });
  const n = flattenHtmlTiming(timing, 10)[1];
  assert.equal(n.startSec, 1.1);
  assert.equal(n.endSec, 1.3);
  assert.equal(n.rate, 1);
  for (const nodes of [
    [{ id: "a", parent: "a", startFrame: 0, durationFrames: 1 }],
    [{ id: "a", parent: "missing", startFrame: 0, durationFrames: 1 }],
    [
      { id: "a", startFrame: 0, durationFrames: 1 },
      { id: "b", parent: "a", startFrame: 0, durationFrames: 2 },
    ],
    [{ id: "a", startFrame: 0, durationFrames: 1, sourceStartSec: -1 }],
  ])
    assert.throws(() => HtmlCaptureSchema.parse({ ...base, timing: { version: 1, nodes } }));
  assert.throws(() =>
    HtmlCaptureSchema.parse({
      ...base,
      timing: {
        version: 1,
        nodes: Array.from({ length: 10 }, (_, i) => ({
          id: `n${i}`,
          parent: i ? `n${i - 1}` : undefined,
          startFrame: 0,
          durationFrames: 1,
        })),
      },
    }),
  );
  assert.throws(() =>
    HtmlCaptureSchema.parse({
      ...base,
      encode: "png",
      timing: { version: 1, nodes: [{ id: "a", startFrame: 0, durationFrames: 1, audioAsset: "tone.wav" }] },
    }),
  );
  assert.throws(() =>
    HtmlCaptureSchema.parse({
      ...base,
      timing: { version: 1, nodes: [{ id: "a", startFrame: 0, durationFrames: 1, audioAsset: "../tone.wav" }] },
    }),
  );
});
test(
  "actual timed nested video and audio capture: random seek, exact PCM, mux and source bounds",
  { skip: process.env.RUN_HTML_CAPTURE_TESTS !== "1", timeout: 120000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "html-timing-"));
    try {
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=2",
        "-y",
        path.join(root, "tone.wav"),
      ]);
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=red:s=64x64:r=10:d=2",
        "-an",
        "-y",
        path.join(root, "take.mp4"),
      ]);
      writeFileSync(
        path.join(root, "index.html"),
        '<style>body{margin:0;background:blue}video{width:64px;height:64px}</style><div id="group"><video id="take" src="take.mp4"></video></div><script>window.AGENTBROS_CAPTURE={version:1,seek(){}}</script>',
      );
      const timing = {
        version: 1,
        nodes: [
          { id: "group", selector: "#group", startFrame: 1, durationFrames: 3, rate: 2 },
          { id: "take", parent: "group", selector: "#take", startFrame: 1, durationFrames: 4, sourceStartSec: 0.2 },
          {
            id: "tone",
            parent: "group",
            startFrame: 0,
            durationFrames: 4,
            audioAsset: "tone.wav",
            sourceStartSec: 0.1,
            volume: 0.5,
          },
        ],
      };
      const input = {
        ...base,
        htmlFile: path.join(root, "index.html"),
        assetRoot: root,
        assets: ["tone.wav", "take.mp4"],
        timing,
        frames: [0, 1, 2, 3],
      };
      const result = await captureHtml(input, path.join(root, "out"));
      const manifest = JSON.parse(readFileSync(result.manifest, "utf8"));
      assert.equal(manifest.video.audio, true);
      assert.equal(manifest.audio.pcmSamples, 19200);
      assert.equal(manifest.audio.tracks[0].startSample, 4800);
      assert.equal(manifest.audio.tracks[0].rate, 2);
      assert.ok(manifest.audio.pcmPeak > 0.001);
      assert.ok(manifest.audio.pcmPeak < 0.2);
      const decoded = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        result.outputs.at(-1)!,
        "-map",
        "0:a:0",
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        "48000",
        "pipe:1",
      ]);
      const peak = (from: number, to: number) => {
        let p = 0;
        for (let i = from * 4; i < to * 4; i += 4) p = Math.max(p, Math.abs(decoded.readFloatLE(i)));
        return p;
      };
      assert.ok(peak(0, 4000) < 0.001);
      assert.ok(peak(6000, 12000) > 0.01);
      assert.ok(mediaProbe(result.outputs.at(-1)!).streams.some((s) => s.codec_type === "audio"));
      mkdirSync(path.join(root, "public/projects/local-html"), { recursive: true });
      writeFileSync(path.join(root, "public/projects/local-html/project.json"), "{}");
      const imported = importAsset({
        rootDir: root,
        projectId: "local-html",
        sourceFile: result.outputs.at(-1)!,
        provenance: { origin: "manual" },
      });
      assert.equal(imported.asset.hash, manifest.video.sha256);
      assert.equal(imported.asset.status, "candidate");
      assert.equal(imported.asset.media.hasAudio, true);
      const random = await captureHtml(
        {
          ...input,
          encode: "png",
          assets: ["take.mp4"],
          timing: { version: 1, nodes: timing.nodes.filter((n) => n.id !== "tone") },
          frames: [3, 0, 2],
        },
        path.join(root, "out"),
      );
      for (const f of random.frames) assert.equal(f.sha256, result.frames.find((a) => a.frame === f.frame)!.sha256);
      const repeat = await captureHtml(input, path.join(root, "out"));
      assert.equal(repeat.manifest, result.manifest);
      await assert.rejects(
        captureHtml(
          {
            ...input,
            timing: {
              version: 1,
              nodes: [{ id: "bad", startFrame: 0, durationFrames: 4, audioAsset: "tone.wav", sourceStartSec: 1.9 }],
            },
          },
          path.join(root, "out"),
        ),
        /outside original/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
