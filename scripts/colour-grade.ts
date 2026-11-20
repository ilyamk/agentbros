import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { bakeCube, fillSegments, loadGrade, loadTimeline, probeVideo, renderGraded } from "../src/lib/colour/grade";

const SPECS = [
  { name: "grade", description: "A grade.json (see docs/colour-grading.md); required unless --timeline is given" },
  { name: "timeline", description: "A timeline.json of per-shot grades (from colour:shots --solve)" },
  { name: "input", description: "Video or still to grade" },
  { name: "output", description: "Graded file (.mp4/.mov, or .png/.tif for a still); never the input" },
  { name: "export-cube", description: "Also write the grade as a .cube LUT for Resolve or any grading tool" },
  { name: "lut-size", type: "number", default: 33, description: "Lattice size of baked LUTs (17, 33 or 65)" },
  { name: "codec", choices: ["h264", "prores"], default: "h264", description: "h264 (CRF) or ProRes 422 HQ for further grading" },
  { name: "crf", type: "number", default: 14, description: "x264 quality when --codec h264" },
  { name: "matrix", choices: ["bt709", "bt601", "bt2020"], description: "Override the Y'CbCr matrix of an untagged input" },
  { name: "range", choices: ["limited", "full"], description: "Override the code-value range of an untagged input" },
  { name: "force", type: "boolean", description: "Overwrite an existing output or cube" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (!args.grade && !args.timeline)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --grade grade.json or --timeline timeline.json" });
  if (args.grade && args.timeline)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass either --grade or --timeline, not both" });
  if (!args.output && !args["export-cube"])
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Nothing to do: pass --input with --output, and/or --export-cube" });
  if (args.output && !args.input) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--output needs --input" });
  const size = Math.round(args["lut-size"] ?? 33);
  if (![17, 33, 65].includes(size)) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--lut-size must be 17, 33 or 65" });
  for (const target of [args.output, args["export-cube"]]) {
    if (target && existsSync(target) && !args.force)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `${target} exists; pass --force to overwrite it` });
  }
  if (args.input && args.output && path.resolve(args.input) === path.resolve(args.output))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--output must differ from --input" });
  if (args.timeline && args["export-cube"])
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--export-cube exports one grade; pass --grade for it" });

  const work = mkdtempSync(path.join(tmpdir(), "colour-grade-"));
  try {
    const outputs: string[] = [];
    const metadata: Record<string, unknown> = { apiCalls: 0 };
    const bake = (gradeFile: string, target: string) => {
      const baked = bakeCube(loadGrade(gradeFile), gradeFile, target, size);
      return { path: baked.path, identity: baked.identity, maxDelta: baked.maxDelta };
    };
    let segments: { start: number; end: number; cube: string | null }[] = [];
    if (args.grade) {
      const gradeFile = path.resolve(args.grade);
      const cube = args["export-cube"] ? path.resolve(args["export-cube"]) : path.join(work, "grade.cube");
      if (args["export-cube"]) mkdirSync(path.dirname(cube), { recursive: true });
      const baked = bake(gradeFile, cube);
      metadata.cube = baked;
      if (args["export-cube"]) outputs.push(cube);
      segments = [{ start: 0, end: Number.POSITIVE_INFINITY, cube }];
    } else {
      const timelineFile = path.resolve(args.timeline!);
      requireFile(timelineFile);
      const timeline = loadTimeline(timelineFile);
      const dir = path.dirname(timelineFile);
      const base = timeline.base ? bake(path.resolve(dir, timeline.base), path.join(work, "base.cube")).path : null;
      const baked = timeline.segments.map((segment, index) => ({
        start: segment.start,
        end: segment.end,
        cube: bake(path.resolve(dir, segment.grade), path.join(work, `s${index}.cube`)).path,
      }));
      const duration = args.input ? probeVideo(path.resolve(args.input)).duration : 0;
      segments = fillSegments(baked, duration, base);
      metadata.segments = segments.map((s, i) => ({ index: i, start: s.start, end: s.end, graded: s.cube !== null }));
    }
    if (args.input && args.output) {
      requireFile(args.input);
      ensureFfmpeg();
      const rendered = renderGraded({
        input: path.resolve(args.input),
        output: path.resolve(args.output),
        segments,
        codec: (args.codec ?? "h264") as "h264" | "prores",
        crf: args.crf ?? 14,
        matrix: args.matrix,
        range: args.range,
      });
      outputs.unshift(args.output);
      metadata.render = { ...rendered, codec: args.codec, output: args.output, tags: "bt709 / bt709 / bt709, limited range" };
      metadata.next = `pnpm colour:compare --input ${args.output} --reference <reference> --output <dir>`;
    }
    return { outputs, metadata };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
