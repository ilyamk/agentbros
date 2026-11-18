/** Read an analysis manifest without generation, downloads or writes. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithin, CliErrorObject, parseArgs, requireFile, requireProject, runScript } from "../src/lib/cli";
import { pipelineDir, projectDir } from "../src/lib/pipeline/paths";

const manifestSchema = z.object({
  version: z.literal(1),
  endpoint: z.string(),
  kind: z.enum(["text", "json"]),
  operationId: z.string(),
  data: z.record(z.string(), z.unknown()),
  files: z.array(z.unknown()),
  untrustedUrls: z.array(z.unknown()),
});
runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project containing the immutable analysis result" },
    { name: "operation-id", required: true, description: "Exact durable operation ID" },
  ] as const);
  requireProject(args.project!);
  const operationId = args["operation-id"]!;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(operationId))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid operation ID." });
  const file = path.resolve(pipelineDir(args.project!), "model-results", `${operationId}.json`);
  assertPathWithin(path.resolve(projectDir(args.project!)), file);
  requireFile(file);
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (manifest.operationId !== operationId)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Manifest operation ID does not match the requested result.",
    });
  const textExcerpt = Object.values(manifest.data)
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .slice(0, 2000);
  return {
    outputs: [file],
    metadata: {
      endpoint: manifest.endpoint,
      kind: manifest.kind,
      dataKeys: Object.keys(manifest.data),
      textExcerpt,
      files: manifest.files,
      untrustedUrls: manifest.untrustedUrls,
    },
  };
});
