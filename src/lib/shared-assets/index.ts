import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cacheRoot } from "../cache-dir";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { probeBlender } from "../backends/probe";

/**
 * Shared media is not committed: each family ships a manifest (source, licence, sha256, target) and
 * `pnpm assets:sync` downloads or regenerates the file into its git-ignored target. Policy: docs/assets.md.
 */

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Input = z.object({ file: z.string(), url: z.string().url(), sha256: Sha });

export const AssetSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().url(), page: z.string().optional() }),
  z.object({
    kind: z.literal("recipe"),
    /** Literal argument array, run from the repository root. `{inputs}` is replaced by the folder holding `inputs`. */
    command: z.array(z.string()).min(1),
    inputs: z.array(Input).default([]),
    requires: z.array(z.enum(["blender", "ffmpeg", "chromium"])).default([]),
    /** Byte-identical output on every machine. When false a different sha is reported as drift, not corruption. */
    deterministic: z.boolean().default(false),
    /** Takes minutes: `--all` skips it unless `--include-slow`. */
    slow: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("synth"),
    sound: z.string(),
    seed: z.number().int(),
    rootHz: z.number().positive(),
    lengthFrames: z.number().int().optional(),
    fps: z.number().optional(),
  }),
  z.object({ kind: z.literal("manual"), instructions: z.string() }),
  z.object({ kind: z.literal("none"), reason: z.string() }),
]);
export type AssetSource = z.infer<typeof AssetSourceSchema>;

export const AssetEntrySchema = z.object({
  /** `<family>:<name>` */
  id: z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9._-]+$/),
  family: z.string(),
  /** Repository-relative path of the file, or `$MODELS/...` for model weights kept outside the repository (see `resolveTarget`). */
  target: z.string(),
  licence: z.string(),
  sha256: Sha.optional(),
  size: z.number().int().positive().optional(),
  source: AssetSourceSchema,
});
export type AssetEntry = z.infer<typeof AssetEntrySchema>;

/** Format of the manifests added for this tool; older families keep their own files and are read by adapters below. */
export const GenericManifestSchema = z.object({
  schemaVersion: z.literal(1),
  family: z.string(),
  note: z.string().optional(),
  assets: z.array(AssetEntrySchema.omit({ id: true, family: true }).extend({ name: z.string() })),
});

export const MANIFESTS = {
  hdri: "public/shared/hdri/sources.json",
  "3d": "public/shared/3d/sources.json",
  plates: "public/shared/3d/plates/sources.json",
  synth: "public/shared/sfx/synth/pack.json",
  collage: "public/shared/collage/sources.json",
  showcase: "public/motion-lab/showcase/sources.json",
  lab: "public/motion-lab/sources.json",
  fonts: "public/shared/fonts/sources.json",
  models: "src/lib/matte/models.json",
} as const;
export type Family = keyof typeof MANIFESTS;
export const FAMILIES = Object.keys(MANIFESTS) as Family[];

const HdriManifest = z.object({
  licence: z.string(),
  files: z.array(
    z.object({
      file: z.string(),
      url: z.string().url(),
      page: z.string().optional(),
      sha256: Sha,
      key: z.string(),
      target: z.string(),
      size: z.number().int(),
    }),
  ),
});
const ModelsManifest = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      file: z.string(),
      target: z.string(),
      sha256: Sha,
      size: z.number().int(),
      licence: z.string(),
      downloadedFrom: z.string().url(),
      sourceFile: z.string(),
      sourceSha256: Sha,
    }),
  ),
});
const SynthManifest = z.object({
  licence: z.string(),
  entries: z.array(
    z.object({
      kind: z.string(),
      file: z.string(),
      seed: z.number().int(),
      rootHz: z.number(),
      lengthFrames: z.number().int().optional(),
      fps: z.number().optional(),
      sha256: Sha,
    }),
  ),
});

const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

