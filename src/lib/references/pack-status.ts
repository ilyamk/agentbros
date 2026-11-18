/**
 * Read-only pack status for refs:plan and the film chain's references-ready check: a thin re-export of the packs
 * module (`src/lib/references/packs/`) in its cheap mode ({ verify: false }): the receipt parses and names the pack,
 * and approval.json binds packSha256 = sha256(canonicalJson(parsed receipt)). Nothing is re-hashed here; full
 * verification is `refs:pack --action check` (checkPack).
 */
import { packDigest } from "./packs/storage";
import { packState as verifiedPackState, type PackState, type PackStatus } from "./packs/check";

export type { PackState, PackStatus };
export { packDigest };

/** Status, digest and receipt of one pack; an unreadable or invalid receipt counts as missing. Never throws. */
export function packState(projectId: string, packId: string, rootDir = process.cwd()): PackState {
  return verifiedPackState(projectId, packId, rootDir, { verify: false });
}

export function packStatus(projectId: string, packId: string, rootDir = process.cwd()): PackStatus {
  return packState(projectId, packId, rootDir).status;
}
