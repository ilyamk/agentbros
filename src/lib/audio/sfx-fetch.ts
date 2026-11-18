// On-demand SFX collection: the repository keeps only manifests (source, licence, recipe, sha256);
// the audio is fetched or rebuilt into the git-ignored public/shared/sfx/<kind>/ folders.
// fetchSfx() never throws for one sound: each gets a status, so callers (sfx:fetch, assets:sync,
// sfx:find, sfx:cues) can report what is missing and why.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { KIND_MANIFEST, SFX_KINDS, SHARED_SFX_DIR, type IndexedSfxKind } from "./sfx-index";
import { writeSynthSfx } from "./sfx-pack";
import type { SynthSfxKind } from "./sfx-synth";

const RecipeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("freesound"),
    id: z.number().int(),
    url: z.string().nullable(),
    sha256: z.string().optional(),
  }),
  z.object({ type: z.literal("kenney"), pack: z.string(), path: z.string(), sha256: z.string().optional() }),
  z.object({
    type: z.literal("synth"),
    kind: z.string(),
    seed: z.number().int(),
    rootHz: z.number(),
    lengthFrames: z.number().int().optional(),
    fps: z.number().optional(),
    sha256: z.string().optional(),
  }),
  z.object({
    type: z.literal("elevenlabs"),
    endpoint: z.string(),
    model: z.string(),
    prompt: z.string(),
    durationSeconds: z.number(),
    credits: z.number().optional(),
    sha256: z.string().optional(),
  }),
]);
export const FetchableEntrySchema = z
  .object({
    file: z.string(),
    source: z.string(),
    sourceId: z.string().optional(),
    sourceUrl: z.string().optional(),
    licence: z.string(),
    attribution: z.string().optional(),
    sha256: z.string().optional(),
    recipe: RecipeSchema.optional(),
    process: z
      .object({ trimStartDb: z.number().nullable(), peakDb: z.number(), channels: z.union([z.number(), z.string()]) })
      .passthrough()
      .optional(),
  })
  .passthrough();
const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(SFX_KINDS),
  entries: z.array(FetchableEntrySchema),
});

export type SfxFetchStatus = "present" | "fetched" | "source-gone" | "needs-generation" | "error";
export type SfxFetchItem = {
  kind: IndexedSfxKind;
  file: string;
  source: string;
  status: SfxFetchStatus;
  /** For fetched files: whether the rebuilt file's bytes equal the manifest's sha256 (an ffmpeg upgrade may re-encode). */
  sha256Match?: boolean;
  /** Whether the downloaded or generated original matched the recorded original hash. */
  originalMatch?: boolean;
  message?: string;
  /** For a sound that cannot be fetched: another same-kind sound on disk that can stand in. */
  fallback?: string;
};
export type SfxFetchResult = {
  ok: boolean;
  root: string;
  items: SfxFetchItem[];
  counts: Record<SfxFetchStatus, number>;
};
export type FetchSfxOptions = {
  kind?: IndexedSfxKind;
  /** A file name, its stem, a source id or "<source>-<sourceId>". */
  id?: string;
  /** Shared SFX root. Default public/shared/sfx. */
  root?: string;
  /** Rebuild files that exist but whose hash differs from the manifest. */
  force?: boolean;
  /** Override for tests: fetch bytes from a URL. */
  download?: (url: string) => Promise<{ status: number; bytes?: Buffer }>;
  freesoundKey?: string;
};

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export function readKindManifest(root: string, kind: IndexedSfxKind) {
  const file = path.join(root, kind, KIND_MANIFEST);
  if (!existsSync(file)) return undefined;
  const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  return parsed.success ? parsed.data : undefined;
}

/** Manifest files of a kind that are not on disk. */
export function missingSfx(root: string, kind: IndexedSfxKind): string[] {
  return (readKindManifest(root, kind)?.entries ?? [])
    .filter((entry) => !existsSync(path.join(root, kind, entry.file)))
    .map((entry) => entry.file);
}

async function defaultDownload(url: string): Promise<{ status: number; bytes?: Buffer }> {
  const response = await fetch(url, { headers: { "User-Agent": "agentbros-sfx-fetch" } });
  return { status: response.status, bytes: response.ok ? Buffer.from(await response.arrayBuffer()) : undefined };
}

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-v", "info", ...args], {
    encoding: "utf8",
    timeout: 120000,
  });
  if (result.error)
    throw new Error(
      /ENOENT/.test(result.error.message) ? "ffmpeg not found: brew install ffmpeg" : result.error.message,
    );
  if (result.status !== 0) throw new Error(`ffmpeg: ${result.stderr.trim().slice(-300)}`);
  return result.stderr;
}

