import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hashFile } from "../assets/registry";
import { analyzeAudio } from "./analysis";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { fraction, numeric } from "../timeline-ir/rational";
import type { TimelineIR } from "../../types/timeline";

export const ProceduralSfxSchema = z
  .object({
    kind: z.enum(["click", "pop", "whoosh", "riser", "impact", "chime"]),
    seed: z.number().int().min(1).max(4294967295),
    durationSec: z.number().min(0.03).max(3).default(0.4),
    gain: z.number().min(0.001).max(0.8).default(0.35),
  })
  .strict();
export function synthesizeSfx(output: string, input: z.input<typeof ProceduralSfxSchema>) {
  const spec = ProceduralSfxSchema.parse(input);
  if (existsSync(output)) throw new Error("SFX output exists; choose a new take");
  const rate = 48000,
    length = Math.round(rate * spec.durationSec),
    bytes = Buffer.alloc(44 + length * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(length * 2, 40);
  let seed = spec.seed,
    peak = 0,
    sum = 0;
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const noise = (seed >>> 0) / 2147483648 - 1,
      t = i / rate,
      position = i / length;
    const envelope =
      spec.kind === "riser"
        ? Math.pow(position, 2) * Math.min(1, (1 - position) / 0.01)
        : Math.min(1, t / 0.004) * Math.pow(1 - position, spec.kind === "whoosh" ? 1 : 3);
    const tone =
      spec.kind === "click"
        ? noise * Math.exp(-t * 90)
        : spec.kind === "pop"
          ? Math.sin(2 * Math.PI * (500 * t - 180 * t * t))
          : spec.kind === "whoosh"
            ? noise * Math.sin(Math.PI * position)
            : spec.kind === "riser"
              ? 0.6 * noise + 0.4 * Math.sin(2 * Math.PI * (120 * t + 200 * position * t))
              : spec.kind === "impact"
                ? 0.65 * Math.sin(2 * Math.PI * 65 * t) + 0.35 * noise * Math.exp(-t * 25)
                : 0.6 * Math.sin(2 * Math.PI * 880 * t) + 0.3 * Math.sin(2 * Math.PI * 1320 * t);
    const value = tone * envelope * spec.gain;
    peak = Math.max(peak, Math.abs(value));
    sum += value * value;
    bytes.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  writeFileSync(output, bytes);
  return {
    sourceSha256: hashFile(output),
    spec,
    sampleRate: rate,
    samples: length,
    samplePeak: peak,
    rms: Math.sqrt(sum / length),
    measurement: analyzeAudio(output),
  };
}
export const SfxCueSchema = z
  .object({
    id: z.string().min(1),
    event: z.string().min(1),
    trackId: z.string().min(1),
    clipId: z.string().min(1),
    anchor: z.enum(["start", "end"]),
    offsetFrames: z.number().int().default(0),
    assetId: z.string().min(1),
    durationSec: z.number().positive().max(30),
    gain: z.number().min(0).max(1).default(0.35),
  })
  .strict();
/** Pure plan: same frame anchors as video; attach through a versioned edit/review. */
export function attachSfxCues(input: TimelineIR, cues: z.input<typeof SfxCueSchema>[]) {
  const ir = structuredClone(input),
    compiled = compileTimelineIR(ir),
    ids = new Set<string>();
  const clips = cues.map((raw) => {
    const cue = SfxCueSchema.parse(raw);
    if (ids.has(cue.id)) throw new Error("Duplicate cue ID");
    ids.add(cue.id);
    const owner = compiled.tracks
      .find((track) => track.id === cue.trackId)
      ?.clips.find((clip) => clip.id === cue.clipId);
    if (!owner) throw new Error(`Cue owner missing: ${cue.id}`);
    const start = numeric(cue.anchor === "start" ? owner.start : owner.end) + cue.offsetFrames,
      duration = cue.durationSec * numeric(ir.timebase);
    if (start < 0 || start + duration > numeric(compiled.duration))
      throw new Error(`Cue/tail outside delivery: ${cue.id}`);
    const rational = (value: number) => fraction(Math.round(value * 1000000), 1000000);
    return {
      id: cue.id,
      assetId: cue.assetId,
      start: rational(start),
      source: {
        start: fraction(0),
        end: rational(duration),
        timebase: ir.timebase,
      },
      rate: fraction(1),
      transition: { kind: "cut" as const },
      captions: [],
      payload: {
        volume: cue.gain,
        cueEvent: cue.event,
        cueOwner: { trackId: cue.trackId, clipId: cue.clipId },
      },
    };
  });
  // Separate tracks allow simultaneous sound tails; the compiler forbids overlap on one track.
  for (const clip of clips) {
    const id = `cue:${clip.id}`;
    if (ir.tracks.some((track) => track.id === id)) throw new Error("Cue track already exists");
    ir.tracks.push({ id, kind: "sfx", clips: [clip] });
  }
  compileTimelineIR(ir);
  return ir;
}
