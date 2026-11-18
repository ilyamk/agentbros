import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface DocumentedCommand {
  script: string;
  flags: string[];
  source: string;
}
/** Inspect command examples as data; never execute shell snippets from instructions. */
export function documentedCommands(markdown: string, root: string): DocumentedCommand[] {
  const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts as Record<string, string>;
  const blocks = [...markdown.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)];
  const regions = blocks.filter((m) => ["", "bash", "sh", "shell"].includes(m[1]!.trim())).map((m) => m[2]!);
  const prose = markdown.replace(/```[^\n]*\n[\s\S]*?```/g, "");
  regions.push(...[...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!));
  const result: DocumentedCommand[] = [];
  for (const region of regions) {
    const joined = region.replace(/\\\r?\n\s*/g, " ");
    for (const match of joined.matchAll(/\bpnpm\s+([^\n]+)/g)) {
      const source = match[0],
        args = match[1]!;
      let script: string;
      let rest: string;
      const direct = /^(?:exec\s+)?tsx\s+(scripts\/[a-z0-9-]+\.ts)(.*)$/i.exec(args);
      if (direct) {
        script = direct[1]!;
        rest = direct[2]!;
      } else {
        const alias = /^([a-z0-9:-]+)(.*)$/i.exec(args);
        if (!alias) throw new Error(`Unsupported documented invocation: ${source}`);
        const command = scripts[alias[1]!];
        if (!command) throw new Error(`Unknown script alias: ${alias[1]}`);
        const target = /^tsx (scripts\/[a-z0-9-]+\.ts)(.*)$/.exec(command);
        if (!target) {
          if (/^(tsc|remotion)\b/.test(command)) continue; // Developer/studio commands are not production JSON CLIs.
          throw new Error(`Invocation is not a production CLI: ${source}`);
        }
        script = target[1]!;
        rest = target[2]! + alias[2]!;
      }
      if (!existsSync(path.join(root, script))) throw new Error(`Unavailable CLI: ${script}`);
      const canonical = realpathSync(path.join(root, script));
      if (!canonical.startsWith(realpathSync(path.join(root, "scripts")) + path.sep))
        throw new Error("Script escapes repository");
      result.push({ script, flags: [...rest.matchAll(/--([a-z][a-z0-9-]*)/gi)].map((m) => m[1]!), source });
    }
  }
  return result;
}
export function checkDocumentedFlags(command: DocumentedCommand, help: string): void {
  const flags = new Set([...help.matchAll(/--([a-z][a-z0-9-]*)/gi)].map((m) => m[1]!));
  flags.add("help");
  for (const flag of command.flags) if (!flags.has(flag)) throw new Error(`Unsupported --${flag} in ${command.source}`);
}