function familyEntries(root: string, family: Family): AssetEntry[] {
  const file = path.join(root, MANIFESTS[family]);
  if (!existsSync(file)) return [];
  const dir = path.dirname(MANIFESTS[family]);
  switch (family) {
    case "hdri": {
      const manifest = HdriManifest.parse(read(file));
      return manifest.files.map((entry) => ({
        id: `hdri:${entry.key}`,
        family,
        target: entry.target,
        licence: manifest.licence,
        sha256: entry.sha256,
        size: entry.size,
        source: { kind: "url", url: entry.url, page: entry.page },
      }));
    }
    case "3d":
      return ModelsManifest.parse(read(file)).models.map((model) => ({
        id: `3d:${model.id}`,
        family,
        target: model.target,
        licence: model.licence,
        sha256: model.sha256,
        size: model.size,
        source: {
          kind: "recipe",
          command: [
            "pnpm",
            "exec",
            "tsx",
            "scripts/blender-run.ts",
            "--script",
            "scripts/blender/prepare_devices.py",
            "--no-render",
            "--output",
            `.cache/assets/3d/prepare-${model.id}`,
            "--script-args",
            JSON.stringify(["{inputs}", model.id]),
          ],
          inputs: [{ file: model.sourceFile, url: model.downloadedFrom, sha256: model.sourceSha256 }],
          requires: ["blender"],
          deterministic: false,
          slow: false,
        },
      }));
    case "synth": {
      const manifest = SynthManifest.parse(read(file));
      return manifest.entries.map((entry) => ({
        id: `synth:${entry.file.replace(/\.wav$/, "")}`,
        family,
        target: path.posix.join(dir, entry.file),
        licence: manifest.licence,
        sha256: entry.sha256,
        source: {
          kind: "synth",
          sound: entry.kind,
          seed: entry.seed,
          rootHz: entry.rootHz,
          lengthFrames: entry.lengthFrames,
          fps: entry.fps,
        },
      }));
    }
    default: {
      const manifest = GenericManifestSchema.parse(read(file));
      return manifest.assets.map(({ name, ...entry }) =>
        AssetEntrySchema.parse({ ...entry, id: `${family}:${name}`, family }),
      );
    }
  }
}

export function loadAssets(root = process.cwd(), families: readonly Family[] = FAMILIES): AssetEntry[] {
  return families.flatMap((family) => familyEntries(root, family));
}

export type AssetState = "present" | "missing" | "corrupt" | "drifted";
export type AssetStatus = {
  id: string;
  family: string;
  target: string;
  state: AssetState;
  source: AssetSource["kind"];
  detail?: string;
};

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const strict = (entry: AssetEntry) =>
  entry.source.kind === "url" ||
  entry.source.kind === "synth" ||
  (entry.source.kind === "recipe" && entry.source.deterministic);

/** Model weights go to the shared model cache, never into a worktree or public/ (Remotion bundles public/). */
export const MODELS_PREFIX = "$MODELS/";
export const modelCacheRoot = (): string => cacheRoot();

/** Absolute path of an asset target: `$MODELS/x` lives under the model cache, anything else under `root`. */
export function resolveTarget(target: string, root = process.cwd()): string {
  return target.startsWith(MODELS_PREFIX)
    ? path.join(modelCacheRoot(), target.slice(MODELS_PREFIX.length))
    : path.join(root, target);
}

export function assetStatus(entry: AssetEntry, root = process.cwd()): AssetStatus {
  const base = { id: entry.id, family: entry.family, target: entry.target, source: entry.source.kind };
  const file = resolveTarget(entry.target, root);
  if (!existsSync(file) || statSync(file).size === 0) return { ...base, state: "missing" };
  if (!entry.sha256) return { ...base, state: "present" };
  const actual = sha256File(file);
  if (actual === entry.sha256) return { ...base, state: "present" };
  return strict(entry)
    ? { ...base, state: "corrupt", detail: `sha256 ${actual} does not match the manifest's ${entry.sha256}` }
    : { ...base, state: "drifted", detail: "regenerated locally; recipe output is not byte-reproducible" };
}

