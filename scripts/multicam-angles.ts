import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject, emitProgress, parseArgs, requireFile, runScript } from "../src/lib/cli";
import {
  activityFromAsd,
  activityFromEnergy,
  activityFromTranscript,
  angleTrackCommand,
  DEFAULT_RULES,
  proposeAngles,
  toReference,
  type Activity,
} from "../src/lib/multicam/angles";
import { extractWav, sha256File } from "../src/lib/multicam/media";
import { runMulticamWorker } from "../src/lib/multicam/worker";
import {
  AngleMapSchema,
  AnglePlanSchema,
  AsdResultSchema,
  MulticamSyncSchema,
  type AnglePlan,
} from "../src/types/multicam";
import { TranscriptSchema } from "../src/types/transcript";

const SPECS = [
  { name: "sync", required: true, description: "sync.json from multicam:sync" },
  { name: "output", required: true, description: "Where to write the angle proposal (angles.json)" },
  { name: "map", description: "Angle map JSON: speakers [{speaker, angle, mic?, position?}], wide?, audio?" },
  { name: "transcript", description: "TranscriptSchema JSON (diarised speakers, sentences for cut snapping)" },
  {
    name: "transcript-source",
    description: "Sync source id the transcript was made from (default: matched by sha256, else the reference)",
  },
  { name: "asd", description: "Visual active-speaker result (light-asd worker) for shared audio" },
  {
    name: "method",
    default: "auto",
    choices: ["auto", "mic-energy", "diarisation", "visual-asd", "wide-only"],
    description: "Speaker evidence; auto prefers separate mics, then diarisation, then visual detection",
  },
  { name: "fps", type: "number", default: 30, description: "Timeline frames per second" },
  { name: "min-shot", type: "number", default: DEFAULT_RULES.minShotSec, description: "Minimum shot length, seconds" },
  {
    name: "overlap-wide",
    type: "number",
    default: DEFAULT_RULES.overlapWideSec,
    description: "Overlapping speech longer than this goes to the wide shot, seconds",
  },
  {
    name: "command-output",
    description: "Also write a timeline-edit add-track command (one visual track switching cameras)",
  },
  { name: "track-id", default: "multicam", description: "Track id for --command-output" },
  {
    name: "sound-track-id",
    description: "Also add the programme sound (map.audio or the reference) on a voiceover track with this id",
  },
  { name: "assets", description: "Comma-separated sourceId=assetId pairs (default: sha256:<source hash>)" },
] as const;

const readJson = (file: string) => {
  requireFile(file);
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
};

