import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { DECODE_SPECS, decodeRequest, frameCount, parseRegion } from "../src/lib/colour/args";
import { bakeCube, normaliseGrade, renderGraded } from "../src/lib/colour/grade";
import { DEFAULT_LOOKS, LOOKS, findLook, looksForMood } from "../src/lib/colour/looks";
import { formatMarkdown, looksDoc } from "../src/lib/colour/looks-doc";
import { runColourWorker } from "../src/lib/colour/worker";
import { ColourTargetSchema, GradeSchema, LooksResultSchema, type Look } from "../src/types/colour";

const SPECS = [
  { name: "list", type: "boolean", description: "List the looks with their intent, use, skin policy and risks" },
  { name: "write-doc", type: "boolean", description: "Regenerate docs/library/looks.md, the Looks & colour section" },
  { name: "input", description: "Video or still to try the looks on" },
  { name: "card", type: "boolean", description: "Use the synthetic test card (grey ramp, hues, skin tones) instead" },
  {
    name: "lut",
    description: "Comma-separated imported .cube files (colour:lut, licence on record) to try as looks",
  },
  { name: "output", description: "Directory for looks.png, one still and one <look>.grade.json per look" },
  {
    name: "looks",
    description: `Comma-separated look ids (default: ${DEFAULT_LOOKS.join(",")}); see --list`,
  },
  { name: "family", choices: ["technical", "film", "commercial", "music-video"], description: "Only this family" },
  {
    name: "mood",
    description: "valence,arousal in -1..1: the six looks nearest this mood (convention, not a verdict)",
  },
  { name: "target", description: "target.json from colour:target: the six looks nearest its duration-weighted mood" },
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
    mood: look.mood,
    palette: look.palette,
    finish: look.finish,
    skin: look.skin,
    risks: look.risks,
  };
}