export function syncCommand(id: string): string {
  return `pnpm assets:sync --id ${id}`;
}

export type SyncOutcome =
  | "unchanged"
  | "downloaded"
  | "regenerated"
  | "source-gone"
  | "corrupt-source"
  | "failed"
  | "needs-tool"
  | "skipped-slow"
  | "manual"
  | "unavailable"
  | "corrupt";
export type SyncResult = { id: string; target: string; outcome: SyncOutcome; detail?: string };

export type SyncDeps = {
  fetch?: typeof fetch;
  run?: (command: string[], cwd: string) => { ok: boolean; output: string };
  hasTool?: (tool: "blender" | "ffmpeg" | "chromium") => boolean;
  synth?: (source: Extract<AssetSource, { kind: "synth" }>) => Buffer | Promise<Buffer>;
};

const defaultRun: NonNullable<SyncDeps["run"]> = (command, cwd) => {
  const [bin, ...args] = command;
  const result = spawnSync(bin!, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false });
  return {
    ok: !result.error && result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-800),
  };
};

const defaultSynth: NonNullable<SyncDeps["synth"]> = async (source) => {
  const { encodeWav, synthesiseSfx } = await import("../audio/sfx-synth");
  const sound = synthesiseSfx({
    kind: source.sound as never,
    seed: source.seed,
    rootHz: source.rootHz,
    lengthFrames: source.lengthFrames,
    fps: source.fps,
  });
  return encodeWav(sound.samples, sound.sampleRate);
};

class SourceGone extends Error {}

async function download(fetcher: typeof fetch, url: string, file: string, sha256: string): Promise<void> {
  if (!url.startsWith("https://")) throw new Error(`refusing a non-HTTPS source: ${url}`);
  const response = await fetcher(url, { redirect: "follow" });
  if (response.status === 404 || response.status === 410)
    throw new SourceGone(`source answered HTTP ${response.status}: ${url}`);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} from ${url}`);
  mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  const hash = createHash("sha256");
  try {
    const body = Readable.fromWeb(response.body as never);
    body.on("data", (chunk: Buffer) => hash.update(chunk));
    await pipeline(body, createWriteStream(part));
    const actual = hash.digest("hex");
    if (actual !== sha256)
      throw Object.assign(
        new Error(`downloaded sha256 ${actual} does not match the manifest's ${sha256}; the source changed`),
        { corruptSource: true },
      );
    renameSync(part, file);
  } finally {
    rmSync(part, { force: true });
  }
}

