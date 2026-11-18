/**
 * Pools the authors' current round for a blind creative review: concept teams' ideas or script variants, authorship
 * stripped, shuffled with a seed (default: project id, kind and round). Writes pipeline/pools/<kind>.json and the key
 * pipeline/pools/<kind>-key.json, which the creative director never reads. Scripts carry their measured reading overruns.
 * Then records the review step's receipt itself (film:done), so the next action is the creative director's brief.
 */
import { parseArgs, runScript } from "../src/lib/cli";
import { openExistingFilm } from "../src/lib/film/cli";
import { ChainRefusal, sealStep } from "../src/lib/film/state";
import { buildPool, keyFile, poolFile } from "../src/lib/film/studio";
import { KIND_SPEC, studioRefusals } from "../src/lib/film/studio-cli";
import type { ReviewKind } from "../src/lib/film/creative-rubric";
import path from "node:path";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    KIND_SPEC,
    { name: "seed", description: "Shuffle seed; default <project>:<kind>:<round>" },
  ] as const);
  const project = openExistingFilm(args.project!);
  const kind = args.kind as ReviewKind;
  const { pool, key } = studioRefusals(() =>
    buildPool(project.projectDir, project.id, kind, args.seed ? { seed: args.seed } : {}),
  );
  const relative = (file: string) => path.relative(process.cwd(), file);
  const step = kind === "ideas" ? "idea-review" : "script-review";
  let sealed: { sealed: true } | { sealed: false; sealRefusal: string };
  try {
    sealStep(project, step);
    sealed = { sealed: true };
  } catch (error) {
    if (!(error instanceof ChainRefusal)) throw error;
    sealed = {
      sealed: false,
      sealRefusal: `${error.message} The pool is written; fix that, then run pnpm film:done --project ${project.id} --step ${step}.`,
    };
  }
  return {
    outputs: [relative(poolFile(project.projectDir, kind)), relative(keyFile(project.projectDir, kind))],
    metadata: {
      projectId: project.id,
      kind,
      round: pool.round,
      seed: pool.seed,
      items: pool.items.length,
      authors: [...new Set(key.entries.map((entry) => entry.author))].length,
      readingOverruns: pool.items.filter((item) => item.readingOverruns?.length).map((item) => item.id),
      step,
      ...sealed,
      next: `pnpm film:next --project ${project.id}`,
    },
  };
});
