/**
 * How a brief reaches its subagent: by reference. film:brief writes the prompt to pipeline/briefs/ and returns its path,
 * a one-line summary and the line to start the subagent with, so the orchestrator's conversation never holds the brief
 * itself (twice: once from film:brief, once in the Agent call). `--print` adds the full text for callers that need it.
 */

export type HandoffRole = "owner" | "critic" | "fixer";

/** The brief's file name under pipeline/briefs/: one per step, lane and role. */
export const briefFileName = (stepId: string, lane: string | undefined, role: HandoffRole) =>
  `${stepId}${lane ? `-${lane}` : ""}${role === "owner" ? "" : `-${role}`}.md`;

/** The whole prompt the orchestrator gives the new subagent. */
export const dispatchLine = (agent: string, file: string) =>
  `You are ${agent}. Read and follow ${file}; reply only in the format its Report section asks for.`;

/** How an owner or fixer inspects a JSON or Markdown artefact without writing a script; never in a critic's brief. */
export const inspectLine = (projectId: string, stepId: string) =>
  `Inspect an input or output with \`pnpm film:show --project ${projectId} --step ${stepId}\` (one artefact: \`--artefact <path> --fields a.b,c\`), not with a script of your own.`;

/** film:brief's metadata: the path and how to dispatch it, the full text only with `print`. */
export function briefMetadata(brief: {
  projectId: string;
  step: string;
  role: HandoffRole;
  agent: string;
  lane?: string;
  file: string;
  prompt: string;
  print?: boolean;
}) {
  const bytes = Buffer.byteLength(brief.prompt);
  return {
    projectId: brief.projectId,
    step: brief.step,
    role: brief.role,
    agent: brief.agent,
    ...(brief.lane ? { lane: brief.lane } : {}),
    brief: brief.file,
    bytes,
    approxTokens: Math.ceil(bytes / 4),
    summary: (brief.prompt.split("\n", 1)[0] ?? "").replace(/^#\s*/, ""),
    dispatch: dispatchLine(brief.agent, brief.file),
    ...(brief.print ? { prompt: brief.prompt } : {}),
  };
}
