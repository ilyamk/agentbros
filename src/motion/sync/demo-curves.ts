// A synthetic 120 BPM bar pattern run through the real curve maths, so previews and tests need no audio file.
import { computeCurves } from "../../lib/audio-curves/compute";
import type { AudioCurves } from "../../lib/audio-curves/schema";
import type { AudioMap } from "../../types/film";

const cache = new Map<string, AudioCurves>();

/** Four-on-the-floor kicks, snares on 2 and 4, eighth hats, bass swelling over each bar and energy rising across. */
export function demoCurves({
  fps = 30,
  seconds = 8,
  bpm = 120,
}: { fps?: number; seconds?: number; bpm?: number } = {}): AudioCurves {
  const key = `${fps}:${seconds}:${bpm}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const beat = 60 / bpm;
  const beats = Array.from(
    { length: Math.floor(seconds / beat) },
    (_, index) => Math.round(index * beat * 1000) / 1000,
  );
  const eighths = Array.from({ length: beats.length * 2 }, (_, index) => Math.round(index * beat * 500) / 1000);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const energyCurve = Array.from({ length: Math.round(seconds * 20) }, (_, index) => {
    const timeSec = index / 20;
    const sinceBeat = (timeSec % beat) / beat;
    const barPos = (timeSec % (beat * 4)) / (beat * 4);
    const kick = Math.exp(-sinceBeat * 6);
    const rise = timeSec / seconds;
    return {
      timeSec: round(timeSec),
      rms: round(Math.min(1, 0.35 + 0.35 * rise + 0.3 * kick)),
      low: round(Math.min(1, 0.25 + 0.45 * Math.sin(Math.PI * barPos) + 0.3 * kick)),
      high: round(Math.min(1, 0.2 + 0.5 * Math.exp(-(((timeSec * 2) % (beat * 2)) / beat) * 8))),
    };
  });
  const map: AudioMap = {
    schemaVersion: 1,
    source: { path: "synthetic:demo", sha256: "0".repeat(64), durationSec: seconds },
    tempo: { bpm, confidence: 1, gridTrust: "reliable" },
    beatsSec: beats,
    downbeatsSec: beats.filter((_, index) => index % 4 === 0),
    phrases: [],
    sections: [],
    events: [],
    keyMoments: [],
    silences: [],
    risers: [],
    energyCurve,
    drums: {
      source: "mix",
      kick: beats.map((timeSec, index) => ({ timeSec, strength: index % 4 === 0 ? 1 : 0.8 })),
      snare: beats.filter((_, index) => index % 2 === 1).map((timeSec) => ({ timeSec, strength: 0.7 })),
      hat: eighths.map((timeSec) => ({ timeSec, strength: 0.4 })),
    },
  };
  const curves = computeCurves({ map, fps, source: { map: "synthetic:demo" } });
  cache.set(key, curves);
  return curves;
}
