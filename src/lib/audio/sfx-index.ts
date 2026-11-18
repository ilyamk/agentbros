import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
// Measured SFX index: every sound file's length, envelope, loudness and spectrum, with its source and
// licence, so agents choose sounds by measurement instead of by name. Schemas and ranking are pure;
// the build reads files and runs scripts/workers/sfx-index.py through uv.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject } from "../cli";

export const SFX_KINDS = ["click", "pop", "whoosh", "impact", "chime", "riser", "sub-drop", "tick", "glass"] as const;
export type IndexedSfxKind = (typeof SFX_KINDS)[number];
export const DYNAMICS = ["impulse", "swell", "sweep", "sustain", "texture"] as const;
export type Dynamics = (typeof DYNAMICS)[number];

export const SHARED_SFX_DIR = "public/shared/sfx";
export const SFX_INDEX_FILE = "sfx-index.json";
export const KIND_MANIFEST = "manifest.json";
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aif", ".aiff"]);
/** Bumped when the worker's measurements change, so cached entries are measured again. */
export const MEASURE_VERSION = 1;
const WORKER = path.resolve(import.meta.dirname, "../../../scripts/workers/sfx-index.py");

export const SfxMeasureSchema = z.object({
  durationSec: z.number().nonnegative(),
  /** First moment within 30 dB of the envelope peak. */
  onsetSec: z.number().nonnegative(),
  /** Onset to envelope peak. */
  attackSec: z.number().nonnegative(),
  peakSec: z.number().nonnegative(),
  peakFraction: z.number().min(0).max(1),
  /** Envelope peak to the last moment within 40 dB of it. */
  tailSec: z.number().nonnegative(),
  activeSec: z.number().nonnegative(),
  integratedLufs: z.number().nullable(),
  samplePeakDb: z.number(),
  crestDb: z.number(),
  centroidHz: z.number().nonnegative(),
  /** Energy-weighted slope of log2 centroid over the file: octaves per file length. */
  centroidTrend: z.number(),
  centroidTrajectory: z.enum(["rising", "falling", "flat"]),
  /** Energy shares: low < 250 Hz, mid, high >= 4 kHz. */
  bands: z.object({ low: z.number(), mid: z.number(), high: z.number() }),
  /** 0 soft swell, 1 hard click: the steepest envelope rise into the peak. */
  transientSharpness: z.number().min(0).max(1),
  nearPeakShare: z.number().min(0).max(1),
  onsetCount: z.number().int().nonnegative(),
  dynamics: z.enum(DYNAMICS),
});
export type SfxMeasure = z.infer<typeof SfxMeasureSchema>;

export const ClapTagSchema = z.object({ tag: z.string(), score: z.number() });
export const SfxIndexEntrySchema = z.object({
  /** Path under `public/`, for `staticFile()`. */
  file: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  /** The folder or pack kind; null when nothing says (CLAP tags may still suggest one). */
  kind: z.enum(SFX_KINDS).nullable(),
  source: z.string(),
  licence: z.string(),
  sourceUrl: z.string().optional(),
  attribution: z.string().optional(),
  title: z.string().optional(),
  measureVersion: z.number().int(),
  measured: SfxMeasureSchema.nullable(),
  error: z.string().optional(),
  clap: z.object({ kinds: z.array(ClapTagSchema), descriptors: z.array(ClapTagSchema) }).optional(),
});
export type SfxIndexEntry = z.infer<typeof SfxIndexEntrySchema>;
export const SfxIndexSchema = z.object({
  schemaVersion: z.literal(1),
  builtAt: z.string(),
  engine: z.string(),
  clapModel: z.string().optional(),
  entries: z.array(SfxIndexEntrySchema),
});
export type SfxIndex = z.infer<typeof SfxIndexSchema>;

export const KindManifestEntrySchema = z.object({
  file: z.string(),
  source: z.string(),
  sourceId: z.string().optional(),
  sourceUrl: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  licence: z.string(),
  licenceUrl: z.string().optional(),
  attribution: z.string().optional(),
  notes: z.string().optional(),
});
export const KindManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(SFX_KINDS),
  entries: z.array(KindManifestEntrySchema),
});

type Provenance = Pick<SfxIndexEntry, "kind" | "source" | "licence" | "sourceUrl" | "attribution" | "title">;

