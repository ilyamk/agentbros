import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { synthesizeSfx } from "../audio/procedural";
import { CliErrorObject, emitProgress } from "../cli";
import type { MusicHttp } from "./http";

export const SFX_CACHE = "public/shared/sfx";

/**
 * kenney.nl only hands out signed links to a browser session (403 otherwise), and that flow is
 * not emulated here. Kenney's CC0 packs come from OpenGameArt, where Kenney uploads them with
 * direct zips, and impact from a pinned MIT repository that bundles the pack.
 */
const BRAG_COMMIT = "669ab9286aa28b6c3ee30e75f181ee74319d012a";
export const SFX_PACKS = {
  interface: {
    title: "Interface Sounds",
    author: "Kenney",
    kind: "zip",
    url: "https://opengameart.org/sites/default/files/kenney_interfaceSounds.zip",
    evidenceUrl: "https://opengameart.org/content/interface-sounds",
  },
  ui: {
    title: "UI Audio (51 UI sound effects)",
    author: "Kenney",
    kind: "zip",
    url: "https://opengameart.org/sites/default/files/UI_SFX_Set.zip",
    evidenceUrl: "https://opengameart.org/content/51-ui-sound-effects-buttons-switches-and-clicks",
  },
  impact: {
    title: "Impact Sounds",
    author: "Kenney",
    kind: "repository",
    repository: "latent-spaces/brag",
    commit: BRAG_COMMIT,
    directory: "skills/brag/assets/sfx/impact",
    evidenceUrl: "https://kenney.nl/assets/impact-sounds",
  },
} as const;
export type SfxPackId = keyof typeof SFX_PACKS;
export const SFX_PACK_IDS = Object.keys(SFX_PACKS) as SfxPackId[];

const SAYS_CC0 = /creativecommons\.org\/publicdomain\/zero|creative commons cc0|\bcc0\b/i;
const AUDIO = /\.(ogg|wav)$/i;
const LICENCE_FILE = /licen[cs]e[^/]*\.txt$/i;

const SfxEntrySchema = z.object({
  id: z.string(),
  pack: z.string(),
  path: z.string(),
  file: z.string(),
  material: z.string().optional(),
  uses: z.array(z.string()),
  weight: z.enum(["light", "medium", "heavy"]).optional(),
  durationSec: z.number(),
  activeDurationSec: z.number(),
  peakDb: z.number(),
  rmsDb: z.number(),
  lowShare: z.number(),
  licence: z.literal("CC0"),
  evidenceUrl: z.string(),
});
export type SfxEntry = z.infer<typeof SfxEntrySchema>;
const SfxIndexSchema = z.object({ schemaVersion: z.literal(1), builtAt: z.string(), entries: z.array(SfxEntrySchema) });

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The page for this exact pack has to say CC0 today; a licence file in the pack has to agree. */
async function evidence(http: MusicHttp, pack: SfxPackId) {
  const page = await http.text(SFX_PACKS[pack].evidenceUrl);
  if (!SAYS_CC0.test(page))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `The ${pack} pack's page no longer says CC0: ${SFX_PACKS[pack].evidenceUrl}`,
    });
  return { pageSaysCc0: true, pageSha256: sha256(Buffer.from(page)) };
}

