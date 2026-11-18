import { botComment, entry, eachPr, eventData, integer, upsertComment, type GitHub, type Comment } from "./api";
import { plannedHistory, type History } from "./gh-pr-facts";
import { parsePrBlock } from "../../src/lib/contrib/pr-block";
import { computeTier } from "../../src/lib/contrib/tiers";
import type { TrustTier } from "../../src/types/contrib";
import type { Pull } from "./gh-pr-facts";
import { APPEAL_MARKER, AUTOCLOSE_MARKER, isClosureRule } from "../../src/lib/contrib/autoclose";

export type Action =
  | { type: "assign" | "unassign"; author: string }
  | { type: "label-add" | "label-remove"; label: string }
  | { type: "comment"; text: string }
  | { type: "reopen"; rule?: string }
  | { type: "refuse"; reason: string };
export type Claim = { number: number; author: string; claimedAt: string; linkedDraftPr: boolean };
export type CommandInput = {
  comment: string;
  author: string;
  authorTier: TrustTier;
  target: {
    number: number;
    kind: "issue" | "pr";
    state: "open" | "closed";
    author: string;
    appealed: boolean;
    closedByRule?: string;
  };
  claims: Claim[];
  now: Date;
};
export type Decide = (input: CommandInput) => Action[];
export type Active = (claims: Claim[], now: Date) => Claim[];
export async function plannedCommands(): Promise<{ decideCommentCommand: Decide; activeClaims: Active }> {
  const modulePath = "../../src/lib/contrib/commands.ts";
  const module = (await import(modulePath)) as { decideCommentCommand?: Decide; activeClaims?: Active };
  if (!module.decideCommentCommand || !module.activeClaims)
    throw new Error(
      "Pending contrib-tools integration: commands.ts must export decideCommentCommand and activeClaims; see docs/github.md",
    );
  return { decideCommentCommand: module.decideCommentCommand, activeClaims: module.activeClaims };
}
export async function applyActions(api: GitHub, issue: number, actions: Action[]): Promise<void> {
  // Never execute a partial decision that contains a refusal.
  if (actions.some((action) => action.type === "refuse")) return;
  for (const action of actions) {
    if (action.type === "assign" || action.type === "unassign")
      await api.call(`/issues/${issue}/assignees`, action.type === "assign" ? "POST" : "DELETE", {
        assignees: [action.author],
      });
    else if (action.type === "label-add") await api.call(`/issues/${issue}/labels`, "POST", { labels: [action.label] });
    else if (action.type === "label-remove")
      await api.call(`/issues/${issue}/labels/${encodeURIComponent(action.label)}`, "DELETE");
    else if (action.type === "reopen") {
      await api.call(`/issues/${issue}/labels`, "POST", { labels: ["appealed", "needs-human"] });
      // The rule id sits on the fixed first line, before any user text, so autoclose exempts only that rule (never rule 5).
      if (action.rule)
        await upsertComment(
          api,
          issue,
          APPEAL_MARKER,
          `Appealed rule ${action.rule}: it no longer closes this PR; the other rules still apply.`,
        );
      await api.call(`/pulls/${issue}`, "PATCH", { state: "open" });
    } else if (action.type === "comment") await upsertComment(api, issue, "<!-- agentbros:command -->", action.text);
  }
}
export function linksIssue(body: string, issue: number, repo: string): boolean {
  try {
    if (parsePrBlock(body).issue === issue) return true;
  } catch {
    /* An explicit issue reference still links the draft. */
  }
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)#${issue}(?!\\d)|https://github\\.com/${escaped}/issues/${issue}(?!\\d)`).test(body);
}
export async function getClaims(api: GitHub, all?: Pull[]): Promise<Claim[]> {
  const issues = await api.pages<{ number: number; assignees: { login: string }[] }>(
    "/issues?state=open&labels=claimed",
  );
  const pulls = all ? all.filter((pr) => pr.state === "open") : await api.pages<Pull>("/pulls?state=open");
  const claims: Claim[] = [];
  await eachPr(
    api,
    issues.map((issue) => issue.number),
    async (number) => {
      const issue = issues.find((issue) => issue.number === number)!;
      const events = await api.pages<{ event: string; created_at: string; label?: { name: string } }>(
        `/issues/${issue.number}/events`,
      );
      const claimedAt = events
        .filter((event) => event.event === "labeled" && event.label?.name === "claimed")
        .at(-1)?.created_at;
      if (!claimedAt) return;
      for (const assignee of issue.assignees)
        claims.push({
          number: issue.number,
          author: assignee.login,
          claimedAt,
          linkedDraftPr: pulls.some(
            (pr) => pr.draft && pr.user.login === assignee.login && linksIssue(pr.body ?? "", issue.number, api.repo),
          ),
        });
    },
  );
  return claims;
}
/**
 * The rule that closed a PR, only when the automation closed it: the last close event is by the bot and the bot's
 * autoclose comment names the rule. Labels are not required, so closures labelled before closed:process existed stay appealable.
 */
