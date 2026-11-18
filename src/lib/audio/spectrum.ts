import { spawnSync } from "node:child_process";
import { CliErrorObject } from "../cli";

// Short-time band levels on a fixed third-octave scale. Shared by audio:masking and audio:syncmap.

export const SPECTRUM_RATE = 22050;
export const FRAME_SIZE = 1024;
export const HOP_SIZE = 256;
export const BAND_COUNT = 24;
const LOW_HZ = 40;
const HIGH_HZ = 11000;
/** 25 edges, log-spaced from 40 Hz to 11 kHz: almost exactly third-octave bands. */
export const BAND_EDGES_HZ: readonly number[] = Array.from({ length: BAND_COUNT + 1 }, (_, index) =>
  Math.round(LOW_HZ * (HIGH_HZ / LOW_HZ) ** (index / BAND_COUNT)),
);
export const bandCentreHz = (band: number) => Math.round(Math.sqrt(BAND_EDGES_HZ[band]! * BAND_EDGES_HZ[band + 1]!));
export const SILENT_DB = -120;

/** Decodes the first audio stream to mono float samples at SPECTRUM_RATE. */
export function decodeMono(file: string, sampleRate = SPECTRUM_RATE): Float32Array {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "f32le",
      "pipe:1",
    ],
    { maxBuffer: 2 * 1024 * 1024 * 1024 },
  );
  if (result.error && /ENOENT/.test(result.error.message))
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffmpeg not found. Install it with: brew install ffmpeg",
    });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffmpeg could not decode ${file}: ${result.error?.message ?? result.stderr.toString().trim().slice(-300)}`,
    });
  const bytes = result.stdout as Buffer;
  const samples = new Float32Array(Math.floor(bytes.length / 4));
  for (let index = 0; index < samples.length; index++) samples[index] = bytes.readFloatLE(index * 4);
  return samples;
}

/** In-place radix-2 FFT; `real.length` must be a power of two. */
export function fft(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  for (let index = 1, swap = 0; index < size; index++) {
    let bit = size >> 1;
    for (; swap & bit; bit >>= 1) swap ^= bit;
    swap ^= bit;
    if (index < swap) {
      [real[index], real[swap]] = [real[swap]!, real[index]!];
      [imaginary[index], imaginary[swap]] = [imaginary[swap]!, imaginary[index]!];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    for (let start = 0; start < size; start += length)
      for (let offset = 0; offset < length / 2; offset++) {
        const cos = Math.cos(angle * offset);
        const sin = Math.sin(angle * offset);
        const a = start + offset;
        const b = a + length / 2;
        const tr = real[b]! * cos - imaginary[b]! * sin;
        const ti = real[b]! * sin + imaginary[b]! * cos;
        real[b] = real[a]! - tr;
        imaginary[b] = imaginary[a]! - ti;
        real[a] = real[a]! + tr;
        imaginary[a] = imaginary[a]! + ti;
      }
  }
}

const HANN = Float64Array.from(
  { length: FRAME_SIZE },
  (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / FRAME_SIZE),
);
const WINDOW_POWER = HANN.reduce((sum, value) => sum + value * value, 0);
/** Each bin's share of each band, by overlap of the bin's width with the band: low bands narrower than a bin still read. */
const BAND_BINS: { bin: number; weight: number }[][] = Array.from({ length: BAND_COUNT }, (_, band) => {
  const width = SPECTRUM_RATE / FRAME_SIZE;
  const low = BAND_EDGES_HZ[band]!;
  const high = BAND_EDGES_HZ[band + 1]!;
  const bins: { bin: number; weight: number }[] = [];
  for (let bin = 1; bin < FRAME_SIZE / 2; bin++) {
    const overlap = Math.min(high, (bin + 0.5) * width) - Math.max(low, (bin - 0.5) * width);
    if (overlap > 0) bins.push({ bin, weight: overlap / width });
  }
  return bins;
});

/**
 * Band levels in dB (full-scale sine ≈ −3 dB in its band) of one frame centred on `centre` (samples). Outside the
 * signal counts as silence, so a sound placed late in the film reads as zeros before it starts.
 */
export function bandLevels(signal: Float32Array, centre: number, gain = 1): Float64Array {
  const real = new Float64Array(FRAME_SIZE);
  const imaginary = new Float64Array(FRAME_SIZE);
  const start = Math.round(centre) - FRAME_SIZE / 2;
  for (let index = 0; index < FRAME_SIZE; index++) {
    const at = start + index;
    real[index] = at >= 0 && at < signal.length ? signal[at]! * HANN[index]! * gain : 0;
  }
  fft(real, imaginary);
  const bins = Float64Array.from(
    { length: FRAME_SIZE / 2 },
    (_, bin) => (2 * (real[bin]! ** 2 + imaginary[bin]! ** 2)) / (FRAME_SIZE * WINDOW_POWER),
  );
  const power = Float64Array.from(BAND_BINS, (entries) =>
    entries.reduce((sum, { bin, weight }) => sum + bins[bin]! * weight, 0),
  );
  return power.map((value) => (value > 1e-12 ? 10 * Math.log10(value) : SILENT_DB));
}

export const sumDb = (...levels: number[]) => {
  const power = levels.reduce((sum, level) => sum + (level <= SILENT_DB ? 0 : 10 ** (level / 10)), 0);
  return power > 1e-12 ? 10 * Math.log10(power) : SILENT_DB;
};
