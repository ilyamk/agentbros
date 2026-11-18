/**
 * Seeded creativity stimuli for concept teams: a deterministic pick from committed generic lists
 * (src/lib/film/stimuli-lists.json), one sheet per method in pipeline/stimuli/<method>-<seed>.json.
 * Procedures: .agents/skills/creative-studio/references/creative-methods.md.
 */
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { openExistingFilm } from "../src/lib/film/cli";
import { STIMULUS_METHODS, isStimulusMethod, writeStimuli } from "../src/lib/film/stimuli";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    { name: "method", required: true, description: `One of ${STIMULUS_METHODS.join(", ")}, or all` },
    { name: "seed", required: true, description: "Any string; the same seed always gives the same stimuli" },
    { name: "count", type: "number", description: "Stimuli per method (default: 10 for kill-first-10, 3 otherwise)" },
  ] as const);
  const method = args.method!;
  if (method !== "all" && !isStimulusMethod(method))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Unknown method "${method}". Allowed: ${STIMULUS_METHODS.join(", ")}, all`,
    });
  const count = args.count;
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 50))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--count must be an integer from 1 to 50" });
  const project = openExistingFilm(args.project!);
  const methods = method === "all" ? STIMULUS_METHODS : [method];
  const written = writeStimuli(project.projectDir, methods, args.seed!, count);
  return {
    outputs: written.map(({ file }) => path.relative(process.cwd(), file)),
    metadata: {
      projectId: project.id,
      seed: args.seed,
      methods: written.map(({ sheet }) => ({ method: sheet.method, count: sheet.count })),
      context: written[0]!.sheet.context,
    },
  };
});
