import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { runScript, parseArgs, CliErrorObject } from "../src/lib/cli";
import { convertHeic, isHeif, majorBrand, readHead } from "../src/lib/assets/heic";
import { importAsset, type ImportAssetOptions } from "../src/lib/assets/registry";

const SPECS = [
  { name: "project", required: true, description: "Existing project ID" },
  {
    name: "input",
    required: true,
    description:
      "Local image/video/audio file; a HEIC/HEIF photo is converted to JPEG first (sips on macOS, else ffmpeg)",
  },
  {
    name: "origin",
    choices: ["manual", "agent-harness", "provider", "stock"],
    default: "manual",
    description: "Asset origin",
  },
  { name: "metadata", description: "JSON sidecar with provenance, rights and optional entityLinks" },
  { name: "dry-run", type: "boolean", description: "Inspect and validate without writing files" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  let sidecar: Pick<ImportAssetOptions, "provenance" | "rights" | "entityLinks" | "vorkResult"> = {
    provenance: { origin: args.origin as ImportAssetOptions["provenance"]["origin"] },
  };
  if (args.metadata) {
    try {
      const raw = JSON.parse(readFileSync(args.metadata, "utf8"));
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).some((key) => !["provenance", "rights", "entityLinks", "vorkResult"].includes(key))
      )
        throw new Error("Sidecar supports provenance, rights, entityLinks and vorkResult only.");
      sidecar = { ...raw, provenance: { ...sidecar.provenance, ...raw.provenance } };
    } catch (error) {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Invalid import sidecar: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  let sourceFile = args.input!;
  let converted: ReturnType<typeof convertHeic> | undefined;
  if (existsSync(sourceFile) && statSync(sourceFile).isFile() && isHeif(sourceFile, majorBrand(readHead(sourceFile)))) {
    converted = convertHeic(path.resolve(sourceFile));
    sourceFile = converted.output;
    sidecar = {
      ...sidecar,
      provenance: {
        ...sidecar.provenance,
        originalFilename: sidecar.provenance.originalFilename ?? path.basename(args.input!),
        tool: sidecar.provenance.tool ?? `heic-to-jpeg:${converted.tool}`,
      },
    };
  }
  try {
    const result = importAsset({ projectId: args.project!, sourceFile, ...sidecar, dryRun: args["dry-run"] });
    return {
      outputs: result.dryRun ? [] : [`public/${result.asset.files.original}`, result.registryPath],
      metadata: {
        ...result,
        ...(converted ? { converted: { from: args.input, tool: converted.tool, command: converted.command } } : {}),
      },
    };
  } finally {
    if (converted) rmSync(path.dirname(converted.output), { recursive: true, force: true });
  }
});
