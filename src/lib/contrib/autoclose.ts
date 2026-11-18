import { TIER_LIMITS, type Size, type TrustTier } from "../../types/contrib";
import { PROCESS_CLOSURE_LABEL, SLOP_CLOSURE_LABEL } from "./history";

export type PrSnapshot = {
  cla: boolean;
  claReminderAt?: string;
  structureReminderAt?: string;
  protectedReminderAt?: string;
  authorTier: TrustTier;
  openPrCount: number;
  newestPr: boolean;
  duplicate?: { sameChangedFiles: boolean; identicalAddedLines: number; open: boolean };
  protectedPaths: string[];
  labels: string[];
  mediaBinary: boolean;
  leakHit: boolean;
  hasPrBlock: boolean;
  hasChangeEntry: boolean;
  size: Size;
  approvedProposal: boolean;
  /** Rule a successful appeal reopened the PR from; `"unknown"` exempts every rule except 5. Absent when not appealed. */
  appealedRule?: string;
};
export type CloseDecision = {
  close: boolean;
  rule: string | null;
  message: string;
  reminder?: boolean;
  label?: (typeof CLOSURE_LABEL)[ClosureRule];
};
const WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Closure label per rule. Process closures (procedure not yet met) never affect trust tiers;
 * slop closures (duplicate, media or leak) do, inside the window in history.ts.
 */
export const CLOSURE_LABEL = {
  "1": PROCESS_CLOSURE_LABEL,
  "2": PROCESS_CLOSURE_LABEL,
  "3": SLOP_CLOSURE_LABEL,
  "4": PROCESS_CLOSURE_LABEL,
  "5": SLOP_CLOSURE_LABEL,
  "6": PROCESS_CLOSURE_LABEL,
  "7": PROCESS_CLOSURE_LABEL,
} as const;
export type ClosureRule = keyof typeof CLOSURE_LABEL;
export const isClosureRule = (rule: string): rule is ClosureRule => Object.hasOwn(CLOSURE_LABEL, rule);
/** Bot comment recording an accepted appeal; its first line after the marker is `Appealed rule N`. */
export const APPEAL_MARKER = "<!-- agentbros:appeal -->";
/** Bot comment recording an automatic closure; its first line after the marker is `Rule N: …`. */
export const AUTOCLOSE_MARKER = "<!-- agentbros:autoclose -->";
/** Rule 5 (media binary or leak) can never be exempted by an appeal. */
export const UNAPPEALABLE_RULE = "5";

export function autoclose(state: PrSnapshot, now: Date): CloseDecision {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid current timestamp");
  const elapsed = (timestamp?: string) => {
    if (!timestamp) return false;
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) throw new Error("Invalid reminder timestamp");
    return now.getTime() - time >= WEEK;
  };
  const close = (rule: ClosureRule, message: string): CloseDecision => ({
    close: true,
    rule,
    label: CLOSURE_LABEL[rule],
    message:
      rule === UNAPPEALABLE_RULE
        ? `${message} This rule cannot be appealed.`
        : `${message} Use /appeal <reason> to reopen once for human review.`,
  });
  // An appeal exempts only the rule that closed the PR; an unreadable appeal record exempts all but rule 5.
  const exempt = (rule: string) =>
    rule !== UNAPPEALABLE_RULE &&
    state.appealedRule !== undefined &&
    (state.appealedRule === "unknown" || state.appealedRule === rule);
  // Tier 3 is maintainer authority: deterministic slop rules never close a maintainer's PR.
  if (state.authorTier === 3)
    return { close: false, rule: null, message: "Maintainer PR: no deterministic closing rule applies." };
  const unsignedCla = !state.cla;
  const unapprovedProtected = state.protectedPaths.length > 0 && !state.labels.includes("design-approved");
  const missingStructure = !state.hasPrBlock || !state.hasChangeEntry;
  if (unsignedCla && elapsed(state.claReminderAt) && !exempt("1"))
    return close("1", "CLA unsigned seven days after the reminder.");
  const limit = TIER_LIMITS[state.authorTier].openPrs;
  if (limit !== null && state.openPrCount > limit && state.newestPr && !exempt("2"))
    return close("2", "The newest PR exceeds the owner's open-PR limit.");
  if (
    state.duplicate?.open &&
    state.duplicate.sameChangedFiles &&
    state.duplicate.identicalAddedLines >= 0.9 &&
    !exempt("3")
  )
    return close("3", "Duplicate of an open PR: same files and at least 90% identical added lines.");
  if (unapprovedProtected && elapsed(state.protectedReminderAt) && !exempt("4"))
    return close("4", "Protected paths still changed without design-approved seven days after the reminder.");
  if (state.mediaBinary || state.leakHit)
    return close("5", "Media binary or leak-scan hit: submit a clean branch so its history can be reviewed.");
  if (missingStructure && elapsed(state.structureReminderAt) && !exempt("6"))
    return close("6", "PR block or change entry still missing seven days after the reminder.");
  if (state.size === "L" && !state.approvedProposal && !exempt("7"))
    return close("7", "Size L requires an approved proposal.");
  // Each pending rule has its own reminder; post the first one not yet posted.
  const pending: CloseDecision[] = [
    ...(unsignedCla && !exempt("1")
      ? [
          {
            close: false,
            rule: "1",
            reminder: !state.claReminderAt,
            message: "Sign the CLA within seven days of the reminder.",
          },
        ]
      : []),
    ...(unapprovedProtected && !exempt("4")
      ? [
          {
            close: false,
            rule: "4",
            reminder: !state.protectedReminderAt,
            message:
              "Protected paths changed: obtain design-approved from a maintainer within seven days of this reminder, or remove those changes.",
          },
        ]
      : []),
    ...(missingStructure && !exempt("6")
      ? [
          {
            close: false,
            rule: "6",
            reminder: !state.structureReminderAt,
            message: "Add the PR block and change entry within seven days of the reminder.",
          },
        ]
      : []),
  ];
  return (
    pending.find((item) => item.reminder) ??
    pending[0] ?? { close: false, rule: null, message: "No deterministic closing rule applies." }
  );
}