const SYNTH_KIND: Record<string, IndexedSfxKind> = {
  hit: "impact",
  click: "click",
  pop: "pop",
  whoosh: "whoosh",
  chime: "chime",
  riser: "riser",
  "sub-drop": "sub-drop",
  tick: "tick",
  glass: "glass",
};

function listAudio(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) return listAudio(full);
    return item.isFile() && AUDIO_EXTENSIONS.has(path.extname(item.name).toLowerCase()) ? [full] : [];
  });
}

const readJson = (file: string): unknown => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined);

/** Source and licence for each file, from kind manifests, the synth pack and the Kenney index. */
function provenance(root: string): Map<string, Provenance> {
  const map = new Map<string, Provenance>();
  const put = (file: string, value: Provenance) => map.set(path.resolve(file), value);
  for (const kind of SFX_KINDS) {
    const parsed = KindManifestSchema.safeParse(readJson(path.join(root, kind, KIND_MANIFEST)));
    if (!parsed.success) continue;
    for (const entry of parsed.data.entries) {
      put(path.join(root, kind, entry.file), {
        kind,
        source: entry.source,
        licence: entry.licence,
        sourceUrl: entry.sourceUrl,
        attribution: entry.attribution,
        title: entry.title,
      });
    }
  }
  const synth = readJson(path.join(root, "synth", "pack.json")) as
    { licence?: string; entries?: { kind: string; file: string }[] } | undefined;
  for (const entry of synth?.entries ?? [])
    put(path.join(root, "synth", entry.file), {
      kind: SYNTH_KIND[entry.kind] ?? null,
      source: "synth",
      licence: "generated",
    });
  const kenney = readJson(path.join(root, "index.json")) as
    { entries?: { path: string; licence: string; evidenceUrl: string; uses?: string[] }[] } | undefined;
  for (const entry of kenney?.entries ?? [])
    put(path.join(root, entry.path), {
      kind: null,
      source: "kenney",
      licence: entry.licence,
      sourceUrl: entry.evidenceUrl,
    });
  return map;
}