function safeEntries(zipFile: string): string[] {
  const listing = spawnSync("unzip", ["-Z1", zipFile], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (listing.status !== 0)
    throw new CliErrorObject({ code: "VALIDATION", message: "The pack is not a readable zip." });
  const entries = listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (entries.some((entry) => path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")))
    throw new CliErrorObject({ code: "VALIDATION", message: "The pack has an unsafe path; it was not extracted." });
  return entries.filter((entry) => !entry.includes("__MACOSX") && (AUDIO.test(entry) || LICENCE_FILE.test(entry)));
}

function extractZip(zipFile: string, destination: string): void {
  const entries = safeEntries(zipFile);
  if (!entries.some((entry) => AUDIO.test(entry)))
    throw new CliErrorObject({ code: "VALIDATION", message: "The pack holds no audio." });
  const result = spawnSync("unzip", ["-q", "-o", "-j", zipFile, ...entries, "-d", destination], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `The pack could not be extracted: ${result.stderr.slice(-300)}`,
    });
}

async function fetchRepositoryPack(
  http: MusicHttp,
  pack: Extract<(typeof SFX_PACKS)[SfxPackId], { kind: "repository" }>,
  destination: string,
): Promise<void> {
  const tree = await http.json<{ tree?: { path: string; type: string }[] }>(
    `https://api.github.com/repos/${pack.repository}/git/trees/${pack.commit}?recursive=1`,
  );
  const files = (tree.tree ?? []).filter(
    (item) => item.type === "blob" && path.dirname(item.path) === pack.directory && AUDIO.test(item.path),
  );
  if (!files.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `No audio at ${pack.repository}@${pack.commit}/${pack.directory}.`,
    });
  for (let start = 0; start < files.length; start += 8)
    await Promise.all(
      files.slice(start, start + 8).map(async (file) =>
        writeFileSync(
          path.join(destination, path.basename(file.path)),
          await http.bytes(`https://raw.githubusercontent.com/${pack.repository}/${pack.commit}/${file.path}`, {
            maxBytes: 8 * 1024 * 1024,
          }),
        ),
      ),
    );
}

/** Once only: a pack with a manifest is left alone unless forced. `fromZip` is the user's own kenney.nl download. */
export async function fetchSfxPack(
  http: MusicHttp,
  pack: SfxPackId,
  options: { cache: string; force?: boolean; fromZip?: string },
): Promise<{ pack: SfxPackId; status: "cached" | "fetched"; files: number; manifest: string }> {
  const directory = path.join(options.cache, "kenney", pack),
    manifestPath = path.join(directory, "pack.json");
  if (existsSync(manifestPath) && !options.force)
    return {
      pack,
      status: "cached",
      files: (JSON.parse(readFileSync(manifestPath, "utf8")) as { files: unknown[] }).files.length,
      manifest: manifestPath,
    };
  const definition = SFX_PACKS[pack];
  const pageEvidence = await evidence(http, pack);
  const parent = path.dirname(directory);
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(path.join(tmpdir(), `sfx-${pack}-`)),
    staged = path.join(work, "pack");
  mkdirSync(staged);
  try {
    let archiveSha256: string | undefined, source: string;
    if (options.fromZip) {
      archiveSha256 = sha256(readFileSync(options.fromZip));
      source = `local zip: ${path.basename(options.fromZip)}`;
      extractZip(options.fromZip, staged);
    } else if (definition.kind === "zip") {
      const bytes = await http.bytes(definition.url, { maxBytes: 200 * 1024 * 1024 });
      archiveSha256 = sha256(bytes);
      source = definition.url;
      const archive = path.join(work, "pack.zip");
      writeFileSync(archive, bytes);
      extractZip(archive, staged);
    } else {
      source = `https://github.com/${definition.repository}/tree/${definition.commit}/${definition.directory}`;
      await fetchRepositoryPack(http, definition, staged);
    }
    const names = readdirSync(staged);
    const licenceName = names.find((name) => LICENCE_FILE.test(name));
    if (licenceName && !SAYS_CC0.test(readFileSync(path.join(staged, licenceName), "utf8")))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `${licenceName} in the ${pack} pack does not say CC0. Nothing was stored.`,
      });
    const files = names.filter((name) => AUDIO.test(name)).sort();
    const manifest = {
      schemaVersion: 1,
      pack,
      title: definition.title,
      author: definition.author,
      licence: "CC0",
      source,
      evidenceUrl: definition.evidenceUrl,
      evidence: { ...pageEvidence, licenceFile: licenceName ?? null },
      archiveSha256: archiveSha256 ?? null,
      fetchedAt: http.now(),
      files: files.map((name) => ({ name, sha256: sha256(readFileSync(path.join(staged, name))) })),
    };
    writeFileSync(path.join(staged, "pack.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(directory, { recursive: true, force: true });
    renameSync(staged, directory);
    return { pack, status: "fetched", files: files.length, manifest: manifestPath };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- What a name says about a sound. Licence never comes from here, only description. ---

const MATERIALS: [RegExp, string][] = [
  [/wood|plank/, "wood"],
  [/plate|metal|tin|bell/, "metal"],
  [/glass/, "glass"],
  [/concrete|mining/, "stone"],
  [/carpet/, "carpet"],
  [/grass/, "grass"],
  [/snow/, "snow"],
  [/punch/, "flesh"],
  [/soft/, "cloth"],
];
const USES: [RegExp, string[]][] = [
  [/^impact/, ["impact", "thud"]],
  [/^footstep/, ["step", "thud"]],
  [/click/, ["click", "type"]],
  [/tick/, ["click", "type"]],
  [/^drop/, ["drop"]],
  [/switch|toggle/, ["switch", "click"]],
  [/rollover|select/, ["hover"]],
  [/^(open|maximi[sz]e)/, ["open"]],
  [/^(close|minimi[sz]e|back)/, ["close"]],
  [/confirm|bong|pluck/, ["confirm"]],
  [/error|glitch/, ["error"]],
  [/scroll|scratch/, ["scroll"]],
  [/mouserelease/, ["click"]],
];

export function describeSound(file: string): Pick<SfxEntry, "material" | "uses" | "weight"> {
  const name = path
    .basename(file)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  const material = MATERIALS.find(([pattern]) => pattern.test(name))?.[1];
  const uses = [...new Set(USES.filter(([pattern]) => pattern.test(name)).flatMap(([, value]) => value))];
  const weight = /light/.test(name)
    ? ("light" as const)
    : /medium/.test(name)
      ? ("medium" as const)
      : /heavy/.test(name)
        ? ("heavy" as const)
        : undefined;
  return { ...(material ? { material } : {}), uses, ...(weight ? { weight } : {}) };
}

export function measureSound(
  file: string,
): Pick<SfxEntry, "durationSec" | "activeDurationSec" | "peakDb" | "rmsDb" | "lowShare"> {
  const rate = 22050;
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"],
    { maxBuffer: 128 * 1024 * 1024, timeout: 60_000 },
  );
  if (result.status !== 0)
    throw new CliErrorObject({ code: "FFMPEG_FAILED", message: `Cannot decode ${path.basename(file)}.` });
  const samples = new Float32Array(
    result.stdout.buffer,
    result.stdout.byteOffset,
    Math.floor(result.stdout.byteLength / 4),
  );
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const threshold = peak * 0.01;
  let first = -1,
    last = -1;
  samples.forEach((sample, index) => {
    if (Math.abs(sample) >= threshold) {
      if (first < 0) first = index;
      last = index;
    }
  });
  let sum = 0,
    low = 0,
    lowEnergy = 0;
  const coefficient = 1 - Math.exp((-2 * Math.PI * 150) / rate);
  for (let index = Math.max(0, first); index <= last; index++) {
    const sample = samples[index]!;
    sum += sample * sample;
    low += coefficient * (sample - low);
    lowEnergy += low * low;
  }
  const active = Math.max(1, last - first + 1);
  const db = (value: number) => Math.round(20 * Math.log10(Math.max(value, 1e-6)) * 10) / 10;
  return {
    durationSec: samples.length / rate,
    activeDurationSec: active / rate,
    peakDb: db(peak),
    rmsDb: db(Math.sqrt(sum / active)),
    lowShare: sum ? Math.round((lowEnergy / sum) * 100) / 100 : 0,
  };
}

export function buildSfxIndex(cache: string, now = new Date().toISOString()) {
  const root = path.join(cache, "kenney");
  const entries: SfxEntry[] = [];
  if (existsSync(root))
    for (const pack of readdirSync(root).sort()) {
      const manifestPath = path.join(root, pack, "pack.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        licence: "CC0";
        evidenceUrl: string;
        files: { name: string }[];
      };
      if (manifest.licence !== "CC0") continue;
      for (const { name } of manifest.files) {
        const file = path.join(root, pack, name);
        if (existsSync(file))
          entries.push({
            id: `${pack}/${name}`,
            pack,
            path: path.relative(cache, file),
            file: name,
            ...describeSound(name),
            ...measureSound(file),
            licence: "CC0",
            evidenceUrl: manifest.evidenceUrl,
          });
      }
    }
  const index = SfxIndexSchema.parse({ schemaVersion: 1, builtAt: now, entries });
  writeFileSync(path.join(cache, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

export function readSfxIndex(cache: string) {
  const file = path.join(cache, "index.json");
  return existsSync(file) ? SfxIndexSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : undefined;
}

// --- Finding ---

export type SfxQuery = {
  material?: string;
  use?: string;
  softness?: "soft" | "hard";
  durationSec?: number;
  synth?: "whoosh" | "riser";
  words: string[];
};

const USE_WORDS: Record<string, string> = {
  thud: "thud",
  knock: "impact",
  tap: "impact",
  hit: "impact",
  impact: "impact",
  bump: "thud",
  click: "click",
  tick: "click",
  press: "click",
  drop: "drop",
  land: "drop",
  type: "type",
  typing: "type",
  keystroke: "type",
  key: "type",
  step: "step",
  switch: "switch",
  toggle: "switch",
  hover: "hover",
  confirm: "confirm",
  error: "error",
};

export function parseSfxQuery(query: string, durationSec?: number): SfxQuery {
  const lower = query.toLowerCase();
  const words = lower.split(/[^a-z0-9.]+/).filter(Boolean);
  const stated = lower.match(/(\d+(?:\.\d+)?)\s*(?:s\b|sec|ms\b)/);
  const seconds = stated ? (/ms\b/.test(stated[0]) ? Number(stated[1]) / 1000 : Number(stated[1])) : undefined;
  const material = words.find((word) =>
    [
      "wood",
      "wooden",
      "metal",
      "metallic",
      "glass",
      "stone",
      "concrete",
      "carpet",
      "grass",
      "snow",
      "cloth",
      "fabric",
      "plank",
      "paper",
    ].includes(word),
  );
  const normalMaterial =
    material &&
    ({ wooden: "wood", plank: "wood", metallic: "metal", concrete: "stone", fabric: "cloth" }[material] ?? material);
  const use = words.map((word) => USE_WORDS[word]).find(Boolean);
  const synth = words.some((word) => ["riser", "rise", "swell"].includes(word))
    ? ("riser" as const)
    : words.some((word) => ["whoosh", "swoosh", "swish", "sweep"].includes(word))
      ? ("whoosh" as const)
      : undefined;
  const softness = words.some((word) => ["soft", "gentle", "quiet", "light", "subtle"].includes(word))
    ? ("soft" as const)
    : words.some((word) => ["hard", "heavy", "loud", "strong"].includes(word))
      ? ("hard" as const)
      : undefined;
  return {
    ...(normalMaterial ? { material: normalMaterial } : {}),
    ...(use ? { use } : {}),
    ...(softness ? { softness } : {}),
    ...((durationSec ?? seconds) ? { durationSec: durationSec ?? seconds } : {}),
    ...(synth ? { synth } : {}),
    words,
  };
}

export function rankSfx(entries: SfxEntry[], query: SfxQuery, limit: number) {
  const scored = entries.map((entry) => {
    let score = 0;
    const why: string[] = [];
    if (query.material) {
      if (entry.material === query.material) {
        score += 6;
        why.push(`material ${entry.material}`);
      } else score -= 3;
    }
    if (query.use) {
      if (entry.uses.includes(query.use)) {
        score += 5;
        why.push(`use ${query.use}`);
      } else score -= 2;
      if (query.use === "thud" && entry.uses.includes("impact")) score += 1;
    }
    if (query.softness === "soft") {
      if (entry.weight === "light") {
        score += 2;
        why.push("light");
      }
      if (entry.weight === "heavy") score -= 2;
      score += Math.max(-1, Math.min(1, (-22 - entry.rmsDb) / 8));
    }
    if (query.softness === "hard") {
      if (entry.weight === "heavy") {
        score += 2;
        why.push("heavy");
      }
      if (entry.weight === "light") score -= 2;
    }
    if (query.durationSec) {
      score -= Math.min(4, (Math.abs(entry.activeDurationSec - query.durationSec) / query.durationSec) * 2);
      why.push(`sounds for ${entry.activeDurationSec.toFixed(2)} s`);
    }
    return { entry, score: Math.round(score * 100) / 100, why: why.join(", ") };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Whooshes and risers come from the repository's own synthesis. Each take is deterministic per seed. */
export function synthSfx(cache: string, kind: "whoosh" | "riser", durationSec: number, seed: number, gain?: number) {
  const seconds = Math.min(3, Math.max(0.05, durationSec));
  const file = path.join(cache, "synth", `${kind}-${seconds.toFixed(2)}s-${seed}${gain ? `-g${gain}` : ""}.wav`);
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    synthesizeSfx(file, { kind, seed, durationSec: seconds, ...(gain ? { gain } : {}) });
  }
  return {
    file,
    kind,
    seed,
    licence: "generated locally, no third-party rights",
    ...measureSound(file),
    note: "Plain synthesis: clean but thin. Try it by ear against the music before keeping it.",
  };
}

export async function ensureSfxPacks(http: MusicHttp, cache: string, packs: readonly SfxPackId[], force = false) {
  const reports: { pack: SfxPackId; status: string; files?: number; message?: string }[] = [];
  for (const pack of packs) {
    try {
      emitProgress(`SFX pack: ${pack}`);
      reports.push(await fetchSfxPack(http, pack, { cache, force }));
    } catch (error) {
      reports.push({ pack, status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return reports;
}
