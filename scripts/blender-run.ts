import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { hashFile, importAsset, type ImportAssetOptions } from "../src/lib/assets/registry";
import {
  DEFAULT_TIMEOUT_SEC,
  parseResolution,
  planBlenderRun,
  runBlender,
  type BlenderRunRequest,
} from "../src/lib/backends/blender-run";
import { parseFrameRange } from "../src/lib/vision/composition";
import { nextTimelineCommands } from "../src/lib/vision/timeline-next";

const SPECS = [
  { name: "script", description: "Trusted Python scene script; runs inside Blender before the render" },
  {
    name: "extensions",
    description:
      "Approved installed ids separated by commas, or approved; uses the isolated profile and factory startup",
  },
  { name: "blend", description: "A .blend to open first. Auto-run scripts stay disabled" },
  { name: "output", required: true, description: "Output directory for frames, log and manifest" },
  { name: "frames", description: 'Inclusive frame range "a-b"; default is the scene range' },
  { name: "engine", choices: ["cycles", "eevee"], description: "Render engine; default is what the scene sets" },
  { name: "samples", type: "number", description: "Render samples; default is what the scene sets" },
  { name: "resolution", description: "WxH such as 1920x1080; default is what the scene sets" },
  { name: "film-transparent", type: "boolean", description: "Render with an alpha background" },
  { name: "format", choices: ["png", "exr"], default: "png", description: "Frame file format" },
  {
    name: "device",
    choices: ["auto", "cpu", "gpu"],
    default: "auto",
    description: "Cycles device. Factory startup alone means CPU; auto picks the GPU",
  },
  {
    name: "encode",
    choices: ["h264", "prores4444"],
    description: "Also encode the PNG frames. prores4444 keeps alpha",
  },
  {
    name: "encode-to",
    description:
      "Also copy the encoded video to this path (a shared plate target), so the frames can stay outside public/; requires --encode",
  },
  {
    name: "factory-startup",
    type: "boolean",
    default: true,
    description: "Use factory defaults; --no-factory-startup loads isolated preferences",
  },
  { name: "no-render", type: "boolean", description: "Run the script only, for baking or saving a .blend" },
  { name: "overwrite", type: "boolean", description: "Replace existing frames in the range" },
  { name: "resume", type: "boolean", description: "Keep existing frames and render only the missing ones" },
  { name: "script-args", description: 'JSON string array passed to the script after "--"' },
  { name: "executable", description: "Blender executable; default searches PATH, then /Applications/Blender.app" },
  {
    name: "timeout",
    type: "number",
    default: DEFAULT_TIMEOUT_SEC,
    description: "Stop Blender after this many seconds",
  },
  { name: "project", description: "Project ID the run belongs to" },
  {
    name: "import",
    type: "boolean",
    description:
      "Import the H.264 video, or a single PNG frame, as an immutable asset; requires --project. Not for ProRes",
  },
  {
    name: "metadata",
    description: "JSON sidecar: provenance and rights for --import, sources[] for third-party files used",
  },
  { name: "dry-run", type: "boolean", description: "Validate and print the Blender command without running it" },
] as const;

type Sidecar = Pick<ImportAssetOptions, "provenance" | "rights"> & { sources?: unknown[] };

function readSidecar(file?: string): Partial<Sidecar> {
  if (!file) return {};
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !["provenance", "rights", "sources"].includes(key))
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "The sidecar supports provenance, rights and sources only.",
    });
  return raw as Partial<Sidecar>;
}

