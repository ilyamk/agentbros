import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { RecordingJoinPolicy } from "../../types/workflow-recording-edit";

export const JOIN_SAMPLE_RATE = 48000;
export const SAMPLES_PER_FRAME = 1600;
const ms = (value: number) => Math.round((value * JOIN_SAMPLE_RATE) / 1000);

type Span = { startFrame: number; endFrame: number };
export type RecordingJoin = {
  index: number;
  outputFrame: number;
  /** Crossfade centre minus the picture cut, in samples at 48kHz; picture and audio stay in sync inside each clip. */
  offsetSamples: number;
  crossfadeSamples: number;
  centreEnergyDbfs: number;
  zeroCrossing: boolean;
};
export type RecordingJoinPlan = {
  sampleRate: 48000;
  samplesPerFrame: 1600;
  policy: RecordingJoinPolicy;
  roomTone: (Span & { gainDb: number }) | null;
  joins: RecordingJoin[];
};

/** Same decode as the workflow's PCM extraction, written to memory: 48kHz stereo s16, padded to the master length. */
export function decodeMasterPcm(file: string, masterFrameCount: number, normalized: boolean): Int16Array {
  const total = masterFrameCount * SAMPLES_PER_FRAME * 2;
  const bytes = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-xerror",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-vn",
      "-t",
      String(masterFrameCount / 30),
      ...(normalized ? ["-af", `aresample=48000,apad,atrim=end_sample=${masterFrameCount * SAMPLES_PER_FRAME}`] : []),
      "-ar",
      "48000",
      "-ac",
      "2",
      "-f",
      "s16le",
      "-",
    ],
    { timeout: 300000, maxBuffer: total * 2 + 1024 * 1024 },
  );
  const pcm = new Int16Array(total);
  pcm.set(new Int16Array(bytes.buffer, bytes.byteOffset, Math.min(total, Math.floor(bytes.length / 2))));
  return pcm;
}

export const hashJoinPlan = (plan: RecordingJoinPlan) =>
  createHash("sha256").update(JSON.stringify(plan)).digest("hex");

/**
 * Chooses each join's crossfade: the lowest-energy 10ms window within the search range (only when it is at least
 * 1dB quieter than the picture cut), then the nearest
 * zero crossing of the outgoing audio within 5ms. Handles never reach into a word outside the kept span,
 * and crossfades never overlap a kept word.
 */
export function planRecordingJoins(input: {
  pcm: Int16Array;
  keeps: Span[];
  words: Span[];
  policy: RecordingJoinPolicy;
  roomTone: (Span & { gainDb: number }) | null;
}): RecordingJoinPlan {
  const { pcm, keeps, words, policy } = input;
  const length = pcm.length / 2;
  const mono = (index: number) => (index < 0 || index >= length ? 0 : (pcm[index * 2] + pcm[index * 2 + 1]) / 2);
  if (input.roomTone) {
    const tone = input.roomTone;
    if (tone.endFrame - tone.startFrame < 3 || tone.endFrame * SAMPLES_PER_FRAME > length)
      throw new Error("Room tone needs at least 100ms inside the recording");
    if (words.some((word) => word.startFrame < tone.endFrame && word.endFrame > tone.startFrame))
      throw new Error("Room tone span overlaps a transcript word; choose a silent span");
  }
  const outputStart = keeps.map((_, i) => keeps.slice(0, i).reduce((n, k) => n + k.endFrame - k.startFrame, 0));
  const half = ms(policy.snap.energyWindowMs) / 2,
    search = ms(policy.snap.searchMs),
    zero = ms(policy.snap.zeroCrossingMs);
  const joins: RecordingJoin[] = [];
  let previousEnd = 0;
  for (let i = 0; i + 1 < keeps.length; i++) {
    const a = keeps[i],
      b = keeps[i + 1],
      J = outputStart[i + 1] * SAMPLES_PER_FRAME;
    const aEnd = a.endFrame * SAMPLES_PER_FRAME,
      bStart = b.startFrame * SAMPLES_PER_FRAME;
    const lastKept = Math.max(
      a.startFrame,
      ...words.filter((w) => w.startFrame >= a.startFrame && w.endFrame <= a.endFrame).map((w) => w.endFrame),
    );
    const firstKept = Math.min(
      b.endFrame,
      ...words.filter((w) => w.startFrame >= b.startFrame && w.endFrame <= b.endFrame).map((w) => w.startFrame),
    );
    const nextWord = Math.min(
      length / SAMPLES_PER_FRAME,
      ...words.filter((w) => w.startFrame >= a.endFrame).map((w) => w.startFrame),
    );
    const previousWord = Math.max(0, ...words.filter((w) => w.endFrame <= b.startFrame).map((w) => w.endFrame));
    const low = Math.max(
      J - (a.endFrame - lastKept) * SAMPLES_PER_FRAME,
      J - (bStart - previousWord * SAMPLES_PER_FRAME),
      previousEnd,
    );
    const high = Math.min(
      J + (firstKept - b.startFrame) * SAMPLES_PER_FRAME,
      J + (nextWord * SAMPLES_PER_FRAME - aEnd),
      (outputStart[i + 2] ?? Infinity) * SAMPLES_PER_FRAME,
    );
    const A = (n: number) => mono(aEnd + n - J),
      B = (n: number) => mono(bStart + n - J);
    let L = ms(policy.crossfadeMs);
    L -= L % 2;
    while (L > ms(5) && high - low < L) L -= 2;
    if (high - low < L)
      throw new Error(
        `Join ${i + 1} at output frame ${outputStart[i + 1]} has under 5ms of silence for a crossfade; move the keep boundary into silence`,
      );
    const feasibleLow = low + L / 2,
      feasibleHigh = high - L / 2;
    const first = Math.max(J - search, feasibleLow),
      last = Math.min(J + search, feasibleHigh);
    let centre = Math.min(Math.max(J, first <= last ? first : feasibleLow), first <= last ? last : feasibleHigh);
    const from = Math.min(first, J, centre) - zero,
      to = Math.max(last, J, centre) + zero;
    const lo = Math.floor(from - half),
      hi = Math.ceil(to + half);
    const prefix = new Float64Array(hi - lo + 1);
    for (let n = lo; n < hi; n++) prefix[n - lo + 1] = prefix[n - lo] + A(n) ** 2 + B(n) ** 2;
    const energy = (c: number) => prefix[Math.round(c + half) - lo] - prefix[Math.round(c - half) - lo];
    const nearest = centre;
    if (first <= last)
      for (let c = Math.ceil(first); c <= last; c++) {
        const e = energy(c),
          best = energy(centre);
        if (
          e < best - 1e-6 ||
          (Math.abs(e - best) <= 1e-6 &&
            (Math.abs(c - J) < Math.abs(centre - J) || (Math.abs(c - J) === Math.abs(centre - J) && c < centre)))
        )
          centre = c;
      }
    if (energy(centre) > 0.8 * energy(nearest)) centre = nearest;
    let crossing = false;
    for (let d = 0; d <= zero && !crossing; d++)
      for (const n of [centre - d, centre + d]) {
        if (!crossing && n >= feasibleLow && n <= feasibleHigh && A(n - 1) * A(n) <= 0 && A(n - 1) !== A(n)) {
          centre = n;
          crossing = true;
        }
      }
    const meanSquare = energy(centre) / (2 * half * 2);
    joins.push({
      index: i,
      outputFrame: outputStart[i + 1],
      offsetSamples: centre - J,
      crossfadeSamples: L,
      centreEnergyDbfs: Math.round(10 * Math.log10(meanSquare / 32768 ** 2 + 1e-12) * 10) / 10,
      zeroCrossing: crossing,
    });
    previousEnd = centre + L / 2;
  }
  return { sampleRate: JOIN_SAMPLE_RATE, samplesPerFrame: SAMPLES_PER_FRAME, policy, roomTone: input.roomTone, joins };
}

