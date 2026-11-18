import { writeFileSync } from "node:fs";

/** Generated tracks with a known tempo, so that nothing here depends on a recording or on a run. */

export const RATE = 44100;

export function writeWav(file: string, samples: Float32Array): void {
  const header = Buffer.alloc(44);
  const bytes = samples.length * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  const body = Buffer.alloc(bytes);
  samples.forEach((value, index) => body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), index * 2));
  writeFileSync(file, Buffer.concat([header, body]));
}

/** Small, fixed noise: the tracks must be the same on every run. */
export function noiseSource(seed = 12345) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 2147483648 - 1;
  };
}

export type Hit = "kick" | "snare" | "hat";

function addHit(track: Float32Array, atSec: number, kind: Hit, gain: number, noise: () => number): void {
  const start = Math.round(atSec * RATE);
  const length = Math.round((kind === "kick" ? 0.18 : kind === "snare" ? 0.14 : 0.05) * RATE);
  let previous = 0;
  for (let index = 0; index < length && start + index < track.length; index += 1) {
    const time = index / RATE;
    let value: number;
    if (kind === "kick") value = Math.sin(2 * Math.PI * 60 * time) * Math.exp(-time * 22);
    else if (kind === "snare") value = (0.75 * noise() + 0.4 * Math.sin(2 * Math.PI * 220 * time)) * Math.exp(-time * 30);
    else {
      const raw = noise();
      value = (raw - previous) * 0.6 * Math.exp(-time * 90);
      previous = raw;
    }
    track[start + index]! += value * gain;
  }
}

/** Kick on one and three, snare on two and four, hats on the eighths. */
export function drumTrack(bpm: number, seconds: number, skip?: (atSec: number) => boolean): Float32Array {
  const track = new Float32Array(Math.round(seconds * RATE));
  const noise = noiseSource();
  const beat = 60 / bpm;
  for (let index = 0; index * beat < seconds; index += 1) {
    const at = index * beat;
    if (!skip?.(at)) addHit(track, at, index % 2 === 0 ? "kick" : "snare", index % 4 === 0 ? 0.9 : 0.7, noise);
    const half = at + beat / 2;
    if (!skip?.(half)) addHit(track, half, "hat", 0.35, noise);
  }
  return track;
}

/**
 * A quiet pad until `startSec`, then a kick on every beat, a snare on two and four, and soft sixteenth hats with a
 * few hits between them. Busy sixteenths are what used to dilute the tracker's evidence into a weak verdict.
 */
export function kickTrainTrack(bpm: number, startSec: number, seconds: number): Float32Array {
  const track = new Float32Array(Math.round(seconds * RATE));
  const noise = noiseSource(777);
  for (let index = 0; index < track.length; index += 1) {
    const time = index / RATE;
    track[index] = 0.03 * Math.sin(2 * Math.PI * 220 * time) * (time < startSec ? 1 : 0.4);
  }
  const beat = 60 / bpm;
  for (let index = 0; startSec + index * beat < seconds; index += 1) {
    const at = startSec + index * beat;
    addHit(track, at, "kick", 0.9, noise);
    if (index % 2 === 1) addHit(track, at, "snare", 0.55, noise);
    for (let sixteenth = 0; sixteenth < 4; sixteenth += 1) addHit(track, at + (sixteenth * beat) / 4, "hat", sixteenth === 0 ? 0.3 : 0.2, noise);
    if (index % 4 === 2) addHit(track, at + (3 * beat) / 4, "kick", 0.5, noise);
  }
  return track;
}

/** Kicks at seeded random times: a train with no grid in it. */
export function randomKicks(count: number, seconds: number): Float32Array {
  const track = new Float32Array(Math.round(seconds * RATE));
  const noise = noiseSource(4242);
  for (let index = 0; index < count; index += 1) addHit(track, ((noise() + 1) / 2) * (seconds - 0.3), "kick", 0.8, noise);
  return track;
}
