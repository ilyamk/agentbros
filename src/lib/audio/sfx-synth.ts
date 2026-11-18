// Procedural, seeded sound effects. Pure maths to PCM: the same kind, seed, key and length always give the same bytes.

export const SYNTH_SFX_KINDS = [
  "sub-drop",
  "hit",
  "riser",
  "whoosh",
  "click",
  "tick",
  "pop",
  "glass",
  "chime",
] as const;
export type SynthSfxKind = (typeof SYNTH_SFX_KINDS)[number];

export const SFX_SAMPLE_RATE = 48000;

export type SynthSfxSpec = {
  kind: SynthSfxKind;
  seed?: number;
  /** Root of the film's key in Hz; tonal sounds (sub-drop, glass, chime, riser) sit on it. Default A (55 Hz). */
  rootHz?: number;
  /** Riser only: length in frames at `fps`, so its last sample is the target frame. */
  lengthFrames?: number;
  fps?: number;
  /** Peak level in dBFS after normalising. Default −2. */
  peakDb?: number;
};

export type SynthSfx = {
  kind: SynthSfxKind;
  samples: Float32Array;
  sampleRate: number;
  /** Seconds into the file that sit on the cue frame: the transient, the whoosh's peak, the riser's end. */
  alignSec: number;
  durationSec: number;
  seed: number;
  rootHz: number;
};

/** mulberry32: small, fast, seeded. */
function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Topology-preserving state-variable filter; call per sample with a cutoff and resonance. */
function svf() {
  let ic1 = 0,
    ic2 = 0;
  return (input: number, cutoffHz: number, q: number) => {
    const g = Math.tan((Math.PI * Math.min(cutoffHz, SFX_SAMPLE_RATE * 0.45)) / SFX_SAMPLE_RATE);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k)),
      a2 = g * a1,
      a3 = g * a2;
    const v3 = input - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    return { low: v2, band: v1, high: input - k * v1 - v2 };
  };
}

const TAU = Math.PI * 2;

