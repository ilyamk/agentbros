import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  encodeWav,
  measureSamples,
  spectralCentroid,
  synthesiseSfx,
  SYNTH_SFX_KINDS,
  type SynthSfxSpec,
} from "./sfx-synth";

/** Committed default pack, rendered by `pnpm sfx:synth --kind all`. */
export const SHARED_SYNTH_PACK = "public/shared/sfx/synth";
export const PACK_MANIFEST = "pack.json";
export const SYNTH_SFX_AUTHOR = "agentbros sfx-synth";

export const SynthPackEntrySchema = z.object({
  kind: z.enum(SYNTH_SFX_KINDS),
  file: z.string(),
  seed: z.number().int(),
  rootHz: z.number().positive(),
  /** Seconds into the file that belong on the cue frame. */
  alignSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
  lengthFrames: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  peakDb: z.number(),
  rmsDb: z.number(),
  centroidHz: z.number().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SynthPackEntry = z.infer<typeof SynthPackEntrySchema>;
export const SynthPackSchema = z.object({
  schemaVersion: z.literal(1),
  licence: z.string(),
  generator: z.string(),
  author: z.string().default(SYNTH_SFX_AUTHOR),
  entries: z.array(SynthPackEntrySchema),
});
export type SynthPack = z.infer<typeof SynthPackSchema>;

const LICENCE = "Generated locally by src/lib/audio/sfx-synth.ts; no third-party rights.";

/** Default spec files are named by kind alone; any other take carries its seed, key and length. */
export function synthFileName(spec: SynthSfxSpec): string {
  const parts: string[] = [spec.kind];
  if ((spec.seed ?? 1) !== 1) parts.push(`s${spec.seed}`);
  if ((spec.rootHz ?? 55) !== 55) parts.push(`r${Math.round((spec.rootHz ?? 55) * 100) / 100}`);
  if (spec.kind === "riser" && ((spec.lengthFrames ?? 60) !== 60 || (spec.fps ?? 30) !== 30))
    parts.push(`${spec.lengthFrames ?? 60}f${spec.fps ?? 30}`);
  return `${parts.join("-")}.wav`;
}

export function readSynthPack(directory: string): SynthPack | undefined {
  const file = path.join(directory, PACK_MANIFEST);
  return existsSync(file) ? SynthPackSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : undefined;
}

/**
 * Renders one sound into `directory` and records it in the pack manifest. Deterministic: an existing file with
 * the same bytes is left alone; a different one is replaced only with `force`.
 */
export function writeSynthSfx(
  directory: string,
  spec: SynthSfxSpec,
  { force = false } = {},
): { entry: SynthPackEntry; status: "written" | "unchanged" } {
  const sound = synthesiseSfx(spec);
  const bytes = encodeWav(sound.samples, sound.sampleRate);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = synthFileName(spec);
  const target = path.join(directory, file);
  mkdirSync(directory, { recursive: true });
  let status: "written" | "unchanged" = "written";
  if (existsSync(target)) {
    const current = createHash("sha256").update(readFileSync(target)).digest("hex");
    if (current === sha256) status = "unchanged";
    else if (!force) throw new Error(`${target} exists with different content; pass --force to replace it.`);
  }
  if (status === "written") writeFileSync(target, bytes);
  const entry = SynthPackEntrySchema.parse({
    kind: sound.kind,
    file,
    seed: sound.seed,
    rootHz: sound.rootHz,
    alignSec: sound.alignSec,
    durationSec: Math.round(sound.durationSec * 10000) / 10000,
    ...(spec.kind === "riser" ? { lengthFrames: spec.lengthFrames ?? 60, fps: spec.fps ?? 30 } : {}),
    ...measureSamples(sound.samples),
    centroidHz: spectralCentroid(sound.samples),
    sha256,
  });
  const pack = readSynthPack(directory) ?? {
    schemaVersion: 1 as const,
    licence: LICENCE,
    generator: "src/lib/audio/sfx-synth.ts",
    entries: [],
  };
  const entries = [...pack.entries.filter((item) => item.file !== file), entry].sort((a, b) =>
    a.file.localeCompare(b.file),
  );
  writeFileSync(
    path.join(directory, PACK_MANIFEST),
    `${JSON.stringify({ ...pack, author: SYNTH_SFX_AUTHOR, entries }, null, 2)}\n`,
  );
  return { entry, status };
}
