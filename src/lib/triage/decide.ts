import { z } from "zod";
import { JudgementSchema } from "../../types/triage";
import type { JudgeResult } from "./vendors";
import { injectionInOutput, markdownText } from "./prompt";

export function validatedJudgement<T extends { canary: string }>(
  result: JudgeResult,
  schema: z.ZodType<T>,
  canary: string,
): { value: T } | { error: string } {
  if (result.abstain !== undefined) return { error: result.abstain };
  const parsed = schema.safeParse(result.json);
  if (!parsed.success) return { error: "Judge output failed schema validation." };
  if (parsed.data.canary !== canary) return { error: "Judge canary did not match." };
  if (injectionInOutput(parsed.data)) return { error: "Injection markers detected in judge output." };
  return { value: parsed.data };
}

export function decide(
  results: [JudgeResult] | [JudgeResult, JudgeResult],
  canary: string,
  labels: string[],
): { labels: string[]; comment: string } {
  const judgements = results.map((result) => validatedJudgement(result, JudgementSchema, canary));
  const first = judgements[0]!;
  const second = judgements[1]!;
  const verdict =
    "value" in first &&
    (judgements.length === 1 || (second && "value" in second && first.value.verdict === second.value.verdict))
      ? first.value.verdict
      : "needs-human";
  return {
    labels: [`triage:${verdict}`],
    comment: [
      "<!-- agentbros:triage -->",
      `Independent triage: **${verdict}**. Advisory labels only; a maintainer decides what happens next.`,
      ...(results.length === 1 ? ["Single local judge; no independent agreement check."] : []),
      ...judgements.map((judgement, index) => {
        const vendor = markdownText(labels[index] ?? `Judge ${index + 1}`);
        if ("error" in judgement) return `\n${vendor}: ${markdownText(judgement.error)}`;
        const reasons = judgement.value.reasons
          .slice(0, 5)
          .map((reason) => `${markdownText(reason.file.slice(0, 200))}: ${markdownText(reason.reason.slice(0, 600))}`);
        if (judgement.value.reasons.length > 5) reasons.push("Further reasons omitted from this comment.");
        return `\n${vendor}: ${[judgement.value.verdict, ...reasons].join("; ")}`;
      }),
      "",
      "This review does not merge, approve or close the pull request.",
    ].join("\n"),
  };
}
