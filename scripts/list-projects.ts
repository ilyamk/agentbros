/**
 * List all available projects.
 *
 * Usage: pnpm projects
 */

import { existsSync } from "fs";
import path from "path";
import { listProjects, loadProject } from "../src/lib/project";

import { parseArgs, runScript } from "../src/lib/cli";

runScript(async () => {
  parseArgs([]);
  const projects = listProjects().map((id) => {
    const project = loadProject(id);
    return {
      id,
      name: project.name,
      formats: project.formats,
      scenes: project.scenes.length,
      voice: project.voice,
      hasVoiceover: existsSync(path.join("public", "projects", id, "voiceover", `${project.scenes[0]?.id}.mp3`)),
      hasMusic: existsSync(path.join("public", "projects", id, "music", "bg.mp3")),
    };
  });
  return { metadata: { projects } };
});
