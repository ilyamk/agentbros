import { readFileSync } from "node:fs";
import { runScript, parseArgs, CliErrorObject } from "../src/lib/cli";
import { listEntities, getEntityVersion, saveEntityVersion, approveEntityVersion } from "../src/lib/entities/service";
import { computeCoverage } from "../src/lib/references/coverage";
import { EntityKindSchema, type EntityCardInput, type EntityKind } from "../src/types/entities";
const SPECS = [
  { name: "project", required: true, description: "Existing project ID" },
  {
    name: "action",
    required: true,
    choices: ["list", "show", "create", "revise", "approve", "coverage"],
    description: "Card operation",
  },
  { name: "kind", choices: EntityKindSchema.options, description: "Entity kind (show/approve/coverage)" },
  { name: "id", description: "Entity ID (show/approve/coverage)" },
  { name: "input", description: "Complete JSON card (create/revise)" },
  { name: "revision", type: "number", description: "Pinned revision (show/approve/coverage)" },
  { name: "base-revision", type: "number", description: "Fork from this immutable revision (revise only)" },
  { name: "expected-revision", type: "number", description: "Latest revision concurrency guard (revise/approve)" },
  { name: "actor", description: "Declared human approval actor" },
  { name: "authorization-evidence", description: "Recorded explicit approval authorization" },
  {
    name: "confirm-user-approval",
    type: "boolean",
    description: "Explicitly confirm that the approval was authorized by a human",
  },
] as const;
void runScript(async () => {
  const args = parseArgs(SPECS),
    projectId = args.project!;
  if (args.action === "list") return { metadata: { entities: listEntities(projectId) } };
  if (args.action === "create" || args.action === "revise") {
    if (!args.input)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--input is required for create/revise." });
    if (args.action === "revise" && args["expected-revision"] === undefined)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Revision requires --expected-revision." });
    let input: EntityCardInput;
    try {
      input = JSON.parse(readFileSync(args.input, "utf8"));
    } catch {
      throw new CliErrorObject({ code: "VALIDATION", message: "Cannot read card JSON." });
    }
    const result = saveEntityVersion(projectId, input, {
      expectedRevision: args.action === "create" ? 0 : args["expected-revision"],
      baseRevision: args["base-revision"],
    });
    const directory = `public/projects/${projectId}/entities/${result.version.card.kind}/${result.version.card.id}`;
    return {
      outputs: [
        `${directory}/entity.json`,
        `${directory}/versions/${String(result.version.revision).padStart(6, "0")}.json`,
      ],
      metadata: { ...result },
    };
  }
  if (!args.kind || !args.id)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--kind and --id are required for show/approve/coverage.",
    });
  if (args.action === "show")
    return {
      metadata: { ...getEntityVersion(projectId, args.kind as EntityKind, args.id, { revision: args.revision }) },
    };
  if (args.action === "coverage") {
    const view = getEntityVersion(projectId, args.kind as EntityKind, args.id, { revision: args.revision });
    return {
      metadata: {
        entity: {
          kind: args.kind,
          id: args.id,
          revision: view.version.revision,
          status: view.status,
          canonical: view.canonical,
        },
        coverage: computeCoverage(view.version),
      },
    };
  }
  if (
    !args["confirm-user-approval"] ||
    !args.actor ||
    !args["authorization-evidence"] ||
    args.revision === undefined ||
    args["expected-revision"] === undefined
  )
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "Approval requires --revision, --expected-revision, --actor, --authorization-evidence and --confirm-user-approval. No consent is inferred.",
    });
  const result = approveEntityVersion(
    projectId,
    args.kind as EntityKind,
    args.id,
    args.revision,
    { id: args.actor, kind: "human", authorizationEvidence: args["authorization-evidence"] },
    { expectedRevision: args["expected-revision"] },
  );
  const directory = `public/projects/${projectId}/entities/${args.kind}/${args.id}`;
  return {
    outputs: [
      `${directory}/entity.json`,
      `${directory}/approvals/${String(result.version.revision).padStart(6, "0")}.json`,
    ],
    metadata: { ...result },
  };
});
