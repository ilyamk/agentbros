/** Reverse lookup: which playbooks name a command, block, category, skill, agent, caption profile, style or template, and where. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Playbook } from "../../types/playbook";
import { COMMAND_REGISTRY } from "../cli/commands";
import { GENERAL_CATEGORIES, GENERAL_COMMANDS, NON_PRODUCTION_SECTIONS } from "./coverage";
import { loadPlaybooks } from "./match";
import { playbookDir, playbooksRoot } from "./project";
import { CAPTION_PROFILE_IDS, knownNames, pnpmAliases } from "./validate";

export type UseKind = "command" | "block" | "category" | "skill" | "agent" | "caption" | "style" | "template";

export type PlaybookUse = { id: string; title: string; status: Playbook["status"]; where: string[] };

export type UseContext = {
  /** Library block id to its category, so a category is found through the blocks a playbook names. */
  blockCategory: Map<string, string>;
  /** Command alias to its registry guide, so a playbook reading that guide uses the command. */
  guides: Map<string, string>;
  /** A playbook's AGENTS.md text, or "" when it has none. */
  text: (id: string) => string;
};

/** Fields that describe the request rather than name a tool. */
const SKIPPED = new Set([
  "version",
  "id",
  "title",
  "status",
  "summary",
  "triggers",
  "notFor",
  "reviewedAt",
  "benchmarks",
  "evidence",
]);

/** Fields whose whole value is a name; elsewhere ("captions" as a footage goal) a value counts only as prose. */
const NAME_FIELD =
  /^(commands|agents|skills|optionalSkills|library\.(categories|blocks)|read|stepRead\.[^.[]+|starter\.(blocks|style|template)|profiles\[\d+\]\.captions)\b/;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether prose names `name`. A name with a hyphen, colon or dot is distinctive and matches as a token; a plain word
 * ("render", "data") matches only as `pnpm <word>` or in backticks, so ordinary prose never counts.
 */
export function mentions(text: string, name: string): boolean {
  if (pnpmAliases(text).includes(name)) return true;
  if (new RegExp("`" + escape(name) + "`").test(text)) return true;
  return /[-:.]/.test(name) && new RegExp(`(?<![\\w:-])${escape(name)}(?![\\w:-])`).test(text);
}

function walk(value: unknown, at: string, visit: (at: string, text: string) => void): void {
  if (typeof value === "string") visit(at, value);
  else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${at}[${index}]`, visit));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SKIPPED.has(key) || (at.startsWith("variants") && key === "triggers")) continue;
      walk(item, at ? `${at}.${key}` : key, visit);
    }
  }
}

/** Where one playbook names `name`: JSON paths, then `AGENTS.md:<lines>`. */
export function usesIn(playbook: Playbook, name: string, context: UseContext): string[] {
  const where: string[] = [];
  walk(playbook, "", (at, text) => {
    if ((text === name && NAME_FIELD.test(at)) || mentions(text, name)) where.push(at);
    else if (/blocks\[\d+\]$/.test(at) && context.blockCategory.get(text) === name) where.push(`${at} (${text})`);
    else if (/^(read|stepRead\.[^.[]+)\[/.test(at) && context.guides.get(name) === text)
      where.push(`${at} (its guide)`);
  });
  const lines = context
    .text(playbook.id)
    .split("\n")
    .flatMap((line, index) => (mentions(line, name) ? [index + 1] : []));
  if (lines.length) where.push(`AGENTS.md:${lines.join(",")}`);
  return where;
}

export function playbookUses(name: string, playbooks: Playbook[], context: UseContext): PlaybookUse[] {
  return playbooks.flatMap((playbook) => {
    const where = usesIn(playbook, name, context);
    return where.length ? [{ id: playbook.id, title: playbook.title, status: playbook.status, where }] : [];
  });
}

export function useContext(root = playbooksRoot()): UseContext & { known: ReturnType<typeof knownNames> } {
  const known = knownNames(root);
  const catalogue = JSON.parse(readFileSync(path.join(root, "docs/library/catalogue.json"), "utf8")) as {
    items: { id: string; category: string }[];
  };
  return {
    known,
    blockCategory: new Map(catalogue.items.map((item) => [item.id, item.category])),
    guides: new Map(
      COMMAND_REGISTRY.flatMap((entry) => (entry.alias && entry.guide ? [[entry.alias, entry.guide] as const] : [])),
    ),
    text: (id) => {
      const file = path.join(playbookDir(id, root), "AGENTS.md");
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    },
  };
}

/** What `name` is in the repository; empty when it names nothing known. */
export function kindsOf(name: string, root = playbooksRoot(), known = knownNames(root)): UseKind[] {
  const kinds: UseKind[] = [];
  if (name in known.scripts) kinds.push("command");
  if (known.blocks.has(name)) kinds.push("block");
  if (known.categories.has(name)) kinds.push("category");
  if (existsSync(path.join(root, ".agents/skills", name, "SKILL.md"))) kinds.push("skill");
  if (existsSync(path.join(root, ".agents/agents", `${name}.md`))) kinds.push("agent");
  if (CAPTION_PROFILE_IDS.includes(name) && name !== "none") kinds.push("caption");
  if (known.styles.has(name)) kinds.push("style");
  if (known.templates.has(name)) kinds.push("template");
  return kinds;
}

export type UsesAnswer = { name: string; kinds: UseKind[]; playbooks: PlaybookUse[]; general?: string };

export function findUses(name: string, root = playbooksRoot()): UsesAnswer {
  const context = useContext(root);
  const general = GENERAL_COMMANDS[name] ?? GENERAL_CATEGORIES[name];
  return {
    name,
    kinds: kindsOf(name, root, context.known),
    playbooks: playbookUses(name, loadPlaybooks(root), context),
    ...(general ? { general } : {}),
  };
}

/** Production commands: aliased registry entries outside the non-production sections, not legacy and not development tools. */
export function productionCommands(): string[] {
  const aliases = COMMAND_REGISTRY.filter(
    (entry) =>
      entry.alias &&
      !(entry.section in NON_PRODUCTION_SECTIONS) &&
      !(typeof entry.mcp === "object" && /legacy|development tool/.test(entry.mcp.excluded)),
  ).map((entry) => entry.alias!);
  return [...new Set(aliases)];
}

/** Production commands and library categories that no playbook names and GENERAL does not list. */
export function ownerlessEntries(root = playbooksRoot()): { commands: string[]; categories: string[] } {
  const context = useContext(root);
  const playbooks = loadPlaybooks(root);
  const owned = (name: string, structured?: RegExp) =>
    playbooks.some((playbook) =>
      usesIn(playbook, name, context).some((where) => !structured || structured.test(where)),
    );
  return {
    commands: productionCommands().filter((alias) => !(alias in GENERAL_COMMANDS) && !owned(alias)),
    // A category word in prose ("data", "ui") is not ownership: only the library fields and the starter count.
    categories: [...context.known.categories]
      .sort()
      .filter((category) => !(category in GENERAL_CATEGORIES) && !owned(category, /^(library\.|starter\.blocks)/)),
  };
}