/** Brings one asset to its target. Idempotent: a verified file is left alone unless `force`. */
export async function syncAsset(
  entry: AssetEntry,
  {
    root = process.cwd(),
    force = false,
    includeSlow = true,
    deps = {},
  }: { root?: string; force?: boolean; includeSlow?: boolean; deps?: SyncDeps } = {},
): Promise<SyncResult> {
  const base = { id: entry.id, target: entry.target };
  const status = assetStatus(entry, root);
  if (!force && (status.state === "present" || status.state === "drifted"))
    return { ...base, outcome: "unchanged", detail: status.detail };
  const file = resolveTarget(entry.target, root);
  const source = entry.source;
  const fetcher = deps.fetch ?? fetch;
  try {
    switch (source.kind) {
      case "url":
        await download(fetcher, source.url, file, entry.sha256!);
        return { ...base, outcome: "downloaded" };
      case "synth": {
        const bytes = await (deps.synth ?? defaultSynth)(source);
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (entry.sha256 && actual !== entry.sha256)
          return {
            ...base,
            outcome: "failed",
            detail: `synthesised sha256 ${actual} does not match the manifest; the generator changed`,
          };
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, bytes);
        return { ...base, outcome: "regenerated" };
      }
      case "recipe": {
        if (source.slow && !includeSlow)
          return { ...base, outcome: "skipped-slow", detail: `takes minutes; run ${syncCommand(entry.id)}` };
        const missingTool = source.requires.find((tool) => !(deps.hasTool ?? defaultHasTool)(tool));
        if (missingTool) return { ...base, outcome: "needs-tool", detail: `needs ${missingTool}; see pnpm preflight` };
        const inputDir = path.join(root, ".cache/assets", entry.family, "inputs");
        for (const input of source.inputs) {
          const local = path.join(inputDir, input.file);
          if (!existsSync(local) || sha256File(local) !== input.sha256)
            await download(fetcher, input.url, local, input.sha256);
        }
        const command = source.command.map((part) => part.replaceAll("{inputs}", inputDir));
        const result = (deps.run ?? defaultRun)(command, root);
        if (!result.ok) return { ...base, outcome: "failed", detail: result.output };
        if (!existsSync(file))
          return { ...base, outcome: "failed", detail: `recipe finished but ${entry.target} was not written` };
        return { ...base, outcome: "regenerated" };
      }
      case "manual":
        return { ...base, outcome: "manual", detail: source.instructions };
      case "none":
        return { ...base, outcome: "unavailable", detail: source.reason };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SourceGone)
      return {
        ...base,
        outcome: "source-gone",
        detail: `${message}. Find a replacement and update ${manifestFor(entry)}`,
      };
    if ((error as { corruptSource?: boolean }).corruptSource)
      return { ...base, outcome: "corrupt-source", detail: message };
    return { ...base, outcome: "failed", detail: message };
  }
}

export function manifestFor(entry: AssetEntry): string {
  return MANIFESTS[entry.family as Family] ?? entry.family;
}

function defaultHasTool(tool: "blender" | "ffmpeg" | "chromium"): boolean {
  if (tool === "ffmpeg") return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  if (tool === "blender") {
    return probeBlender().available;
  }
  return true;
}

export const SUCCESS: readonly SyncOutcome[] = ["unchanged", "downloaded", "regenerated"];

export class AssetMissingError extends Error {
  constructor(readonly missing: AssetStatus[]) {
    super(
      `Missing shared asset(s): ${missing.map((item) => `${item.id} (${item.target}, ${item.state})`).join(", ")}. Run: ${missing.map((item) => syncCommand(item.id)).join(" && ")}`,
    );
  }
}

/**
 * Pre-render hook: makes sure `ids` exist. Downloads (cheap, verified) are fetched automatically when `fetch` is on;
 * recipes and anything that fails raise AssetMissingError naming the exact `pnpm assets:sync --id` command.
 */
export async function ensureAssets(
  ids: readonly string[],
  {
    root = process.cwd(),
    fetch: autoFetch = true,
    deps = {},
    onProgress,
  }: { root?: string; fetch?: boolean; deps?: SyncDeps; onProgress?: (message: string) => void } = {},
): Promise<SyncResult[]> {
  if (!ids.length) return [];
  const byId = new Map(loadAssets(root).map((entry) => [entry.id, entry]));
  const results: SyncResult[] = [];
  const missing: AssetStatus[] = [];
  for (const id of new Set(ids)) {
    const entry = byId.get(id);
    if (!entry) throw new Error(`Unknown asset id "${id}" in the needs table (src/lib/assets/needs.ts).`);
    const status = assetStatus(entry, root);
    if (status.state === "present" || status.state === "drifted") continue;
    if (autoFetch && entry.source.kind !== "recipe" && entry.source.kind !== "manual" && entry.source.kind !== "none") {
      onProgress?.(`Fetching ${id} -> ${entry.target}`);
      const result = await syncAsset(entry, { root, deps });
      results.push(result);
      if (SUCCESS.includes(result.outcome)) continue;
    }
    missing.push(status);
  }
  if (missing.length) throw new AssetMissingError(missing);
  return results;
}
