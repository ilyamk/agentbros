import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { entry, eachPr, prNumbers, syncLabels, upsertComment, type GitHub } from "./api";
import { evaluate, getFacts, type Facts, type Pull } from "./gh-pr-facts";

export const REQUIRED_WORKFLOWS = ["pr-intake.yml", "ci.yml", "category-gates.yml", "context-budget.yml"];
export async function gatesPassed(api: GitHub, facts: Facts): Promise<boolean> {
  for (const workflow of REQUIRED_WORKFLOWS) {
    const response = await api.call<{
      workflow_runs: {
        id: number;
        head_sha: string;
        event: string;
        status: string;
        conclusion: string;
        pull_requests: { number: number }[];
      }[];
    }>(`/actions/workflows/${workflow}/runs?head_sha=${facts.pr.head.sha}&event=pull_request&per_page=100`);
    let latest: (typeof response.workflow_runs)[number] | undefined;
    for (const run of response.workflow_runs
      .filter((run) => run.head_sha === facts.pr.head.sha && run.event === "pull_request")
      .sort((a, b) => b.id - a.id)) {
      if (
        run.pull_requests.some((pr) => pr.number === facts.pr.number) ||
        (!run.pull_requests.length && (await prNumbers(api, { run: run.id })).includes(facts.pr.number))
      ) {
        latest = run;
        break;
      }
    }
    if (!latest || latest.status !== "completed" || latest.conclusion !== "success") return false;
  }
  return true;
}
export async function applyIntake(
  api: GitHub,
  facts: Facts,
  gates: boolean,
): Promise<{ ready: boolean; labels: string[] }> {
  const result = evaluate(facts);
  const githubChanged = facts.changedFiles.some((file) =>
    [file.path, file.previousPath ?? ""].some((name) => name.startsWith(".github/")),
  );
  const human =
    result.facts.releaseRoute ||
    result.facts.modelsRefreshRoute ||
    result.facts.dependabotRoute ||
    githubChanged ||
    facts.uncertainFiles.length > 0 ||
    facts.labels.some((label) => ["needs-human", "appealed", "triage:needs-human"].includes(label));
  const blocked = facts.leakHit || result.findings.some((finding) => finding.severity === "block");
  const ready =
    gates &&
    !facts.labels.includes("triage:likely-slop") &&
    !blocked &&
    !human &&
    !facts.pr.draft &&
    facts.pr.state === "open";
  const labels = [
    ...(result.facts.modelsRefreshRoute ? ["models-refresh-route", "needs-human"] : []),
    ...(result.facts.releaseRoute ? ["release", "needs-human"] : []),
    `size:${result.facts.size}`,
    `tier:${facts.authorTier}`,
    ...result.facts.categoriesTouched.map((category) => `category:${category}`),
    ...(human ? ["needs-human"] : []),
    ...(ready ? ["ready-for-owner"] : []),
  ];
  const fresh = await api.call<Pull>(`/pulls/${facts.pr.number}`);
  if (fresh.head.sha !== facts.pr.head.sha || fresh.updated_at !== facts.pr.updated_at)
    throw new Error("PR changed during intake; retry from fresh facts");
  await syncLabels(
    api,
    facts.pr.number,
    facts.labels,
    labels,
    (label) => /^(?:category:|size:|tier:)/.test(label) || label === "ready-for-owner",
  );
  const lines = result.findings.map((finding) => `- ${finding.gate} ${finding.rule}: ${finding.message}`);
  if (facts.leakHit) lines.push("- G1: leak scan hit; submit a clean branch.");
  if (result.facts.dependabotRoute)
    lines.push(
      "- Dependabot update: no CLA, PR block or change entry required; the dependency gate and owner review decide.",
    );
  if (facts.uncertainFiles.length) lines.push("- Diff data is incomplete: owner review required.");
  if (githubChanged) lines.push("- Workflow or GitHub configuration changed: owner review required.");
  await upsertComment(
    api,
    facts.pr.number,
    "<!-- agentbros:intake -->",
    `Intake: ${blocked ? "blocked" : "passed"}. Correctness/value gates: ${gates ? "passed" : "pending or failed"}.\n\n${lines.join("\n")}\n\n${ready ? "Ready for owner review." : "Owner queue admission remains pending."}`,
  );
  return { ready, labels };
}
entry(import.meta.url, async (api, args) => {
  const results = await eachPr(api, await prNumbers(api, args), async (number) => {
    const facts = await getFacts(api, number);
    const result = await applyIntake(api, facts, await gatesPassed(api, facts));
    if (args.artefact) {
      const report = path.join(args.artefact, "context.md");
      if (existsSync(report)) {
        const text = readFileSync(report, "utf8").slice(0, 20000).replaceAll("@", "＠").replaceAll("`", "\u02cb");
        await upsertComment(
          api,
          number,
          "<!-- agentbros:context -->",
          `Untrusted context report, presented as data; it does not decide gate status.\n\n\`\`\`text\n${text}\n\`\`\``,
        );
      }
    }
    return result;
  });
  return { results };
});