/** The collection's processing: optional leading-silence trim, peak to -1 dBFS, MP3 V2 at 44.1 kHz. */
export function processSfx(
  input: string,
  output: string,
  process: { trimStartDb: number | null; peakDb: number; channels: number | string },
  work: string,
) {
  const wav = path.join(work, "stage.wav");
  const trim =
    process.trimStartDb === null
      ? []
      : ["-af", `silenceremove=start_periods=1:start_threshold=${process.trimStartDb}dB:start_silence=0.005`];
  ffmpeg(["-y", "-i", input, ...trim, "-ar", "44100", "-c:a", "pcm_f32le", wav]);
  const max = Number(
    /max_volume: (-?[\d.]+)/.exec(ffmpeg(["-i", wav, "-af", "volumedetect", "-f", "null", "-"]))?.[1] ?? 0,
  );
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=channels", "-of", "csv=p=0", wav], {
    encoding: "utf8",
  });
  const sourceChannels = Number(probe.stdout.trim()) || 1;
  const channels = typeof process.channels === "number" ? process.channels : Math.min(2, sourceChannels);
  ffmpeg([
    "-y",
    "-i",
    wav,
    "-af",
    `volume=${(process.peakDb - max).toFixed(2)}dB`,
    "-ac",
    String(channels),
    "-ar",
    "44100",
    "-c:a",
    "libmp3lame",
    "-q:a",
    "2",
    "-map_metadata",
    "-1",
    output,
  ]);
}

async function freesoundUrl(
  id: number,
  key: string | undefined,
  download: NonNullable<FetchSfxOptions["download"]>,
): Promise<{ url?: string; gone?: boolean; message?: string }> {
  if (!key) return { message: "no preview URL recorded and FREESOUND_API_KEY is not set" };
  const result = await download(
    `https://freesound.org/apiv2/sounds/${id}/?fields=previews&token=${encodeURIComponent(key)}`,
  );
  if (result.status === 404) return { gone: true, message: `Freesound sound ${id} no longer exists` };
  if (!result.bytes) return { message: `Freesound API returned ${result.status}` };
  const body = JSON.parse(result.bytes.toString("utf8")) as { previews?: Record<string, string> };
  return { url: body.previews?.["preview-hq-mp3"] };
}