function guessProvenance(file: string, root: string): Provenance {
  const name = path.basename(file);
  const freesound = /^freesound-(\d+)-/.exec(name);
  if (freesound)
    return {
      kind: null,
      source: "freesound",
      licence: "unknown",
      sourceUrl: `https://freesound.org/s/${freesound[1]}/`,
    };
  if (path.relative(root, file).startsWith("synth")) return { kind: null, source: "synth", licence: "generated" };
  return { kind: null, source: "unknown", licence: "unknown" };
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const toPublic = (file: string, publicDir: string) => path.relative(publicDir, file).split(path.sep).join("/");

/** Runs the measurement worker over files; returns measurements keyed by absolute path. */
export function measureFiles(
  files: string[],
): Record<string, { error?: string; silent?: boolean } & Partial<SfxMeasure>> {
  if (!files.length) return {};
  const work = mkdtempSync(path.join(tmpdir(), "sfx-index-"));
  try {
    const request = path.join(work, "request.json");
    writeFileSync(request, JSON.stringify({ files }));
    const result = spawnSync(pythonUv(process.env.REFERENCE_UVX), pythonArgs("sfx-index", [WORKER, request]), {
      env: pythonEnvironment("sfx-index"),
      encoding: "utf8",
      timeout: 1800000,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      const detail = result.error?.message ?? result.stderr.trim().slice(-600);
      throw new CliErrorObject({
        code: /ENOENT/.test(detail) ? "VALIDATION" : "INTERNAL",
        message: `sfx-index worker failed: ${detail}`,
        details: { fix: "Install uv (https://astral.sh/uv) and ffmpeg; the first run downloads numpy and pyloudnorm." },
      });
    }
    return (JSON.parse(result.stdout) as { results: Record<string, never> }).results;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export type BuildIndexOptions = {
  /** Directory scanned recursively. */
  dir: string;
  /** Where the index is written. */
  output: string;
  /** The `public/` directory, so entries carry `staticFile()` paths. */
  publicDir: string;
  /** Shared sound root for provenance (kind manifests, synth pack, Kenney index). Defaults to `dir`. */
  provenanceRoot?: string;
  now?: string;
  measure?: typeof measureFiles;
};

/** Measures every audio file under `dir`, reusing entries whose hash and measure version are unchanged. */
export function buildSfxMeasureIndex(options: BuildIndexOptions): {
  index: SfxIndex;
  measured: number;
  reused: number;
  errors: string[];
} {
  const dir = path.resolve(options.dir);
  const publicDir = path.resolve(options.publicDir);
  const previous = SfxIndexSchema.safeParse(readJson(options.output));
  const cached = new Map((previous.success ? previous.data.entries : []).map((entry) => [entry.sha256, entry]));
  const known = provenance(path.resolve(options.provenanceRoot ?? dir));
  const files = listAudio(dir).sort();
  const hashes = new Map(files.map((file) => [file, { sha: sha256(file), bytes: statSync(file).size }]));
  const todo = files.filter((file) => {
    const hit = cached.get(hashes.get(file)!.sha);
    return !hit || hit.measureVersion !== MEASURE_VERSION || !hit.measured;
  });
  const results = (options.measure ?? measureFiles)(todo);
  const errors: string[] = [];
  const entries = files.map((file): SfxIndexEntry => {
    const { sha, bytes } = hashes.get(file)!;
    const origin = known.get(file) ?? guessProvenance(file, dir);
    const base = { file: toPublic(file, publicDir), sha256: sha, bytes, ...origin, measureVersion: MEASURE_VERSION };
    const hit = cached.get(sha);
    if (hit && hit.measureVersion === MEASURE_VERSION && hit.measured && !(file in results)) return { ...hit, ...base };
    const raw = results[file];
    const parsed = SfxMeasureSchema.safeParse(raw);
    if (!parsed.success) {
      const error = raw?.error ?? (raw?.silent ? "silent file" : "measurement incomplete");
      errors.push(`${base.file}: ${error}`);
      return { ...base, measured: null, error };
    }
    return { ...base, measured: parsed.data };
  });
  const clean = (entry: SfxIndexEntry) =>
    Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as SfxIndexEntry;
  const index: SfxIndex = {
    schemaVersion: 1,
    builtAt: options.now ?? new Date().toISOString(),
    engine: `scripts/workers/sfx-index.py v${MEASURE_VERSION}`,
    ...(previous.success && previous.data.clapModel ? { clapModel: previous.data.clapModel } : {}),
    entries: entries.map(clean),
  };
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(index, null, 1)}\n`);
  return { index, measured: todo.length, reused: files.length - todo.length, errors };
}

export function readSfxMeasureIndex(file: string): SfxIndex | undefined {
  const parsed = SfxIndexSchema.safeParse(readJson(file));
  return parsed.success ? parsed.data : undefined;
}

/** Directories inside each project that hold its own sounds. */
export function projectSfxDirs(projectsRoot: string): { project: string; dir: string }[] {
  if (!existsSync(projectsRoot)) return [];
  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .flatMap((item) =>
      ["sfx", "assets/sfx"].map((sub) => ({ project: item.name, dir: path.join(projectsRoot, item.name, sub) })),
    )
    .filter((item) => existsSync(item.dir));
}

// ---------------------------------------------------------------------------
// Fit to a request: pure, shared by sfx:find and cue-sounds.
// ---------------------------------------------------------------------------

export type SfxConstraints = {
  kind?: IndexedSfxKind;
  durationSec?: number;
  /** Wanted peak position as a fraction of the file (whoosh peak at 0.6). */
  peakFraction?: number;
  /** Wanted seconds from start to peak (a riser that peaks on the hit). */
  peakSec?: number;
  /** Longest acceptable tail after the peak. */
  maxTailSec?: number;
  dynamics?: Dynamics;
  trajectory?: "rising" | "falling" | "flat";
  softness?: "soft" | "hard";
};

/** 0..1 fit of a measured sound to constraints, with the reasons. Kind is a filter, not a score. */
export function constraintFit(measured: SfxMeasure, constraints: SfxConstraints): { fit: number; why: string[] } {
  const parts: { weight: number; score: number; why: string }[] = [];
  const ratio = (actual: number, wanted: number) =>
    Math.exp(-Math.abs(Math.log(Math.max(actual, 0.01) / Math.max(wanted, 0.01))) * 1.5);
  if (constraints.durationSec)
    parts.push({
      weight: 2,
      score: ratio(measured.activeSec, constraints.durationSec),
      why: `active ${measured.activeSec.toFixed(2)} s vs ${constraints.durationSec} s`,
    });
  if (constraints.peakSec !== undefined)
    parts.push({
      weight: 2,
      score: ratio(measured.peakSec, constraints.peakSec),
      why: `peak at ${measured.peakSec.toFixed(2)} s vs ${constraints.peakSec} s`,
    });
  if (constraints.peakFraction !== undefined)
    parts.push({
      weight: 1.5,
      score: Math.max(0, 1 - Math.abs(measured.peakFraction - constraints.peakFraction) * 2.5),
      why: `peak at ${Math.round(measured.peakFraction * 100)}% vs ${Math.round(constraints.peakFraction * 100)}%`,
    });
  if (constraints.maxTailSec !== undefined)
    parts.push({
      weight: 1.5,
      score:
        measured.tailSec <= constraints.maxTailSec
          ? 1
          : Math.max(0, 1 - (measured.tailSec - constraints.maxTailSec) / Math.max(constraints.maxTailSec, 0.2)),
      why: `tail ${measured.tailSec.toFixed(2)} s, room ${constraints.maxTailSec.toFixed(2)} s`,
    });
  if (constraints.dynamics)
    parts.push({
      weight: 1,
      score: measured.dynamics === constraints.dynamics ? 1 : 0.3,
      why: `dynamics ${measured.dynamics}`,
    });
  if (constraints.trajectory)
    parts.push({
      weight: 1,
      score: measured.centroidTrajectory === constraints.trajectory ? 1 : 0.3,
      why: `centroid ${measured.centroidTrajectory}`,
    });
  if (constraints.softness) {
    const hard = measured.transientSharpness;
    parts.push({
      weight: 1,
      score: constraints.softness === "hard" ? hard : 1 - hard,
      why: `sharpness ${hard.toFixed(2)}`,
    });
  }
  if (!parts.length) return { fit: 1, why: [] };
  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  return {
    fit: parts.reduce((sum, part) => sum + part.weight * part.score, 0) / total,
    why: parts.map((part) => part.why),
  };
}

/** Reads measured constraints out of free text: "peak at 60%", "soft tail", "rising", "0.5 s". */
export function parseConstraintText(text: string): SfxConstraints {
  const lower = text.toLowerCase();
  const out: SfxConstraints = {};
  const peak = /peak(?:s|ing)?\s*(?:at|@)?\s*(\d{1,3})\s*%/.exec(lower);
  if (peak) out.peakFraction = Math.min(1, Number(peak[1]) / 100);
  const seconds = /(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)\b/.exec(lower.replace(/peak[^,]*/g, ""));
  if (seconds) out.durationSec = Number(seconds[1]);
  if (/\b(soft|gentle|subtle|airy)\b/.test(lower)) out.softness = "soft";
  else if (/\b(hard|sharp|punchy|snappy)\b/.test(lower)) out.softness = "hard";
  if (/\b(short tail|no tail|dry|tight)\b/.test(lower)) out.maxTailSec = 0.15;
  if (/\b(rising|riser|build|swell)\b/.test(lower)) out.trajectory = "rising";
  if (/\b(falling|drop|downward)\b/.test(lower)) out.trajectory = "falling";
  for (const kind of SFX_KINDS) if (new RegExp(`\\b${kind}`).test(lower)) out.kind ??= kind;
  return out;
}

/** Index entries with a kind and a measurement, as planner input for `planCueSounds({ library })`. */
export function librarySounds(
  index: SfxIndex,
  exists: (file: string) => boolean = () => true,
): import("./cue-sounds").LibrarySound[] {
  return index.entries
    .filter((entry) => entry.kind && entry.measured && !entry.error && exists(entry.file))
    .map((entry) => ({
      kind: entry.kind!,
      file: entry.file,
      durationSec: entry.measured!.durationSec,
      onsetSec: entry.measured!.onsetSec,
      peakSec: entry.measured!.peakSec,
      tailSec: entry.measured!.tailSec,
      dynamics: entry.measured!.dynamics,
      integratedLufs: entry.measured!.integratedLufs,
    }));
}
