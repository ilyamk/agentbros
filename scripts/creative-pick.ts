/**
 * Turns the latest ranked review into the chain's artefact. ideas: concept.json with the top three, the first selected,
 * the rest rejected with their rank, each argued against. scripts: the winning variant to script.json,
 * script-music-map.json and script.md, the runner-up to script-alternative.json and .md.
 */
import path from "node:path";
import { parseArgs, runScript } from "../src/lib/cli";
import { openExistingFilm } from "../src/lib/film/cli";
import { pickIdeas, pickScript } from "../src/lib/film/studio";
import { KIND_SPEC, studioRefusals } from "../src/lib/film/studio-cli";

void runScript(async () => {
  const args = parseArgs([{ name: "project", required: true, description: "Project ID" }, KIND_SPEC] as const);
  const project = openExistingFilm(args.project!);
  const relative = (file: string) => path.relative(process.cwd(), file);
  if (args.kind === "ideas") {
    const { concept, file } = studioRefusals(() => pickIdeas(project.projectDir));
    return {
      outputs: [relative(file)],
      metadata: {
        projectId: project.id,
        kind: "ideas",
        candidates: concept.candidates.map((candidate) => candidate.id),
        selectedId: concept.selectedId,
      },
    };
  }
  const result = studioRefusals(() => pickScript(project.projectDir));
  return {
    outputs: result.outputs.map(relative),
    metadata: { projectId: project.id, kind: "scripts", winner: result.winner, runnerUp: result.runnerUp ?? null },
  };
});
