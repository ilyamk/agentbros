/**
 * The studio console's read tools (RFC 0004 D17), answered in-process from the workspace root: `avc_console_url`
 * (the running server's address, never its token) and `avc_console_view` (the project read model, trimmed by
 * src/lib/console/agent-view.ts). Posting a card is the bridge tool `avc_console_card`; applying decisions and
 * changing control are the user's and are not tools.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { consoleAddress, trimView } from "../lib/console/agent-view";
import type { ConsoleDataSource } from "../lib/console/data";
import { createProjectorDataSource } from "../lib/console/view/source";
import { ProjectIdSchema } from "../types/console";

export interface ConsoleToolOptions {
  root: string;
  projectScope?: string;
  /** The read model's source (default: the projector over `root`, as the console server uses). */
  consoleSource?: (root: string) => ConsoleDataSource;
}

type Reply = (
  value: Record<string, unknown>,
  isError?: boolean,
) => { isError: boolean; structuredContent: Record<string, unknown>; content: { type: "text"; text: string }[] };

const project = ProjectIdSchema.optional().describe("Project id (the scoped project when the server is scoped)");

/** The project a call may read: the scope's when the server is scoped (another one is refused). */
export function scopedConsoleProject(scope: string | undefined, requested: string | undefined): string | undefined {
  if (scope && requested !== undefined && requested !== scope)
    throw new Error("Project is outside the server project scope.");
  return requested ?? scope;
}

export function registerConsoleTools(server: McpServer, options: ConsoleToolOptions, reply: Reply): void {
  const failure = (error: unknown, code = "INVALID_INPUT") =>
    reply({ ok: false, error: code, message: error instanceof Error ? error.message : String(error) }, true);

  server.registerTool(
    "avc_console_url",
    {
      description:
        "The studio console's address (http://127.0.0.1:<port>/, with the project's page when a project is given) if the console server is running; never the session token. Open it once beside the chat. Read-only; it does not start a server (pnpm next does).",
      inputSchema: z.object({ project }).strict(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const id = scopedConsoleProject(options.projectScope, args.project);
        const address = consoleAddress(options.root, id);
        return reply({
          ok: true,
          metadata: {
            ...address,
            ...(id ? { project: id } : {}),
            ...(address.running ? {} : { hint: "No console server is running; pnpm next starts one." }),
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "avc_console_view",
    {
      description:
        "A project's console read model, trimmed: control state, steps and their status, decisions waiting for the user, agent cards (open ones and answers), money totals, the latest render and QA counts. Read-only.",
      inputSchema: z.object({ project }).strict(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const id = scopedConsoleProject(options.projectScope, args.project);
        if (!id) throw new Error("A project is required.");
        const source = (options.consoleSource ?? ((root: string) => createProjectorDataSource(root)))(options.root);
        const view = await source.view(id);
        if (!view) return reply({ ok: false, error: "PROJECT_NOT_FOUND", message: `Project ${id} not found.` }, true);
        return reply({ ok: true, metadata: { view: trimView(view) } });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
