import path from "node:path";
import { CliErrorObject, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { hashFile, importAsset } from "../src/lib/assets/registry";
import { CODEC_CHOICES, DEFAULT_ENTRY, GL_CHOICES, parseFrameRange, renderClip } from "../src/lib/vision/composition";
import { nextTimelineCommands } from "../src/lib/vision/timeline-next";

const SPECS = [
  { name: "entry", default: DEFAULT_ENTRY, description: "Remotion entry point" },
  { name: "composition", required: true, description: "Composition ID" },
  { name: "output", required: true, description: "Output video path" },
  { name: "frames", description: 'Inclusive frame range "a-b"; default is the whole composition' },
  { name: "codec", choices: CODEC_CHOICES, default: "h264", description: "Video codec" },
  { name: "crf", type: "number", description: "Constant rate factor; not for prores" },
  { name: "props", description: "JSON file with input props" },
  { name: "public-dir", default: "public", description: "Public directory served to the composition" },
  { name: "gl", choices: GL_CHOICES, default: "angle", description: "Chromium GL backend" },
  { name: "project", description: "Project ID to import the output into; requires --import" },
  { name: "import", type: "boolean", description: "Import the output as an immutable project asset" },
  { name: "track", description: "Visual track for the suggested timeline:edit command" },
  { name: "clip", description: "Comma-separated clip IDs for the suggested timeline:edit command" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (Boolean(args.project) !== Boolean(args.import))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--project and --import must be used together." });
  if ((args.track || args.clip) && !args.import)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--track and --clip only apply with --import." });
  if (args.project) requireProject(args.project);
  const output = path.resolve(args.output!);
  const range = args.frames ? parseFrameRange(args.frames) : undefined;
  const composition = await renderClip(
    {
      entry: args.entry!,
      composition: args.composition!,
      publicDir: args["public-dir"]!,
      gl: args.gl!,
      propsFile: args.props,
      prepareAssets: args["public-dir"] === "public",
    },
    { output, range, codec: args.codec!, crf: args.crf },
  );
  const metadata: Record<string, unknown> = { output, sha256: hashFile(output), codec: args.codec, composition };
  const outputs = [output];
  if (args.project) {
    const imported = importAsset({
      projectId: args.project,
      sourceFile: output,
      provenance: { origin: "manual", tool: "motion-render", model: "remotion" },
    });
    const assetPath = `public/${imported.asset.files.original}`;
    outputs.push(path.resolve(assetPath));
    metadata.asset = {
      id: imported.asset.id,
      path: assetPath,
      sha256: imported.asset.hash,
      duplicate: imported.duplicate,
      registryPath: imported.registryPath,
    };
    metadata.timeline = nextTimelineCommands({
      projectId: args.project,
      assetId: imported.asset.id,
      fps: composition.fps,
      frameCount: composition.frameCount,
      fullComposition: !range,
      trackId: args.track,
      clipIds: args.clip
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    });
  }
  return { outputs, metadata };
});
