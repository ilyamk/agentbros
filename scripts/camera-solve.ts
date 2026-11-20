/**
 * Solve a moving plate camera for 3D inserts: feature tracks outside a matte, a Blender libmv solve with
 * sanity-checked cleaning rounds, and an optional metric scale from a person matte. Writes camera.json (OpenCV
 * K/R/t per frame, the sidecar `vorkCamera` reads), bundles.json and solve-report.json.
 */
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { cameraSolve } from "../src/lib/vfx/camera-solve";

const pair = (value: string | undefined, name: string): [number, number] | undefined => {
  if (value === undefined) return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match || Number(match[1]) >= Number(match[2]))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `--${name} is "a-b" with a < b` });
  return [Number(match[1]), Number(match[2])];
};

runScript(async () => {
  const args = parseArgs([
    { name: "plate", required: true, description: "The plate video to solve" },
    { name: "output", required: true, description: "Output directory: tracks, solve/, scaled/ and requests" },
    { name: "focal-px", type: "number", required: true, description: "Initial focal length in pixels" },
    { name: "frames", description: 'Plate frame range "a-b" (inclusive); default the whole plate' },
    { name: "matte", description: "Holdout matte folder (moving subject), excluded from tracking" },
    { name: "matte-pattern", default: "frame-{:05d}.png", description: "Matte file name pattern" },
    { name: "keyframes", description: 'Solve keyframes "a-b" when the default pair leaves frames unsolved' },
    { name: "clean-rounds", type: "number", description: "Cleaning rounds (each exported; the best sane one kept)" },
    { name: "max-points", type: "number", description: "Tracked corners per frame (default 900)" },
    { name: "epipolar-px", type: "number", description: "Epipolar outlier distance in px (default 1; 0 disables)" },
    { name: "scale-matte", description: "Person matte folder for metric scale from the head width" },
    { name: "subject-width-m", type: "number", default: 0.16, description: "Known subject width for --scale-matte" },
    { name: "executable", description: "Blender executable" },
  ] as const);
  const result = await cameraSolve({
    plate: args.plate!,
    output: args.output!,
    tracks: {
      frames: pair(args.frames, "frames"),
      matteDir: args.matte,
      mattePattern: args["matte-pattern"],
      maxPoints: args["max-points"],
      epipolarPx: args["epipolar-px"],
    },
    solve: {
      focalPx: args["focal-px"]!,
      keyframes: pair(args.keyframes, "keyframes"),
      cleanRounds: args["clean-rounds"],
    },
    scale: args["scale-matte"]
      ? { matteDir: args["scale-matte"], mattePattern: args["matte-pattern"], subjectWidthM: args["subject-width-m"] }
      : undefined,
    executable: args.executable,
  });
  return {
    outputs: [result.camera],
    metadata: {
      ...result.report,
      tracks: result.tracks["count"] ?? null,
      finalDir: result.finalDir,
      scale: result.scale ?? null,
    },
  };
});
