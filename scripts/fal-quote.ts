import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseArgs, runScript, CliErrorObject, assertPathWithin } from "../src/lib/cli";
import { fetchProviderEstimate, generateModelExecutor, runBatch } from "../src/lib/jobs/batch";
import { providerUnitQuantity } from "../src/lib/providers/fal-quote-input";
import { buildFalOperation } from "../src/lib/providers/fal-operations";
import { FalBatchSpecSchema } from "../src/types/fal-catalog";
import { FalEndpointRequestSchema, FalOperationRequestSchema } from "../src/types/generation";
runScript(async () => {
  const args = parseArgs([
    { name: "request", description: "Either endpoint-keyed or legacy operation request JSON" },
    { name: "spec", description: "FalBatchSpec JSON file" },
    { name: "project", required: true, description: "Project ID for policy and headroom" },
    {
      name: "provider-estimate",
      type: "boolean",
      description: "Opt-in free provider pricing estimate POST; evidence only, requires FAL_KEY",
    },
    { name: "scope-root", description: "Trusted MCP workspace boundary" },
  ] as const);
  if (Boolean(args.request) === Boolean(args.spec))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose exactly one of --request and --spec." });
  const request = args.request
    ? z
        .union([FalEndpointRequestSchema, FalOperationRequestSchema])
        .parse(JSON.parse(readFileSync(args.request, "utf8")))
    : undefined;
  const plan = request ? buildFalOperation(request) : undefined;
  const spec = args.spec
    ? FalBatchSpecSchema.parse(JSON.parse(readFileSync(args.spec, "utf8")))
    : FalBatchSpecSchema.parse({
        version: 1,
        batchId: "quote",
        endpoint: plan!.endpoint,
        baseInput: plan!.input,
        context: request?.context,
        variations: [{ id: "request" }],
        outputDir: path.resolve("public/projects", args.project!, "assets"),
        assetIdPrefix: "quote",
      });
  if (args["scope-root"]) assertPathWithin(args["scope-root"], path.resolve(args.request ?? args.spec!));
  const result = await runBatch(spec, {
    projectId: args.project!,
    write: false,
    scopeRoot: args["scope-root"],
    ...(request ? { executor: (execution) => generateModelExecutor({ ...execution, request }) } : {}),
  });
  const endpoints: Record<string, number> = {};
  for (const row of result.operations) {
    if (!args["provider-estimate"]) continue;
    const operationPlan = plan ?? buildFalOperation(row.operation.request);
    const quantity = providerUnitQuantity(
      operationPlan,
      operationPlan.input,
      request?.context ?? row.operation.request.context,
    );
    endpoints[spec.endpoint] = (endpoints[spec.endpoint] ?? 0) + quantity;
  }
  const providerEstimate = args["provider-estimate"] ? await fetchProviderEstimate(endpoints) : undefined;
  return {
    outputs: [],
    metadata: {
      ...result,
      ...(request
        ? { evidenceKind: result.operations[0]?.evidenceKind, inputHash: result.operations[0]?.inputHash }
        : {}),
      quoteInput: request
        ? result.operations[0]?.quoteInput
        : result.operations.map((row) => ({ operationId: row.operation.operationId, quoteInput: row.quoteInput })),
      ...(providerEstimate ? { providerEstimate } : {}),
    },
  };
});
