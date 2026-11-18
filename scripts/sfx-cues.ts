import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { cueSoundTracks, planCueSounds, type PlacedBlock, type SoundEvent } from "../src/lib/audio/cue-sounds";
import { readSynthPack, SHARED_SYNTH_PACK } from "../src/lib/audio/sfx-pack";
import { librarySounds, readSfxMeasureIndex, SHARED_SFX_DIR, type IndexedSfxKind } from "../src/lib/audio/sfx-index";
import { fetchSfx, freezeProjectSfx, missingSfx } from "../src/lib/audio/sfx-fetch";
import { LocalAudioMixSchema } from "../src/types/audio-master";
import { maskingFromFiles, readMixPlan } from "../src/lib/audio/masking-files";
import { projectPipeline } from "../src/lib/film/inputs";
import {
  duckKeyframes,
  safeFixes,
  stripFixMasking,
  type DuckWindow,
  type MaskingReport,
  type TaggedKeyframe,
} from "../src/lib/audio/masking";
import {
  decideFilmEvents,
  describeUndecided,
  DECISION_FIX,
  isDecided,
  seamCues,
  soundCueWeight,
} from "../src/lib/audio/cut-decisions";
import { readJsonFile } from "../src/lib/film/inputs";
import { MotionPlanSchema } from "../src/types/creative";
import { CueSheetSchema } from "../src/types/film";
import type { PlannedCue } from "../src/lib/audio/cue-sounds";
import { earshotLibrarySounds } from "../src/lib/audio/earshot";
import { selectedSounds } from "../src/lib/audio/sfx-audition";
import { SfxSelectionSchema } from "../src/types/sfx-selection";
import { hashFile } from "../src/lib/assets/registry";

const CueSchema = z.object({
  frame: z.number().int(),
  kind: z.enum(["land", "hit", "cut", "reveal", "click", "type", "exit", "peak", "stop"]),
  sfx: z.enum(["click", "pop", "whoosh", "impact", "chime", "riser", "sub-drop", "tick", "glass", "none"]).optional(),
  weight: z.enum(["hero", "support"]).optional(),
  label: z.string().optional(),
  /** Extra sounds layered on a hero cue. */
  layers: z
    .array(z.enum(["click", "pop", "whoosh", "impact", "chime", "riser", "sub-drop", "tick", "glass"]))
    .min(1)
    .optional(),
});
const PlacementsSchema = z.object({
  fps: z.number().positive(),
  durationInFrames: z.number().int().positive(),
  blocks: z.array(
    z.object({
      /** Library item id, e.g. "hero-stat-odometer". */
      id: z.string().min(1),
      startFrame: z.number().int(),
      props: z.record(z.string(), z.unknown()).optional(),
      /** Explicit cues instead of the item's own `cues(props)`; also for blocks outside the library. */
      cues: z.array(CueSchema).optional(),
      /** Extra cues added to the item's own. */
      extraCues: z.array(CueSchema).optional(),
    }),
  ),
});

