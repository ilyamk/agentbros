import path from "path";
import { lstatSync } from "node:fs";
import { assertPathWithin, isReservedProjectId, reservedProjectReason } from "../cli";

const PROJECTS_DIR = path.join("public", "projects");

export function projectDir(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
    throw new Error(`Invalid project id "${id}": expected letters, digits, hyphens or underscores.`);
  }
  const result = path.join(PROJECTS_DIR, id);
  assertPathWithin(PROJECTS_DIR, result);
  return result;
}

/** `.cache` directories that hold durable per-project state, keyed by project id. */
export const PROJECT_STATE_CACHES = [
  "paid-responses",
  "realtime",
  "realtime-channels",
  "realtime-editors",
  "rhythm-evidence",
];

/** memory/usage/<id>.json: the library blocks one film used (library:usage). Project footprint, unlike the user's lessons in memory/. */
export const projectUsageRecord = (id: string): string => path.join("memory", "usage", `${id}.json`);

/** Every location that belongs to one project, whether or not it exists on disk. */
export function projectFootprint(id: string): string[] {
  // Unlike projectDir(), accepts a leading underscore so scratch projects can be removed.
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(id)) {
    throw new Error(`Invalid project id "${id}": expected letters, digits, hyphens or underscores.`);
  }
  // out/console/ is the studio console's, never a project's renders (RFC 0004).
  if (isReservedProjectId(id)) throw new Error(reservedProjectReason(id));
  return [
    path.join(PROJECTS_DIR, id),
    path.join("src", "projects", id),
    path.join("out", id),
    ...PROJECT_STATE_CACHES.map((cache) => path.join(".cache", cache, id)),
    projectUsageRecord(id),
  ];
}

/**
 * Paths under a project's `pipeline/` that belong to the studio console and the step lease (RFC 0004: decisions in
 * inbox/, control and lease in session/, agent cards in cards/, ratings.json), never to a route's own artefacts.
 * Scans of pipeline/ for route markers skip them. `relative` is relative to pipeline/, either separator.
 */
export const CONSOLE_PIPELINE_ENTRIES = ["inbox", "session", "cards", "ratings.json"] as const;
export function isConsolePipelineEntry(relative: string): boolean {
  const first = relative.split(/[\\/]/).find((segment) => segment && segment !== ".");
  return first !== undefined && (CONSOLE_PIPELINE_ENTRIES as readonly string[]).includes(first);
}

export function pipelineDir(id: string): string {
  const result = path.join(projectDir(id), "pipeline");
  if (lstatSync(result, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("Pipeline directory cannot be a symlink.");
  }
  return result;
}

export function stageArtefactPath(id: string, stage: string, kind: "json" | "md"): string {
  if (!/^[a-z0-9-]+$/.test(stage) || !["json", "md"].includes(kind)) {
    throw new Error("Invalid pipeline artefact path.");
  }
  const directory = pipelineDir(id);
  const result = path.join(directory, `${stage}.${kind}`);
  assertPathWithin(directory, result);
  return result;
}

export function pipelineStatePath(id: string): string {
  return path.join(pipelineDir(id), "pipeline-state.json");
}

export function assetsPlanPath(id: string): string {
  return stageArtefactPath(id, "asset-plan", "json");
}

/** Maps each pipeline stage to the stem of its artefact file (without extension). */
export const STAGE_FILE: Record<string, string> = {
  brief: "brief",
  script: "script",
  design: "design",
  characters: "characters",
  storyboard: "storyboard",
  "asset-plan": "asset-plan",
  assets: "assets-status",
  "narrator-direction": "narrator-direction",
  voiceover: "voiceover-status",
  "caption-edit": "caption-edit",
  rhythm: "rhythm",
  "audio-mix": "audio-mix",
  "talking-head": "talking-head-status",
  compose: "compose",
  render: "render-status",
  qa: "qa",
};
