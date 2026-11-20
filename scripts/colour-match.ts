import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { DECODE_SPECS, decodeRequest, frameCount, parseCrop, parseRegion } from "../src/lib/colour/args";
import { runColourWorker } from "../src/lib/colour/worker";
import { GradeSchema, MatchResultSchema, MatchShotsResultSchema } from "../src/types/colour";

const SPECS = [
  { name: "input", required: true, description: "The clip to grade" },
  { name: "reference", required: true, description: "The clip or still to match" },
  {
    name: "output",
    required: true,
    description: "Where to write the editable grade.json (with --per-shot: a directory for grades/ and timeline.json)",
  },
  {
    name: "method",
    choices: ["stats", "paired"],
    default: "stats",
    description: "stats: Lab statistics per zone (any content); paired: per-pixel fit (same shot, aligned frames)",
  },
  { name: "strength", type: "number", default: 1, description: "Blend the solved grade toward identity, 0..1" },
  { name: "frames", type: "number", default: 8, description: "Frames per clip used for the fit" },
  { name: "reference-crop", default: "auto", description: "Active picture of the reference: auto, none or x,y,w,h" },
  {
    name: "skin",
    choices: ["match", "protect", "off"],
    default: "match",
    description:
      "match: fit the world on non-skin pixels, then a skin secondary toward the reference's skin; protect: hold the source skin; off: one global fit (old behaviour)",
  },
  { name: "skin-region", description: "Skin in the input as x,y,w,h in source pixels (default: the skin chroma rule)" },
  { name: "reference-skin-region", description: "Skin in the reference as x,y,w,h (default: the skin chroma rule)" },
  {
    name: "no-environment",
    type: "boolean",
    description: "Skip the environment secondary that rotates the dominant non-skin hue toward the reference",
  },
  {
    name: "per-shot",
    type: "boolean",
    description:
      "Two videos cut the same way (a regenerated or face-swapped edit and its source): solve one grade per shot",
  },
  { name: "force", type: "boolean", description: "Overwrite an existing grade file" },
  ...DECODE_SPECS,
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  requireFile(args.input!);
  requireFile(args.reference!);
  ensureFfmpeg();
  const output = path.resolve(args.output!);
  const guarded = args["per-shot"] ? path.join(output, "timeline.json") : output;
  if (existsSync(guarded) && !args.force)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${guarded} exists; pass --force to overwrite it or choose another path`,
    });
  const strength = args.strength ?? 1;
  if (!(strength >= 0 && strength <= 1))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--strength must be between 0 and 1" });
  const frames = frameCount(args.frames, 8);
  const request = {
    input: path.resolve(args.input!),
    reference: path.resolve(args.reference!),
    method: args.method,
    strength,
    referenceCrop: parseCrop(args["reference-crop"], "reference-crop"),
    skin: args.skin,
    skinRegion: parseRegion(args["skin-region"], "skin-region"),
    referenceSkinRegion: parseRegion(args["reference-skin-region"], "reference-skin-region"),
    environment: !args["no-environment"],
    ...decodeRequest(args),
  };
  const provenance = (frameTotal: number) => ({
    reference: path.basename(args.reference!),
    method: args.method ?? "stats",
    frames: frameTotal,
    strength,
  });
  if (args["per-shot"]) {
    if (args["skin-region"] || args["reference-skin-region"])
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--per-shot keys skin by the chroma rule in every shot; skin regions apply to a single-shot match",
      });
    const perShot = Math.min(frames, 6);
    const result = runColourWorker(
      "match",
      { ...request, output, perShot: true, frames: perShot },
      MatchShotsResultSchema,
    );
    mkdirSync(path.join(output, "grades"), { recursive: true });
    const segments = result.shots.map((shot) => {
      const grade = GradeSchema.parse({
        version: 1,
        name: `${shot.label} ${shot.start.toFixed(2)}-${shot.end.toFixed(2)}s: match to ${path.basename(args.reference!)}`,
        notes: `Solved by colour:match --per-shot. Stages: ${shot.stages.join("; ")}.`,
        matchedTo: provenance(perShot),
        ...shot.grade,
      });
      const file = path.join(output, "grades", `${shot.label}.json`);
      writeFileSync(file, `${JSON.stringify(grade, null, 2)}\n`);
      return { label: shot.label, start: shot.start, end: shot.end, grade: `grades/${shot.label}.json` };
    });
    const timeline = path.join(output, "timeline.json");
    writeFileSync(timeline, `${JSON.stringify({ version: 1, segments }, null, 2)}\n`);
    const report = path.join(output, "match.json");
    writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`);
    return {
      outputs: [timeline, ...segments.map((s) => path.join(output, s.grade)), result.files.preview!, report],
      metadata: {
        perShot: true,
        gate: result.gateStatus,
        shots: result.shots.map((s) => ({
          label: s.label,
          start: s.start,
          end: s.end,
          gate: s.gate.status,
          failed: s.gate.failed,
          warnings: s.gate.warnings,
        })),
        next: `pnpm colour:grade --timeline ${timeline} --input ${args.input} --output <graded>`,
        apiCalls: 0,
      },
    };
  }
  const evidence = output.replace(/\.json$/i, "") + "-match";
  mkdirSync(evidence, { recursive: true });
  const result = runColourWorker("match", { ...request, output: evidence, frames }, MatchResultSchema);
  const grade = GradeSchema.parse({
    version: 1,
    name: `match ${path.basename(args.input!)} to ${path.basename(args.reference!)}`,
    notes: `Solved by colour:match. Stages: ${result.stages.join("; ")}. Edit any value; colour:grade re-bakes the LUT from this file.`,
    matchedTo: provenance(frames),
    ...result.grade,
  });
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(grade, null, 2)}\n`);
  const report = path.join(evidence, "match.json");
  writeFileSync(
    report,
    `${JSON.stringify({ metrics: result.metrics, gate: result.gate, stages: result.stages, input: result.input, reference: result.reference, grade }, null, 2)}\n`,
  );
  return {
    outputs: [output, result.files.preview!, report],
    metadata: {
      grade,
      method: result.method,
      gate: result.gate.status,
      failed: result.gate.failed,
      warnings: result.gate.warnings,
      stages: result.stages,
      zoneDeltaE2000: { before: result.metrics.zoneDeltaE2000Before, after: result.metrics.zoneDeltaE2000After },
      preview: result.files.preview,
      note: "Gate and metrics are on sampled frames; zone dE alone is not proof. Render with colour:grade, then run colour:check against the source.",
      apiCalls: 0,
    },
  };
});
