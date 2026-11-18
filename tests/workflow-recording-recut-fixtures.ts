import path from "node:path";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hashFile } from "../src/lib/assets/registry";
import type { Transcript } from "../src/types/transcript";
import type { SpeechMask } from "../src/types/speech-mask";

type Word = [id: string, text: string, start: number, end: number, kind?: "word" | "filler"];
/** Synthetic speech: each word is a tone burst over a quiet noise floor; fillers are low tones. Not real speech. */
export const RECUT_WORDS: Word[] = [
  ["w1", "We", 0.5, 0.7],
  ["w2", "ship", 0.75, 1.0],
  ["f1", "um", 1.2, 1.5, "filler"],
  ["w3", "today.", 1.7, 2.1],
  ["w4", "The", 3.6, 3.8],
  ["w5", "new—", 3.85, 4.1],
  ["w6", "The", 4.4, 4.55],
  ["w7", "new", 4.6, 4.85],
  ["w8", "version", 4.9, 5.3],
  ["w9", "is", 5.35, 5.45],
  ["w10", "fast.", 5.5, 5.9],
  ["w11", "It", 6.4, 6.55],
  ["w12", "is", 6.6, 6.7],
  ["w13", "not", 6.75, 7.0],
  ["f2", "uh", 7.2, 7.4, "filler"],
  ["w14", "free.", 7.6, 7.9],
  ["w15", "Thanks", 8.4, 8.7],
  ["w16", "for", 9.7, 9.85],
  ["w17", "watching.", 9.9, 10.4],
];
export const RECUT_SENTENCES: [string, string, string][] = [
  ["s1", "w1", "w3"],
  ["s2", "w4", "w5"],
  ["s3", "w6", "w10"],
  ["s4", "w11", "w14"],
  ["s5", "w15", "w17"],
];
export const RECUT_DURATION = 11;

export function recutFixture(root: string, durationSec = RECUT_DURATION) {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "talk.mp4");
  const gate = (start: number, end: number) => `between(t\\,${start}\\,${end})`;
  const speech = RECUT_WORDS.filter((w) => w[4] !== "filler")
    .map((w) => gate(w[2], w[3]))
    .join("+");
  const fillers = RECUT_WORDS.filter((w) => w[4] === "filler")
    .map((w) => gate(w[2], w[3]))
    .join("+");
  const expression = `0.3*sin(2*PI*330*t)*(${speech})+0.2*sin(2*PI*150*t)*(${fillers})+0.002*(random(0)-0.5)`;
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x180:rate=30:duration=${durationSec}`,
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${expression}:s=48000:d=${durationSec}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    file,
  ]);
  const sha256 = hashFile(file);
  const transcript: Transcript = {
    version: 1,
    source: { file, sha256, durationSec },
    engine: { provider: "local", model: "synthetic-fixture", verbatim: true, diarized: false, timing: "native" },
    language: "en",
    speakers: [],
    words: RECUT_WORDS.map(([id, text, startSec, endSec, kind]) => ({
      id,
      text,
      kind: kind ?? "word",
      startSec,
      endSec,
      speaker: null,
      channel: null,
      confidence: 1,
    })),
    sentences: RECUT_SENTENCES.map(([id, firstWordId, lastWordId]) => {
      const first = RECUT_WORDS.findIndex((w) => w[0] === firstWordId),
        last = RECUT_WORDS.findIndex((w) => w[0] === lastWordId);
      return {
        id,
        firstWordId,
        lastWordId,
        text: RECUT_WORDS.slice(first, last + 1)
          .map((w) => w[1])
          .join(" "),
        startSec: RECUT_WORDS[first][2],
        endSec: RECUT_WORDS[last][3],
        speaker: null,
      };
    }),
  };
  return {
    file,
    sha256,
    transcript,
    mask: vadMask(
      file,
      sha256,
      durationSec,
      RECUT_WORDS.map((w) => [w[2], w[3]]),
    ),
  };
}

/** A `speech:local` speech mask (SpeechMaskSchema): unpadded spans bound to the source hash. */
export function vadMask(file: string, sha256: string, durationSec: number, spans: [number, number][]): SpeechMask {
  return {
    version: 1,
    source: { file, sha256, durationSec },
    engine: {
      provider: "silero-vad",
      version: "synthetic-fixture",
      sampleRate: 16000,
      threshold: 0.5,
      minSpeechMs: 250,
      minSilenceMs: 100,
      padMs: 0,
    },
    speech: spans.map(([startSec, endSec]) => ({ startSec, endSec })),
    speechSec: spans.reduce((n, [a, b]) => n + b - a, 0),
  };
}
