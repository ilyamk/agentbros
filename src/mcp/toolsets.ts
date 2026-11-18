/**
 * Which tools a server lists. Harnesses cap or pay for listed tools (Cursor and Copilot limit the count,
 * every schema costs context), so a launcher can list a small set and reach the rest through `avc_call`,
 * which goes through the same bridge checks as a listed tool.
 */
import { COMMAND_REGISTRY, SECTIONS, type CommandSection } from "../lib/cli/commands";
import type { ToolCommand } from "./catalog";

/** The loop every route runs (next step, its brief, render, QA, delivery, spend), without generation or engines. */
export const CORE_TOOLS = [
  "next",
  "playbook",
  "memory",
  "project_list",
  "project_create",
  "film_init",
  "film_status",
  "film_next",
  "film_brief",
  "film_show",
  "film_done",
  "footage_next",
  "film_render",
  "render_project",
  "editorial_qa",
  "delivery",
  "budget",
  "cost_report",
  "asset_import",
  "commands",
  "console_card",
] as const;

export type Toolset = "all" | "core" | CommandSection;
export const TOOLSETS: readonly Toolset[] = ["all", "core", ...(Object.keys(SECTIONS) as CommandSection[])];

export function sectionOf(tool: string): CommandSection | undefined {
  return COMMAND_REGISTRY.find((entry) => entry.mcp === tool)?.section;
}

/** Parses `core`, `all` or a comma list of toolsets (`core,footage`); throws on an unknown name. */
export function parseToolsets(value: string): Toolset[] {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error("Toolsets must name at least one of: " + TOOLSETS.join(", "));
  for (const name of names)
    if (!TOOLSETS.includes(name as Toolset))
      throw new Error(`Unknown toolset: ${name}. Use one or more of: ${TOOLSETS.join(", ")}`);
  return names as Toolset[];
}

export function isListed(command: ToolCommand, toolsets: readonly Toolset[]): boolean {
  if (toolsets.includes("all")) return true;
  if (toolsets.includes("core") && (CORE_TOOLS as readonly string[]).includes(command.name)) return true;
  const section = sectionOf(command.name);
  return section !== undefined && toolsets.includes(section);
}
