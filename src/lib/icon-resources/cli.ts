import path from "node:path";
import { runScript, parseArgs, CliErrorObject } from "../cli";
import { IconProviderSchema } from "../../types/icon-resources";
import { IconResources } from "./service";
export function runIcons(kind: "icon" | "brand") {
  runScript(async () => {
    const args = parseArgs([
      { name: "project", required: true, description: "Existing template or bespoke project" },
      {
        name: "action",
        choices: ["capabilities", "search", "inspect", "acquire", "export", "list", "check"],
        default: "capabilities",
        description: "Search, inspect, acquire, export and validate local resources",
      },
      { name: "query", description: "Search phrase, Russian or English" },
      { name: "queries", description: "JSON array of up to eight English search expansions" },
      { name: "provider", choices: IconProviderSchema.options, description: "Limit discovery to one provider" },
      { name: "collection", description: "Iconify collection prefix" },
      { name: "id", description: "Exact candidate ID or acquired resource/acquisition ID" },
      { name: "variant", description: "Real provider variant" },
      { name: "offline", type: "boolean", default: false, description: "Forbid network requests" },
      { name: "limit", type: "number", default: 20, description: "Result limit 1–100" },
      { name: "format", choices: ["svg", "png", "webp"], description: "Export format; default PNG" },
      { name: "size", type: "number", description: "Square output size 16–4096" },
      { name: "padding", type: "number", description: "Padding in output pixels" },
      { name: "colour", description: "Hex colour; brand overrides need a reason" },
      { name: "background", description: "transparent or #RRGGBB" },
      { name: "stroke-width", type: "number", description: "Stroke-based icon width" },
      {
        name: "allow-style-override",
        type: "boolean",
        default: false,
        description: "Explicit exception to project style or brand colours",
      },
      { name: "reason", description: "Reason for style exception" },
    ] as const);
    try {
      const service = new IconResources(process.cwd(), String(args.project));
      const action = args.action;
      let result: unknown;
      if (action === "capabilities") result = service.capabilities();
      else if (action === "search") {
        let queries: unknown = args.queries ? JSON.parse(String(args.queries)) : [];
        if (!Array.isArray(queries) || queries.some((q) => typeof q !== "string"))
          throw Error("queries must be a JSON string array");
        result = await service.search({
          query: String(args.query ?? ""),
          queries: queries as string[],
          providers: args.provider ? [IconProviderSchema.parse(args.provider)] : undefined,
          kind,
          offline: args.offline,
          limit: args.limit,
          collection: args.collection,
        });
      } else if (action === "list") result = service.list();
      else if (action === "check") result = service.check();
      else {
        if (!args.id) throw new CliErrorObject({ code: "INVALID_INPUT", message: "This action requires --id" });
        if (action === "inspect") result = await service.inspect(args.id, args.offline);
        else if (action === "acquire")
          result = await service.acquire(args.id, {
            variant: args.variant,
            offline: args.offline,
            allowStyleOverride: args["allow-style-override"],
            reason: args.reason,
          });
        else {
          const options = Object.fromEntries(
            Object.entries({
              format: args.format,
              size: args.size,
              padding: args.padding,
              colour: args.colour,
              background: args.background,
              strokeWidth: args["stroke-width"],
              allowStyleOverride: args["allow-style-override"],
              reason: args.reason,
            }).filter(([, v]) => v !== undefined),
          );
          result = await service.export(args.id, options);
        }
      }
      const written = result as { original?: string; file?: string; metadataFile?: string };
      const outputs = ["acquire", "export"].includes(String(action))
        ? [written.original, written.file, written.metadataFile]
            .filter((v): v is string => !!v)
            .map((v) => path.resolve("public", v))
        : [];
      return { outputs, metadata: { result, networkAllowed: !args.offline, paidOperations: 0 } };
    } catch (error) {
      if (error instanceof CliErrorObject) throw error;
      throw new CliErrorObject({ code: "VALIDATION", message: String(error) });
    }
  });
}
