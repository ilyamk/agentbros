/**
 * Record the user's 1-5 rating of a styleframe, reference or render of a project in pipeline/ratings.json (RFC 0004
 * §8, US10, A16): `pnpm ref:rate --project P --path <project-relative file> --score 1..5 [--note "<the user's words>"]
 * [--kind styleframe|reference|render|asset|other] [--step S] [--expect <sha256>]`. The file must be a file of the
 * project; `--expect` refuses it when it changed since the user saw it. A note is the user's words, verbatim: it also
 * becomes a memory preference (memory --add --type preference, in-process) before the rating is written, so a refused
 * note writes nothing. The latest rating of a path wins when read (the look panel, the look and critic steps).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { wordsChannel } from "../src/lib/cli/channel";
import { userWordsProblem } from "../src/lib/cli/user-words";
import {
  appendRating,
  buildRating,
  inferKind,
  ratingBody,
  ratingSummary,
  resolveTarget,
  type RatingKind,
} from "../src/lib/console/ratings";
import { stepById } from "../src/lib/film/chain";
import { addMemory, getMemory } from "../src/lib/memory";
import { RATING_TARGETS } from "../src/types/console";
import type { MemoryEntry } from "../src/types/memory";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project the rated file belongs to" },
    {
      name: "path",
      required: true,
      description: "Project-relative path of the rated file (a styleframe, a reference, a render inside the project)",
    },
    { name: "score", type: "number", required: true, description: "The user's score, an integer from 1 to 5" },
    { name: "note", description: "The user's words about it, verbatim (also saved to memory as a preference)" },
    { name: "kind", choices: RATING_TARGETS, description: "What is rated [default: from the path]" },
    { name: "step", description: "The film step the rating is for [default: look for a styleframe]" },
    { name: "expect", description: "SHA-256 of the file the user saw: refused when the file changed" },
  ] as const);
  validateProjectId(args.project!);
  const projectDir = path.resolve("public/projects", args.project!);
  if (!existsSync(projectDir))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `No project ${args.project}.` });
  const score = args.score!;
  if (!Number.isInteger(score) || score < 1 || score > 5)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `--score is an integer from 1 to 5 (got ${score}).` });
  if (args.expect !== undefined && !/^[a-f0-9]{64}$/.test(args.expect))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--expect is the lowercase hex SHA-256 of the file." });
  const note = args.note;
  if (note !== undefined) {
    const problem = userWordsProblem(note);
    if (problem)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--note is the user's own words, verbatim: ${problem}.`,
      });
  }
  const target = resolveTarget(projectDir, args.path!, args.expect);
  const kind = (args.kind as RatingKind | undefined) ?? inferKind(target.path);
  const step = args.step ?? (kind === "styleframe" ? "look" : undefined);
  if (step !== undefined && !stepById(step))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `--step ${step} is not a film chain step.` });
  const channel = wordsChannel().channel ?? "cli";
  const at = new Date().toISOString();
  const rating = buildRating({
    target,
    score,
    kind,
    ...(note !== undefined ? { note } : {}),
    ...(step ? { step } : {}),
    channel,
    at,
  });

  let memory: { id: string; file?: string; existing?: boolean } | undefined;
  const remember = () => {
    if (note === undefined) return;
    try {
      const entry: MemoryEntry = addMemory({
        type: "preference",
        summary: ratingSummary(rating, note),
        source: { kind: "user", quote: note, at, ...wordsChannel() },
        body: ratingBody(rating, note),
        supersedes: [],
        scope: { playbooks: [], steps: step ? [step] : [], platforms: [], axes: [], project: args.project! },
      });
      memory = { id: entry.id, file: path.relative(process.cwd(), getMemory(entry.id).file) };
    } catch (error) {
      // The same preference is already in memory (a near-duplicate): the rating stands, the entry is not repeated.
      const existing = (error as CliErrorObject).details?.["existing"];
      if (error instanceof CliErrorObject && error.code === "FILE_EXISTS" && typeof existing === "string")
        memory = { id: existing, existing: true };
      else throw error;
    }
  };
  const { file, count } = appendRating(projectDir, rating, remember);
  return {
    outputs: [path.relative(process.cwd(), file), ...(memory?.file ? [memory.file] : [])],
    metadata: {
      projectId: args.project,
      rating,
      ratings: count,
      ...(memory ? { memory } : {}),
    },
  };
});
