/**
 * Ranks the creative director's latest review in place with the project's frozen rubric (v1 or v2, same ranking): applies the measured reading cap,
 * keeps only pairs both orders agree on, orders the top six by agreed wins, puts passing items first and computes the
 * verdict. The top skips an item the director marked sameImage with one already in it. Refuses a review with an unscored
 * item, a wrong axis or a missing ordered pair, and a judgement changed after its verdict unless --rescore-reason is given.
 */
import path from "node:path";
import { parseArgs, runScript } from "../src/lib/cli";
import { openExistingFilm } from "../src/lib/film/cli";
import { rankLatest } from "../src/lib/film/studio";
import { KIND_SPEC, studioRefusals } from "../src/lib/film/studio-cli";
import type { ReviewKind } from "../src/lib/film/creative-rubric";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    KIND_SPEC,
    {
      name: "rescore-reason",
      description:
        "Why the scores changed after creative:rank gave its verdict; recorded as rescoredAfterVerdict and shown to the user",
    },
  ] as const);
  const project = openExistingFilm(args.project!);
  const { file, computed, rescored } = studioRefusals(() =>
    rankLatest(project.projectDir, args.kind as ReviewKind, {
      ...(args["rescore-reason"] ? { rescoreReason: args["rescore-reason"] } : {}),
    }),
  );
  return {
    outputs: [path.relative(process.cwd(), file)],
    metadata: {
      projectId: project.id,
      kind: args.kind,
      ...computed,
      ...(rescored ? { rescoredAfterVerdict: true } : {}),
    },
  };
});
