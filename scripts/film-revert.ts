/**
 * Revokes a decision the harness made under the user's policy (pipeline/decisions.jsonl), on the user's own words.
 * The revocation is appended; the policy approval it covered stops counting, so the step's gate is open again and
 * film:next asks the user (a revoked decision is never taken again on the same artefacts). The hash cascade reopens
 * every later step. On a recording's source project it revokes a footage:policy-apply decision: a caption style is
 * dropped from the goals, a shorts approval is asked again (src/lib/footage/policy-apply.ts). CLI only, never MCP.
 */
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { openPolicyProject } from "../src/lib/autonomy/project";
import { appendDecision, readDecisions, revokedDecisionIds } from "../src/lib/film/decisions";
import { appendGuardEvent } from "../src/lib/film/guard";
import { requireUserWords } from "../src/lib/cli/user-words";
import { stepState } from "../src/lib/film/state";
import { undoFootageDecision } from "../src/lib/footage/policy-apply";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    { name: "decision", required: true, description: "The decision id in pipeline/decisions.jsonl (d-NNN)" },
    { name: "answer", required: true, description: "The user's own words revoking it" },
  ] as const);
  const answer = requireUserWords(args.answer, "--answer");
  const project = openPolicyProject(args.project!);
  const entries = readDecisions(project.projectDir);
  const target = entries.find((entry) => entry.id === args.decision && entry.kind !== "revoked");
  if (!target)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `No decision ${args.decision} in pipeline/decisions.jsonl. Known: ${entries.map((entry) => entry.id).join(", ") || "none"}.`,
    });
  if (revokedDecisionIds(entries).has(target.id))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Decision ${target.id} is already revoked.` });
  const at = new Date().toISOString();
  const revoked = appendDecision(project.projectDir, {
    kind: "revoked",
    revokes: target.id,
    step: target.step,
    answer,
    at,
  });
  appendGuardEvent(project.projectDir, { kind: "reentry", step: target.step, source: `film:revert ${target.id}`, at });
  if (!project.film) {
    const undone = undoFootageDecision(project.projectDir, target);
    return {
      metadata: {
        projectId: project.id,
        revoked,
        step: target.step,
        ...(undone ? { undone } : {}),
        next: `pnpm footage:next --project ${project.id}`,
      },
    };
  }
  const state = stepState(project.film, target.step);
  return {
    metadata: {
      projectId: project.id,
      revoked,
      step: target.step,
      status: state.status,
      next: `pnpm film:next --project ${project.id}`,
    },
  };
});
