/**
 * The hash a user approval binds to (RFC 0004 FR3): the content of what the user saw, independent of how paths are
 * written (the chain keys outputs by root-relative paths, the console's bindings by project-relative ones). One
 * artefact: its sha256. Several: the sha256 of their sorted sha256s joined by newlines. `film:approve --expect`,
 * `feedback --step --expect` and the console compute it the same way.
 */
import { createHash } from "node:crypto";

export function artefactsExpect(hashes: Iterable<string>): string {
  const sorted = [...hashes].sort();
  if (sorted.length === 1) return sorted[0]!;
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}