function render(seconds: number, fill: (t: number, i: number, n: number) => number): Float32Array {
  const n = Math.round(seconds * SFX_SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fill(i / SFX_SAMPLE_RATE, i, n);
  return out;
}

/** Ends every sound on true silence with a short fade, so a cut-off never clicks. */
function fadeTail(samples: Float32Array, seconds = 0.004) {
  const n = Math.min(samples.length, Math.round(seconds * SFX_SAMPLE_RATE));
  for (let i = 0; i < n; i++) samples[samples.length - 1 - i]! *= i / n;
}

function normalise(samples: Float32Array, peakDb: number) {
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  if (peak === 0) return;
  const gain = 10 ** (peakDb / 20) / peak;
  for (let i = 0; i < samples.length; i++) samples[i]! *= gain;
}

export function synthesiseSfx(spec: SynthSfxSpec): SynthSfx {
  const seed = spec.seed ?? 1;
  const root = spec.rootHz ?? 55;
  const random = rng(seed);
  const noise = () => random() * 2 - 1;
  // Small seeded variation so takes differ but stay in character.
  const vary = (amount: number) => 1 + (random() * 2 - 1) * amount;
  let samples: Float32Array;
  let alignSec = 0;

  switch (spec.kind) {
    case "sub-drop": {
      const length = 1.6 * vary(0.05),
        start = root * 2.2,
        end = root * 0.62;
      let phase = 0;
      samples = render(length, (t) => {
        const f = end + (start - end) * Math.exp(-t * 3.2);
        phase += (TAU * f) / SFX_SAMPLE_RATE;
        const env = Math.min(1, t / 0.006) * Math.exp(-t * 2.1);
        return Math.tanh(1.6 * Math.sin(phase)) * env;
      });
      break;
    }
    case "hit": {
      // Transient (bright noise click), body (pitched thump), tail (dark noise bloom): three layers, one moment.
      const tone = svf(),
        tail = svf();
      let phase = 0;
      const bodyHz = root * vary(0.04);
      samples = render(1.8, (t) => {
        const n = noise();
        const transient = tone(n, 4500, 0.7).high * Math.exp(-t * 180);
        const f = bodyHz + bodyHz * 2.2 * Math.exp(-t * 38);
        phase += (TAU * f) / SFX_SAMPLE_RATE;
        const body = Math.tanh(2 * Math.sin(phase)) * Math.min(1, t / 0.002) * Math.exp(-t * 6.5);
        const bloom = tail(n, 900 * Math.exp(-t * 1.4) + 120, 0.8).low * Math.min(1, t / 0.01) * Math.exp(-t * 2.6);
        return 0.55 * transient + 0.9 * body + 1.4 * bloom;
      });
      break;
    }
    case "riser": {
      const fps = spec.fps ?? 30;
      const frames = spec.lengthFrames ?? 60;
      // An exact number of frames: at 48 kHz and 30 fps a frame is 1600 samples, so the end is frame-exact.
      const length = frames / fps;
      const band = svf();
      const partials = [1, 1.5, 2, 3].map((ratio) => ({ ratio, phase: random() * TAU }));
      samples = render(length, (t, i, n) => {
        const p = i / (n - 1);
        const cutoff = 300 * (6000 / 300) ** (p * p);
        const air = band(noise(), cutoff, 3.5).band;
        const f = root * 4 * 2 ** (2 * p * p);
        let tonal = 0;
        for (const partial of partials) {
          partial.phase += (TAU * f * partial.ratio) / SFX_SAMPLE_RATE;
          tonal += Math.sin(partial.phase) / partial.ratio;
        }
        const env = p ** 2.4;
        // Shimmer quickens towards the end: tremolo rate rises from 4 to 22 Hz.
        const shimmer = 0.75 + 0.25 * Math.sin(TAU * (4 * t + 9 * t * p));
        return (0.8 * air + 0.22 * tonal) * env * shimmer;
      });
      alignSec = length;
      break;
    }
    case "whoosh": {
      const length = 0.7 * vary(0.08),
        peakAt = 0.58 * vary(0.05);
      const band = svf(),
        band2 = svf();
      samples = render(length, (t, i, n) => {
        const p = i / n;
        const shape = p < peakAt ? (p / peakAt) ** 2 : ((1 - p) / (1 - peakAt)) ** 1.5;
        const cutoff = 250 + 1900 * shape;
        const n1 = noise();
        return (band(n1, cutoff, 1.8).band + 0.3 * band2(n1, cutoff * 1.6, 2.4).band) * shape;
      });
      alignSec = peakAt * (samples.length / SFX_SAMPLE_RATE);
      break;
    }
    case "click": {
      const high = svf();
      const f = 3200 * vary(0.06);
      samples = render(
        0.06,
        (t) => 0.7 * high(noise(), 5000, 0.7).high * Math.exp(-t * 900) + Math.sin(TAU * f * t) * Math.exp(-t * 260),
      );
      break;
    }
    case "tick": {
      const f = 1500 * vary(0.05);
      samples = render(
        0.05,
        (t) =>
          (Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * f * 2.4 * t)) * Math.min(1, t / 0.0005) * Math.exp(-t * 170) +
          0.15 * noise() * Math.exp(-t * 1200),
      );
      break;
    }
    case "pop": {
      let phase = 0;
      const top = 900 * vary(0.08);
      samples = render(0.14, (t) => {
        phase += (TAU * (top * 0.33 + top * 0.67 * Math.exp(-t * 55))) / SFX_SAMPLE_RATE;
        return Math.sin(phase) * Math.min(1, t / 0.001) * Math.exp(-t * 32);
      });
      break;
    }
    case "glass": {
      // Inharmonic partials of a struck glass, tuned so the fundamental is the key's root, four octaves up.
      const f0 = root * 16;
      const partials = [
        { ratio: 1, gain: 1, decay: 2.2 },
        { ratio: 2.76, gain: 0.5, decay: 3.4 },
        { ratio: 5.4, gain: 0.25, decay: 5.5 },
        { ratio: 8.93, gain: 0.12, decay: 8 },
      ].map((partial) => ({ ...partial, detune: vary(0.002) }));
      samples = render(1.6, (t) => {
        let value = 0;
        for (const partial of partials)
          value +=
            partial.gain * Math.sin(TAU * f0 * partial.ratio * partial.detune * t) * Math.exp(-t * partial.decay);
        return value * Math.min(1, t / 0.0015) + 0.05 * noise() * Math.exp(-t * 400);
      });
      break;
    }
    case "chime": {
      // Root and fifth, soft attack, the fifth 70 ms later: a gentle "done".
      const notes = [
        { f: root * 8 * vary(0.002), at: 0 },
        { f: root * 12 * vary(0.002), at: 0.07 * vary(0.15) },
      ];
      samples = render(2, (t) => {
        let value = 0;
        for (const note of notes) {
          const local = t - note.at;
          if (local < 0) continue;
          const env = Math.min(1, local / 0.012) * Math.exp(-local * 2.4);
          value +=
            env *
            (Math.sin(TAU * note.f * local) +
              0.35 * Math.sin(TAU * note.f * 2 * local) +
              0.12 * Math.sin(TAU * note.f * 3 * local));
        }
        return value;
      });
      break;
    }
  }

  if (spec.kind !== "riser") fadeTail(samples);
  else {
    // The riser stops dead on its last frame: only a 1 ms fade, so the end stays exact.
    fadeTail(samples, 0.001);
  }
  // −2 dBFS sample peak keeps the true peak under −1 dBTP.
  normalise(samples, spec.peakDb ?? -2);
  return {
    kind: spec.kind,
    samples,
    sampleRate: SFX_SAMPLE_RATE,
    alignSec: Math.round(alignSec * 10000) / 10000,
    durationSec: samples.length / SFX_SAMPLE_RATE,
    seed,
    rootHz: root,
  };
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate = SFX_SAMPLE_RATE): Buffer {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++)
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), 44 + i * 2);
  return bytes;
}

