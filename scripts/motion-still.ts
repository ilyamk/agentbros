import { parseArgs, runScript } from "../src/lib/cli";
import { DEFAULT_ENTRY, GL_CHOICES, parseFrameList, renderStills } from "../src/lib/vision/composition";

const SPECS = [
  { name: "entry", default: DEFAULT_ENTRY, description: "Remotion entry point" },
  { name: "composition", required: true, description: "Composition ID" },
  { name: "frames", required: true, description: 'Comma-separated frames, such as "0,30,90"' },
  { name: "output", required: true, description: "Directory for frame-NNNNNN.png files" },
  { name: "props", description: "JSON file with input props" },
  { name: "public-dir", default: "public", description: "Public directory served to the composition" },
  { name: "gl", choices: GL_CHOICES, default: "angle", description: "Chromium GL backend" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  const result = await renderStills(
    {
      entry: args.entry!,
      composition: args.composition!,
      publicDir: args["public-dir"]!,
      gl: args.gl!,
      propsFile: args.props,
    },
    parseFrameList(args.frames!),
    args.output!,
  );
  return { outputs: result.stills.map((still) => still.path), metadata: result };
});