function parseScriptArgs(value?: string): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--script-args must be a JSON string array." });
  return parsed as string[];
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (args.import && !args.project)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--import requires --project." });
  if (args.project) requireProject(args.project);
  const sidecar = readSidecar(args.metadata);
  const request: BlenderRunRequest = {
    extensions: args.extensions,
    script: args.script,
    blend: args.blend,
    output: args.output!,
    frames: args.frames ? parseFrameRange(args.frames) : undefined,
    engine: args.engine as BlenderRunRequest["engine"],
    samples: args.samples,
    resolution: args.resolution ? parseResolution(args.resolution) : undefined,
    filmTransparent: args["film-transparent"] ? true : undefined,
    format: args.format as BlenderRunRequest["format"],
    device: args.device as BlenderRunRequest["device"],
    encode: args.encode as BlenderRunRequest["encode"],
    factoryStartup: Boolean(args["factory-startup"]),
    noRender: Boolean(args["no-render"]),
    overwrite: Boolean(args.overwrite),
    resume: Boolean(args.resume),
    scriptArgs: parseScriptArgs(args["script-args"]),
    executable: args.executable,
    timeoutSec: args.timeout!,
  };
  if (args["encode-to"] && !request.encode)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--encode-to requires --encode." });
  if (args.import && request.noRender)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--import needs rendered output." });
  if (args.import && request.encode === "prores4444")
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "ProRes is a finishing handoff and the asset registry would store it as MP4. Import --encode h264, or use the PNG sequence for alpha in Remotion.",
    });
  if (args["dry-run"]) return { outputs: [], metadata: { dryRun: true, ...planBlenderRun(request) } };

  const result = await runBlender(request);
  const outsideProject =
    args.project &&
    request.script &&
    !path
      .resolve(request.script)
      .startsWith(path.resolve("public/projects", args.project, "assets/blender") + path.sep);
  const warnings = [
    ...(outsideProject
      ? [
          `The script is outside public/projects/${args.project}/assets/blender, so it does not travel with the project.`,
        ]
      : []),
    ...(result.render.filmTransparent && result.frames.length
      ? ["preview.mp4 and the contact sheet show transparent pixels as grey; the PNG frames keep the alpha."]
      : []),
  ];
  const metadata: Record<string, unknown> = {
    ...result,
    project: args.project,
    sources: sidecar.sources ?? [],
    warnings,
  };
  const outputs = [
    ...(result.review ? [result.review.sheet, result.review.preview] : []),
    ...(result.encoded ? [result.encoded.path] : []),
    ...(result.camera ? [result.camera.path] : []),
    ...result.frames.map((frame) => frame.path),
    result.logFile,
  ];
  if (args["encode-to"] && result.encoded) {
    const copy = path.resolve(args["encode-to"]);
    mkdirSync(path.dirname(copy), { recursive: true });
    copyFileSync(result.encoded.path, copy);
    outputs.unshift(copy);
    metadata.encodedCopy = copy;
  }

  if (args.import) {
    const source =
      result.encoded?.path ??
      (result.frames.length === 1 && request.format === "png" ? result.frames[0]!.path : undefined);
    if (!source)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--import needs --encode for ${result.frames.length} frames. The frames are kept at ${result.output}.`,
      });
    const imported = importAsset({
      projectId: args.project!,
      sourceFile: source,
      provenance: {
        origin: "manual",
        tool: "blender-run",
        model: `Blender ${result.render.blenderVersion}`,
        originalFilename: path.basename(source),
        ...sidecar.provenance,
      },
      rights: sidecar.rights,
    });
    const assetPath = `public/${imported.asset.files.original}`;
    outputs.push(path.resolve(assetPath));
    metadata.asset = {
      id: imported.asset.id,
      path: assetPath,
      sha256: imported.asset.hash,
      duplicate: imported.duplicate,
      registryPath: imported.registryPath,
      rights: imported.asset.rights,
    };
    if (imported.asset.kind === "video")
      metadata.timeline = nextTimelineCommands({
        projectId: args.project!,
        assetId: imported.asset.id,
        fps: result.render.fps,
        frameCount: result.frames.length,
        fullComposition: true,
      });
  }
  const manifest = path.join(result.output, "blender-run.json");
  writeFileSync(manifest, JSON.stringify(metadata, null, 2));
  outputs.unshift(manifest);
  return { outputs, metadata: { ...metadata, manifest, manifestSha256: hashFile(manifest) } };
});
