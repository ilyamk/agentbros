import { APPLE_COMMANDS, availableLocalCommands } from "../lib/local-capabilities";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadCatalog } from "../lib/models/fal-catalog";
import { FalCategorySchema, TrustTierSchema } from "../types/fal-catalog";
import { listModels } from "../lib/models/registry";
import { COMMAND_REGISTRY } from "../lib/cli/commands";
import { COMMANDS } from "./catalog";
import { invokeCommand, summarizeInlineMedia, type BridgeOptions } from "./bridge";
import { registerConsoleTools, type ConsoleToolOptions } from "./console-tools";
import { listGuides, readGuide } from "./guides";
import { CORE_TOOLS, isListed, sectionOf, TOOLSETS, type Toolset } from "./toolsets";

/** Sent in the MCP initialize result; harnesses show it to the model before any tool call. */
export const SERVER_INSTRUCTIONS = [
  "Agent Bros. Pictures: a local video studio. Each tool runs one repository CLI and returns its one-line JSON envelope { ok, outputs, metadata, error, message }.",
  "Start every request with avc_next (an existing project) or avc_playbook (a new video), then do what the answer says and call avc_next again.",
  "Tools not listed are reachable through avc_call { tool, arguments } with the same checks; avc_capabilities lists them all with their spend policy, avc_help shows a tool's flags.",
  "Skills and leaf-agent briefs from .agents/ are served by avc_guide: read the skill a step names before acting on it.",
  "Paid generation is blocked or forced to dry-run unless the human launcher passed --allow-paid. Approvals and budget raises belong to the user on the CLI, never to a tool call.",
].join("\n");
const result = (value: Record<string, unknown>, isError = false) => {
  const summarized = summarizeInlineMedia(value) as Record<string, unknown>;
  const serialized = JSON.stringify(summarized);
  if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) {
    const compact = {
      ok: value.ok ?? true,
      ...(value.error ? { error: value.error } : {}),
      ...(typeof value.message === "string" ? { message: value.message.slice(0, 4096) } : {}),
      outputs: value.outputs ?? [],
      metadata: {
        bridgeSummary: true,
        reason: "Result exceeds 2 MiB MCP response limit; read the listed local artifact or use a narrower query.",
        keys: Object.keys(value),
      },
    };
    return { isError, structuredContent: compact, content: [{ type: "text" as const, text: JSON.stringify(compact) }] };
  }
  return { isError, structuredContent: summarized, content: [{ type: "text" as const, text: serialized }] };
};
export function createVideoMcpServer(
  options: BridgeOptions & { toolsets?: readonly Toolset[]; consoleSource?: ConsoleToolOptions["consoleSource"] },
) {
  const server = new McpServer({ name: "agentbros", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
  const available = COMMANDS.filter((command) => existsSync(path.join(options.codeRoot, "scripts", command.script)));
  const toolsets = options.toolsets ?? ["all"];
  const listed = available.filter((command) => isListed(command, toolsets));
  const run = async (command: (typeof available)[number], args: unknown, signal: AbortSignal) => {
    try {
      const envelope = await invokeCommand(command, args, options, signal);
      return result(envelope, !envelope.ok);
    } catch (error) {
      return result(
        { ok: false, error: "MCP_BRIDGE", message: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  };
  server.registerTool(
    "avc_capabilities",
    {
      description:
        "Local tool and model verification catalog. Schema/local adapter support is not live API acceptance.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const nativeReady = await availableLocalCommands();
      return result({
        root: options.root,
        projectScope: options.projectScope ?? null,
        allowPaid: options.allowPaid,
        authority: "trusted-local-project-cli",
        toolsets: { active: toolsets, available: TOOLSETS, core: CORE_TOOLS },
        tools: available.map((command) => ({
          name: `avc_${command.name}`,
          section: sectionOf(command.name) ?? null,
          listed: listed.includes(command),
          spendPolicy: command.paid,
          readOnly: command.readOnly,
        })),
        cliOnly: COMMAND_REGISTRY.flatMap((entry) =>
          typeof entry.mcp === "string" ||
          (entry.alias && APPLE_COMMANDS.has(entry.alias) && !nativeReady.has(entry.alias))
            ? []
            : [{ command: entry.alias ?? entry.script, reason: entry.mcp.excluded }],
        ),
        limitations: [
          "No remote multi-tenant authentication",
          "Paid work disabled by default",
          "No live provider acceptance inferred from schemas",
        ],
      });
    },
  );
  server.registerTool(
    "avc_models",
    {
      description:
        "Offline fal catalogue, capped at 100 results (default 50). Optional legacy family routing remains available; schemas are not live acceptance.",
      inputSchema: z
        .object({
          family: z.string().optional(),
          category: FalCategorySchema.optional(),
          tier: TrustTierSchema.optional(),
          search: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ family, category, tier, search, limit }) => {
      const legacy = listModels(),
        catalog = loadCatalog();
      const legacyById = new Map(legacy.map((model) => [model.id, model]));
      const entries =
        family === undefined
          ? [...catalog.values()].map((entry) => ({
              ...entry,
              ...legacyById.get(entry.endpoint),
              id: entry.endpoint,
              verification: legacyById.get(entry.endpoint)?.verification ?? {
                schema: !!entry.schema,
                localAdapter: false,
                live: false,
              },
            }))
          : legacy
              .filter((model) => model.family === family || model.requestRouting.family === family)
              .map((model) => ({ ...catalog.get(model.id), ...model, endpoint: model.id }));
      const matched = entries.filter((entry) => {
        const indexed = catalog.get(entry.id);
        return (
          (!category || indexed?.category === category) &&
          (!tier || indexed?.tier === tier) &&
          (!search ||
            `${entry.id} ${indexed?.displayName ?? ""} ${indexed?.tags.join(" ") ?? ""}`
              .toLowerCase()
              .includes(search.toLowerCase()))
        );
      });
      const models = matched.slice(0, limit);
      return result({
        families: [...new Set(legacy.flatMap((model) => [model.family, model.requestRouting.family]))],
        models,
        total: matched.length,
        returned: models.length,
        truncated: matched.length > limit,
        liveVerification: "No paid API acceptance was performed by this local implementation.",
      });
    },
  );
  server.registerTool(
    "avc_help",
    {
      description: "Get canonical CLI help for a whitelisted command, including paid tools without invoking them.",
      inputSchema: z
        .object({ command: z.enum(available.map((command) => command.name) as [string, ...string[]]) })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ command }, context) => {
      try {
        const found = available.find((entry) => entry.name === command)!;
        const help = {
          ...found,
          schema: z.object({ help: z.literal(true) }).strict(),
          paths: [],
          paid: "local" as const,
        };
        return result(
          await invokeCommand(help, { help: true }, { ...options, projectScope: undefined }, context.mcpReq.signal),
        );
      } catch (error) {
        return result(
          { ok: false, error: "MCP_BRIDGE", message: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    },
  );
  server.registerTool(
    "avc_guide",
    {
      description:
        "Read the studio's skills and leaf-agent briefs from .agents/: list them, read a skill's SKILL.md (with its reference file list) or one reference file, or read an agent definition to follow or dispatch.",
      inputSchema: z
        .object({
          kind: z.enum(["skill", "agent"]).default("skill"),
          name: z.string().max(64).optional(),
          file: z.string().max(256).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ kind, name, file }) => {
      try {
        if (!name) return result({ ok: true, kind, entries: listGuides(options.codeRoot, kind) });
        return result({ ok: true, kind, name, ...readGuide(options.codeRoot, kind, name, file) });
      } catch (error) {
        return result(
          { ok: false, error: "INVALID_INPUT", message: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    },
  );
  registerConsoleTools(server, options, result);
  if (listed.length < available.length)
    server.registerTool(
      "avc_call",
      {
        description:
          "Run any whitelisted tool that this launcher does not list (see avc_capabilities, listed:false) with its usual arguments; the same schema, path, project-scope and spend checks apply. Use avc_help for its flags.",
        inputSchema: z
          .object({
            tool: z.string().max(80).describe("Tool name, with or without the avc_ prefix"),
            arguments: z.record(z.string(), z.unknown()).default({}),
          })
          .strict(),
        annotations: { openWorldHint: true },
      },
      async ({ tool, arguments: args }, context) => {
        const command = available.find((entry) => entry.name === tool.replace(/^avc_/, ""));
        if (!command)
          return result(
            { ok: false, error: "INVALID_INPUT", message: `Unknown tool: ${tool}. avc_capabilities lists every tool.` },
            true,
          );
        return run(command, args, context.mcpReq.signal);
      },
    );
  for (const command of listed)
    server.registerTool(
      `avc_${command.name}`,
      {
        description: command.description,
        inputSchema: command.schema,
        annotations: { readOnlyHint: command.readOnly, openWorldHint: command.paid !== "local" },
      },
      async (args, context) => run(command, args, context.mcpReq.signal),
    );
  return server;
}
