import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject, emitProgress, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { readJsonFile, projectPipeline } from "../src/lib/film/inputs";
import { writeJsonAtomic } from "../src/lib/film/evidence";
import { CueSheetSchema } from "../src/types/film";
import { SfxSelectionSchema, type CandidateChecks } from "../src/types/sfx-selection";
import { hashFile } from "../src/lib/assets/registry";
import { analyzeAudio } from "../src/lib/audio/analysis";
import { audition, packSounds, type AuditionSources } from "../src/lib/audio/sfx-audition";
import { readSynthPack, SHARED_SYNTH_PACK } from "../src/lib/audio/sfx-pack";
import { librarySounds, readSfxMeasureIndex } from "../src/lib/audio/sfx-index";
import { earshot, earshotLibrarySounds } from "../src/lib/audio/earshot";
import { earshotStatus, EARSHOT_SHA } from "../src/lib/audio/earshot-runtime";

const SPECS = [
  { name: "project", required: true, description: "Project ID" },
  {
    name: "cue-sheet",
    description: "CueSheet JSON whose hero sound cues are auditioned; default pipeline/cue-sheet.json",
  },
  {
    name: "pack",
    description: "Synth pack directory under public/; default the project's assets/sfx/synth, else the shared pack",
  },
  {
    name: "library",
    default: "public/shared/sfx/sfx-index.json",
    description: "Measured SFX index (sfx:index): its best-fitting sounds of each kind are candidates",
  },
  { name: "no-library", type: "boolean", description: "Leave the measured library out" },
  {
    name: "earshot-takes",
    description: "Comma-separated Earshot take receipts (sfx:synth --engine earshot --kind …) to compare as candidates",
  },
  { name: "duration-sec", type: "number", description: "Film length, for the room after the last cue" },
  { name: "no-check", type: "boolean", description: "Skip Earshot's audit even when it is prepared" },
  { name: "output", description: "Selection JSON; default pipeline/sfx-selection.json" },
] as const;

/** Earshot's audit result inside a saved audio:review report. */
const CheckResultSchema = z
  .object({
    ok: z.boolean(),
    warnings: z.array(z.object({ code: z.string(), msg: z.string() }).passthrough()),
    notes: z.array(z.object({ code: z.string(), msg: z.string() }).passthrough()).default([]),
  })
  .passthrough();
const SavedReportSchema = z
  .object({ source: z.object({ sha256: z.string() }).passthrough(), result: CheckResultSchema })
  .passthrough();

void runScript(async () => {
  const args = parseArgs(SPECS);
  const project = args.project!;
  requireProject(project);
  const root = process.cwd();
  const publicDir = path.resolve("public");
  const cueSheetPath = args["cue-sheet"] ?? projectPipeline(project, "cue-sheet.json");
  const sheet = readJsonFile(cueSheetPath, CueSheetSchema, "Cue sheet");

  const projectPack = path.join("public/projects", project, "assets/sfx/synth");
  const packDir = path.resolve(args.pack ?? (readSynthPack(projectPack) ? projectPack : SHARED_SYNTH_PACK));
  const packBase = path.relative(publicDir, packDir).split(path.sep).join("/");
  if (packBase.startsWith(".."))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--pack must be under public/." });
  const pack = readSynthPack(packDir);

  const index = args["no-library"] ? undefined : readSfxMeasureIndex(path.resolve(args.library!));
  const takes = (args["earshot-takes"]?.split(",").filter(Boolean) ?? []).map((receipt) => {
    if (!existsSync(path.resolve(receipt)))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Earshot take receipt not found: ${receipt}. Render the take first (sfx:synth --engine earshot writes <output>.take.json).`,
      });
    return { sound: earshotLibrarySounds([receipt], project, root)[0]!, receipt };
  });
  // A pack manifest can be committed while its audio is not rendered or synced (media stays out of git): skip those.
  const packEntries = pack?.entries.filter((entry) => existsSync(path.join(packDir, entry.file))) ?? [];
  if (pack && packEntries.length < pack.entries.length)
    emitProgress(
      `${pack.entries.length - packEntries.length} of ${pack.entries.length} pack sounds in ${packBase} are not on disk and were skipped (render them with sfx:synth).`,
    );
  const sources: AuditionSources = {
    takes,
    ...(index ? { library: librarySounds(index, (file) => existsSync(path.join(publicDir, file))) } : {}),
    ...(packEntries.length ? { pack: packSounds(packEntries, packBase) } : {}),
  };

  const status = earshotStatus();
  const auditing = status.available && !args["no-check"];
  const earshotState = auditing
    ? { available: true, packageSha: EARSHOT_SHA }
    : {
        available: false,
        reason: args["no-check"] ? "--no-check" : `${status.available ? "" : status.reason}. ${status.fix}`,
      };
  const reviewDir = path.join("public/projects", project, "pipeline/audio-review");
  // One saved audio:review report per candidate's bytes, reused on reruns and attached to critic packs.
  const check = async (file: string, sha256: string): Promise<CandidateChecks> => {
    if (!auditing) return { engine: "none", reason: earshotState.reason ?? "Earshot not prepared" };
    const report = path.join(reviewDir, `${sha256}.json`);
    try {
      let saved: unknown;
      if (existsSync(report)) saved = JSON.parse(readFileSync(report, "utf8"));
      else {
        emitProgress(`Earshot audit: ${file}`);
        saved = (
          await earshot({ action: "check", input: path.join("public", file) }, { projectId: project, output: report })
        ).metadata;
      }
      const parsed = SavedReportSchema.parse(saved);
      if (parsed.source.sha256 !== sha256) throw new Error(`saved report ${report} is of other bytes`);
      return {
        engine: "earshot",
        ok: parsed.result.ok,
        warnings: parsed.result.warnings.map(({ code, msg }) => ({ code, msg })),
        notes: parsed.result.notes.map(({ code, msg }) => ({ code, msg })),
        report: path.relative(path.join("public/projects", project), report),
      };
    } catch (error) {
      return {
        engine: "none",
        reason: `Earshot audit failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
  const selection = SfxSelectionSchema.parse(
    await audition({
      project,
      sheet,
      cueSheet: { path: path.relative(root, path.resolve(cueSheetPath)), sha256: hashFile(cueSheetPath) },
      ...(args["duration-sec"] !== undefined ? { durationSec: args["duration-sec"] } : {}),
      sources,
      earshot: earshotState,
      deps: {
        hash: (file) => hashFile(path.join(publicDir, file)),
        loudness: (file) => {
          const measured = analyzeAudio(path.join(publicDir, file));
          return { integratedLufs: measured.integratedLufs, truePeakDb: measured.truePeakDb };
        },
        check,
      },
    }),
  );
  const output = args.output ?? projectPipeline(project, "sfx-selection.json");
  writeJsonAtomic(output, selection);
  for (const cue of selection.cues) emitProgress(`${cue.cueId} (${cue.sfx}): ${cue.selected ?? "none"}. ${cue.reason}`);
  return {
    outputs: [output],
    metadata: {
      heroCues: selection.cues.length,
      selected: selection.cues.filter((cue) => cue.selected).length,
      candidates: selection.cues.reduce((sum, cue) => sum + cue.candidates.length, 0),
      earshot: selection.earshot,
      next: `pnpm sfx:cues … --cue-sheet ${cueSheetPath} --selection ${output}`,
      notice: selection.notice,
    },
  };
});
