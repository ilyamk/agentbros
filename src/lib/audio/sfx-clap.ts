import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
// Local CLAP (contrastive language-audio) embeddings: auto-tags, text-to-sound search and a proxy
// "listen" for agents, who cannot hear. Runs scripts/workers/sfx-clap.py through uv; the weights sit
// in the Hugging Face cache outside git. Scores are similarities, not judgements of quality.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject } from "../cli";
import { SFX_KINDS, type IndexedSfxKind } from "./sfx-index";

export const CLAP_MODEL = "laion/larger_clap_general";
export const SFX_CLAP_FILE = "sfx-clap.json";
const WORKER = path.resolve(import.meta.dirname, "../../../scripts/workers/sfx-clap.py");

export const KIND_PROMPTS: Readonly<Record<IndexedSfxKind, string>> = {
  click: "a short mouse click or button click sound",
  pop: "a quick bubbly pop sound",
  whoosh: "a fast whoosh of air swishing past",
  impact: "a heavy impact hit or thud",
  chime: "a bright bell chime ringing",
  riser: "a rising tension riser building up",
  "sub-drop": "a deep low bass boom dropping",
  tick: "a tiny clock tick",
  glass: "a glass clink or tap on glass",
};
export const DESCRIPTORS = [
  "soft",
  "hard",
  "wooden",
  "metallic",
  "glassy",
  "plastic",
  "digital",
  "airy",
  "organic",
  "mechanical",
  "bright",
  "dark",
  "deep",
  "thin",
  "punchy",
  "cinematic",
  "electronic",
  "noisy",
  "tonal",
  "reverberant",
  "dry",
  "distorted",
] as const;
export const MOODS = [
  "calm",
  "uplifting",
  "happy",
  "playful",
  "energetic",
  "epic",
  "tense",
  "dark",
  "sad",
  "mysterious",
  "dreamy",
  "romantic",
  "aggressive",
  "corporate",
  "nostalgic",
  "suspenseful",
] as const;
export const GENRES = [
  "electronic",
  "ambient",
  "piano",
  "orchestral",
  "rock",
  "hip hop",
  "lo-fi",
  "acoustic guitar",
  "synthwave",
  "jazz",
  "pop",
  "cinematic score",
] as const;

export const descriptorPrompt = (word: string) => `a ${word} sound`;
export const moodPrompt = (mood: string) => `${mood} music`;
export const genrePrompt = (genre: string) => `${genre} music`;

export const SfxClapStoreSchema = z.object({
  schemaVersion: z.literal(1),
  model: z.string(),
  dims: z.number().int().positive(),
  vectors: z.record(z.string(), z.string()),
});
export type SfxClapStore = z.infer<typeof SfxClapStoreSchema>;

type WorkerOutput = {
  model: string;
  dims: number;
  text: string[];
  audio: Record<string, { embedding?: string; labelScores?: number[]; error?: string }>;
};

export function decodeVector(base64: string): Float32Array {
  const bytes = Buffer.from(base64, "base64");
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index]! * b[index]!;
  return dot;
}

/** Runs the CLAP worker. Throws VALIDATION when uv is missing, INTERNAL when the model cannot load. */
export function runClap(request: {
  audio?: string[];
  text?: string[];
  labels?: string[];
  model?: string;
}): WorkerOutput {
  const work = mkdtempSync(path.join(tmpdir(), "sfx-clap-"));
  try {
    const file = path.join(work, "request.json");
    writeFileSync(
      file,
      JSON.stringify({
        model: request.model ?? CLAP_MODEL,
        audio: request.audio ?? [],
        text: request.text ?? [],
        labels: request.labels ?? [],
      }),
    );
    const result = spawnSync(pythonUv(process.env.REFERENCE_UV), pythonArgs("clap", [WORKER, file]), {
      encoding: "utf8",
      timeout: 3600000,
      killSignal: "SIGKILL",
      maxBuffer: 512 * 1024 * 1024,
      env: { ...pythonEnvironment("clap"), TOKENIZERS_PARALLELISM: "false", TRANSFORMERS_VERBOSITY: "error" },
    });
    if (result.error || result.status !== 0) {
      const detail = result.error?.message ?? result.stderr.trim().slice(-800);
      throw new CliErrorObject({
        code: /ENOENT/.test(detail) ? "VALIDATION" : "INTERNAL",
        message: `CLAP worker failed: ${detail}`,
        details: {
          fix: "Needs uv, ffmpeg and network for the first download of torch and the CLAP weights (~0.7 GB, Hugging Face cache).",
        },
      });
    }
    return JSON.parse(result.stdout) as WorkerOutput;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function readClapStore(file: string): SfxClapStore | undefined {
  if (!existsSync(file)) return undefined;
  const parsed = SfxClapStoreSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  return parsed.success ? parsed.data : undefined;
}

export type Tag = { tag: string; score: number };

/** Softmax over kind prompts at a softened logit scale (20; CLAP trains near 100, which saturates): which kind the sound is most like. */
export function kindTags(scores: number[], scale = 20): Tag[] {
  const max = Math.max(...scores);
  const exps = scores.map((score) => Math.exp((score - max) * scale));
  const sum = exps.reduce((total, value) => total + value, 0);
  return SFX_KINDS.map((kind, index) => ({ tag: kind, score: Math.round((exps[index]! / sum) * 1000) / 1000 })).sort(
    (a, b) => b.score - a.score,
  );
}

/** Words ranked by how far their similarity stands above the set's mean, in standard deviations. */
export function relativeTags(words: readonly string[], scores: number[], top = 5): Tag[] {
  const mean = scores.reduce((total, value) => total + value, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((total, value) => total + (value - mean) ** 2, 0) / scores.length) || 1;
  return words
    .map((word, index) => ({ tag: word, score: Math.round(((scores[index]! - mean) / sd) * 100) / 100 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

/** The label prompts used for SFX tagging, in the order the score array comes back. */
export const SFX_LABELS = [...SFX_KINDS.map((kind) => KIND_PROMPTS[kind]), ...DESCRIPTORS.map(descriptorPrompt)];

export function sfxTagsFromScores(scores: number[]): { kinds: Tag[]; descriptors: Tag[] } {
  return {
    kinds: kindTags(scores.slice(0, SFX_KINDS.length)).slice(0, 3),
    descriptors: relativeTags(DESCRIPTORS, scores.slice(SFX_KINDS.length), 5),
  };
}
