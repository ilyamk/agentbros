import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { ProjectConfigSchema, type ProjectConfig } from "../types/video";

const PROJECTS_DIR = path.join("public", "projects");

/** Load a project config from public/projects/{projectId}/project.json */
export function loadProject(projectId: string): ProjectConfig {
  const configPath = path.join(PROJECTS_DIR, projectId, "project.json");
  if (!existsSync(configPath)) {
    throw new Error(
      `Project "${projectId}" not found. Expected: ${configPath}\n` +
        `Available projects: ${listProjects().join(", ") || "(none)"}`,
    );
  }
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  return ProjectConfigSchema.parse(raw);
}

/** List all available project IDs */
export function listProjects(): string[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(path.join(PROJECTS_DIR, d.name, "project.json")))
    .map((d) => d.name);
}

/** Get the public-relative path for a project asset (for staticFile()) */
export function projectAssetPath(projectId: string, ...segments: string[]): string {
  return ["projects", projectId, ...segments].join("/");
}

/** Get the public-relative path for a shared asset (for staticFile()) */
export function sharedAssetPath(...segments: string[]): string {
  return ["shared", ...segments].join("/");
}

/**
 * Resolve an asset path with project-first, shared-fallback strategy.
 * Returns the public-relative path (for staticFile()).
 */
export function resolveAsset(projectId: string, category: string, filename: string): string {
  const projectPath = path.join(PROJECTS_DIR, projectId, "assets", category, filename);
  if (existsSync(projectPath)) {
    return projectAssetPath(projectId, "assets", category, filename);
  }
  // Fallback to shared
  return sharedAssetPath(category, filename);
}