/** Joined speech in output coordinates: exactly `sum(keep frames) × 1600` stereo samples. */
export function renderJoinedSpeech(pcm: Int16Array, keeps: Span[], plan: RecordingJoinPlan): Int16Array {
  const length = pcm.length / 2;
  const total = keeps.reduce((n, k) => n + k.endFrame - k.startFrame, 0) * SAMPLES_PER_FRAME;
  const out = new Float64Array(total * 2);
  let cursor = 0;
  const outputStart: number[] = [];
  for (const keep of keeps) {
    outputStart.push(cursor);
    for (let n = keep.startFrame * SAMPLES_PER_FRAME * 2; n < keep.endFrame * SAMPLES_PER_FRAME * 2; n++)
      out[cursor * 2 + n - keep.startFrame * SAMPLES_PER_FRAME * 2] = pcm[n];
    cursor += (keep.endFrame - keep.startFrame) * SAMPLES_PER_FRAME;
  }
  const sample = (index: number, channel: number) => (index < 0 || index >= length ? 0 : pcm[index * 2 + channel]);
  const tone = plan.roomTone
    ? pcm.subarray(plan.roomTone.startFrame * SAMPLES_PER_FRAME * 2, plan.roomTone.endFrame * SAMPLES_PER_FRAME * 2)
    : undefined;
  const toneGain = plan.roomTone ? 10 ** (plan.roomTone.gainDb / 20) : 0,
    bedFade = ms(10);
  for (const join of plan.joins) {
    const J = outputStart[join.index + 1],
      aEnd = keeps[join.index].endFrame * SAMPLES_PER_FRAME,
      bStart = keeps[join.index + 1].startFrame * SAMPLES_PER_FRAME;
    const centre = J + join.offsetSamples,
      L = join.crossfadeSamples,
      start = centre - L / 2,
      end = start + L;
    for (let n = Math.min(start, J); n < Math.max(end, J); n++)
      for (let c = 0; c < 2; c++) {
        const a = sample(aEnd + n - J, c),
          b = sample(bStart + n - J, c);
        const t = (n - start + 0.5) / L;
        out[n * 2 + c] =
          n < start ? a : n >= end ? b : a * Math.cos((Math.PI / 2) * t) + b * Math.sin((Math.PI / 2) * t);
      }
    if (tone)
      for (let n = start - bedFade; n < end + bedFade; n++) {
        if (n < 0 || n >= total) continue;
        const envelope =
          n < start
            ? Math.sin(((Math.PI / 2) * (n - start + bedFade + 0.5)) / bedFade) ** 2
            : n >= end
              ? Math.sin(((Math.PI / 2) * (end + bedFade - n - 0.5)) / bedFade) ** 2
              : 1;
        const k = (n - start + bedFade) % (tone.length / 2);
        for (let c = 0; c < 2; c++) out[n * 2 + c] += toneGain * envelope * tone[k * 2 + c];
      }
  }
  const result = new Int16Array(total * 2);
  for (let i = 0; i < out.length; i++) result[i] = Math.max(-32768, Math.min(32767, Math.round(out[i])));
  return result;
}

export function writePcmWav(file: string, samples: Int16Array, channels = 2, sampleRate = JOIN_SAMPLE_RATE): void {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}
