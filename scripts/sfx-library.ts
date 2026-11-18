import { existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, ensureFfprobe, parseArgs, runScript } from "../src/lib/cli";
import { MusicHttp } from "../src/lib/music/http";
import {
  buildSfxIndex,
  ensureSfxPacks,
  fetchSfxPack,
  parseSfxQuery,
  rankSfx,
  readSfxIndex,
  SFX_CACHE,
  SFX_PACK_IDS,
  SFX_PACKS,
  synthSfx,
  type SfxPackId,
} from "../src/lib/music/sfx";

const SPECS = [
  {
    name: "action",
    default: "find",
    choices: ["find", "fetch", "status", "synth"],
    description: "find | fetch | status | synth",
  },
  { name: "query", description: 'find: e.g. "soft wood thud". Whoosh and riser requests are synthesised' },
  { name: "duration", type: "number", description: "find, synth: wanted length in seconds" },
  { name: "limit", type: "number", description: "find: how many results (default 5)" },
  { name: "pack", choices: SFX_PACK_IDS, description: "fetch: only this pack" },
  { name: "from-zip", description: "fetch: a pack zip the user downloaded from kenney.nl; needs --pack" },
  { name: "force", type: "boolean", description: "fetch: replace a cached pack" },
  { name: "no-fetch", type: "boolean", description: "find: use only what is cached" },
  { name: "kind", choices: ["whoosh", "riser"], description: "synth: which sound" },
  { name: "seed", type: "number", description: "synth: take number (default 1)" },
  { name: "gain", type: "number", description: "synth: 0.001 to 0.8" },
  { name: "cache", default: SFX_CACHE, description: "Shared cache directory, gitignored" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  const cache = path.resolve(args.cache!);
  const http = new MusicHttp();

  if (args.action === "status") {
    const index = readSfxIndex(cache);
    return {
      metadata: {
        cache,
        packs: SFX_PACK_IDS.map((pack) => ({
          pack,
          title: SFX_PACKS[pack].title,
          cached: existsSync(path.join(cache, "kenney", pack, "pack.json")),
          evidenceUrl: SFX_PACKS[pack].evidenceUrl,
        })),
        indexed: index?.entries.length ?? 0,
        builtAt: index?.builtAt ?? null,
      },
    };
  }

  ensureFfmpeg();
  ensureFfprobe();

  if (args.action === "fetch") {
    if (args["from-zip"] && !args.pack)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--from-zip needs --pack." });
    const packs: readonly SfxPackId[] = args.pack ? [args.pack as SfxPackId] : SFX_PACK_IDS;
    const reports = args["from-zip"]
      ? [await fetchSfxPack(http, packs[0]!, { cache, force: args.force, fromZip: path.resolve(args["from-zip"]) })]
      : await ensureSfxPacks(http, cache, packs, args.force);
    const index = buildSfxIndex(cache);
    return { outputs: [path.join(cache, "index.json")], metadata: { packs: reports, indexed: index.entries.length } };
  }

  if (args.action === "synth") {
    if (!args.kind) throw new CliErrorObject({ code: "INVALID_INPUT", message: "synth needs --kind whoosh or riser." });
    const result = synthSfx(
      cache,
      args.kind as "whoosh" | "riser",
      args.duration || 0.6,
      args.seed || 1,
      args.gain || undefined,
    );
    return { outputs: [result.file], metadata: result };
  }

  if (!args.query) throw new CliErrorObject({ code: "INVALID_INPUT", message: "find needs --query." });
  const query = parseSfxQuery(args.query, args.duration || undefined);
  const notice = "Agents cannot hear. These are ranked from names and measurements: audition them against the music.";
  if (query.synth) {
    const defaults = query.synth === "whoosh" ? 0.5 : 1.5;
    const takes = [1, 2, 3].map((seed) =>
      synthSfx(cache, query.synth!, query.durationSec ?? defaults, seed, query.softness === "soft" ? 0.2 : undefined),
    );
    return { outputs: takes.map((take) => take.file), metadata: { query, results: takes, notice } };
  }
  let packs: unknown[] = [];
  if (!args["no-fetch"]) {
    const missing = SFX_PACK_IDS.filter((pack) => !existsSync(path.join(cache, "kenney", pack, "pack.json")));
    if (missing.length || !readSfxIndex(cache)) {
      packs = await ensureSfxPacks(http, cache, missing);
      buildSfxIndex(cache);
    }
  }
  const index = readSfxIndex(cache);
  if (!index?.entries.length)
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: "The SFX cache is empty. Run sfx-library --action fetch.",
      details: { packs },
    });
  const ranked = rankSfx(index.entries, query, args.limit || 5).map(({ entry, score, why }) => ({
    file: path.join(cache, entry.path),
    id: entry.id,
    material: entry.material ?? null,
    uses: entry.uses,
    weight: entry.weight ?? null,
    durationSec: Number(entry.durationSec.toFixed(3)),
    activeDurationSec: Number(entry.activeDurationSec.toFixed(3)),
    peakDb: entry.peakDb,
    rmsDb: entry.rmsDb,
    lowShare: entry.lowShare,
    licence: entry.licence,
    evidenceUrl: entry.evidenceUrl,
    score,
    why,
  }));
  return {
    outputs: ranked.map((item) => item.file),
    metadata: { query, results: ranked, notice, ...(packs.length ? { packs } : {}) },
  };
});
