/**
 * Read-only access to the canonical skills (`.agents/skills/<name>/`) and leaf agents
 * (`.agents/agents/<name>.md`) for harnesses that cannot load them from disk themselves.
 * Paths are contained in the checkout's `.agents/` folder; only Markdown and small text files are served.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { assertPathWithin } from "../lib/cli";

const MAX_BYTES = 256 * 1024;
const TEXT = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv"]);
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface GuideEntry {
  name: string;
  description: string;
}

function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]!] = pair[2]!.replace(/^["']|["']$/g, "");
  }
  return fields;
}

const skillsDir = (codeRoot: string) => path.join(codeRoot, ".agents", "skills");
const agentsDir = (codeRoot: string) => path.join(codeRoot, ".agents", "agents");

export function listGuides(codeRoot: string, kind: "skill" | "agent"): GuideEntry[] {
  if (kind === "skill") {
    const dir = skillsDir(codeRoot);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => NAME.test(name) && existsSync(path.join(dir, name, "SKILL.md")))
      .sort()
      .map((name) => ({
        name,
        description: frontmatter(readFileSync(path.join(dir, name, "SKILL.md"), "utf8")).description ?? "",
      }));
  }
  const dir = agentsDir(codeRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort()
    .map((file) => {
      const fields = frontmatter(readFileSync(path.join(dir, file), "utf8"));
      return { name: fields.name ?? file.slice(0, -3), description: fields.description ?? "" };
    });
}

/** A skill's SKILL.md (or one of its reference files), or an agent definition, as text. */
export function readGuide(
  codeRoot: string,
  kind: "skill" | "agent",
  name: string,
  file?: string,
): { path: string; text: string; files?: string[] } {
  if (!NAME.test(name)) throw new Error(`Invalid ${kind} name: ${name}`);
  if (kind === "agent") {
    if (file) throw new Error("Agents are single files; omit file.");
    const target = path.join(agentsDir(codeRoot), `${name}.md`);
    if (!existsSync(target)) throw new Error(`Unknown agent: ${name}`);
    return { path: path.relative(codeRoot, target), text: readFileSync(target, "utf8") };
  }
  const base = path.join(skillsDir(codeRoot), name);
  if (!existsSync(path.join(base, "SKILL.md"))) throw new Error(`Unknown skill: ${name}`);
  const relative = file ?? "SKILL.md";
  if (relative.includes("\0") || path.isAbsolute(relative)) throw new Error("File must be relative to the skill.");
  const target = path.resolve(base, relative);
  assertPathWithin(realpathSync(base), realpathSync(target));
  if (!lstatSync(target).isFile() || !TEXT.has(path.extname(target).toLowerCase()))
    throw new Error("Only Markdown and text files in a skill can be read.");
  if (statSync(target).size > MAX_BYTES) throw new Error(`File exceeds ${MAX_BYTES} bytes.`);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && TEXT.has(path.extname(entry.name).toLowerCase()))
        files.push(path.relative(base, full).split(path.sep).join("/"));
    }
  };
  if (!file) walk(base);
  return {
    path: path.relative(codeRoot, target).split(path.sep).join("/"),
    text: readFileSync(target, "utf8"),
    ...(file ? {} : { files: files.sort() }),
  };
}
