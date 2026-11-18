/** Step lease report: pipeline/session/violations.jsonl summed by step, command and code, with `clean` and the guard's mode. Reads only (docs/step-lease.md). */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { effectiveGuardMode } from "../src/lib/step-lease/guard";
import {
  projectDirOf,
  readLease,
  readViolations,
  summariseViolations,
  leaseFile,
  violationsFile,
} from "../src/lib/step-lease/lease";

function report(rootDir: string, projectId: string, since: string | undefined) {
  const projectDir = projectDirOf(rootDir, projectId);
  const loaded = readLease(projectDir);
  return {
    projectId,
    file: path.relative(rootDir, violationsFile(projectDir)),
    guard: effectiveGuardMode(projectDir),
    lease: loaded && "lease" in loaded ? { step: loaded.lease.step, owner: loaded.lease.owner } : null,
    ...summariseViolations(readViolations(projectDir), since),
  };
}

void runScript(async () => {
  const args = parseArgs([
    { name: "project", description: "Project ID; without it, every project that has a step lease or violations" },
    { name: "since", description: "Count only runs at or after this ISO time (after an allow list was fixed)" },
  ] as const);
  const rootDir = process.cwd();
  if (args.since !== undefined && Number.isNaN(Date.parse(args.since)))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `--since is not an ISO time: ${args.since}` });
  const note =
    "clean: no out-of-step run without a step:unlock. Unlocked runs are counted apart; refused runs happened in enforce mode.";
  if (args.project !== undefined) {
    validateProjectId(args.project);
    if (!existsSync(projectDirOf(rootDir, args.project)))
      throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project "${args.project}" not found.` });
    const result = report(rootDir, args.project, args.since);
    return {
      outputs: existsSync(violationsFile(projectDirOf(rootDir, args.project))) ? [result.file] : [],
      metadata: { ...result, note },
    };
  }
  const projectsDir = path.join(rootDir, "public", "projects");
  const ids = existsSync(projectsDir)
    ? readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name))
        .map((entry) => entry.name)
        // A lease or a violation log, not merely pipeline/session/ (the console's control.json lives there too).
        .filter((id) => {
          const projectDir = projectDirOf(rootDir, id);
          return existsSync(leaseFile(projectDir)) || existsSync(violationsFile(projectDir));
        })
        .sort()
    : [];
  const projects = ids.map((id) => {
    const { projectId, guard, total, outOfStep, unlocked, refused, clean, last, byCommand } = report(
      rootDir,
      id,
      args.since,
    );
    return { projectId, guard, total, outOfStep, unlocked, refused, clean, last, topCommands: byCommand.slice(0, 5) };
  });
  return {
    outputs: [],
    metadata: {
      projects,
      outOfStep: projects.reduce((sum, project) => sum + project.outOfStep, 0),
      clean: projects.every((project) => project.clean),
      note,
    },
  };
});