/** Fetches or rebuilds the collection's sounds into the shared root. Per-sound failures become statuses. */
export async function fetchSfx(options: FetchSfxOptions = {}): Promise<SfxFetchResult> {
  const root = path.resolve(options.root ?? SHARED_SFX_DIR);
  const download = options.download ?? defaultDownload;
  const key = options.freesoundKey ?? process.env.FREESOUND_API_KEY;
  const kinds = options.kind ? [options.kind] : [...SFX_KINDS];
  const items: SfxFetchItem[] = [];
  const work = mkdtempSync(path.join(tmpdir(), "sfx-fetch-"));
  try {
    for (const kind of kinds) {
      const manifest = readKindManifest(root, kind);
      if (!manifest) continue;
      const matches = (entry: z.infer<typeof FetchableEntrySchema>) => {
        if (!options.id) return true;
        const stem = entry.file.replace(/\.[a-z0-9]+$/, "");
        return [entry.file, stem, entry.sourceId, `${entry.source}-${entry.sourceId}`].includes(options.id);
      };
      for (const entry of manifest.entries.filter(matches)) {
        const target = path.join(root, kind, entry.file);
        const base = { kind, file: `${kind}/${entry.file}`, source: entry.source };
        if (existsSync(target)) {
          const same = !entry.sha256 || sha256(readFileSync(target)) === entry.sha256;
          if (same || !options.force) {
            items.push({ ...base, status: "present", ...(entry.sha256 ? { sha256Match: same } : {}) });
            continue;
          }
        }
        const recipe = entry.recipe;
        try {
          if (!recipe) throw new Error("no recipe in the manifest");
          const original = path.join(work, `${kind}-${entry.file}.orig`);
          let originalBytes: Buffer;
          if (recipe.type === "elevenlabs") {
            const fallback = manifest.entries.find(
              (other) =>
                other.source !== "elevenlabs" &&
                other.file !== entry.file &&
                existsSync(path.join(root, kind, other.file)),
            )?.file;
            items.push({
              ...base,
              status: "needs-generation",
              message: `Paid: regenerate with ${recipe.endpoint} prompt "${recipe.prompt}" (${recipe.durationSeconds} s) only with the user's consent`,
              ...(fallback ? { fallback: `${kind}/${fallback}` } : {}),
            });
            continue;
          } else if (recipe.type === "freesound") {
            let url = recipe.url ?? undefined;
            let result = url ? await download(url) : { status: 0 };
            if (!result.bytes) {
              const lookup = await freesoundUrl(recipe.id, key, download);
              if (lookup.gone || (!lookup.url && result.status === 404)) {
                items.push({
                  ...base,
                  status: "source-gone",
                  message: lookup.message ?? `preview ${url} returned 404`,
                });
                continue;
              }
              if (!lookup.url) throw new Error(lookup.message ?? `preview returned ${result.status}`);
              url = lookup.url;
              result = await download(url);
            }
            if (!result.bytes) throw new Error(`download returned ${result.status}`);
            originalBytes = result.bytes;
          } else if (recipe.type === "kenney") {
            const cached = path.join(root, recipe.path);
            if (!existsSync(cached)) {
              const { ensureSfxPacks } = await import("../music/sfx");
              const { MusicHttp } = await import("../music/http");
              await ensureSfxPacks(new MusicHttp(), root, [recipe.pack as never]);
            }
            if (!existsSync(cached)) throw new Error(`Kenney file ${recipe.path} missing after fetching the pack`);
            originalBytes = readFileSync(cached);
          } else {
            const synthDir = path.join(work, `synth-${entry.file}`);
            const { entry: made } = writeSynthSfx(synthDir, {
              kind: recipe.kind as SynthSfxKind,
              seed: recipe.seed,
              rootHz: recipe.rootHz,
              ...(recipe.lengthFrames ? { lengthFrames: recipe.lengthFrames, fps: recipe.fps } : {}),
            });
            originalBytes = readFileSync(path.join(synthDir, made.file));
          }
          writeFileSync(original, originalBytes);
          mkdirSync(path.dirname(target), { recursive: true });
          processSfx(original, target, entry.process ?? { trimStartDb: null, peakDb: -1, channels: 2 }, work);
          const rebuilt = sha256(readFileSync(target));
          items.push({
            ...base,
            status: "fetched",
            ...(entry.sha256 ? { sha256Match: rebuilt === entry.sha256 } : {}),
            ...(recipe.sha256 ? { originalMatch: sha256(originalBytes) === recipe.sha256 } : {}),
          });
        } catch (error) {
          items.push({ ...base, status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const counts = { present: 0, fetched: 0, "source-gone": 0, "needs-generation": 0, error: 0 } as Record<
    SfxFetchStatus,
    number
  >;
  for (const item of items) counts[item.status] += 1;
  return { ok: counts.error === 0 && counts["source-gone"] === 0, root, items, counts };
}

/**
 * Copies library sounds a film uses into the project, with their provenance, so the delivery
 * snapshot freezes them. Returns the new `public/`-relative paths keyed by the old ones.
 */
export function freezeProjectSfx(
  files: string[],
  options: { publicDir: string; projectDir: string; sharedRoot?: string },
): Record<string, string> {
  const root = path.resolve(options.sharedRoot ?? path.join(options.publicDir, "shared", "sfx"));
  const dest = path.join(options.projectDir, "assets", "sfx", "library");
  const moved: Record<string, string> = {};
  const provenance: Record<string, unknown> = {};
  for (const file of [...new Set(files)]) {
    const source = path.join(options.publicDir, file);
    if (!existsSync(source)) continue;
    const relative = path.relative(root, source);
    if (relative.startsWith("..")) continue;
    const [kind, name] = relative.split(path.sep);
    const out = path.join(dest, relative);
    mkdirSync(path.dirname(out), { recursive: true });
    copyFileSync(source, out);
    const entry = SFX_KINDS.includes(kind as IndexedSfxKind)
      ? readKindManifest(root, kind as IndexedSfxKind)?.entries.find((item) => item.file === name)
      : undefined;
    const published = path.relative(options.publicDir, out).split(path.sep).join("/");
    moved[file] = published;
    provenance[published] = {
      from: file,
      sha256: sha256(readFileSync(out)),
      ...(entry
        ? { source: entry.source, sourceUrl: entry.sourceUrl, licence: entry.licence, attribution: entry.attribution }
        : { licence: "unknown" }),
    };
  }
  if (Object.keys(provenance).length) {
    const file = path.join(dest, "provenance.json");
    const previous = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
    writeFileSync(file, `${JSON.stringify({ ...previous, ...provenance }, null, 2)}\n`);
  }
  return moved;
}
