import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readStructure } from "../src/lib/audio-map/analyse";
import { noiseSource, RATE, writeWav } from "./fixtures/audio-tracks";

const hasUv = spawnSync(process.env.REFERENCE_UVX ?? "uvx", ["--version"], { encoding: "utf8" }).status === 0;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
const worker = { skip: hasUv && hasFfmpeg ? false : "needs uv and ffmpeg", timeout: 600000 } as const;

const BEAT = 0.5;
const STOP = 32;

/**
 * 16 bars at 120 BPM: an intro of pad alone (0-8 s), a thinner build without bass (8-16 s) with a riser over its last two bars and a
 * snare fill on its last beat, a drop (16-24 s), the drums dropping out under the bass (24-28 s), the drop again
 * (28-32 s), and a hard stop at 32 s into two seconds of silence.
 */
function formTrack(): Float32Array {
  const track = new Float32Array(Math.round((STOP + 2) * RATE));
  const noise = noiseSource(2024);
  const hit = (at: number, kind: "kick" | "snare" | "hat", gain: number) => {
    const start = Math.round(at * RATE);
    const length = Math.round((kind === "kick" ? 0.18 : kind === "snare" ? 0.14 : 0.05) * RATE);
    let previous = 0;
    for (let index = 0; index < length && start + index < track.length; index += 1) {
      const time = index / RATE;
      const raw = noise();
      const value =
        kind === "kick"
          ? Math.sin(2 * Math.PI * 60 * time) * Math.exp(-time * 22)
          : kind === "snare"
            ? (0.75 * raw + 0.4 * Math.sin(2 * Math.PI * 220 * time)) * Math.exp(-time * 30)
            : (raw - previous) * 0.6 * Math.exp(-time * 90);
      previous = raw;
      track[start + index]! += value * gain;
    }
  };
  for (let index = 0; index < Math.round(STOP * RATE); index += 1) {
    const time = index / RATE;
    const bass = time >= 16 && time < STOP ? 0.22 : 0;
    track[index] =
      0.04 * Math.sin(2 * Math.PI * 220 * time) +
      0.03 * Math.sin(2 * Math.PI * 330 * time) +
      bass * Math.sin(2 * Math.PI * 55 * time);
    if (time >= 12 && time < 16) {
      const progress = (time - 12) / 4;
      track[index]! += 0.25 * progress * Math.sin(2 * Math.PI * (500 * time + (1750 * (time - 12) ** 2) / 4));
    }
  }
  for (let beat = 0; beat * BEAT < STOP; beat += 1) {
    const at = beat * BEAT;
    const inDrop = (at >= 16 && at < 24) || (at >= 28 && at < STOP);
    const inBuild = at >= 8 && at < 16;
    if (!inDrop && !inBuild) continue;
    hit(at + BEAT / 2, "hat", 0.35);
    hit(at, "kick", inDrop ? 0.95 : 0.45);
    if (beat % 2 === 1) hit(at, "snare", inDrop ? 0.7 : 0.5);
    if (inDrop) for (const sixteenth of [1, 3]) hit(at + (sixteenth * BEAT) / 4, "hat", 0.2);
    if (at >= 15) for (const sixteenth of [1, 2, 3]) hit(at + (sixteenth * BEAT) / 4, "snare", 0.55);
  }
  return track;
}

/** The map the grid worker would give this track, written by hand, so the form is tested apart from the grid fit. */
function formMap() {
  const beats = Array.from({ length: 64 }, (_, index) => index * BEAT);
  const playing = beats.filter((at) => (at >= 8 && at < 24) || (at >= 28 && at < STOP));
  const hit = (timeSec: number, strength: number) => ({ timeSec, strength });
  const fill = beats
    .filter((at) => at >= 15 && at < 16)
    .flatMap((at) => [1, 2, 3].map((sixteenth) => hit(at + (sixteenth * BEAT) / 4, 0.6)));
  return {
    schemaVersion: 1,
    source: { path: "form.wav", sha256: "c".repeat(64), durationSec: STOP + 2 },
    tempo: { bpm: 120, confidence: 0.9, gridTrust: "reliable" },
    beatsSec: beats,
    downbeatsSec: beats.filter((_, index) => index % 4 === 0),
    phrases: [],
    sections: [],
    events: [],
    keyMoments: [{ timeSec: STOP, kind: "hard-stop", strength: 0.9 }],
    silences: [{ startSec: STOP, endSec: STOP + 2 }],
    risers: [],
    energyCurve: [],
    drums: {
      source: "mix",
      kick: playing.map((at) => hit(at, 0.9)),
      snare: [...playing.filter((_, index) => index % 2 === 1).map((at) => hit(at, 0.6)), ...fill],
      hat: playing.map((at) => hit(at + BEAT / 2, 0.4)),
    },
  };
}

