import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { DECODE_SPECS, decodeRequest, frameCount, parseRegion } from "../src/lib/colour/args";
import { bakeCube, normaliseGrade, renderGraded } from "../src/lib/colour/grade";
import { DEFAULT_LOOKS, LOOKS, findLook } from "../src/lib/colour/looks";
import { runColourWorker } from "../src/lib/colour/worker";
import { GradeSchema, LooksResultSchema, type Look } from "../src/types/colour";

const SPECS = [
  { name: "list", type: "boolean", description: "List the looks with their intent, use, skin policy and risks" },
  { name: "input", description: "Video or still to try the looks on" },
  { name: "output", description: "Directory for looks.png, one still and one <look>.grade.json per look" },
  {
    name: "looks",
    description: `Comma-separated look ids (default: ${DEFAULT_LOOKS.join(",")}); see --list`,
  },
  { name: "family", choices: ["technical", "film", "commercial", "music-video"], description: "Only this family" },
  { name: "at", type: "number", description: "Show the looks on the frame at this time in seconds" },
  { name: "frames", type: "number", default: 3, description: "Frames measured for the skin solve and the gate" },
  { name: "skin-region", description: "Skin to hold as x,y,w,h in source pixels (default: the skin chroma rule)" },
  { name: "render", type: "boolean", description: "Also render the whole input once per look (<look>.mp4)" },
  { name: "force", type: "boolean", description: "Overwrite existing look grades and renders" },
  ...DECODE_SPECS,
] as const;

function describe(look: Look) {
  return {
    id: look.id,
    name: look.name,
    family: look.family,
    intent: look.intent,
    typicalUse: look.typicalUse,
    moves: look.moves,
    skin: look.skin,
    risks: look.risks,
  };
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (args.list) return { outputs: [], metadata: { looks: LOOKS.map(describe), defaults: DEFAULT_LOOKS } };
  if (!args.input || !args.output)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --input and --output (or --list)" });
  requireFile(args.input);
  ensureFfmpeg();
  let chosen: Look[];
  if (args.looks) {
    chosen = args.looks.split(",").map((id) => {
      const look = findLook(id.trim());
      if (!look)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `Unknown look "${id}"; pnpm colour:looks --list names them`,
        });
      return look;
    });
  } else if (args.family) chosen = LOOKS.filter((look) => look.family === args.family);
  else chosen = DEFAULT_LOOKS.map((id) => findLook(id)!);
  if (chosen.length > 11) throw new CliErrorObject({ code: "INVALID_INPUT", message: "At most 11 looks per grid" });
  const output = path.resolve(args.output);
  const existing = chosen.map((look) => path.join(output, `${look.id}.grade.json`)).filter((f) => existsSync(f));
  if (existing.length && !args.force)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${existing[0]} exists; pass --force to overwrite the look grades`,
    });
  mkdirSync(output, { recursive: true });
  const placeholder = path.join(output, "look.grade.json");
  const result = runColourWorker(
    "looks",
    {
      input: path.resolve(args.input),
      output,
      ...(args.at !== undefined ? { at: args.at } : { frames: frameCount(args.frames, 3) }),
      skinRegion: parseRegion(args["skin-region"], "skin-region"),
      looks: chosen.map((look) => ({
        id: look.id,
        name: look.name,
        skin: look.skin,
        grade: normaliseGrade(GradeSchema.parse(look.grade), placeholder),
      })),
      ...decodeRequest(args),
    },
    LooksResultSchema,
  );
  const outputs = [result.files.grid!];
  const summary = [];
  for (const [index, solved] of result.looks.entries()) {
    const look = chosen[index]!;
    const file = path.join(output, `${look.id}.grade.json`);
    const grade = GradeSchema.parse({
      version: 1,
      name: `${look.name} (colour:looks ${look.id})`,
      notes: `${look.intent} Skin policy: ${look.skin.mode}, chroma x${look.skin.chroma}. The skin secondary was solved on ${path.basename(args.input)}; re-run colour:looks for other footage.`,
      ...solved.grade,
    });
    writeFileSync(file, `${JSON.stringify(grade, null, 2)}\n`);
    outputs.push(file, solved.still);
    let render: string | undefined;
    if (args.render) {
      render = path.join(output, `${look.id}${/\.(png|tif|tiff|jpe?g)$/i.test(args.input) ? ".png" : ".mp4"}`);
      if (existsSync(render) && !args.force)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `${render} exists; pass --force` });
      const work = mkdtempSync(path.join(tmpdir(), "colour-looks-"));
      try {
        const cube = bakeCube(grade, file, path.join(work, "look.cube"), 33).path;
        renderGraded({
          input: path.resolve(args.input),
          output: render,
          segments: [{ start: 0, end: Number.POSITIVE_INFINITY, cube }],
          codec: "h264",
          crf: 16,
          matrix: args.matrix,
          range: args.range,
        });
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      outputs.push(render);
    }
    summary.push({
      ...describe(look),
      gate: solved.gate.status,
      failed: solved.gate.failed,
      warnings: solved.gate.warnings,
      grade: file,
      still: solved.still,
      ...(render ? { render } : {}),
    });
  }
  writeFileSync(path.join(output, "looks.json"), `${JSON.stringify({ input: args.input, looks: summary }, null, 2)}\n`);
  outputs.push(path.join(output, "looks.json"));
  return {
    outputs,
    metadata: {
      grid: result.files.grid,
      looks: summary,
      next: "pnpm colour:grade --grade <dir>/<look>.grade.json --input <video> --output <graded>",
      note: "The gate measures skin, levels and saturation; which look fits the film is the user's call.",
      apiCalls: 0,
    },
  };
});
