import { APPEAL_MARKER, AUTOCLOSE_MARKER, autoclose, type PrSnapshot } from "../../src/lib/contrib/autoclose";
import { entry, eachPr, botComment, prNumbers, upsertComment, type Comment, type GitHub } from "./api";
import { allPulls, getFacts, evaluate, plannedHistory, type Facts, type Pull } from "./gh-pr-facts";
import { applyActions, getClaims, plannedCommands } from "./gh-commands";

export async function closePr(api: GitHub, facts: Facts, now = new Date(), peers: Facts[] = []) {
  const routes = evaluate(facts).facts;
  if (routes.modelsRefreshRoute)
    return { close: false, rule: "models-refresh-route", message: "Trusted model refresh PR requires human review." };
  if (routes.releaseRoute)
    return { close: false, rule: "release-route", message: "Trusted release PR requires human review." };
  if (routes.dependabotRoute)
    return { close: false, rule: "dependabot-route", message: "Dependabot update requires human review." };
  if (facts.authorTier === 3)
    return { close: false, rule: null, message: "Maintainer PR: no deterministic closing rule applies." };
  // An appealed PR also carries needs-human; it stays exempt only from the appealed rule (never rule 5), below.
  const appealed = facts.labels.includes("appealed");
  if (facts.pr.state !== "open" || (facts.labels.includes("needs-human") && !appealed) || facts.uncertainFiles.length)
    return { close: false, rule: null, message: "Human review is pending." };
  const comments = await api.pages<Comment>(`/issues/${facts.pr.number}/comments`);
  const appealRecord = comments.find((comment) => botComment(comment) && comment.body.startsWith(`${APPEAL_MARKER}\n`));
  const appealedRule = appealed
    ? (/^Appealed rule (\d+)\b/.exec(appealRecord?.body.slice(APPEAL_MARKER.length + 1) ?? "")?.[1] ?? "unknown")
    : undefined;
  const reminderAt = (rule: string) =>
    comments.find((comment) => botComment(comment) && comment.body.startsWith(`<!-- agentbros:reminder:${rule} -->`))
      ?.created_at;
  const result = evaluate(facts);
  const hasRule = (rule: string) => result.findings.some((finding) => finding.rule === rule);
  const added = (value: Facts) =>
    value.rawFiles.flatMap((file) => (file.patch ?? "").split("\n").filter((line) => line.startsWith("+"))).sort();
  const lines = added(facts);
  const paths = facts.changedFiles
    .map((file) => file.path)
    .sort()
    .join("\n");
  const duplicate = peers.some(
    (peer) =>
      peer.pr.number < facts.pr.number &&
      peer.pr.state === "open" &&
      paths ===
        peer.changedFiles
          .map((file) => file.path)
          .sort()
          .join("\n") &&
      (() => {
        const other = added(peer);
        const remaining = [...other];
        let matches = 0;
        for (const line of lines) {
          const index = remaining.indexOf(line);
          if (index >= 0) {
            matches++;
            remaining.splice(index, 1);
          }
        }
        return lines.length > 0 && matches / Math.max(lines.length, other.length) >= 0.9;
      })(),
  );
  const state: PrSnapshot = {
    cla: facts.cla,
    claReminderAt: reminderAt("1"),
    protectedReminderAt: reminderAt("4"),
    structureReminderAt: reminderAt("6"),
    authorTier: facts.authorTier,
    openPrCount: facts.openPrCount,
    newestPr: facts.newestPr,
    duplicate: { open: duplicate, sameChangedFiles: duplicate, identicalAddedLines: duplicate ? 1 : 0 },
    protectedPaths: result.facts.protectedPathsTouched,
    labels: facts.labels,
    mediaBinary: hasRule("media-binary"),
    leakHit: facts.leakHit,
    hasPrBlock: !hasRule("pr-block"),
    hasChangeEntry: !hasRule("change-entry") && !hasRule("change-entry-reference"),
    size: result.facts.size,
    approvedProposal: facts.labels.includes("design-approved"),
    ...(appealedRule === undefined ? {} : { appealedRule }),
  };
  const decision = autoclose(state, now);
  const fresh = await api.call<Pull>(`/pulls/${facts.pr.number}`);
  if (fresh.head.sha !== facts.pr.head.sha || fresh.updated_at !== facts.pr.updated_at)
    throw new Error("PR changed during autoclose; retry from fresh facts");
  if (decision.reminder)
    await upsertComment(api, facts.pr.number, `<!-- agentbros:reminder:${decision.rule} -->`, decision.message);
  if (decision.close) {
    await upsertComment(api, facts.pr.number, AUTOCLOSE_MARKER, `Rule ${decision.rule}: ${decision.message}`);
    // closed:process (rules 1, 2, 4, 6, 7) never affects tier; closed:slop (rules 3, 5) does (src/lib/contrib/history.ts).
    if (decision.label) await api.call(`/issues/${facts.pr.number}/labels`, "POST", { labels: [decision.label] });
    await api.call(`/pulls/${facts.pr.number}`, "PATCH", { state: "closed" });
  }
  return decision;
}
export type Gather = (
  api: GitHub,
  number: number,
  history?: typeof plannedHistory,
  now?: Date,
  pulls?: Pull[],
) => Promise<Facts>;
/** `all` is every repository PR, fetched once per run, so per-PR author history costs no extra API pages. */
export async function maintainPrs(
  api: GitHub,
  pulls: Pull[],
  now = new Date(),
  gather: Gather = getFacts,
  close = closePr,
  all?: Pull[],
) {
  const facts: Facts[] = [];
  const gathered = await eachPr(
    api,
    pulls.map((pr) => pr.number),
    async (number) => {
      facts.push(await gather(api, number, plannedHistory, now, all));
      return { pr: number, gathered: true };
    },
  );
  const decisions = await eachPr(
    api,
    facts.map((fact) => fact.pr.number),
    async (number) => ({
      pr: number,
      ...(await close(
        api,
        facts.find((fact) => fact.pr.number === number)!,
        now,
        facts,
      )),
    }),
  );
  return [...gathered.filter((item) => "skipped" in item), ...decisions];
}
entry(import.meta.url, async (api, args) => {
  const all = await allPulls(api);
  if (args.run) {
    // workflow_run trigger: only the triggering PR. Duplicates (rule 3) and claim expiry wait for the hourly sweep.
    const numbers = await prNumbers(api, { run: args.run });
    const decisions = await maintainPrs(
      api,
      all.filter((pr) => pr.state === "open" && numbers.includes(pr.number)),
      new Date(),
      getFacts,
      closePr,
      all,
    );
    return { decisions, scope: "run" };
  }
  const decisions = await maintainPrs(
    api,
    all.filter((pr) => pr.state === "open"),
    new Date(),
    getFacts,
    closePr,
    all,
  );
  const { activeClaims } = await plannedCommands();
  const claims = await getClaims(api, all);
  const active = activeClaims(claims, new Date());
  const expired = claims.filter(
    (claim) => !active.some((item) => item.number === claim.number && item.author === claim.author),
  );
  const claimResults = await eachPr(api, [...new Set(expired.map((claim) => claim.number))], async (number) => {
    for (const claim of expired.filter((claim) => claim.number === number))
      await applyActions(api, number, [
        { type: "unassign", author: claim.author },
        { type: "label-remove", label: "claimed" },
      ]);
    return { pr: number, expired: true };
  });
  return { decisions, expired, claimResults };
});
