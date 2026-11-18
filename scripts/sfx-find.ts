import { existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import {
  constraintFit,
  DYNAMICS,
  parseConstraintText,
  readSfxMeasureIndex,
  SFX_INDEX_FILE,
  SFX_KINDS,
  SHARED_SFX_DIR,
  type IndexedSfxKind,
  type SfxConstraints,
} from "../src/lib/audio/sfx-index";
import { fetchSfx, missingSfx } from "../src/lib/audio/sfx-fetch";
import { cosine, decodeVector, readClapStore, runClap, SFX_CLAP_FILE } from "../src/lib/audio/sfx-clap";

const SPECS = [
  {
    name: "text",
    description:
      'What it should sound like, e.g. "short airy whoosh, peak at 60%, soft tail"; ranked by CLAP similarity',
  },
  { name: "kind", choices: SFX_KINDS, description: "Only this kind (folder kind, else the CLAP top kind)" },
  { name: "duration", type: "number", description: "Wanted active length in seconds" },
  { name: "peak-at", type: "number", description: "Wanted peak position, fraction of the file (0..1)" },
  { name: "peak-sec", type: "number", description: "Wanted seconds from the file start to its peak" },
  { name: "max-tail", type: "number", description: "Longest tail after the peak, seconds" },
  { name: "dynamics", choices: DYNAMICS, description: "impulse | swell | sweep | sustain | texture" },
  { name: "limit", type: "number", default: 5, description: "How many results" },
  { name: "index", default: path.join(SHARED_SFX_DIR, SFX_INDEX_FILE), description: "Index from sfx:index" },
  { name: "no-clap", type: "boolean", description: "Rank by measurements only (no model load)" },
  { name: "no-fetch", type: "boolean", description: "Do not fetch missing collection files of --kind first" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  const index = readSfxMeasureIndex(path.resolve(args.index!));
  if (!index)
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `No SFX index at ${args.index}. Run pnpm sfx:index (add --clap for text search).`,
    });
  const fromText = args.text ? parseConstraintText(args.text) : {};
  const constraints: SfxConstraints = {
    ...fromText,
    ...(args.kind ? { kind: args.kind as IndexedSfxKind } : {}),
    ...(args.duration ? { durationSec: args.duration } : {}),
    ...(args["peak-at"] !== undefined ? { peakFraction: args["peak-at"] } : {}),
    ...(args["peak-sec"] !== undefined ? { peakSec: args["peak-sec"] } : {}),
    ...(args["max-tail"] !== undefined ? { maxTailSec: args["max-tail"] } : {}),
    ...(args.dynamics ? { dynamics: args.dynamics as SfxConstraints["dynamics"] } : {}),
  };
  const publicDir = path.resolve("public");
  const sharedRoot = path.resolve(SHARED_SFX_DIR);
  let fetched: unknown;
  if (!args["no-fetch"]) {
    const kinds = constraints.kind ? [constraints.kind] : SFX_KINDS;
    if (kinds.some((kind) => missingSfx(sharedRoot, kind).length)) {
      const results = await Promise.all(
        kinds.filter((kind) => missingSfx(sharedRoot, kind).length).map((kind) => fetchSfx({ kind })),
      );
      fetched = results.map((result) => result.counts);
    }
  }
  const pool = index.entries.filter((entry) => {
    if (!entry.measured || !existsSync(path.join(publicDir, entry.file))) return false;
    if (!constraints.kind) return true;
    return entry.kind ? entry.kind === constraints.kind : entry.clap?.kinds[0]?.tag === constraints.kind;
  });
  const store = readClapStore(path.join(path.dirname(path.resolve(args.index!)), SFX_CLAP_FILE));
  let query: Float32Array | undefined;
  let clapNote: string | undefined;
  if (args.text && !args["no-clap"]) {
    if (!store) clapNote = "No CLAP vectors beside the index: run pnpm sfx:index --clap. Ranked by measurements only.";
    else query = decodeVector(runClap({ text: [args.text], model: store.model }).text[0]!);
  }
  const sims = pool.map((entry) =>
    query && store?.vectors[entry.sha256] ? cosine(query, decodeVector(store.vectors[entry.sha256]!)) : undefined,
  );
  const known = sims.filter((value): value is number => value !== undefined);
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const ranked = pool
    .map((entry, position) => {
      const { fit, why } = constraintFit(entry.measured!, constraints);
      const sim = sims[position];
      const clap = sim === undefined ? undefined : hi > lo ? (sim - lo) / (hi - lo) : 1;
      const score = clap === undefined ? fit : 0.55 * clap + 0.45 * fit;
      return { entry, score, fit, sim, why };
    })
    .sort((a, b) => b.score - a.score || a.entry.file.localeCompare(b.entry.file))
    // The same sound in two places (synth/ and a kind folder copy) shows once: keyed by its measurement.
    .filter((item, position, all) => {
      const key = (m: NonNullable<typeof item.entry.measured>) =>
        `${m.durationSec.toFixed(2)}|${m.peakFraction.toFixed(2)}|${Math.round(m.centroidHz / 20)}`;
      return all.findIndex((other) => key(other.entry.measured!) === key(item.entry.measured!)) === position;
    })
    .slice(0, args.limit!)
    .map(({ entry, score, fit, sim, why }) => ({
      file: `public/${entry.file}`,
      staticFile: entry.file,
      kind: entry.kind,
      score: Math.round(score * 1000) / 1000,
      clapSimilarity: sim === undefined ? null : Math.round(sim * 1000) / 1000,
      measuredFit: Math.round(fit * 1000) / 1000,
      why,
      durationSec: entry.measured!.durationSec,
      peakSec: entry.measured!.peakSec,
      peakFraction: entry.measured!.peakFraction,
      tailSec: entry.measured!.tailSec,
      dynamics: entry.measured!.dynamics,
      centroid: `${entry.measured!.centroidHz} Hz ${entry.measured!.centroidTrajectory}`,
      integratedLufs: entry.measured!.integratedLufs,
      tags: entry.clap
        ? [
            ...entry.clap.kinds.slice(0, 2).map((tag) => tag.tag),
            ...entry.clap.descriptors.slice(0, 3).map((tag) => tag.tag),
          ]
        : [],
      source: entry.source,
      licence: entry.licence,
      ...(entry.attribution ? { attribution: entry.attribution } : {}),
    }));
  return {
    outputs: ranked.map((item) => item.file),
    metadata: {
      constraints,
      pool: pool.length,
      results: ranked,
      ...(clapNote ? { clapNote } : {}),
      ...(fetched ? { fetched } : {}),
      notice: "Ranked by CLAP similarity and measurements: agents cannot hear. Audition against the picture and music.",
    },
  };
});
