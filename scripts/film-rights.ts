/**
 * Records the user's answer to a replica's rights gate in pipeline/replica-rights.json: who owns the film to copy and what
 * the replica is for. Only the user's own words; without a stated right to publish the replica is study-only.
 */
import { requireUserWords } from "../src/lib/cli/user-words";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { RIGHTS } from "../src/lib/film/chain";
import { openExistingFilm } from "../src/lib/film/cli";
import { resolveRoute } from "../src/lib/film/routes";
import { baseTokens, fill, filmTypes, writeJsonAtomic } from "../src/lib/film/state";
import { ReplicaRightsStatusSchema, type ReplicaRights } from "../src/types/reference-replica";
import { writePreparationRights } from "../src/lib/model-preparation/approval";
import { requireProject } from "../src/lib/cli";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    {
      name: "status",
      required: true,
      choices: ReplicaRightsStatusSchema.options,
      description:
        "owned (the user's own film), licensed (they hold a licence to remake it) or study-only (anything else, or no answer: never published)",
    },
    { name: "answer", required: true, description: "The user's own words, as they said them" },
    {
      name: "preparation",
      description:
        "Optional model:prepare ID; records hash-bound source-use rights for any project instead of replica rights",
    },
    {
      name: "evidence",
      description:
        "Supplied source-use licence or ownership evidence covering the selected video, images and likenesses",
    },
    {
      name: "allow-processing",
      type: "boolean",
      description: "The user explicitly permits processing these exact inputs",
    },
    { name: "placements", description: "Comma-separated authorised publication placements (or private-study)" },
    { name: "commercial", type: "boolean", description: "The supplied rights permit commercial use" },
    {
      name: "audio-rights",
      choices: ["owned", "licensed", "muted"],
      description: "Source-audio permission; muted only for a silent prepared clip",
    },
    { name: "advertising", type: "boolean", description: "Supplied rights explicitly cover advertising" },
    { name: "endorsement", type: "boolean", description: "Supplied rights explicitly cover endorsement" },
    { name: "standalone-resale", type: "boolean", description: "Supplied rights explicitly cover standalone resale" },
  ] as const);
  requireUserWords(args.answer, "--answer");
  if (args.preparation) {
    requireProject(args.project!);
    if (!args["allow-processing"] || !args.evidence || !args.placements || !args["audio-rights"])
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message:
          "Preparation rights need --allow-processing, --evidence, --placements and --audio-rights, reflecting the user's actual authorisation.",
      });
    const result = writePreparationRights(args.project!, args.preparation, {
      status: args.status as "owned" | "licensed" | "study-only",
      userStatement: args.answer!,
      evidence: args.evidence,
      processingAllowed: true,
      commercialAllowed: args.commercial === true,
      placements: args.placements
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      audioRights: args["audio-rights"] as "owned" | "licensed" | "muted",
      usage: {
        advertising: args.advertising === true,
        endorsement: args.endorsement === true,
        standaloneResale: args["standalone-resale"] === true,
      },
    });
    return {
      outputs: [result.file],
      metadata: {
        preparation: args.preparation,
        rights: result.rights,
        next: "Complete the input visual review, then model:prepare --action approve with the user's own answer.",
      },
    };
  }
  const project = openExistingFilm(args.project!);
  const tokens = baseTokens(project);
  const { type, secondary } = filmTypes(project, tokens);
  const route = resolveRoute(type, secondary);
  if (!route.steps.some((step) => step.id === "rights"))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Project "${project.id}" is a ${route.type} film; only a replica asks the rights question.`,
    });
  const record: ReplicaRights = {
    schemaVersion: 1,
    status: args.status as ReplicaRights["status"],
    userStatement: args.answer!.trim(),
    askedAt: new Date().toISOString(),
  };
  const file = path.resolve(project.rootDir, fill(RIGHTS, tokens)!);
  writeJsonAtomic(file, record);
  return {
    outputs: [path.relative(process.cwd(), file)],
    metadata: {
      projectId: project.id,
      rights: record,
      ...(record.status === "study-only"
        ? { warnings: ["study-only: the replica stays private and is never published"] }
        : {}),
      next: `pnpm film:done --project ${project.id} --step rights`,
    },
  };
});
