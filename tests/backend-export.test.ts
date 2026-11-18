import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { exportOtio, exportFcpxml, captionSidecars, type ExportAssets } from "../src/lib/backends/export";
import { fraction as f } from "../src/lib/timeline-ir/rational";
import type { TimelineIR } from "../src/types/timeline";
export function ir(rate = 1): TimelineIR {
  return {
    version: 1,
    projectId: "test & export",
    timebase: f(30),
    tracks: [
      {
        id: "visual",
        kind: "visual",
        clips: [
          {
            id: "hero",
            assetId: "video",
            start: f(15),
            source: { start: f(12), end: f(60), timebase: f(24) },
            rate: f(rate),
            transition: { kind: "cut" },
            captions: [{ id: "word", text: "hello", start: f(12), end: f(24) }],
          },
        ],
      },
      {
        id: "voice",
        kind: "voiceover",
        clips: [
          {
            id: "voice",
            assetId: "audio",
            start: f(0),
            source: { start: f(0), end: f(48000), timebase: f(48000) },
            rate: f(1),
            transition: { kind: "cut" },
            captions: [],
          },
        ],
      },
    ],
  };
}
export const assets: ExportAssets = {
  video: {
    path: path.resolve("fixture video.mp4"),
    kind: "video",
    durationFrames: f(240),
    timebase: f(24),
    width: 1920,
    height: 1080,
    hasAudio: true,
  },
  audio: { path: path.resolve("fixture.wav"), kind: "audio", durationFrames: f(48000), timebase: f(48000) },
};
test("OTIO tracks, trims and rate retain actual output duration plus exact fractional source metadata", () => {
  const result = exportOtio(ir(2), assets) as any;
  const video = result.tracks.children[0];
  assert.equal(video.kind, "Video");
  assert.equal(video.children[0].OTIO_SCHEMA, "Gap.1");
  assert.equal(video.children[0].source_range.duration.value, 15);
  const clip = video.children[1];
  assert.equal(clip.OTIO_SCHEMA, "Clip.2");
  assert.equal(clip.source_range.start_time.value, 12);
  assert.equal(clip.source_range.duration.value, 24);
  assert.equal(clip.source_range.duration.rate, 24);
  assert.equal(clip.effects[0].time_scalar, 2);
  assert.deepEqual(clip.metadata.aiVideoCreator.sourceEnd, f(60));
  assert.deepEqual(clip.metadata.aiVideoCreator.exactOutputDuration, f(30));
  assert.match(clip.media_references.DEFAULT_MEDIA.target_url, /fixture%20video.mp4$/);
  assert.equal(result.tracks.children[1].kind, "Audio");
  assert.deepEqual(result.metadata.aiVideoCreator.exactIR.timebase, f(30));
});
test("FCPXML exports source FPS, trim and independent connected audio/video lanes with escaped XML", () => {
  const xml = exportFcpxml(ir(), assets);
  assert.match(xml, /frameDuration="1\/24s"/);
  assert.match(xml, /frameDuration="1\/30s"/);
  assert.match(xml, /name="test &amp; export"/);
  assert.match(xml, /name="hero"[^>]+lane="1"[^>]+offset="1\/2s"[^>]+start="1\/2s"[^>]+duration="2\/1s"/);
  assert.match(xml, /name="voice"[^>]+lane="-1"/);
  assert.match(xml, /hasVideo="1"[^>]+hasAudio="1"/);
});
test("fractional 30000/1001 source rates remain rational in FCPXML and authoritative metadata", () => {
  const timeline = ir();
  timeline.tracks[0]!.clips[0]!.source.timebase = f(30000, 1001);
  const source = { ...assets, video: { ...assets.video!, timebase: f(30000, 1001) } };
  assert.match(exportFcpxml(timeline, source), /frameDuration="1001\/30000s"/);
  assert.deepEqual(
    (exportOtio(timeline, source) as any).metadata.aiVideoCreator.exactIR.tracks[0].clips[0].source.timebase,
    f(30000, 1001),
  );
});
test("captions follow source trim/rate with exact frames and outward SRT millisecond rounding", () => {
  const captions = captionSidecars(ir(2));
  assert.deepEqual(captions.exact.captions[0]!.start, f(15));
  assert.deepEqual(captions.exact.captions[0]!.end, f(45, 2));
  assert.match(captions.srt, /00:00:00,500 --> 00:00:00,750/);
});
test("unsupported retime/crossfade/procedural payload and missing/fps mismatched assets fail explicitly", () => {
  assert.throws(() => exportFcpxml(ir(2), assets), /retiming/);
  const payload = ir();
  payload.tracks[0]!.clips[0]!.payload = { component: "CustomComposition" };
  assert.throws(() => exportOtio(payload, assets), /baked/);
  assert.throws(() => exportOtio(ir(), {}), /Missing/);
  assert.throws(() => exportOtio(ir(), { ...assets, video: { ...assets.video!, timebase: f(25) } }), /fps/);
});
test("FCPXML is parsed by a real local XML parser; export rejects attribute-injection metadata", async () => {
  const { execFileSync } = await import("node:child_process");
  const xml = exportFcpxml(ir(), assets);
  execFileSync(
    "python3",
    [
      "-c",
      'import xml.etree.ElementTree as ET,sys; root=ET.fromstring(sys.stdin.read()); assert root.tag=="fcpxml"; assert len(root.findall(".//asset-clip"))==2',
    ],
    { input: xml },
  );
  assert.throws(() =>
    exportFcpxml(ir(), { ...assets, video: { ...assets.video!, width: '1920" injected="1' as any } }),
  );
});
