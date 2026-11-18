import { readFileSync } from "node:fs";
import { entry, eachPr, plainText, prNumbers, syncLabels, upsertComment, type GitHub } from "./api";
import { getFacts, type Facts } from "./gh-pr-facts";

const allowed = ["triage:promising", "triage:needs-work", "triage:likely-slop", "triage:needs-human"];
export async function applyTriage(api: GitHub, facts: Facts, data: unknown) {
  const report = data as {
    ok?: unknown;
    metadata?: { labels?: unknown; comment?: unknown; skipped?: unknown; headSha?: unknown };
  };
  if (report.ok === true && typeof report.metadata?.skipped === "string") return { skipped: report.metadata.skipped };
  if (report.metadata?.headSha !== undefined && report.metadata.headSha !== facts.pr.head.sha)
    return { skipped: "PR head changed after triage" };
  const labels = report.ok === false ? ["triage:needs-human"] : report.metadata?.labels;
  const comment =
    report.ok === false
      ? "Triage could not run within the configured budget or provider limits. Human review is required."
      : report.metadata?.comment;
  if (
    typeof report.ok !== "boolean" ||
    !Array.isArray(labels) ||
    labels.length !== 1 ||
    !labels.every((label) => typeof label === "string" && allowed.includes(label)) ||
    typeof comment !== "string" ||
    comment.length > 30000
  )
    throw new Error("Invalid triage result; no GitHub changes applied");
  await syncLabels(
    api,
    facts.pr.number,
    facts.labels,
    labels as string[],
    (label) => label.startsWith("triage:") || (label === "ready-for-owner" && labels.includes("triage:likely-slop")),
  );
  // Model output is untrusted prose: no mentions, links, images, HTML or code spans reach the comment.
  await upsertComment(
    api,
    facts.pr.number,
    "<!-- agentbros:triage -->",
    `Advisory triage (model output, shown as plain text):\n\n${plainText(comment.replace(/^<!-- agentbros:triage -->\s*/, ""))}`,
  );
  return { labels };
}
entry(import.meta.url, async (api, args) => {
  if (!args.artefact) throw new Error("--artefact must name the trusted triage script's JSON result");
  const data: unknown = JSON.parse(readFileSync(args.artefact, "utf8"));
  const report = data as { ok?: unknown; metadata?: { skipped?: unknown } };
  if (report.ok === true && typeof report.metadata?.skipped === "string") return { skipped: report.metadata.skipped };
  const results = await eachPr(api, await prNumbers(api, args), async (number) =>
    applyTriage(api, await getFacts(api, number), data),
  );
  return { results };
});
