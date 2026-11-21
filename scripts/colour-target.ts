import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { DECODE_SPECS, decodeRequest, frameCount, parseRegion } from "../src/lib/colour/args";
import { runColourWorker } from "../src/lib/colour/worker";
import { ColourTargetSchema, GradeSchema, MoodPlanSchema, TargetResultSchema } from "../src/types/colour";

const SPECS = [
  {
    name: "input",
    required: true,
    description: "The reference (or any clip): measured shot by shot into target.json and a colour-script sheet",
  },
  { name: "output", required: true, description: "Directory for target.json and target.png" },
  { name: "frames", type: "number", default: 4, description: "Frames measured per shot" },
  { name: "single", type: "boolean", description: "One target for the whole clip (no cut detection)" },
  { name: "skin-region", description: "Skin as x,y,w,h in source pixels (default: the skin chroma rule)" },
  {
    name: "mood",
    description:
      'Mood plan: "at:valence,arousal;..." in seconds and -1..1, or a JSON file; solves a bounded grade per shot toward it',
  },
  { name: "strength", type: "number", default: 1, description: "Share of the mood move applied (0..1)" },
  { name: "force", type: "boolean", description: "Overwrite an existing target.json" },
  ...DECODE_SPECS,
] as const;

function moodPlan(value: string | undefined) {
  if (!value) return undefined;
  const raw = existsSync(value)
    ? JSON.parse(readFileSync(value, "utf8"))
    : value.split(";").map((part) => {
        const [at, mood] = part.split(":");
        const [valence, arousal] = (mood ?? "").split(",").map(Number);
        return { at: Number(at), valence, arousal };
      });
  const parsed = MoodPlanSchema.safeParse(raw);
  if (!parsed.success)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--mood must be "at:valence,arousal;..." with values in -1..1, or a JSON file of {at, valence, arousal}: ${parsed.error.issues[0]?.message}`,
    });
  return parsed.data;
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  requireFile(args.input!);
  ensureFfmpeg();
  const output = path.resolve(args.output!);
  const targetFile = path.join(output, "target.json");
  if (existsSync(targetFile) && !args.force)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `${targetFile} exists; pass --force to overwrite it` });
  const mood = moodPlan(args.mood);
  const strength = args.strength ?? 1;
  if (!(strength >= 0 && strength <= 1))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--strength must be between 0 and 1" });
  mkdirSync(output, { recursive: true });
  const result = runColourWorker(
    "target",
    {
      input: path.resolve(args.input!),
      output,
      perShot: !args.single,
      frames: frameCount(args.frames, 4),
      skinRegion: parseRegion(args["skin-region"], "skin-region"),
      ...(mood ? { mood, strength } : {}),
      ...decodeRequest(args),
    },
    TargetResultSchema,
  );
  const target = ColourTargetSchema.parse({
    version: 1,
    source: path.basename(args.input!),
    duration: result.duration,
    shots: result.shots.map(({ label, start, end, profile, wantedMood }) => ({
      label,
      start,
      end,
      profile,
      ...(wantedMood ? { wantedMood } : {}),
    })),
    tolerances: result.tolerances,
  });
  writeFileSync(targetFile, `${JSON.stringify(target, null, 2)}\n`);
  const outputs = [targetFile, result.files.sheet!];
  let timeline: string | undefined;
  if (mood) {
    mkdirSync(path.join(output, "grades"), { recursive: true });
    const segments = result.shots.map((shot) => {
      const solved = shot as typeof shot & { grade: Record<string, unknown> };
      const grade = GradeSchema.parse({
        version: 1,
        name: `${shot.label} ${shot.start.toFixed(2)}-${shot.end.toFixed(2)}s: mood ${shot.wantedMood?.valence},${shot.wantedMood?.arousal}`,
        notes:
          "Solved by colour:target --mood: brightness and warmth for valence, saturation and contrast for arousal, each capped. A convention, not a measured emotion.",
        ...solved.grade,
      });
      const file = path.join(output, "grades", `${shot.label}.json`);
      writeFileSync(file, `${JSON.stringify(grade, null, 2)}\n`);
      outputs.push(file);
      return { label: shot.label, start: shot.start, end: shot.end, grade: `grades/${shot.label}.json` };
    });
    timeline = path.join(output, "timeline.json");
    writeFileSync(timeline, `${JSON.stringify({ version: 1, segments }, null, 2)}\n`);
    outputs.push(timeline);
  }
  return {
    outputs,
    metadata: {
      target: targetFile,
      sheet: result.files.sheet,
      shots: result.shots.map((shot) => {
        const extra = shot as typeof shot & { gate?: { status: string; failed: string[] }; measured?: unknown };
        return {
          label: shot.label,
          start: shot.start,
          end: shot.end,
          scheme: shot.profile.colour.scheme,
          mood: shot.profile.mood,
          ...(extra.gate ? { gate: extra.gate.status, failed: extra.gate.failed } : {}),
        };
      }),
      ...(timeline ? { timeline } : {}),
      next: timeline
        ? `pnpm colour:grade --timeline ${timeline} --input ${args.input} --output <graded>; then pnpm colour:check --target ${targetFile} --input <graded> --source ${args.input}`
        : `pnpm colour:check --target ${targetFile} --input <graded> [--source <ungraded>]`,
      apiCalls: 0,
    },
  };
});
