/**
 * The project a policy belongs to: a bespoke film, or the source project of a user's own recording (a recut or shorts
 * episode id resolves to it, as footage:next does). film:policy and film:revert open projects through here.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, validateProjectId } from "../cli";
import { isBespokeProject, openFilmProject, projectDirFor, type FilmProject } from "../film/state";
import { resolveSourceProject } from "../footage/next";
import { detectRoute } from "../pipeline/route";
import type { PolicyProjectKind } from "./pre-answers";

export type PolicyProject = { id: string; projectDir: string; kind: PolicyProjectKind; film?: FilmProject };

export function openPolicyProject(id: string, rootDir: string = process.cwd()): PolicyProject {
  validateProjectId(id);
  const directory = projectDirFor(id, rootDir);
  if (!existsSync(directory))
    throw new CliErrorObject({
      code: "PROJECT_NOT_FOUND",
      message: `Project "${id}" not found. Create it with film:init (a film) or footage:next (a recording).`,
    });
  if (isBespokeProject(directory)) {
    const film = openFilmProject(directory);
    let filmType: string | undefined;
    try {
      const brief = JSON.parse(readFileSync(path.join(directory, "pipeline", "brief.json"), "utf8"));
      if (typeof brief?.filmType === "string") filmType = brief.filmType;
    } catch {
      filmType = undefined;
    }
    return {
      id: film.id,
      projectDir: film.projectDir,
      kind: { route: "film", ...(filmType ? { filmType } : {}) },
      film,
    };
  }
  let route: string | null = null;
  try {
    route = detectRoute(directory).route;
  } catch {
    route = null;
  }
  if (route === "footage") {
    const source = resolveSourceProject(id, rootDir).projectId;
    return { id: source, projectDir: projectDirFor(source, rootDir), kind: { route: "footage" } };
  }
  throw new CliErrorObject({
    code: "INVALID_INPUT",
    message: `Project "${id}" is neither a bespoke film (brief.renderMode) nor a recording footage:next edits; a policy covers only those.`,
  });
}