test("structure: a 16-bar form gives its phrase line, fill, riser, drop-out and hard stop", worker, (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "audio-structure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "form.wav");
  writeWav(input, formTrack());
  const { structure, brief } = readStructure(input, formMap());
  assert.ok(Math.abs((structure.barSec ?? 0) - 2) < 0.01, `bar ${structure.barSec}`);
  const starts = [
    ...structure.phrases.map((phrase) => phrase.startSec),
    ...structure.sections.map((section) => section.startSec),
  ];
  assert.ok(
    starts.some((sec) => Math.abs(sec - 16) <= 0.15),
    `boundary at the drop: ${brief}`,
  );
  assert.ok(
    structure.sections.some((section) => section.label === "drop" && Math.abs(section.startSec - 16) <= 0.15),
    `a drop at 16 s: ${brief}`,
  );
  assert.ok(
    structure.fills.some((fill) => Math.abs(fill.boundarySec - 16) <= 0.15),
    `fill into 16 s: ${JSON.stringify(structure.fills)}`,
  );
  assert.ok(
    structure.risers.some((riser) => Math.abs(riser.boundarySec - 16) <= 0.15),
    `riser into 16 s: ${JSON.stringify(structure.risers)}`,
  );
  assert.ok(
    structure.breaks.some((item) => item.kind === "drum-dropout" && item.startSec <= 25 && item.endSec >= 27),
    `drums drop out 24-28 s: ${JSON.stringify(structure.breaks)}`,
  );
  assert.equal(structure.ending.kind, "hard-stop", JSON.stringify(structure.ending));
  assert.ok(Math.abs(structure.ending.lastSoundSec - STOP) <= 0.35, JSON.stringify(structure.ending));
  assert.ok(
    structure.ending.finalDownbeatSec !== undefined &&
      structure.ending.finalDownbeatSec >= 29.9 &&
      structure.ending.finalDownbeatSec <= 32.1,
    JSON.stringify(structure.ending),
  );
});

// --- Short cues: regressions from the 30 s cue benchmark (synthetic stand-ins, never the cue files) ---

type Drum = "kick" | "snare" | "hat";

/** A steady groove at `bpm` over a pad, with a per-sample shaping of the pad, and drums from `from` to `to`. */
function groove(
  seconds: number,
  bpm: number,
  options: { pad?: (time: number) => number; from?: number; to?: number; finalHit?: number } = {},
) {
  const track = new Float32Array(Math.round(seconds * RATE));
  const noise = noiseSource(99);
  const beat = 60 / bpm;
  const to = options.to ?? seconds;
  const hit = (at: number, kind: Drum, gain: number) => {
    const start = Math.round(at * RATE);
    const length = Math.round((kind === "kick" ? 0.18 : kind === "snare" ? 0.14 : 0.05) * RATE);
    let previous = 0;
    for (let index = 0; index < length && start + index < track.length; index += 1) {
      const time = index / RATE;
      const raw = noise();
      const value =
        kind === "kick"
          ? Math.sin(2 * Math.PI * 60 * time) * Math.exp(-time * 22)
          : kind === "snare"
            ? (0.75 * raw + 0.4 * Math.sin(2 * Math.PI * 220 * time)) * Math.exp(-time * 30)
            : (raw - previous) * 0.6 * Math.exp(-time * 90);
      previous = raw;
      track[start + index]! += value * gain;
    }
  };
  for (let index = 0; index < Math.round(to * RATE); index += 1) {
    const time = index / RATE;
    track[index] =
      (options.pad?.(time) ?? 1) *
      (0.05 * Math.sin(2 * Math.PI * 220 * time) + 0.03 * Math.sin(2 * Math.PI * 330 * time));
  }
  const beats: number[] = [];
  for (let at = options.from ?? 0; at < to - 0.05; at += beat) {
    beats.push(at);
    hit(at, "kick", 0.8);
    if (beats.length % 2 === 0) hit(at, "snare", 0.5);
    hit(at + beat / 2, "hat", 0.3);
  }
  if (options.finalHit !== undefined) {
    hit(options.finalHit, "kick", 1);
    hit(options.finalHit, "snare", 1);
  }
  return { track, beats, beat };
}

