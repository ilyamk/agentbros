import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { DECODE_SPECS, decodeRequest, frameCount } from "../src/lib/colour/args";
import { runColourWorker } from "../src/lib/colour/worker";
import { takeList } from "../src/lib/multicam/args";
import { GradeSchema, ShotsResultSchema } from "../src/types/colour";

const SPECS = [
  { name: "input", description: "One edited video: its cuts are detected and every shot measured" },
  { name: "output", required: true, description: "Directory for shots.png, shots.json and, with --solve, grades/ and timeline.json" },
  { name: "hero", type: "number", default: 0, description: "Index of the hero shot or clip the others are matched to" },
  { name: "reference", description: "Match everything to this clip or still instead of a hero shot" },
  { name: "tolerance", type: "number", default: 2.5, description: "Mean zone CIEDE2000 above which a shot is flagged" },
  { name: "frames", type: "number", default: 3, description: "Frames measured per shot" },
  { name: "cut-threshold", type: "number", default: 0.45, description: "Histogram distance (0..1) that counts as a cut" },
  { name: "solve", type: "boolean", description: "Solve a match grade per shot toward the hero and write a timeline" },
  { name: "force", type: "boolean", description: "Overwrite existing grades and timeline" },
  ...DECODE_SPECS,
] as const;

void runScript(async () => {
  const argv = process.argv.slice(2);
  const { values: listed, rest } = takeList(argv[0] === "--" ? argv.slice(1) : argv, "inputs");
  const clips = listed?.length === 1 ? listed[0]!.split(",") : listed;
  const args = parseArgs(SPECS, rest);
  if (!args.input && !clips?.length)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --input <edited video> or --inputs <clip> <clip> ..." });
  if (args.input && clips?.length) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --input or --inputs, not both" });
  const sources = args.input ? [args.input] : clips!;
  sources.forEach(requireFile);
  if (args.reference) requireFile(args.reference);
  ensureFfmpeg();
  const output = path.resolve(args.output!);
  const timelineFile = path.join(output, "timeline.json");
  if (args.solve && existsSync(timelineFile) && !args.force)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `${timelineFile} exists; pass --force to overwrite the solved grades` });
  mkdirSync(output, { recursive: true });
  const hero = Math.round(args.hero ?? 0);
  if (!args.reference && !args.input && (hero < 0 || hero >= sources.length))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `--hero must index one of the ${sources.length} clips` });
  const result = runColourWorker(
    "shots",
    {
      inputs: sources.map((source) => ({ path: path.resolve(source), label: args.input ? undefined : path.basename(source, path.extname(source)) })),
      detect: Boolean(args.input),
      hero,
      reference: args.reference ? path.resolve(args.reference) : undefined,
      tolerance: args.tolerance,
      frames: frameCount(args.frames, 3),
      cutThreshold: args["cut-threshold"],
      solve: Boolean(args.solve),
      output,
      ...decodeRequest(args),
    },
    ShotsResultSchema,
  );
  const outputs = [result.files.sheet!];
  const grades: string[] = [];
  if (args.solve) {
    const dir = path.join(output, "grades");
    mkdirSync(dir, { recursive: true });
    for (const shot of result.shots) {
      if (!shot.grade) continue;
      const file = path.join(dir, `${shot.label}.json`);
      const grade = GradeSchema.parse({
        version: 1,
        name: `${shot.label} matched to ${result.hero}`,
        matchedTo: { reference: result.hero, method: "stats", frames: frameCount(args.frames, 3) },
        ...shot.grade,
      });
      writeFileSync(file, `${JSON.stringify(grade, null, 2)}\n`);
      grades.push(file);
    }
    if (args.input) {
      const segments = result.shots
        .filter((shot) => shot.grade)
        .map((shot) => ({ label: shot.label, start: Number(shot.start), end: Number(shot.end), grade: `grades/${shot.label}.json` }));
      if (segments.length) {
        writeFileSync(timelineFile, `${JSON.stringify({ version: 1, segments }, null, 2)}\n`);
        outputs.push(timelineFile);
      }
    }
    outputs.push(...grades);
  }
  const report = path.join(output, "shots.json");
  writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`);
  outputs.push(report);
  return {
    outputs,
    metadata: {
      hero: result.hero,
      consistency: result.consistency,
      shots: result.shots.map((shot) => ({
        label: shot.label,
        start: shot.start,
        end: shot.end,
        meanDeltaE2000: shot.zones.meanDeltaE2000,
        outOfTolerance: shot.outOfTolerance,
        summary: shot.summary,
      })),
      sheet: result.files.sheet,
      next: args.solve
        ? args.input
          ? `pnpm colour:grade --timeline ${path.relative(process.cwd(), timelineFile)} --input ${args.input} --output <graded.mp4>`
          : "pnpm colour:grade --grade <grades/clip.json> --input <clip> --output <graded clip>"
        : undefined,
      apiCalls: 0,
    },
  };
});
