import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { PolyHavenResources } from "../src/lib/resources/poly-haven";
import { z } from "zod";
runScript(async () => {
  const args = parseArgs([
    { description: "action", name: "action", default: "search" },
    { description: "query", name: "query" },
    { description: "kind", name: "kind" },
    { description: "id", name: "id" },
    { name: "selector", description: "JSON string array selecting one exact original file" },
    { description: "project", name: "project" },
    { description: "max-bytes", name: "max-bytes", type: "number" },
  ] as const);
  const service = new PolyHavenResources();
  if (args.action === "search") {
    if (!args.query) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Search requires --query." });
    const results = await service.search({
      query: args.query,
      kind: args.kind ? z.enum(["hdri", "texture", "model"]).parse(args.kind) : undefined,
    });
    return { outputs: [], metadata: { resources: results, apiCredit: "Powered by Poly Haven" } };
  }
  if (!args.id) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--id required." });
  if (args.action === "inspect")
    return { outputs: [], metadata: { resource: await service.inspect(args.id), apiCredit: "Powered by Poly Haven" } };
  if (args.action === "acquire" && args.project && args.selector) {
    const result = await service.acquire(args.id, z.array(z.string()).parse(JSON.parse(args.selector)), {
      projectId: args.project,
      maxBytes: args["max-bytes"],
    });
    return {
      outputs: result.outputs,
      metadata: { resource: result.resource, sha256: result.sha256, apiCredit: result.apiCredit },
    };
  }
  throw new CliErrorObject({
    code: "INVALID_INPUT",
    message: "Use search/inspect/acquire; acquisition requires --project and --selector.",
  });
});
