/**
 * List a film's kept renders (out/<id>/versions/) and prune old ones. Without --apply a prune is only a plan.
 *
 * Usage: pnpm film:versions --project <id> [--prune] [--keep 5] [--apply]
 * A prune keeps the newest --keep (default 5), the best version, the one equal to out/<id>/film.mp4, and any version
 * an approval, chain receipt, delivery snapshot or report, or render receipt names. --apply implies --prune.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, emitProgress, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import {
  applyFilmVersionPrune,
  bestFilmVersion,
  listFilmVersions,
  planFilmVersionPrune,
  type FilmVersionProject,
} from "../src/lib/film/versions";
import { formatBytes } from "../src/lib/workspace/cleanup";

runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    { name: "prune", type: "boolean", description: "Plan removal of old kept versions (dry run unless --apply)" },
    { name: "keep", description: "How many newest versions a prune keeps besides the protected ones; default 5" },
    {
      name: "apply",
      type: "boolean",
      description: "Delete the planned copies and rewrite index.json; implies --prune",
    },
  ] as const);
  const id = args.project!;
  validateProjectId(id);
  if (args.keep !== undefined && !/^\d+$/.test(args.keep))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--keep must be a whole number of 0 or more." });
  const project: FilmVersionProject = {
    id,
    rootDir: process.cwd(),
    projectDir: path.resolve("public/projects", id),
  };
  if (!existsSync(project.projectDir) && !existsSync(path.resolve("out", id)))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project "${id}" has no files on disk.` });

  if (!args.prune && !args.apply) {
    const versions = listFilmVersions(project);
    const best = bestFilmVersion(project);
    for (const version of versions)
      emitProgress(
        `${version.sha256.slice(0, 16)}  ${version.createdAt}  ${formatBytes(version.sizeBytes).padStart(9)}  ${version.steps.join(",")}${version.sha256 === best?.sha256 ? "  [best]" : ""}${version.exists ? "" : "  [missing]"}`,
      );
    return {
      outputs: [],
      metadata: {
        projectId: id,
        versions,
        best: best?.sha256 ?? null,
        totalBytes: versions.reduce((sum, version) => sum + (version.exists ? version.sizeBytes : 0), 0),
      },
    };
  }

  const plan = planFilmVersionPrune(project, { keep: args.keep === undefined ? 5 : Number(args.keep) });
  for (const entry of plan.kept) emitProgress(`keep    ${entry.file}  (${entry.reasons.join(", ")})`);
  for (const entry of plan.remove)
    emitProgress(`remove  ${entry.file}  ${entry.exists ? formatBytes(entry.bytes) : "[missing]"}`);
  emitProgress(`${args.apply ? "Freed" : "Would free"} ${formatBytes(plan.bytesFreed)}.`);
  const removed = args.apply ? applyFilmVersionPrune(project, plan) : [];
  return {
    outputs: removed,
    metadata: {
      projectId: id,
      dryRun: !args.apply,
      ...plan,
      totalSize: formatBytes(plan.bytesFreed),
    },
  };
});
