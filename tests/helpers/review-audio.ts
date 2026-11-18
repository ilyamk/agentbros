import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { importAsset } from "../../src/lib/assets/registry";
import { adaptLegacyProject, TimelineEditStore } from "../../src/lib/timeline-ir";
/** Small genuine PCM originals, no downloaded media/models or external generator. */
export function writeTone(file: string, frequency: number, seconds: number) {
  const samples = 48000 * seconds,
    data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(48000, 24);
  data.writeUInt32LE(96000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(Math.round(0.12 * 32767 * Math.sin((2 * Math.PI * frequency * i) / 48000)), 44 + i * 2);
  writeFileSync(file, data);
}
export function audioProject(root: string) {
  const project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  const config = {
    name: "demo",
    productName: "demo",
    formats: ["square"],
    colors: {},
    musicVolume: 0.4,
    voiceoverEnabled: false,
    scenes: [{ id: "hook", text: "Original speech", headline: "Original", visualType: "title", durationInFrames: 90 }],
  };
  writeFileSync(path.join(project, "project.json"), JSON.stringify(config));
  const ir = adaptLegacyProject(config, "demo");
  ir.tracks = ir.tracks.filter((t) => t.kind === "visual");
  const assets = [
    ["voiceover", 440, 3],
    ["music", 880, 1],
    ["sfx", 1320, 3],
  ] as const;
  for (const [kind, hz, seconds] of assets) {
    const source = path.join(project, kind + ".wav");
    writeTone(source, hz, seconds);
    const asset = importAsset({
      rootDir: root,
      projectId: "demo",
      sourceFile: source,
      provenance: { origin: "manual" },
      rights: { licence: "synthetic-test" },
    }).asset;
    ir.tracks.push({
      id: kind,
      kind,
      clips: [
        {
          id: "clip",
          assetId: asset.id,
          start: { num: 0, den: 1 },
          source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
          rate: { num: 1, den: 1 },
          transition: { kind: "cut" },
          captions:
            kind === "voiceover"
              ? [{ id: "word", text: "Original speech", start: { num: 15, den: 1 }, end: { num: 60, den: 1 } }]
              : [],
          payload: { volume: kind === "voiceover" ? 1 : 0.4, ...(kind === "music" ? { loop: true } : {}) },
        },
      ],
    });
  }
  const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
  store.initialize(ir);
  writeFileSync(
    path.join(project, "pipeline/audio-mix.json"),
    JSON.stringify({
      totalDurationSec: 3,
      tracks: [
        {
          track: "music",
          baseVolume: 0.4,
          keyframes: [
            { atSec: 1.5, volume: 0.8 },
            { atSec: 2.5, volume: 1 },
          ],
        },
        { track: "sfx", baseVolume: 0.4, keyframes: [{ atSec: 2, volume: 0.6 }] },
      ],
    }),
  );
  return { project, store, ir };
}
export function amplitude(bytes: Buffer, frequency: number, start = 0, seconds = 0.4) {
  const first = Math.round(start * 48000),
    count = Math.round(seconds * 48000);
  let sin = 0,
    cos = 0;
  for (let i = 0; i < count; i++) {
    const sample = bytes.readFloatLE((first + i) * 4),
      a = (2 * Math.PI * frequency * i) / 48000;
    sin += sample * Math.sin(a);
    cos += sample * Math.cos(a);
  }
  return (2 * Math.hypot(sin, cos)) / count;
}
