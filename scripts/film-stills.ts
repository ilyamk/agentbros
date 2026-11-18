import { attachStillReview } from "../src/lib/vision/review-adapters";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { projectPipeline, readJsonFile } from "../src/lib/film/inputs";
import { DEFAULT_ENTRY, GL_CHOICES, renderStills } from "../src/lib/vision/composition";
import { RgbImage } from "../src/lib/vision/image";
import { writeImage } from "../src/lib/vision/media";
import { composeGrid, formatTimecode, type Cell } from "../src/lib/vision/sheets";
import { CueSheetSchema } from "../src/types/film";

const TILE_LONG_SIDE = 300;

const SPECS = [
  { name: "composition", required: true, description: "Composition ID" },
  { name: "entry", default: DEFAULT_ENTRY, description: "Remotion entry point" },
  { name: "project", description: "Project ID: supplies pipeline/cue-sheet.json and out/qa/<project>/stills" },
  { name: "cue-sheet", description: "CueSheet JSON" },
  { name: "output", description: "Directory for the stills and sheet.jpg" },
  { name: "props", description: "JSON file with input props" },
  { name: "public-dir", default: "public", description: "Public directory served to the composition" },
  { name: "gl", choices: GL_CHOICES, default: "angle", description: "Chromium GL backend" },
] as const;

function tile(file: string, width: number, height: number): RgbImage {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      file,
      "-vf",
      `scale=${width}:${height}`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: width * height * 3 + 1024 },
  );
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Could not read ${file}: ${result.error?.message ?? result.stderr?.toString().slice(-300)}`,
    });
  return new RgbImage(width, height, result.stdout);
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  if (args.project) requireProject(args.project);
  const cuePath = args["cue-sheet"] ?? (args.project ? projectPipeline(args.project, "cue-sheet.json") : undefined);
  const output = args.output ?? (args.project ? path.join("out/qa", args.project, "stills") : undefined);
  if (!cuePath || !output)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --cue-sheet and --output, or --project." });
  const sheet = readJsonFile(cuePath, CueSheetSchema, "Cue sheet");
  if (!sheet.cues.length) throw new CliErrorObject({ code: "INVALID_INPUT", message: `${cuePath} has no cues.` });
  const frames = [...new Set(sheet.cues.map((cue) => cue.frame))].sort((a, b) => a - b);
  const { stills, composition } = await renderStills(
    {
      entry: args.entry!,
      composition: args.composition!,
      publicDir: args["public-dir"]!,
      gl: args.gl!,
      propsFile: args.props,
    },
    frames,
    output,
  );
  if (Math.abs(composition.fps - sheet.fps) > 0.01)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `The cue sheet is at ${sheet.fps} fps and the composition at ${composition.fps} fps, so its frames do not line up. Rerun edit:snap.`,
    });
  const rows = sheet.cues.map((cue) => ({
    id: cue.id,
    kind: cue.kind,
    frame: cue.frame,
    path: stills.find((still) => still.frame === cue.frame)!.path,
  }));
  const scale = TILE_LONG_SIDE / Math.max(composition.width, composition.height);
  const [width, height] = [
    Math.round((composition.width * scale) / 2) * 2,
    Math.round((composition.height * scale) / 2) * 2,
  ];
  const cells: Cell[] = rows.map((row) => ({
    image: tile(row.path, width, height),
    label: `${formatTimecode(row.frame / composition.fps)} ${row.id}`,
  }));
  const contact = writeImage(
    composeGrid(cells, { title: `${args.composition} AT EVERY CUE`, columns: Math.min(6, cells.length) }),
    path.join(output, "sheet.jpg"),
  );
  const review = attachStillReview(
    stills,
    {
      ...composition,
      frameCount: composition.durationInFrames,
      durationSec: composition.durationInFrames / composition.fps,
      hasAudio: false,
    },
    output,
    rows.map((row) => ({ frame: row.frame, reasons: [`${row.kind}: ${row.id}`], basis: "declared" })),
    composition,
  );
  return {
    outputs: [contact, ...stills.map((still) => still.path), ...review.outputs],
    metadata: { reviewPack: review.reviewPack, sheet: contact, cues: rows, composition },
  };
});
