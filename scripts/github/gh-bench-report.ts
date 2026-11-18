import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "../../src/lib/cli";
import { runOffline } from "../../src/lib/contrib/cli";
import { BenchSubmissionReportSchema, BenchVerificationResultSchema } from "../../src/types/bench";
import { submissionFields } from "../bench-fetch-bundle";
import { GitHub, plainText, syncLabels, upsertComment } from "./api";

function json(file: string): unknown {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
    throw new Error("Expected bounded JSON report data");
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}
export function prepareBenchReport(event: unknown, result: unknown, fetchSucceeded: boolean) {
  const data = event as { issue: { number: number; user: { login: string }; body: string } };
  let cells = "Unavailable: invalid submission fields";
  try {
    cells = submissionFields(data.issue.body).cells;
  } catch {
    /* The report still records failed intake. */
  }
  const envelope = result as { ok?: boolean; metadata?: unknown } | null;
  const parsed = BenchVerificationResultSchema.safeParse(envelope?.ok === true ? envelope.metadata : undefined);
  const accepted = fetchSucceeded && parsed.success && parsed.data.signer === data.issue.user.login;
  return BenchSubmissionReportSchema.parse({
    version: 1,
    issue: data.issue.number,
    author: data.issue.user.login,
    cells,
    result: accepted
      ? { verified: true, verification: parsed.data }
      : {
          verified: false,
          message:
            "Bundle acquisition or signature/deterministic verification failed. Check the unprivileged workflow log.",
        },
  });
}
export async function publishBenchReport(api: GitHub, raw: unknown, expectedIssue: number, expectedAuthor: string) {
  const report = BenchSubmissionReportSchema.parse(raw);
  if (report.issue !== expectedIssue || report.author !== expectedAuthor)
    throw new Error("Report does not match the triggering issue");
  const issue = await api.call<{ user: { login: string }; labels: { name: string }[] }>(`/issues/${report.issue}`);
  if (issue.user.login !== report.author || !issue.labels.some((label) => label.name === "bench:submitted"))
    throw new Error("Issue identity or submission label changed");
  const accepted = report.result.verified;
  const summary = accepted
    ? `${report.result.verification.label === "community-export" ? "Signature and file integrity verification passed; measurements remain claims" : "Signature and deterministic verification passed"} (${report.result.verification.label}).\n\n${report.result.verification.limitations.map((line) => `- ${line}`).join("\n")}`
    : report.result.message;
  // Untrusted prose is data: suppress mentions and Markdown links/formatting.
  const plain = plainText(summary);
  await upsertComment(
    api,
    report.issue,
    "<!-- agentbros:bench-verification -->",
    `Benchmark verification: ${accepted ? "passed" : "rejected"}.\n\n${plain}`,
  );
  const label = accepted ? "bench:verified" : "bench:rejected";
  await syncLabels(
    api,
    report.issue,
    issue.labels.map((item) => item.name),
    [label],
    (name) => ["bench:verified", "bench:rejected"].includes(name),
  );
  return { issue: report.issue, label };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runOffline(async () => {
    const args = parseArgs([
      { name: "event", description: "Trigger event JSON (default GITHUB_EVENT_PATH)" },
      { name: "result", description: "Unprivileged bench:verify JSON envelope" },
      { name: "fetch-succeeded", type: "boolean", description: "Bundle download and extraction succeeded" },
      { name: "out", description: "Prepare a schema-validated report file" },
      { name: "artefact", description: "Publish a prepared JSON report" },
    ] as const);
    const event = json(args.event ?? process.env.GITHUB_EVENT_PATH ?? "") as {
      issue: { number: number; user: { login: string } };
    };
    if (args.out) {
      let result: unknown = null;
      try {
        result = args.result ? json(args.result) : null;
      } catch {
        /* A missing or malformed verifier result is a rejection. */
      }
      const report = prepareBenchReport(event, result, Boolean(args["fetch-succeeded"]));
      writeFileSync(args.out, JSON.stringify(report) + "\n", { flag: "wx" });
      return { outputs: [args.out], metadata: { verified: report.result.verified } };
    }
    if (!args.artefact) throw new Error("Supply --out or --artefact");
    const api = new GitHub(process.env.GITHUB_REPOSITORY ?? "", process.env.GH_TOKEN ?? "");
    return { metadata: await publishBenchReport(api, json(args.artefact), event.issue.number, event.issue.user.login) };
  });
