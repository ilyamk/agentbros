import { localSuggestions } from "../src/lib/local-capabilities/suggestions";
/**
 * Writes the subagent prompt for a step to pipeline/briefs/ and returns its path, a summary and the one line to start
 * the subagent with (metadata.dispatch); --print adds the full text in metadata.prompt.
 */
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { recordDispatch } from "../src/lib/console/journal";
import { buildBrief, type BriefRole } from "../src/lib/film/brief";
import { briefMetadata } from "../src/lib/film/brief-handoff";
import { openExistingFilm, refusals } from "../src/lib/film/cli";
import { guardDispatch } from "../src/lib/film/guard-cli";
import { issueBriefLease } from "../src/lib/step-lease/issue";
import { SCRIPT_VARIANTS, TEAM_STANCES } from "../src/types/studio";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    { name: "step", required: true, description: "Step id, as in film:status" },
    {
      name: "role",
      choices: ["owner", "critic", "fixer"],
      description:
        "Whose brief. Default: the step's owner. critic gives the step's judge: creative-critic, or creative-director on idea-review and script-review",
    },
    { name: "team", choices: TEAM_STANCES, description: "Step ideas: the concept team's stance, one brief per team" },
    {
      name: "variant",
      choices: SCRIPT_VARIANTS,
      description: "Step script-variants: the variant, one brief per variant",
    },
    {
      name: "note",
      description:
        "The user's own words for this step, recorded in the spine. This records user words; use --local-evidence for advisory native data. Refused on a critic brief",
    },
    {
      name: "local-evidence",
      description:
        "One project-owned native result JSON with its source-bound receipt; advisory data for owner/fixer only",
    },
    {
      name: "print",
      type: "boolean",
      description:
        "Also return the full prompt in metadata.prompt. Not needed to dispatch: start the subagent with metadata.dispatch",
    },
  ] as const);
  if (args.team && args.variant)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --team or --variant, not both." });
  const project = openExistingFilm(args.project!);
  const lane = args.team ?? args.variant;
  const guard = refusals(() => guardDispatch(project, args.step!, args.role ?? "owner", lane));
  const hints = args.role !== "critic" ? await localSuggestions(project.id, args.step) : {};
  const brief = refusals(() =>
    buildBrief(project, args.step!, {
      localTools: hints,
      ...(args["local-evidence"] ? { localEvidence: args["local-evidence"] } : {}),
      ...(args.role ? { role: args.role as BriefRole } : {}),
      ...(args.note ? { note: args.note } : {}),
      ...(lane ? { lane } : {}),
    }),
  );
  guard.commit();
  const lease = issueBriefLease(project, {
    step: brief.step,
    role: brief.role,
    agent: brief.agent,
    ...(lane ? { lane } : {}),
    prompt: brief.prompt,
  });
  // The console's agent.dispatch (RFC 0004 §7): which agent was sent where, in every harness. Never fails the brief.
  recordDispatch({
    rootDir: project.rootDir,
    project: project.id,
    step: brief.step,
    agent: brief.agent,
    role: brief.role,
    brief: brief.file,
    ...(args.team ? { team: args.team } : {}),
    ...(args.variant ? { variant: args.variant } : {}),
    ...(lane ? { lane } : {}),
  });
  return {
    outputs: [brief.file],
    metadata: {
      ...briefMetadata({ projectId: project.id, ...brief, ...(lane ? { lane } : {}), print: args.print === true }),
      ...lease,
      ...(brief.role !== "critic" ? hints : {}),
    },
  };
});