/** An imported LUT as a look: it must be on record in the luts.json colour:lut wrote beside it. */
function lutLook(file: string): Look {
  const cube = path.resolve(file.trim());
  requireFile(cube);
  const registry = path.join(path.dirname(cube), "luts.json");
  const entry = existsSync(registry)
    ? (
        JSON.parse(readFileSync(registry, "utf8")) as {
          luts: {
            id: string;
            file: string;
            licence: string;
            source: string;
            attribution?: string;
            moodShift: { valence: number; arousal: number };
          }[];
        }
      ).luts.find((e) => e.file === path.basename(cube))
    : undefined;
  if (!entry)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${cube} has no licence on record; import it with pnpm colour:lut --add <file> --licence ... first`,
    });
  return {
    id: `lut-${entry.id}`,
    name: `LUT ${entry.id}`,
    family: "film",
    intent: `Imported LUT (${entry.licence}, ${entry.source}).`,
    typicalUse: "as its author intends; check skin and levels on this footage",
    moves: ["whatever the LUT encodes; skin held by a solved secondary"],
    mood: { valence: entry.moodShift.valence, arousal: entry.moodShift.arousal },
    palette: { scheme: "analogous", keyHues: [] },
    finish: "none",
    lut: {
      path: cube,
      licence: entry.licence,
      source: entry.source,
      ...(entry.attribution ? { attribution: entry.attribution } : {}),
    },
    skin: { mode: "hold", chroma: 1, hueAllowance: 6, lightness: 0, warm: false },
    risks: ["built for other footage: levels and skin may break", "licence terms travel with the file"],
    grade: { version: 1, luts: [{ path: cube, position: "input", strength: 1 }] },
  };
}

/** The mood asked for: --mood directly, or the duration-weighted mood of a target's shots. */
function wantedMood(mood: string | undefined, target: string | undefined) {
  if (mood) {
    const [valence, arousal] = mood.split(",").map(Number);
    if (![valence, arousal].every((n) => n !== undefined && Number.isFinite(n) && n >= -1 && n <= 1))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--mood must be valence,arousal in -1..1" });
    return { valence: valence!, arousal: arousal! };
  }
  if (!target) return undefined;
  requireFile(target);
  const parsed = ColourTargetSchema.parse(JSON.parse(readFileSync(target, "utf8")));
  const weight = (s: { start: number; end: number }) => Math.max(s.end - s.start, 1e-3);
  const total = parsed.shots.reduce((sum, s) => sum + weight(s), 0);
  const mean = (key: "valence" | "arousal") =>
    parsed.shots.reduce((sum, s) => sum + (s.wantedMood ?? s.profile.mood)[key] * weight(s), 0) / total;
  return { valence: Math.round(mean("valence") * 1000) / 1000, arousal: Math.round(mean("arousal") * 1000) / 1000 };
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (args["write-doc"]) {
    const doc = path.resolve("docs/library/looks.md");
    writeFileSync(doc, await formatMarkdown(looksDoc(), doc));
    return { outputs: [doc], metadata: { looks: LOOKS.length } };
  }
  const mood = wantedMood(args.mood, args.target);
  if (args.list) {
    const listed = mood ? looksForMood(mood, LOOKS.length) : LOOKS;
    return {
      outputs: [],
      metadata: {
        looks: listed.map((look) => ({
          ...describe(look),
          ...(mood
            ? {
                moodDistance:
                  Math.round(Math.hypot(look.mood.valence - mood.valence, look.mood.arousal - mood.arousal) * 1000) /
                  1000,
              }
            : {}),
        })),
        defaults: DEFAULT_LOOKS,
        ...(mood ? { mood } : {}),
      },
    };
  }
  if ((!args.input && !args.card) || !args.output)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --input (or --card) and --output (or --list)" });
  if (args.input && args.card)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --input or --card, not both" });
  if (args.input) requireFile(args.input);
  if (args.card && args.render)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--render needs --input footage" });
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
  } else if (mood) chosen = looksForMood(mood, 6);
  else if (args.family) chosen = LOOKS.filter((look) => look.family === args.family);
  else chosen = DEFAULT_LOOKS.map((id) => findLook(id)!);
  if (args.lut) chosen = [...(args.looks || mood || args.family ? chosen : []), ...args.lut.split(",").map(lutLook)];
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
      input: args.input ? path.resolve(args.input) : "",
      ...(args.card ? { card: true } : {}),
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
      notes: `${look.intent} Skin policy: ${look.skin.mode}, chroma x${look.skin.chroma}. The skin secondary was solved on ${args.input ? path.basename(args.input) : "the test card"}; re-run colour:looks for other footage.`,
      ...solved.grade,
    });
    writeFileSync(file, `${JSON.stringify(grade, null, 2)}\n`);
    outputs.push(file, solved.still);
    let render: string | undefined;
    if (args.render) {
      render = path.join(output, `${look.id}${/\.(png|tif|tiff|jpe?g)$/i.test(args.input!) ? ".png" : ".mp4"}`);
      if (existsSync(render) && !args.force)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `${render} exists; pass --force` });
      const work = mkdtempSync(path.join(tmpdir(), "colour-looks-"));
      try {
        const cube = bakeCube(grade, file, path.join(work, "look.cube"), 33).path;
        renderGraded({
          input: path.resolve(args.input!),
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
      ...(look.lut ? { lut: look.lut } : {}),
      gate: solved.gate.status,
      failed: solved.gate.failed,
      warnings: solved.gate.warnings,
      grade: file,
      still: solved.still,
      ...(render ? { render } : {}),
    });
  }
  writeFileSync(
    path.join(output, "looks.json"),
    `${JSON.stringify({ input: args.input ?? "test card", looks: summary }, null, 2)}\n`,
  );
  outputs.push(path.join(output, "looks.json"));
  return {
    outputs,
    metadata: {
      grid: result.files.grid,
      ...(mood ? { mood, ranking: "nearest look mood first (a convention, not a verdict)" } : {}),
      looks: summary,
      next: "pnpm colour:grade --grade <dir>/<look>.grade.json --input <video> --output <graded>",
      note: "The gate measures skin, levels and saturation; which look fits the film is the user's call.",
      apiCalls: 0,
    },
  };
});
