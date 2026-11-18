/** A local dated shortlist, separate from acquisition and generation. */
import { readFileSync } from "node:fs";
import { ZodError } from "zod";
import { CliErrorObject, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { addMotionCandidate, motionSources, searchMotionCandidates } from "../src/lib/model-preparation/library";

void runScript(async () => {
  try {
    const args = parseArgs([
      {
        name: "action",
        choices: ["sources", "add", "search"],
        default: "search",
        description: "Inspect supported sources, add an immutable candidate, or search dated local candidates",
      },
      { name: "project", description: "Existing project ID" },
      { name: "input", description: "Strict MotionCandidate JSON for action=add" },
      { name: "query", description: "Words in title, category or tags" },
      { name: "category", description: "Exact category" },
      { name: "market", description: "Exact market" },
      {
        name: "max-age-days",
        type: "number",
        default: 7,
        description: "House freshness window, measured from observedAt; never invent missing metrics",
      },
    ] as const);
    if (args.action === "sources")
      return { metadata: { sources: motionSources(), automaticHiggsfieldLibrary: false, paid: false } };
    if (!args.project) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--project is required." });
    requireProject(args.project);
    if (args.action === "add") {
      if (!args.input) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--input is required for add." });
      const result = addMotionCandidate(args.project, JSON.parse(readFileSync(args.input, "utf8")));
      return { outputs: [result.file], metadata: { candidate: result.candidate, rightsGranted: false } };
    }
    const candidates = searchMotionCandidates(args.project, {
      query: args.query,
      category: args.category,
      market: args.market,
      maxAgeDays: args["max-age-days"],
    });
    return {
      metadata: {
        candidates,
        sources: motionSources(),
        ...(candidates.length
          ? {}
          : {
              nextAction:
                "Research fresh public candidates or reuse an authorised original; add dated evidence before calling a clip trending. Stock and newly recorded motions are alternatives, not established trends.",
            }),
      },
    };
  } catch (error) {
    if (error instanceof ZodError) throw new CliErrorObject({ code: "VALIDATION", message: error.message });
    throw error;
  }
});
