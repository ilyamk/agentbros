import { existsSync } from "node:fs";
import { CliErrorObject, validateProjectId } from "../cli";
import { ChainRefusal, isBespokeProject, openFilmProject, projectDirFor, type FilmProject } from "./state";

/** The chain only runs on a project whose brief chose bespoke rendering. */
export function openExistingFilm(id: string): FilmProject {
  validateProjectId(id);
  const directory = projectDirFor(id);
  if (!existsSync(directory))
    throw new CliErrorObject({
      code: "PROJECT_NOT_FOUND",
      message: `Project "${id}" not found. Create it with film:init.`,
    });
  if (!isBespokeProject(directory))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Project "${id}" is not bespoke (brief.renderMode). A project.json project follows pnpm next (render, QA, delivery).`,
    });
  return openFilmProject(directory);
}

/** A refused step is the caller's to fix, not an internal fault. */
export function refusals<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ChainRefusal) throw new CliErrorObject({ code: "STAGE_INCOMPLETE", message: error.message });
    throw error;
  }
}

/** Pulls a flag taking several values out of argv: parseArgs keeps only one. */
export function takeRepeated(argv: readonly string[], flag: string): { values: string[]; rest: string[] } {
  const values: string[] = [];
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === `--${flag}`) {
      while (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("--")) values.push(argv[++index]!);
    } else if (token.startsWith(`--${flag}=`)) values.push(token.slice(flag.length + 3));
    else rest.push(token);
  }
  return { values, rest };
}
