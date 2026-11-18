import { readFileSync } from "node:fs";
import { CliErrorObject } from "../cli";
import { metricDeltas } from "../metrics";
import { budgetDelta, type ContextBudget } from "../context/budget";
import { newShowcases, readEntries, releaseNotes } from "./index";

export const NOTES_FLAGS = [
  { name: "version", required: true, description: "Stable release version, without v" },
  { name: "since", description: "Release tag to compare (default: last reachable release tag)" },
  { name: "metrics-old", description: "Old metrics JSON snapshot from pnpm metrics" },
  { name: "metrics-new", description: "New metrics JSON snapshot from pnpm metrics" },
  { name: "context-old", description: "Old context:budget JSON snapshot" },
  { name: "context-new", description: "New context:budget JSON snapshot" },
] as const;

export function notesFor(
  root: string,
  args: Record<string, string | number | boolean | undefined>,
  includeShowcases = true,
) {
  const readPair = (kind: string): [unknown, unknown] | undefined => {
    const old = args[`${kind}-old`];
    const current = args[`${kind}-new`];
    if (Boolean(old) !== Boolean(current))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `Pass both --${kind}-old and --${kind}-new` });
    return typeof old === "string" && typeof current === "string"
      ? [JSON.parse(readFileSync(old, "utf8")), JSON.parse(readFileSync(current, "utf8"))]
      : undefined;
  };
  const metrics = readPair("metrics");
  const context = readPair("context");
  const entries = readEntries(root);
  const notes = releaseNotes(String(args.version), entries, {
    ...(metrics ? { metrics: metricDeltas(...metrics) } : {}),
    ...(context ? { context: budgetDelta(context[1] as ContextBudget, context[0] as ContextBudget) } : {}),
    showcases: includeShowcases ? newShowcases(root, typeof args.since === "string" ? args.since : undefined) : [],
  });
  return { entries, notes };
}