export async function botClosureRule(api: GitHub, number: number): Promise<string | undefined> {
  const events = await api.pages<{ event: string; actor: { login: string } | null }>(`/issues/${number}/events`);
  if (events.filter((event) => event.event === "closed").at(-1)?.actor?.login !== "github-actions[bot]")
    return undefined;
  const comments = await api.pages<Comment>(`/issues/${number}/comments`);
  const record = comments.find((comment) => botComment(comment) && comment.body.startsWith(`${AUTOCLOSE_MARKER}\n`));
  const rule = /^Rule (\d+):/.exec(record?.body.slice(AUTOCLOSE_MARKER.length + 1) ?? "")?.[1];
  return rule !== undefined && isClosureRule(rule) ? rule : undefined;
}
export async function handleCommand(
  api: GitHub,
  event: Record<string, unknown>,
  decide: Decide,
  history: History | typeof plannedHistory = plannedHistory,
  now = new Date(),
) {
  if (event.action !== "created") return { ignored: true };
  const payload = event as {
    issue: { number: number };
    comment: { id: number };
    sender: { login: string };
    repository?: { default_branch?: string };
  };
  const comment = await api.call<Comment>(`/issues/comments/${integer(payload.comment.id)}`);
  if (
    comment.user.login !== payload.sender.login ||
    !/^\/(?:claim|unclaim|appeal|bench-lite)(?:\s|$)/.test(comment.body)
  )
    return { ignored: true };
  const number = integer(payload.issue.number);
  const issue = await api.call<{
    state: string;
    user: { login: string };
    pull_request?: unknown;
    labels: { name: string }[];
  }>(`/issues/${number}`);
  const all = await api.pages<Pull>("/pulls?state=all");
  const pulls = all.filter((pr) => pr.user.login.toLowerCase() === comment.user.login.toLowerCase());
  // Trust overrides (including maintainer tier 3 for /unclaim) are read from the default branch, never a contributor ref.
  const branch = payload.repository?.default_branch ?? (await api.call<{ default_branch: string }>("")).default_branch;
  const trust = await api.content(".github/trust.json", branch);
  const tier = computeTier(
    await history(pulls, trust ? JSON.parse(trust.text) : { version: 1, overrides: [] }, comment.user.login, now),
  );
  const labels = issue.labels.map((label) => label.name);
  const closedByRule =
    issue.pull_request && issue.state !== "open" && /^\/appeal\s/.test(comment.body)
      ? await botClosureRule(api, number)
      : undefined;
  const actions = decide({
    comment: comment.body,
    author: comment.user.login,
    authorTier: tier,
    target: {
      number,
      kind: issue.pull_request ? "pr" : "issue",
      state: issue.state === "open" ? "open" : "closed",
      author: issue.user.login,
      appealed: labels.includes("appealed"),
      ...(closedByRule === undefined ? {} : { closedByRule }),
    },
    claims: await getClaims(api, all),
    now,
  });
  await applyActions(api, number, actions);
  const refused = actions.find((action) => action.type === "refuse");
  if (refused?.type === "refuse") await upsertComment(api, number, "<!-- agentbros:command -->", refused.reason);
  return { actions };
}
entry(import.meta.url, async (api, args) =>
  handleCommand(api, eventData(args), (await plannedCommands()).decideCommentCommand),
);
