import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { runColourWorker } from "../src/lib/colour/worker";
import { projectDir } from "../src/lib/pipeline/paths";

/** Licences a LUT may be imported under. Share-alike is allowed but flagged; anything unknown is refused. */
const LICENCES = ["cc0", "cc-by-4.0", "cc-by-sa-4.0", "own", "licensed"] as const;

const SPECS = [
  { name: "add", description: "A .cube or HaldCLUT .png to import (validated, normalised to .cube)" },
  { name: "list", type: "boolean", description: "List the imported LUTs with their licences" },
  { name: "project", description: "Project id: LUTs live in public/projects/<id>/colour/luts/" },
  { name: "dir", description: "Or an explicit LUT directory" },
  { name: "id", description: "Id for the imported LUT (kebab-case; default: the file name)" },
  { name: "licence", choices: LICENCES, description: "Licence of the file; unknown licences are refused" },
  { name: "source", description: "Where it came from: URL or a description of the purchase or author" },
  { name: "attribution", description: "Credit line (required for CC BY and CC BY-SA)" },
  { name: "evidence", description: "Licence evidence file (required for licensed): a receipt or licence text" },
  { name: "force", type: "boolean", description: "Replace an imported LUT with the same id" },
] as const;

const EntrySchema = z.strictObject({
  id: z.string(),
  file: z.string(),
  kind: z.enum(["cube", "haldclut"]),
  size: z.number(),
  licence: z.enum(LICENCES),
  source: z.string(),
  attribution: z.string().optional(),
  evidence: z.string().optional(),
  shareAlike: z.boolean(),
  meanDeltaE2000: z.number(),
  moodShift: z.strictObject({ valence: z.number(), arousal: z.number() }),
  preview: z.string(),
});
const RegistrySchema = z.strictObject({ version: z.literal(1), luts: z.array(EntrySchema) });

const LutResultSchema = z.looseObject({
  ok: z.literal(true),
  kind: z.enum(["cube", "haldclut"]),
  size: z.number(),
  meanDeltaE2000: z.number(),
  moodShift: z.strictObject({ valence: z.number(), arousal: z.number() }),
  files: z.record(z.string(), z.string()),
});

function lutDir(args: { project?: string; dir?: string }) {
  if (args.dir) return path.resolve(args.dir);
  if (!args.project) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --project <id> or --dir" });
  const root = projectDir(args.project);
  if (!existsSync(root)) throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `No project at ${root}` });
  return path.resolve(root, "colour", "luts");
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  const dir = lutDir(args);
  const registryFile = path.join(dir, "luts.json");
  const registry = existsSync(registryFile)
    ? RegistrySchema.parse(JSON.parse(readFileSync(registryFile, "utf8")))
    : { version: 1 as const, luts: [] as z.infer<typeof EntrySchema>[] };
  if (args.list || !args.add)
    return { outputs: existsSync(registryFile) ? [registryFile] : [], metadata: { dir, luts: registry.luts } };
  requireFile(args.add);
  if (!args.licence || !args.source)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Pass --licence (${LICENCES.join(", ")}) and --source: a LUT with an unknown licence is not imported`,
    });
  if (args.licence.startsWith("cc-by") && !args.attribution)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "CC BY licences need --attribution" });
  if (args.licence === "licensed") {
    if (!args.evidence)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--licence licensed needs --evidence" });
    requireFile(args.evidence);
  }
  const id = (args.id ?? path.parse(args.add).name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!id) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --id" });
  if (registry.luts.some((entry) => entry.id === id) && !args.force)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `LUT "${id}" exists; pass --force to replace it` });
  mkdirSync(dir, { recursive: true });
  const cube = path.join(dir, `${id}.cube`);
  const credit = [`licence: ${args.licence}`, `source: ${args.source}`];
  if (args.attribution) credit.push(`attribution: ${args.attribution}`);
  const result = runColourWorker(
    "lut",
    { input: path.resolve(args.add), output: cube, title: id, comments: credit },
    LutResultSchema,
  );
  const entry = EntrySchema.parse({
    id,
    file: `${id}.cube`,
    kind: result.kind,
    size: result.size,
    licence: args.licence,
    source: args.source,
    ...(args.attribution ? { attribution: args.attribution } : {}),
    ...(args.evidence ? { evidence: path.resolve(args.evidence) } : {}),
    shareAlike: args.licence === "cc-by-sa-4.0",
    meanDeltaE2000: result.meanDeltaE2000,
    moodShift: result.moodShift,
    preview: path.basename(result.files.preview!),
  });
  registry.luts = [...registry.luts.filter((e) => e.id !== id), entry].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return {
    outputs: [cube, result.files.preview!, registryFile],
    metadata: {
      ...entry,
      warnings: entry.shareAlike
        ? ["CC BY-SA: a film graded with it is fine, but a changed LUT you share must carry the same licence"]
        : [],
      next: `pnpm colour:looks --input <video> --output <dir> --lut ${cube}`,
      apiCalls: 0,
    },
  };
});
