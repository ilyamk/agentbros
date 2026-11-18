import path from "node:path";
import { PROJECTS_DIR } from "../../types/console";
import { HttpError } from "../local-server/errors";
import { writeProjectTitle } from "../project-display";
import { spawnCli } from "./control-actions";

export function projectSettings(rootDir: string, releaseReview: (project: string) => Promise<void>) {
  const removing = new Set<string>();
  const writes = new Map<string, number>();
  const assertAvailable = (project: string) => {
    if (removing.has(project)) throw new HttpError(409, "CONFLICT", "Project deletion is already in progress.");
  };
  return {
    async write<T>(project: string, action: () => Promise<T>): Promise<T> {
      assertAvailable(project);
      writes.set(project, (writes.get(project) ?? 0) + 1);
      try {
        return await action();
      } finally {
        const remaining = (writes.get(project) ?? 1) - 1;
        if (remaining) writes.set(project, remaining);
        else writes.delete(project);
      }
    },
    rename(project: string, title: string) {
      writeProjectTitle(path.join(rootDir, PROJECTS_DIR, project), title);
      return { ok: true } as const;
    },
    async remove(project: string) {
      assertAvailable(project);
      if (writes.has(project))
        throw new HttpError(409, "CONFLICT", "A project action is still running. Try again when it finishes.");
      removing.add(project);
      try {
        await releaseReview(project);
        const result = await spawnCli(rootDir, "project-remove.ts", ["--project", project, "--yes"], 120_000);
        if (!result.ok) {
          const code = result.error ?? "INTERNAL";
          const status = code === "PROJECT_NOT_FOUND" ? 404 : code === "VALIDATION" ? 409 : 500;
          const reasons = Array.isArray(result.details?.blocked) ? result.details.blocked.join("\n") : "";
          const message = [result.message ?? "Project deletion failed.", reasons].filter(Boolean).join("\n");
          throw new HttpError(status, code, message.slice(0, 4000));
        }
        return { ok: true } as const;
      } finally {
        removing.delete(project);
      }
    },
  };
}