const SPECS = [
  {
    name: "placements",
    required: true,
    description: "JSON {fps, durationInFrames, blocks:[{id, startFrame, props?, cues?, extraCues?}]}",
  },
  { name: "output", required: true, description: "Where to write the sound cue sheet JSON (events for <CueSounds>)" },
  { name: "pack", default: SHARED_SYNTH_PACK, description: "Directory with pack.json, under public/" },
  { name: "plan-output", description: "Also write an audio:mix plan with these sounds as sfx tracks" },
  { name: "merge", description: "With --plan-output: an existing audio:mix plan to add the sfx tracks to" },
  {
    name: "library",
    default: "public/shared/sfx/sfx-index.json",
    description: "Measured SFX index (sfx:index) to pick from by fit to each cue; the pack is the fallback",
  },
  { name: "no-library", type: "boolean", description: "Use only the synth pack" },
  {
    name: "earshot-takes",
    description: "Comma-separated project take JSONs rendered with a --kind; overrides those library families",
  },
  {
    name: "min-gap-frames",
    type: "number",
    description: "Explicit minimum spacing for repeated sounds (default 2 frames)",
  },
  { name: "no-fetch", type: "boolean", description: "Do not fetch missing collection files before choosing" },
  {
    name: "project",
    description:
      "Copy the chosen library sounds into public/projects/<id>/assets/sfx/library/ with provenance.json, and point the events there",
  },
  {
    name: "motion-plan",
    description: "MotionPlan JSON: every shot boundary is a cut that must be decided (sound or silence)",
  },
  {
    name: "cue-sheet",
    description:
      "CueSheet JSON (edit:snap): its cut, transition and hero cues carry the decisions (sfx, silent.reason, layers), placed over the blocks' own sounds",
  },
  {
    name: "selection",
    description:
      "sfx:audition's sfx-selection.json: each hero cue's chosen sound is placed on it (needs --cue-sheet); budgets, layers and gain stay the planner's",
  },
  { name: "seed", type: "number", default: 1, description: "Seed for the choice among equally fitting library sounds" },
  { name: "budget-sec", type: "number", default: 15, description: "One riser and one impact per this many seconds" },
  {
    name: "fix-masking",
    type: "boolean",
    description:
      "Read masking (audio:masking) against --music/--vo and apply the safe fixes: SFX gain within its ceiling and short music ducks as audio:mix keyframes",
  },
  {
    name: "music",
    description: "With --fix-masking: the music file, or its audio map, when the plan has no music track",
  },
  { name: "vo", description: "With --fix-masking: the voice-over file, when the plan has no speech track" },
  {
    name: "music-gain",
    type: "number",
    description: "With --fix-masking and no music track in the plan: music volume (default 1)",
  },
  {
    name: "music-offset-sec",
    type: "number",
    description: "With --fix-masking and no music track in the plan: film second where the music starts (default 0)",
  },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  requireFile(args.placements!);
  const placements = PlacementsSchema.parse(JSON.parse(readFileSync(args.placements!, "utf8")));
  const packDir = path.resolve(args.pack!);
  const publicDir = path.resolve("public");
  const packBase = path.relative(publicDir, packDir).split(path.sep).join("/");
  if (packBase.startsWith(".."))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--pack must be under public/ so scenes can staticFile() it.",
    });
  const pack = readSynthPack(packDir);
  if (!pack)
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `No pack.json in ${args.pack}. Run pnpm sfx:synth first.`,
    });

  const needsLibrary = placements.blocks.some((block) => !block.cues);
  const library = needsLibrary ? (await import("../src/lib/library/load")).loadLibrary() : undefined;
  const items = library ? (await library).items : [];
  const warnings: string[] = [];
  const blocks: PlacedBlock[] = placements.blocks.map((block) => {
    let cues: PlannedCue[] = block.cues ?? [];
    if (!block.cues) {
      const item = items.find((candidate) => candidate.id === block.id);
      if (!item)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `Unknown library block "${block.id}". Pass its cues explicitly.`,
        });
      if (!item.cues) warnings.push(`${block.id} declares no cues.`);
      const seamed = seamCues(item.cues?.({ ...item.defaultProps, ...(block.props ?? {}) }) ?? [], block.props);
      if (item.category === "transitions" && !seamed.placed && seamed.cues.some((cue) => cue.kind === "cut"))
        warnings.push(
          `${block.id}@${block.startFrame}: no seamFrame in its props, so its cut cue sits on the preview's centred seam, not necessarily on the film's. Set props.seamFrame (frames from the block's start to the perceived cut).`,
        );
      cues = seamed.cues;
    }
    return { blockId: block.id, startFrame: block.startFrame, cues: [...cues, ...(block.extraCues ?? [])] };
  });

  // Every cut, transition and hero moment is decided: a sound or a silence with its reason. Checked when the film's
  // plan or cue sheet is given; placements alone keep the blocks' own sounds as before.
  const motionPlan = args["motion-plan"]
    ? readJsonFile(args["motion-plan"], MotionPlanSchema, "Motion plan")
    : undefined;
  const cueSheet = args["cue-sheet"] ? readJsonFile(args["cue-sheet"], CueSheetSchema, "Cue sheet") : undefined;
  const decisions =
    motionPlan || cueSheet ? decideFilmEvents({ fps: placements.fps, plan: motionPlan, cueSheet, blocks }) : undefined;
  if (decisions?.some((event) => !isDecided(event))) {
    const open = describeUndecided(decisions);
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${open.length} cut(s), transition(s) or hero moment(s) undecided: ${open.join("; ")}. ${DECISION_FIX}`,
      details: { undecided: decisions.filter((event) => !isDecided(event)) },
    });
  }
  // sfx:audition's choices: each selected sound goes on its cue, checked against the bytes it was measured on.
  const selection = args.selection ? readJsonFile(args.selection, SfxSelectionSchema, "SFX selection") : undefined;
  if (selection && !cueSheet)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--selection binds cue-sheet cues: pass --cue-sheet." });
  const chosen = selectedSounds(selection);
  for (const [cueId, { sound, sha256 }] of chosen) {
    const file = path.join(publicDir, sound.file);
    if (!existsSync(file) || hashFile(file) !== sha256)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `The sound selected for ${cueId} (${sound.file}) is missing or changed since sfx:audition; run sfx:audition again.`,
      });
  }
  if (decisions && cueSheet) {
    const byId = new Map(cueSheet.cues.map((cue) => [cue.id, cue]));
    const sheetCues: PlannedCue[] = decisions.flatMap((event) => {
      if (event.by !== "cue-sheet" || !event.cueId) return [];
      const source = byId.get(event.cueId);
      const layers = event.state === "sound" ? event.layers : undefined;
      const weight = source ? soundCueWeight(source) : layers || event.kind !== "cut" ? "hero" : "support";
      const selected = event.state === "sound" ? chosen.get(event.cueId) : undefined;
      return [
        {
          frame: event.frame,
          kind: event.kind,
          decided: true,
          weight,
          label: event.cueId,
          ...(event.state === "sound"
            ? { sfx: event.sfx, ...(layers ? { layers } : {}), ...(selected ? { sound: selected.sound } : {}) }
            : { sfx: "none" as const, silent: { reason: event.state === "silent" ? event.reason : "" } }),
        },
      ];
    });
    if (sheetCues.length) blocks.push({ blockId: "cue-sheet", startFrame: 0, cues: sheetCues });
  }

  let fetched: unknown;
  if (!args["no-library"] && !args["no-fetch"]) {
    const sharedRoot = path.resolve(SHARED_SFX_DIR);
    const wanted = new Set(
      blocks
        .flatMap((block) => block.cues.flatMap((cue) => [cue.sfx, ...(cue.layers ?? [])]))
        .filter((sfx): sfx is IndexedSfxKind => !!sfx && sfx !== "none"),
    );
    const missing = [...wanted].filter((kind) => missingSfx(sharedRoot, kind).length);
    if (missing.length)
      fetched = (await Promise.all(missing.map((kind) => fetchSfx({ kind })))).map((result) => result.counts);
  }
  const sfxIndex = args["no-library"] ? undefined : readSfxMeasureIndex(path.resolve(args.library!));
  const bankSounds = args["earshot-takes"]
    ? args.project
      ? earshotLibrarySounds(args["earshot-takes"].split(","), args.project)
      : (() => {
          throw new Error("--earshot-takes requires --project");
        })()
    : [];
  const selectedKinds = new Set(bankSounds.map((sound) => sound.kind));
  const measuredSounds =
    bankSounds.length || sfxIndex
      ? [
          ...bankSounds,
          ...(sfxIndex
            ? librarySounds(sfxIndex, (file) => existsSync(path.join(publicDir, file))).filter(
                (sound) => !selectedKinds.has(sound.kind),
              )
            : []),
        ]
      : undefined;
  if (
    args["min-gap-frames"] !== undefined &&
    (!Number.isInteger(args["min-gap-frames"]) ||
      args["min-gap-frames"] < 0 ||
      args["min-gap-frames"] > placements.fps * 60)
  )
    throw new Error("Minimum gap must be an integer between zero and one minute");
  const planned = planCueSounds(blocks, {
    fps: placements.fps,
    durationInFrames: placements.durationInFrames,
    pack: pack.entries,
    packBase,
    budgetWindowSec: args["budget-sec"],
    minGapFrames: args["min-gap-frames"],
    library: measuredSounds,
    seed: args.seed,
    ...(args.project ? { project: args.project } : {}),
  });
  const { dropped, silences } = planned;
  let events = planned.events;
  if (args.project) {
    const moved = freezeProjectSfx(
      events
        .filter((event) => event.origin === "library" && !event.file.startsWith(`projects/${args.project}/`))
        .map((event) => event.file),
      { publicDir, projectDir: path.join(publicDir, "projects", args.project) },
    );
    events = events.map((event) => (moved[event.file] ? { ...event, file: moved[event.file]! } : event));
  }
  // A rerun replaces what the last run wrote: its sfx tracks (read back from the previous sheet) and its tagged duck keyframes.
  type BaseTrack = {
    role?: string;
    source?: string;
    startSec?: number;
    volume?: number;
    sourceEndSec?: number;
    keyframes?: TaggedKeyframe[];
  };
  const previous = existsSync(args.output!)
    ? (JSON.parse(readFileSync(args.output!, "utf8")) as { fps?: number; events?: SoundEvent[] })
    : undefined;
  const previousTracks = previous?.events && previous.fps ? cueSoundTracks(previous.events, previous.fps) : [];
  const fromLastRun = (track: BaseTrack) =>
    track.role === "sfx" &&
    previousTracks.some(
      (old) => old.source === track.source && old.startSec === track.startSec && old.volume === track.volume,
    );
  const undoLastRun = <P extends { tracks?: BaseTrack[] }>(plan: P): P => ({
    ...plan,
    tracks: (plan.tracks ?? [])
      .filter((track) => !fromLastRun(track))
      .map((track) =>
        track.role === "music" && track.keyframes ? { ...track, keyframes: stripFixMasking(track.keyframes) } : track,
      ),
  });
  const mergedBase = args.merge
    ? undoLastRun(JSON.parse(readFileSync(args.merge, "utf8")) as { tracks?: BaseTrack[] })
    : undefined;
  let masking: { report: MaskingReport; ducks: DuckWindow[]; changed: string[]; reportPath: string } | undefined;
  if (args["fix-masking"]) {
    const projectPlan = args.project ? projectPipeline(args.project, "mix-plan.json") : undefined;
    const planPath = args.merge ?? (projectPlan && existsSync(projectPlan) ? projectPlan : undefined);
    const read = readMixPlan(planPath);
    const mixPlan = read ? undoLastRun(read) : undefined;
    if (!mixPlan?.tracks.some((track) => track.role === "music") && !args.music)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message:
          "--fix-masking needs a music track in the plan (--merge, or pipeline/mix-plan.json with --project) or --music (the file, or its audio map).",
      });
    const report = maskingFromFiles({
      cues: { fps: placements.fps, durationInFrames: placements.durationInFrames, events },
      plan: mixPlan,
      planPath,
      music: args.music,
      vo: args.vo,
      musicGain: args["music-gain"],
      musicStartSec: args["music-offset-sec"],
      publicDir,
    });
    const fixed = safeFixes(events, report);
    events = fixed.events;
    const reportPath = args.output!.replace(/\.json$/, "") + ".masking.json";
    masking = { report, ducks: fixed.ducks, changed: fixed.changed, reportPath };
  }
  const musicDuck = masking?.ducks.length
    ? { windows: masking.ducks, keyframes: duckKeyframes(masking.ducks, { volume: args["music-gain"] ?? 1 }) }
    : undefined;
  mkdirSync(path.dirname(path.resolve(args.output!)), { recursive: true });
  writeFileSync(
    args.output!,
    `${JSON.stringify({ schemaVersion: 1, fps: placements.fps, durationInFrames: placements.durationInFrames, pack: packBase, events, dropped, silences, ...(decisions ? { decisions } : {}), blockCues: blocks.flatMap((block) => block.cues.map((cue) => ({ frame: block.startFrame + cue.frame, kind: cue.kind, blockId: block.blockId, ...(cue.label ? { label: cue.label } : {}) }))), ...(masking ? { masking: masking.report.summary } : {}), ...(musicDuck ? { musicDuck } : {}) }, null, 2)}\n`,
  );
  const outputs = [args.output!];
  if (masking) {
    writeFileSync(masking.reportPath, `${JSON.stringify(masking.report, null, 2)}\n`);
    outputs.push(masking.reportPath);
  }
  if (args["plan-output"]) {
    const tracks = cueSoundTracks(events, placements.fps);
    const base = mergedBase ?? { version: 1, durationSec: placements.durationInFrames / placements.fps, tracks: [] };
    const ducks = masking?.ducks ?? [];
    const existing = (base.tracks ?? []).map((track) =>
      ducks.length && track.role === "music"
        ? { ...track, keyframes: duckKeyframes(ducks, { volume: track.volume ?? 1, keyframes: track.keyframes }) }
        : track,
    );
    const plan = LocalAudioMixSchema.parse({ ...base, tracks: [...existing, ...tracks] });
    writeFileSync(args["plan-output"], `${JSON.stringify(plan, null, 2)}\n`);
    outputs.push(args["plan-output"]);
  }
  return {
    outputs,
    metadata: {
      events: events.length,
      hero: events.filter((event) => event.weight === "hero").length,
      ...(fetched ? { fetched } : {}),
      fromLibrary: events.filter((event) => event.origin === "library").length,
      library: measuredSounds ? `${measuredSounds.length} measured sounds` : "none: synth pack only",
      dropped,
      ...(decisions
        ? {
            decided: {
              events: decisions.length,
              sound: decisions.filter((event) => event.state === "sound").length,
              silent: silences.length,
              layers: events.filter((event) => event.layerOf).length,
            },
          }
        : {}),
      warnings,
      ...(masking
        ? {
            masking: masking.report.summary,
            maskingFixes: masking.changed,
            maskingAssumed: masking.report.inputs,
            ...(musicDuck && !mergedBase?.tracks?.some((track) => track.role === "music")
              ? {
                  musicDuckNote:
                    "No music track in the plan: the duck keyframes are in the cue sheet's musicDuck; copy them onto the music track.",
                }
              : {}),
          }
        : {}),
      notice: "Agents cannot hear: placement and gain are rules, not taste. The user judges the result.",
      apiCalls: 0,
    },
  };
});
