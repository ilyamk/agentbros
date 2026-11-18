import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { gitText } from "../context/repository";
import { runCommand, type CommandRunner } from "./check";
import type { GateEvidence } from "../../types/contrib-tools";

/** Fixed source-to-document order; optional generators support older checkouts. */
export const GENERATORS: readonly string[][] = [
  ["pnpm", "library:catalogue"],
  ["pnpm", "playbook", "--write-doc"],
  ["pnpm", "commands", "--write-doc"],
  ["pnpm", "models:slots", "--write-doc"],
  ["pnpm", "film:route", "--write-doc"],
  ["pnpm", "api:surface"],
  ["pnpm", "metrics", "--write-readme"],
  ["pnpm", "credits:write-doc"],
  ["pnpm", "deps:licences", "--write"],
];
function snapshot(root: string): Map<string, string> {
  return new Map(
    gitText(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean)
      .map((file) => {
        const absolute = path.join(root, file);
        const stat = existsSync(absolute) ? lstatSync(absolute) : undefined;
        // Never follow links or open credential files while reporting generated changes.
        const safe = !file.split("/").some((part) => part === ".env" || part.startsWith(".env."));
        return [
          file,
          safe && stat?.isFile()
            ? createHash("sha256").update(readFileSync(absolute)).digest("hex")
            : stat
              ? "unread"
              : "deleted",
        ];
      }),
  );
}
export function regenerate(
  root: string,
  runner: CommandRunner = runCommand,
): { gates: GateEvidence[]; changed: string[]; skipped: string[] } {
  const scripts = (
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }
  ).scripts;
  const before = snapshot(root),
    gates: GateEvidence[] = [],
    skipped: string[] = [];
  for (const command of GENERATORS) {
    if (["credits:write-doc", "deps:licences"].includes(command[1]!) && !scripts[command[1]!]) {
      skipped.push(command[1]!);
      continue;
    }
    const start = Date.now();
    let result;
    try {
      result = runner([...command], root);
    } catch (error) {
      result = { exitCode: 1, stdout: "", stderr: String(error) };
    }
    gates.push({
      name: command[1]!,
      command: [...command],
      exitCode: result.exitCode,
      durationMs: Date.now() - start,
      summary: (result.stderr.trim() || (result.exitCode ? result.stdout.trim() || "Failed" : "Generated")).slice(-500),
    });
    if (result.exitCode) break;
  }
  const after = snapshot(root);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
  return { gates, changed, skipped };
}
