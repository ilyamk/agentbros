import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ReplicaRightsSchema } from "../../types/reference-replica";

export const STUDY_ONLY_NOTICE = "Study only, not for publication";

/**
 * Why a replica may not be published, from its rights answer (pipeline/replica-rights.json, written by film:rights):
 * study-only, or a record that does not validate. Undefined when the project is no replica or its rights allow release.
 */
export function replicaPublicationBlock(projectDir: string): string | undefined {
  const file = path.join(projectDir, "pipeline", "replica-rights.json");
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    raw = undefined;
  }
  const rights = ReplicaRightsSchema.safeParse(raw);
  if (!rights.success)
    return `${STUDY_ONLY_NOTICE}: pipeline/replica-rights.json does not validate, so the replica is treated as study-only. Record the user's answer with film:rights.`;
  if (rights.data.status !== "study-only") return undefined;
  return `${STUDY_ONLY_NOTICE}: the user's rights answer for this replica is study-only ("${rights.data.userStatement}"). It may be rendered and reviewed locally, never released. Only the user's own statement of ownership or a licence, recorded with film:rights, changes that.`;
}
