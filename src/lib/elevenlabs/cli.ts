import path from "node:path";
import { parseArgs, runScript, CliErrorObject } from "../cli";
import { OperationStore } from "../jobs/store";
import { executeStudioAudio } from "./operations";
import { executeVoiceManagement, recordVoiceSelection } from "./voices";
import { executeDubbing, syncDubbingBinding, DubbingBindingSchema } from "./dubbing";
import { readStudioRequest } from "./files";

export const STUDIO_CLI_SPECS = [
  { name: "project", required: true, description: "Existing project; must match the request projectId" },
  { name: "request", description: "Versioned request JSON; nested paths are scoped to the workspace" },
  {
    name: "action",
    choices: ["plan", "execute", "status", "sync", "approve"],
    default: "plan",
    description: "Offline plan by default; status is local; sync is dubbing-only; execute requires --dry-run=false",
  },
  {
    name: "dry-run",
    type: "boolean",
    default: true,
    description: "No provider mutation or project writes (default true)",
  },
  { name: "scope-root", description: "Trusted workspace root supplied by the MCP bridge" },
  { name: "operation-id", description: "Original durable operation ID, including for local status" },
  { name: "max-cost-usd", type: "number", description: "Explicit authorised positive per-operation planning bound" },
  { name: "binding", description: "Dubbing-only: existing project-local binding for status/sync" },
] as const;

export function scopedStudioRequest(args: {
  project: string;
  request: string;
  "scope-root"?: string;
  "max-cost-usd"?: number;
  "operation-id"?: string;
}): Record<string, unknown> {
  const raw = readStudioRequest(process.cwd(), args.request, args["scope-root"]) as Record<string, unknown>;
  if (!raw || raw.projectId !== args.project)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Request projectId differs from --project" });
  return {
    ...raw,
    ...(args["max-cost-usd"] !== undefined ? { maxCostUsd: args["max-cost-usd"] } : {}),
    ...(args["operation-id"] ? { operationId: args["operation-id"] } : {}),
  };
}

export function runStudioCli(kind: "dialogue" | "transform" | "voices" | "dubbing") {
  return runScript(async () => {
    const args = parseArgs([
      ...STUDIO_CLI_SPECS,
      { name: "answer", description: "User's words approving the calibration takes (voices only)" },
    ] as const);
    if (kind === "voices" && args.action === "approve") {
      if (!args.request || args["scope-root"])
        throw Error("Voice listening approval is available only in the trusted CLI");
      const raw = scopedStudioRequest({ ...args, project: args.project!, request: args.request });
      return recordVoiceSelection(raw, args.answer);
    }
    if (args.action === "approve") throw Error("Listening approval is available on voices:manage only");
    if (args.action === "status" && args["operation-id"]) {
      const store = new OperationStore(args.project!);
      const job = store.snapshot().jobs[args["operation-id"]];
      if (!job)
        throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: "Operation is not in this project journal" });
      return {
        outputs: [],
        metadata: {
          operationId: job.operationId,
          state: job.state,
          providerRequestId: job.providerRequestId,
          budget: store.summary(),
        },
      };
    }
    if (kind === "dubbing" && args.binding && ["status", "sync"].includes(args.action!)) {
      const raw = DubbingBindingSchema.parse(readStudioRequest(process.cwd(), args.binding, args["scope-root"]));
      if (raw.projectId !== args.project) throw Error("Dubbing binding belongs to another project");
      if (args.action === "sync" && args["dry-run"] === false)
        return {
          outputs: [path.resolve(args.binding)],
          metadata: { binding: await syncDubbingBinding(args.binding, { scopeRoot: args["scope-root"] }) },
        };
      return {
        outputs: [],
        metadata: { binding: raw, state: args.action === "sync" ? "planned" : "last-observed", remoteRefreshed: false },
      };
    }
    if (!args.request)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Supply --request (or --operation-id for local status)",
      });
    const raw = scopedStudioRequest({ ...args, project: args.project!, request: args.request });
    if (kind === "dialogue" && raw.task !== "dialogue") throw Error("generate:dialogue accepts dialogue requests only");
    if (kind === "transform" && !["isolate", "voice-change"].includes(String(raw.task)))
      throw Error("audio:transform accepts isolate or voice-change");
    const execution = { dryRun: args.action !== "execute" || args["dry-run"] !== false, scopeRoot: args["scope-root"] };
    return kind === "voices"
      ? executeVoiceManagement(raw, execution)
      : kind === "dubbing"
        ? executeDubbing(raw, execution)
        : executeStudioAudio(raw, execution);
  });
}
