import { TIER_LIMITS, TrustTierSchema, type TrustTier } from "../../types/contrib";
import { UNAPPEALABLE_RULE, isClosureRule } from "./autoclose";

export type CommentCommand = { name: "claim" | "unclaim" | "bench-lite" } | { name: "appeal"; reason: string };
export type CommandAction =
  | { type: "assign" | "unassign"; author: string }
  | { type: "label-add" | "label-remove"; label: string }
  | { type: "comment"; text: string }
  | { type: "refuse"; reason: string }
  | { type: "reopen"; rule: string };
export interface Claim {
  author: string;
  number: number;
  claimedAt: string;
  linkedDraftPr: boolean;
}
export interface CommandContext {
  comment: string;
  author: string;
  authorTier: TrustTier;
  now: Date;
  /** `closedByRule`: the autoclose rule id, set only when the automation itself closed the PR (trusted caller facts). */
  target: {
    number: number;
    kind: "issue" | "pr";
    state: "open" | "closed";
    author: string;
    appealed?: boolean;
    closedByRule?: string;
  };
  claims: Claim[];
}
export function parseCommentCommand(comment: string): CommentCommand | null {
  const text = comment.trim();
  if (/^\/(?:claim|unclaim|bench-lite)$/.test(text))
    return { name: text.slice(1) as "claim" | "unclaim" | "bench-lite" };
  const appeal = /^\/appeal[ \t]+([^\r\n]+)$/.exec(text);
  return appeal?.[1]?.trim() ? { name: "appeal", reason: appeal[1].trim() } : null;
}
export function activeClaims(claims: Claim[], now: Date): Claim[] {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid current timestamp");
  return claims.filter((claim) => {
    const time = Date.parse(claim.claimedAt);
    if (!Number.isFinite(time)) throw new Error("Invalid claim timestamp");
    return claim.linkedDraftPr || now.getTime() - time < 7 * 86400000;
  });
}
export function decideCommentCommand(input: CommandContext): CommandAction[] {
  const command = parseCommentCommand(input.comment);
  if (!command) return [];
  const tier = TrustTierSchema.parse(input.authorTier);
  const claims = activeClaims(input.claims, input.now);
  const same = (author: string) => author.toLowerCase() === input.author.toLowerCase();
  const refuse = (reason: string): CommandAction[] => [{ type: "refuse", reason }];
  if (command.name === "appeal") {
    if (input.target.kind !== "pr" || input.target.state !== "closed") return refuse("Appeals require a closed PR.");
    if (!same(input.target.author)) return refuse("Only the PR author may appeal.");
    if (input.target.appealed) return refuse("Only one appeal is allowed per closure.");
    const rule = input.target.closedByRule;
    if (rule === undefined || !isClosureRule(rule))
      return refuse("Appeals apply only to a PR closed by an automatic rule; ask a maintainer about a manual closure.");
    if (rule === UNAPPEALABLE_RULE)
      return refuse("Rule 5 (media binary or leak) cannot be appealed: submit a clean branch in a new PR.");
    return [
      { type: "reopen", rule },
      { type: "label-add", label: "needs-human" },
      { type: "comment", text: `Appeal of rule ${rule} from @${input.author}: ${command.reason}` },
    ];
  }
  if (command.name === "bench-lite") {
    if (tier < 2 || input.target.kind !== "pr" || input.target.state !== "open")
      return refuse("Bench-lite requires tier 2 or above and an open PR.");
    return [{ type: "label-add", label: "bench-lite" }];
  }
  if (input.target.kind !== "issue" || input.target.state !== "open") return refuse("Claims require an open issue.");
  const current = claims.find((claim) => claim.number === input.target.number);
  if (command.name === "unclaim") {
    const owned = input.claims.find((claim) => claim.number === input.target.number);
    if (!owned || (!same(owned.author) && tier !== 3)) return refuse("Only the claimant or a maintainer may unclaim.");
    return [
      { type: "unassign", author: owned.author },
      { type: "label-remove", label: "claimed" },
    ];
  }
  if (current) return refuse(same(current.author) ? "You already hold this claim." : "This issue is already claimed.");
  const limit = TIER_LIMITS[tier].openPrs;
  if (limit !== null && claims.filter((claim) => same(claim.author)).length >= limit)
    return refuse(`Tier ${tier} allows ${limit} active claims.`);
  const expired = input.claims.find((claim) => claim.number === input.target.number);
  return [
    ...(expired ? [{ type: "unassign" as const, author: expired.author }] : []),
    { type: "assign", author: input.author },
    { type: "label-add", label: "claimed" },
    { type: "comment", text: `Claimed by @${input.author}. Expires after seven days without a linked draft PR.` },
  ];
}