function gridMap(seconds: number, beats: number[], trust: "reliable" | "none" = "reliable") {
  const hit = (timeSec: number, strength: number) => ({ timeSec, strength });
  return {
    schemaVersion: 1,
    source: { path: "cue.wav", sha256: "d".repeat(64), durationSec: seconds },
    tempo: { confidence: trust === "reliable" ? 0.9 : 0.1, gridTrust: trust },
    beatsSec: trust === "reliable" ? beats : [],
    downbeatsSec: trust === "reliable" ? beats.filter((_, index) => index % 4 === 0) : [],
    phrases: [],
    sections: [],
    events: [],
    keyMoments: [],
    silences: [],
    risers: [],
    energyCurve: [],
    drums: {
      source: "mix",
      kick: beats.map((at) => hit(at, 0.8)),
      snare: beats.filter((_, index) => index % 2 === 1).map((at) => hit(at, 0.5)),
      hat: beats.map((at) => hit(at + (beats[1]! - beats[0]!) / 2, 0.3)),
    },
  };
}

function structureOf(t: { after: (fn: () => void) => void }, samples: Float32Array, map: Record<string, unknown>) {
  const directory = mkdtempSync(path.join(tmpdir(), "audio-structure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "cue.wav");
  writeWav(input, samples);
  return readStructure(input, map);
}

test("short cue: a pad that swells a little every two bars is not a riser every two bars", worker, (t) => {
  // No grid, 30 s: a pad that climbs 15% over 3.8 s and falls back, again and again (about 1.2 dB a climb).
  const { track } = groove(30, 126.6, { pad: (time) => 1 + 0.15 * ((time % 3.8) / 3.8), to: 30, from: 31 });
  const { structure, brief } = structureOf(t, track, gridMap(30, [], "none"));
  assert.ok(structure.risers.length <= 1, `${structure.risers.length} risers: ${brief}`);
  const spacing = Math.max(structure.barSec ? 4 * structure.barSec : 6, 30 / 6) - 0.01;
  for (const [a, b] of structure.fills.slice(0, -1).map((fill, index) => [fill, structure.fills[index + 1]!] as const))
    assert.ok(b.boundarySec - a.boundarySec >= spacing, brief);
});

// Guard: the old worker passed this too; it keeps the ending's last second free of structure as the code changes.
test("short cue: the last second before a hard stop is the ending, never a drop or a phrase start", worker, (t) => {
  // Groove to 29.7 s, then a last loud hit and silence from 30 s.
  const { track, beats } = groove(31, 126.6, { from: 0, to: 29.7, finalHit: 29.72 });
  const map = gridMap(31, beats);
  const { structure, brief } = structureOf(t, track, {
    ...map,
    keyMoments: [{ timeSec: 29.72, kind: "drop", strength: 0.9 }],
  });
  const guard = structure.ending.lastSoundSec - structure.ending.fadeSec - 1;
  assert.ok(
    structure.phrases.every((phrase) => phrase.startSec < guard || phrase.startSec === 0),
    brief,
  );
  assert.ok(
    structure.sections.every((section) => section.startSec < guard),
    brief,
  );
  assert.ok(![...structure.risers, ...structure.fills].some((event) => event.boundarySec >= guard), brief);
  assert.ok(!structure.sections.some((section) => section.label === "drop" && section.startSec > 28), brief);
});

test("short cue with no grid: one change gives one phrase start, not a cluster", worker, (t) => {
  // A pad alone, then at 14 s a brighter pad with noise: the novelty curve has a broad plateau at 14 s.
  const noise = noiseSource(5);
  const track = new Float32Array(30 * RATE);
  for (let index = 0; index < track.length; index += 1) {
    const time = index / RATE;
    track[index] =
      time < 14
        ? 0.06 * Math.sin(2 * Math.PI * 220 * time)
        : 0.12 * Math.sin(2 * Math.PI * 880 * time) + 0.05 * noise();
  }
  const { structure, brief } = structureOf(t, track, gridMap(30, [], "none"));
  const starts = structure.phrases.map((phrase) => phrase.startSec).filter((sec) => sec > 0);
  for (let index = 1; index < starts.length; index += 1)
    assert.ok(starts[index]! - starts[index - 1]! >= 1, `clustered: ${starts.join(" ")}`);
  assert.ok(
    starts.some((sec) => Math.abs(sec - 14) <= 0.5),
    `the change at 14 s: ${brief}`,
  );
});

test("brief: each listed phrase start counts its bars to the next listed start", worker, (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "audio-structure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "form.wav");
  writeWav(input, formTrack());
  const { structure, brief } = readStructure(input, formMap());
  const listed = [
    ...(brief.match(/Phrase starts: ([^.]+(?:\.\d+[^.]*)*)\./)?.[1] ?? "").matchAll(/(\d+\.\d+) \((\d+) bars/g),
  ].map((match) => ({ at: Number(match[1]), bars: Number(match[2]) }));
  assert.ok(listed.length >= 2, brief);
  const end = structure.phrases.at(-1)!.endSec;
  listed.forEach((item, index) => {
    const next = listed[index + 1]?.at ?? end;
    assert.equal(item.bars, Math.round((next - item.at) / structure.barSec!), brief);
  });
});

test("labels weigh level and density together: the busiest stretch is not the quiet build", worker, (t) => {
  // 120 BPM, 24 s: loud pad with a kick per beat (0-8 s, 16-24 s); between them a quieter pad under kick, snare and sixteenth hats.
  const beat = 0.5;
  const busy = (at: number) => at >= 8 && at < 16;
  const { track } = groove(24, 120, { pad: (time) => (busy(time) ? 0.5 : 2), from: 99 });
  const noise = noiseSource(7);
  const kicks: number[] = [];
  const snares: number[] = [];
  const hats: number[] = [];
  for (let at = 0; at < 24; at += beat) {
    kicks.push(at);
    if (!busy(at)) continue;
    if (Math.round(at / beat) % 2 === 1) snares.push(at);
    for (const sixteenth of [0, 1, 2, 3]) hats.push(at + (sixteenth * beat) / 4);
  }
  const add = (at: number, length: number, shape: (time: number) => number) => {
    const start = Math.round(at * RATE);
    for (let index = 0; index < Math.round(length * RATE) && start + index < track.length; index += 1)
      track[start + index]! += shape(index / RATE);
  };
  for (const at of kicks) add(at, 0.18, (time) => 0.8 * Math.sin(2 * Math.PI * 60 * time) * Math.exp(-time * 22));
  for (const at of snares) add(at, 0.14, (time) => 0.5 * noise() * Math.exp(-time * 30));
  for (const at of hats) add(at, 0.05, (time) => 0.2 * noise() * Math.exp(-time * 90));
  const beats = Array.from({ length: 48 }, (_, index) => index * beat);
  const hit = (timeSec: number) => ({ timeSec, strength: 0.6 });
  const map = {
    ...gridMap(24, beats),
    drums: { source: "mix", kick: kicks.map(hit), snare: snares.map(hit), hat: hats.map(hit) },
  };
  const { structure, brief } = structureOf(t, track, map);
  for (const [index, section] of structure.sections.entries()) {
    assert.match(section.reason, /level \d\.\d\d.*density \d+\.\d\/s/, brief);
    const following = structure.sections[index + 1];
    if (section.label === "build" && section.confidence > 0.35)
      assert.ok(
        following && (following.intensity ?? 0) > (section.intensity ?? 0),
        `a build must lead into a fuller section: ${JSON.stringify(structure.sections)}`,
      );
  }
  const middle = structure.sections.find((section) => section.startSec <= 9 && section.endSec >= 15);
  if (middle)
    assert.notEqual(middle.label, "break", `the busiest stretch is not a break: ${JSON.stringify(structure.sections)}`);
});
