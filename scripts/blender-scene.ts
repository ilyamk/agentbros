import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import {
  captureBakedBlender,
  importBakedBlenderFrames,
  encodeBakedBlenderVideo,
  readBlenderSceneRequest,
} from "../src/lib/backends/blender-bake";
import { bakeBlenderScene } from "../src/lib/backends/blender-scene";
runScript(async () => {
  const args = parseArgs([
    { name: "request", description: "Owned declarative scene JSON" },
    { name: "output", description: "Immutable candidate image sequence directory" },
    { name: "cache", description: "Pinned local cache directory" },
    { name: "executable", description: "Trusted absolute administrator Blender executable, CLI only" },
    {
      name: "video",
      type: "boolean",
      default: false,
      description: "Encode complete contiguous sequence as silent MP4 (max 120 frames)",
    },
    { name: "project", description: "Optional explicit immutable candidate import destination" },
    {
      name: "dry-run",
      type: "boolean",
      default: false,
      description: "Validate scene and bake without starting Blender",
    },
  ] as const);
  if (!args.request) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Bounded request JSON is required" });
  const request = readBlenderSceneRequest(args.request);
  const bake = bakeBlenderScene(request);
  if (args["dry-run"])
    return {
      outputs: [],
      metadata: {
        state: "validated",
        bakeSha256: bake.sha256,
        frames: bake.scene.durationFrames,
        objects: bake.scene.objects.length,
        providerSpendUsd: 0,
      },
    };
  if (!args.output || !args.cache || !args.executable)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "output/cache/trusted executable required; no installation is performed",
    });
  const result = await captureBakedBlender(request, {
    outputDirectory: args.output,
    cacheDirectory: args.cache,
    executable: args.executable,
  });
  const video =
    result.state === "candidate" && args.video ? await encodeBakedBlenderVideo(result, args.output) : undefined;
  const imported = result.state === "candidate" && args.project ? importBakedBlenderFrames(result, args.project) : [];
  return { outputs: [...result.outputs, ...(video ? [video.path] : [])], metadata: { ...result, imported, video } };
});
