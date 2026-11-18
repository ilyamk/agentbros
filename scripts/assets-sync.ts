/**
 * Downloads or regenerates shared media (HDRIs, 3D models, plates, synth SFX, samples) from the committed
 * manifests into their git-ignored targets, verifying sha256. Idempotent. Policy: docs/assets.md.
 *
 *   pnpm assets:sync --all [--include-slow] [--force]
 *   pnpm assets:sync --family hdri
 *   pnpm assets:sync --id hdri:studio
 *   pnpm assets:sync --check [--family 3d]       # report only, no download
 */
import { CliErrorObject, emitProgress, parseArgs, runScript } from "../src/lib/cli";
import { fetchSfx, missingSfx, readKindManifest } from "../src/lib/audio/sfx-fetch";
import { SFX_KINDS, SHARED_SFX_DIR } from "../src/lib/audio/sfx-index";
import {
  FAMILIES,
  SUCCESS,
  assetStatus,
  loadAssets,
  syncAsset,
  syncCommand,
  type Family,
} from "../src/lib/shared-assets";

const SPECS = [
  { name: "all", type: "boolean", description: "Every family" },
  {
    name: "family",
    choices: [...FAMILIES, "sfx"],
    description: "One family; sfx delegates to the SFX collection's fetchSfx (sfx:fetch)",
  },
  { name: "id", description: "One asset, as <family>:<name> (see --check)" },
  {
    name: "check",
    type: "boolean",
    description: "Report present, missing, corrupt or drifted files; download nothing",
  },
  {
    name: "include-slow",
    type: "boolean",
    description:
      "With --all or --family, also run recipes that take minutes; with --all, also download model weights (family models)",
  },
  { name: "force", type: "boolean", description: "Fetch or regenerate even when the file verifies" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  const chosen = [args.all, args.family, args.id].filter(Boolean).length;
  if (chosen > 1) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass one of --all, --family or --id." });
  if (!chosen && !args.check)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Pass --all, --family <name>, --id <family:name> or --check.",
    });
  const sfx = args.family === "sfx" || args.id?.startsWith("sfx:") || (!args.family && !args.id);
  const all = args.family === "sfx" ? [] : loadAssets(process.cwd(), args.family ? [args.family as Family] : FAMILIES);
  const selected = args.id ? all.filter((entry) => entry.id === args.id) : all;
  if (args.id && !selected.length && !args.id.startsWith("sfx:"))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Unknown asset "${args.id}". Run pnpm assets:sync --check to list the ids.`,
    });

  if (args.check) {
    const assets = selected.map((entry) => assetStatus(entry));
    const families: Record<string, Record<string, number>> = {};
    for (const asset of assets) {
      const counts = (families[asset.family] ??= { present: 0, missing: 0, corrupt: 0, drifted: 0 });
      counts[asset.state] = (counts[asset.state] ?? 0) + 1;
    }
    if (sfx) {
      const total = SFX_KINDS.reduce(
        (sum, kind) => sum + (readKindManifest(SHARED_SFX_DIR, kind)?.entries.length ?? 0),
        0,
      );
      const missing = SFX_KINDS.reduce((sum, kind) => sum + missingSfx(SHARED_SFX_DIR, kind).length, 0);
      families.sfx = { present: total - missing, missing, corrupt: 0, drifted: 0 };
    }
    const corrupt = assets.filter((asset) => asset.state === "corrupt");
    for (const asset of assets)
      if (asset.state !== "present")
        emitProgress(
          `${asset.state.padEnd(8)} ${asset.id}  ${asset.target}${asset.state === "missing" ? `  -> ${syncCommand(asset.id)}` : ""}`,
        );
    const metadata = { families, assets };
    if (corrupt.length)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `${corrupt.length} file(s) fail their sha256: ${corrupt.map((asset) => asset.id).join(", ")}. Re-fetch with --force.`,
        details: metadata,
      });
    return { metadata };
  }

  const includeSlow = Boolean(args.id) || Boolean(args["include-slow"]);
  const results = [];
  for (const entry of selected) {
    emitProgress(`${entry.id} -> ${entry.target}`);
    // Model weights are hundreds of MB and only one command needs each: --all leaves them to --id or --include-slow.
    if (args.all && !includeSlow && entry.family === "models" && assetStatus(entry).state !== "present") {
      results.push({
        id: entry.id,
        target: entry.target,
        outcome: "skipped-slow" as const,
        detail: `model weights; run ${syncCommand(entry.id)}`,
      });
      continue;
    }
    const result = await syncAsset(entry, { force: args.force, includeSlow });
    if (!SUCCESS.includes(result.outcome)) emitProgress(`  ${result.outcome}: ${result.detail ?? ""}`);
    results.push(result);
  }
  let sfxResult;
  if (sfx) {
    emitProgress("sfx: delegating to fetchSfx (pnpm sfx:fetch)");
    sfxResult = await fetchSfx({ id: args.id?.replace(/^sfx:/, ""), force: args.force });
  }
  const summary: Record<string, number> = {};
  for (const result of results) summary[result.outcome] = (summary[result.outcome] ?? 0) + 1;
  const outputs = results
    .filter((result) => result.outcome === "downloaded" || result.outcome === "regenerated")
    .map((result) => result.target);
  const hard = results.filter(
    (result) =>
      ["failed", "source-gone", "corrupt-source"].includes(result.outcome) ||
      (args.id && !SUCCESS.includes(result.outcome)),
  );
  const metadata = { summary, results, ...(sfxResult ? { sfx: { ok: sfxResult.ok, counts: sfxResult.counts } } : {}) };
  // Under --all a sound that needs a key or a paid regeneration is reported, not fatal; --family sfx and --id sfx: are strict.
  if (sfxResult && !sfxResult.ok && (args.family === "sfx" || args.id))
    hard.push({
      id: "sfx",
      target: SHARED_SFX_DIR,
      outcome: "failed",
      detail: `fetchSfx: ${JSON.stringify(sfxResult.counts)}`,
    });
  if (hard.length)
    throw new CliErrorObject({
      code: hard.some((r) => r.outcome === "failed") ? "INTERNAL" : "VALIDATION",
      message: hard.map((r) => `${r.id}: ${r.outcome}${r.detail ? ` (${r.detail.slice(0, 300)})` : ""}`).join("; "),
      details: { outputs, ...metadata },
    });
  return { outputs, metadata };
});