function fftMagnitudes(frame: Float64Array): Float64Array {
  const n = frame.length;
  const re = Float64Array.from(frame),
    im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j]!, re[i]!];
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -TAU / size;
    for (let start = 0; start < n; start += size)
      for (let k = 0; k < size / 2; k++) {
        const cos = Math.cos(angle * k),
          sin = Math.sin(angle * k);
        const a = start + k,
          b = a + size / 2;
        const tr = re[b]! * cos - im[b]! * sin,
          ti = re[b]! * sin + im[b]! * cos;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
  }
  const magnitudes = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) magnitudes[i] = Math.hypot(re[i]!, im[i]!);
  return magnitudes;
}

/** Spectral centroid in Hz, energy-weighted over the whole sound: a brightness figure for an agent that cannot hear. */
export function spectralCentroid(samples: Float32Array, sampleRate = SFX_SAMPLE_RATE): number {
  const size = 2048;
  let weighted = 0,
    total = 0;
  for (let start = 0; start < samples.length; start += size) {
    const frame = new Float64Array(size);
    for (let i = 0; i < size && start + i < samples.length; i++)
      frame[i] = samples[start + i]! * (0.5 - 0.5 * Math.cos((TAU * i) / (size - 1)));
    const magnitudes = fftMagnitudes(frame);
    for (let bin = 1; bin < magnitudes.length; bin++) {
      const power = magnitudes[bin]! ** 2;
      weighted += power * ((bin * sampleRate) / size);
      total += power;
    }
  }
  return total ? Math.round(weighted / total) : 0;
}

export function measureSamples(samples: Float32Array) {
  let peak = 0,
    sum = 0;
  for (const value of samples) {
    peak = Math.max(peak, Math.abs(value));
    sum += value * value;
  }
  const db = (value: number) => Math.round(20 * Math.log10(Math.max(value, 1e-9)) * 10) / 10;
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / Math.max(1, samples.length))) };
}
