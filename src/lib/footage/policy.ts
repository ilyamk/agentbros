/**
 * A footage source project's autonomy policy, as footage:next reads it: the user's pre-answered caption style and
 * shorts (count, or auto-pass `shorts` for every proposed clip), and what the user revoked (film:revert). Reads only;
 * footage:policy-apply (src/lib/footage/policy-apply.ts) does the writes and the ledger line.
 * Interactive is the absence of a policy file, or a policy that is not autonomous: footage:next then asks as before.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { currentPolicy, isAutonomous } from "../autonomy/policy";
import { captionStyleProblem, shortsCountProblem } from "../autonomy/pre-answers";
import { readDecisions, revokedDecisionIds } from "../film/decisions";
import type { PreAnswers } from "../../types/policy";

/** Ledger steps of the footage decisions (pipeline/decisions.jsonl of the source project). */
export const FOOTAGE_CAPTIONS_STEP = "footage-captions";
export const FOOTAGE_SHORTS_STEP = "footage-shorts";

export type FootagePolicyView = {
  revision: number;
  /** The user's words that granted the policy in force. */
  grantedBy: string;
  preAnswers: PreAnswers;
  autoPassShorts: boolean;
  /** Caption styles the policy chose and the user revoked: never chosen again by the policy. */
  revokedCaptionStyles: { style: string; decision: string }[];
  /** proposals.json hashes whose policy selection the user revoked. */
  revokedProposals: { sha256: string; decision: string }[];
  /** The goals file's hash, which footage:policy-apply --apply captionStyle expects. */
  goalsSha256: string | null;
  /** The ranked proposals' hash, which --apply shorts expects. */
  proposalsSha256: string | null;
  /** The series request on disk is the one a revoked policy decision wrote: the user is asked again. */
  seriesRevokedBy: string | null;
};

export function fileSha256(file: string): string | null {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The policy view when the source project's policy is autonomous; undefined otherwise (interactive). */
export function readFootagePolicy(
  projectDir: string,
  rootDir: string,
  files: { goals: string; proposals?: string | null; series?: string | null },
): FootagePolicyView | undefined {
  let policy;
  try {
    policy = currentPolicy(projectDir);
  } catch {
    return undefined;
  }
  if (!isAutonomous(policy)) return undefined;
  const entries = readDecisions(projectDir);
  const revoked = revokedDecisionIds(entries);
  const standingOrRevoked = entries.flatMap((entry) => (entry.kind === "revoked" ? [] : [entry]));
  const gone = standingOrRevoked.filter((entry) => revoked.has(entry.id));
  const seriesSha = files.series ? fileSha256(path.resolve(rootDir, files.series)) : null;
  const seriesKey = files.series ? path.relative(rootDir, path.resolve(rootDir, files.series)) : null;
  return {
    revision: policy.revision,
    grantedBy: policy.grantedBy.answer,
    preAnswers: policy.preAnswers,
    autoPassShorts: policy.autoPass.includes("shorts"),
    revokedCaptionStyles: gone
      .filter((entry) => entry.step === FOOTAGE_CAPTIONS_STEP && entry.evidence.captionStyle)
      .map((entry) => ({ style: entry.evidence.captionStyle!, decision: entry.id })),
    revokedProposals: gone
      .filter((entry) => entry.step === FOOTAGE_SHORTS_STEP)
      .flatMap((entry) =>
        Object.entries(entry.artefactHashes)
          .filter(([file]) => file.endsWith("proposals.json"))
          .map(([, sha256]) => ({ sha256, decision: entry.id })),
      ),
    goalsSha256: fileSha256(path.resolve(rootDir, files.goals)),
    proposalsSha256: files.proposals ? fileSha256(path.resolve(rootDir, files.proposals)) : null,
    seriesRevokedBy:
      (seriesSha &&
        seriesKey &&
        gone.find((entry) => entry.step === FOOTAGE_SHORTS_STEP && entry.artefactHashes[seriesKey] === seriesSha)
          ?.id) ||
      null,
  };
}

const ignored = (what: string, why: string) => `The policy's ${what} pre-answer was ignored: ${why} Ask the user.`;

/** The caption style the policy chooses for the user, or why it does not (a warning), or nothing to say. */
export function captionStyleUnderPolicy(view: FootagePolicyView | undefined): { style?: string; warning?: string } {
  const style = view?.preAnswers.captionStyle;
  if (!view || style === undefined) return {};
  const problem = captionStyleProblem(style);
  if (problem) return { warning: ignored("captionStyle", problem) };
  const revoked = view.revokedCaptionStyles.find((item) => item.style === style);
  if (revoked)
    return {
      warning: ignored("captionStyle", `the user revoked the policy's ${style} captions (${revoked.decision}).`),
    };
  return { style };
}

/**
 * The clips the policy approves for the user: the top `shorts` ranked proposals, or with auto-pass `shorts` every
 * proposed clip. Only proposed clips carry a selection draft; when fewer are proposed than the pre-answer asks, or the
 * user revoked the policy's pick on these exact proposals, it says why and the user is asked.
 */
export function shortsUnderPolicy(
  view: FootagePolicyView | undefined,
  proposed: readonly string[],
): { ids?: string[]; basis?: "preAnswer" | "autoPass"; warning?: string } {
  if (!view) return {};
  const count = view.preAnswers.shorts;
  if (count === undefined && !view.autoPassShorts) return {};
  if (count !== undefined) {
    const problem = shortsCountProblem(count);
    if (problem) return { warning: ignored("shorts", problem) };
  }
  const revoked = view.revokedProposals.find((item) => item.sha256 === view.proposalsSha256);
  if (revoked)
    return {
      warning: ignored("shorts", `the user revoked the policy's pick on these proposals (${revoked.decision}).`),
    };
  const wanted = count ?? proposed.length;
  if (proposed.length < Math.max(wanted, 2))
    return {
      warning: ignored(
        count !== undefined ? "shorts" : "auto-pass shorts",
        `${proposed.length} clip(s) were proposed above the threshold, ${count !== undefined ? `the pre-answer approves ${count}` : "a series needs at least 2"}.`,
      ),
    };
  return { ids: proposed.slice(0, wanted), basis: count !== undefined ? "preAnswer" : "autoPass" };
}
