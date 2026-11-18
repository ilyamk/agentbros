/**
 * Waveform peaks (RFC 0004 §10.2): the range-served file is fetched as an ArrayBuffer (no blob: URL, strict CSP),
 * decoded with Web Audio and folded into min/max pairs per bucket. Files above a cap are not decoded; the waveform
 * then falls back to a plain bar.
 */

export interface Peaks {
  /** Interleaved [min, max] per bucket, each in −1…1. */
  values: Float32Array;
  buckets: number;
  durationSec: number;
}

export const WAVEFORM_BUCKETS = 512;
/** Audio files above this are not decoded in the browser. */
export const WAVEFORM_MAX_BYTES = 12 * 1024 * 1024;
/** Decode sample rate: enough for a picture, cheap in memory. */
const DECODE_RATE = 8000;

/** Min/max per bucket over the mean of the channels. */
export function computePeaks(channels: readonly Float32Array[], buckets: number): Float32Array {
  const out = new Float32Array(buckets * 2);
  const length = channels[0]?.length ?? 0;
  if (!length || buckets < 1) return out;
  const per = length / buckets;
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor(bucket * per);
    const end = Math.max(start + 1, Math.min(length, Math.floor((bucket + 1) * per)));
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i] ?? 0;
      const sample = sum / channels.length;
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    out[bucket * 2] = min > max ? 0 : min;
    out[bucket * 2 + 1] = min > max ? 0 : max;
  }
  return out;
}

export type PeaksResult = { ok: true; peaks: Peaks } | { ok: false; reason: "too-large" | "unsupported" | "failed" };

const cache = new Map<string, Promise<PeaksResult>>();

type Decoder = { decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> };

function decoder(): Decoder | undefined {
  const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Offline) return undefined;
  try {
    return new Offline(1, 1, DECODE_RATE);
  } catch {
    return undefined;
  }
}

async function load(url: string, maxBytes: number, buckets: number): Promise<PeaksResult> {
  const context = decoder();
  if (!context || typeof fetch !== "function") return { ok: false, reason: "unsupported" };
  const controller = new AbortController();
  try {
    const response = await fetch(url, { credentials: "same-origin", signal: controller.signal });
    if (!response.ok) return { ok: false, reason: "failed" };
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort();
      return { ok: false, reason: "too-large" };
    }
    const data = await response.arrayBuffer();
    if (data.byteLength > maxBytes) return { ok: false, reason: "too-large" };
    const audio = await context.decodeAudioData(data);
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
    return { ok: true, peaks: { values: computePeaks(channels, buckets), buckets, durationSec: audio.duration } };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** Peaks of the file at `url`, decoded once per URL. */
export function loadPeaks(
  url: string,
  { maxBytes = WAVEFORM_MAX_BYTES, buckets = WAVEFORM_BUCKETS } = {},
): Promise<PeaksResult> {
  const key = `${url}#${maxBytes}#${buckets}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = load(url, maxBytes, buckets);
    cache.set(key, pending);
    // a failed load may succeed later (the render may not exist yet)
    void pending.then((result) => {
      if (!result.ok && result.reason === "failed") cache.delete(key);
    });
  }
  return pending;
}

/** Test seam: forget decoded peaks. */
export function clearPeaksCache(): void {
  cache.clear();
}