void runScript(async () => {
  const args = parseArgs(SPECS);
  const sync = MulticamSyncSchema.parse(readJson(args.sync!));
  const map = args.map ? AngleMapSchema.parse(readJson(args.map)) : null;
  const transcript = args.transcript ? TranscriptSchema.parse(readJson(args.transcript)) : null;
  const asd = args.asd ? AsdResultSchema.parse(readJson(args.asd)) : null;
  const byId = new Map(sync.sources.map((source) => [source.id, source]));
  for (const id of [
    ...(map?.speakers.flatMap((row) => [row.angle, ...(row.mic ? [row.mic] : [])]) ?? []),
    ...(map?.wide ? [map.wide] : []),
    ...(map?.audio ? [map.audio] : []),
  ]) {
    if (!byId.has(id))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `Angle map names unknown source ${id}` });
  }
  const reference = byId.get(sync.referenceId)!;
  const transcriptSource = transcript
    ? ((args["transcript-source"]
        ? byId.get(args["transcript-source"])
        : sync.sources.find((source) => source.sha256 === transcript.source.sha256)) ?? reference)
    : reference;
  const rules = { ...DEFAULT_RULES, minShotSec: args["min-shot"], overlapWideSec: args["overlap-wide"] };
  const mics = (map?.speakers ?? []).filter((row) => row.mic);
  const separateMics = mics.length >= 2 && new Set(mics.map((row) => row.mic)).size === mics.length;
  const diarised =
    !!transcript &&
    transcript.engine.diarized &&
    new Set(transcript.words.map((word) => word.speaker).filter(Boolean)).size >= 2;
  const method = (
    args.method === "auto"
      ? separateMics
        ? "mic-energy"
        : diarised
          ? "diarisation"
          : asd
            ? "visual-asd"
            : "wide-only"
      : args.method
  ) as AnglePlan["method"];
  const notes: string[] = [];
  let activity: Activity | null = null;
  if (method === "mic-energy") {
    if (!separateMics)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "mic-energy needs a map with a distinct mic source for at least two speakers",
      });
    const work = mkdtempSync(path.join(tmpdir(), "multicam-angles-"));
    try {
      const wavs = mics.map((row, index) => {
        const wav = path.join(work, `${index}.wav`);
        extractWav(byId.get(row.mic!)!.file, wav);
        return wav;
      });
      emitProgress("Measuring per-mic levels");
      const energy = runMulticamWorker<{ hopSec: number; levels: number[][] }>("energy", {
        files: wavs,
        hopSec: rules.hopSec,
      });
      activity = activityFromEnergy(
        mics.map((row, index) => ({
          speaker: row.speaker,
          source: byId.get(row.mic!)!,
          levels: energy.levels[index]!,
          hopSec: energy.hopSec,
        })),
        reference.durationSec,
        rules,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } else if (method === "diarisation") {
    if (!diarised)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "diarisation needs a diarised transcript with at least two speakers",
      });
    activity = activityFromTranscript(transcript!, transcriptSource, reference.durationSec, rules);
  } else if (method === "visual-asd") {
    if (!asd || !map)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "visual-asd needs --asd and a --map with speaker positions",
      });
    const camera = byId.get(asd.source);
    if (!camera)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `ASD source ${asd.source} is not in the sync` });
    activity = activityFromAsd(asd, camera, map, reference.durationSec, rules);
    notes.push("Speaker activity from visual active-speaker detection; check faces were mapped to the right speakers.");
  }
  if (method !== "mic-energy" && separateMics)
    notes.push("Separate mics were mapped but not used; mic-energy is the stronger evidence.");
  const plan = AnglePlanSchema.parse({
    ...proposeAngles({
      sync,
      syncFile: { file: args.sync!, sha256: sha256File(args.sync!) },
      map,
      activity,
      method,
      fps: Number.isInteger(args.fps) ? { num: args.fps, den: 1 } : { num: Math.round(args.fps * 1000), den: 1000 },
      rules,
      sentenceStartsSec: transcript?.sentences.map((sentence) => toReference(transcriptSource, sentence.startSec)),
      focusSource: method === "visual-asd" ? asd!.source : null,
    }),
  });
  plan.notes.push(...notes);
  const output = path.resolve(args.output!);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`);
  const outputs = [args.output!];
  if (args["command-output"]) {
    const assetIds = Object.fromEntries(
      (args.assets ?? "")
        .split(",")
        .filter(Boolean)
        .map((pair) => pair.split("=") as [string, string]),
    );
    const command = angleTrackCommand(plan, sync, {
      trackId: args["track-id"]!,
      timebase: plan.fps,
      assetIds,
      soundTrackId: args["sound-track-id"],
      soundSource: map?.audio,
    });
    writeFileSync(path.resolve(args["command-output"]), `${JSON.stringify(command, null, 2)}\n`);
    outputs.push(args["command-output"]);
  }
  const counts = plan.segments.reduce<Record<string, number>>(
    (all, segment) => ({ ...all, [segment.reason]: (all[segment.reason] ?? 0) + 1 }),
    {},
  );
  return {
    outputs,
    metadata: { method, segments: plan.segments.length, reasons: counts, notes: plan.notes, apiCalls: 0 },
  };
});
