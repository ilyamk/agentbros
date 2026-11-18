import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { VisualReviewSchema } from "../../types/creative";
import { hashFile } from "../assets/registry";

/** Same shape as `Finding` in scripts/pipeline-check.ts, which cannot be imported without running that script. */
export type VisualReviewFinding = {
  severity: "error" | "warning" | "info";
  code: "VISUAL_REVIEW_MISSING" | "REVIEW_STALE";
  stage?: string;
  message: string;
  ref?: { file: string; jsonPath?: string };
};

/** SHA-256 of a rendered file, as recorded in a review's `renderSha256`. */
export const hashRenderFile = (file: string): string => hashFile(file);

/**
 * Compares the receipts in `<projectDir>/pipeline/reviews/*.json` with the current render.
 * A step is stale only when none of its receipts covers this render. Malformed receipts do not count.
 * Findings are errors while no receipt covers this render, warnings once one does.
 */
export function checkVisualReviews(projectDir: string, currentRenderSha256: string): VisualReviewFinding[] {
  const directory = path.join(projectDir, "pipeline", "reviews");
  const relative = (name: string) => path.join("pipeline", "reviews", name);
  const files = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort()
    : [];
  const receipts: Array<{ file: string; step: string; renderSha256: string }> = [];
  const malformed: string[] = [];
  for (const name of files) {
    try {
      const review = VisualReviewSchema.parse(JSON.parse(readFileSync(path.join(directory, name), "utf8")));
      receipts.push({ file: name, step: review.step, renderSha256: review.renderSha256 });
    } catch {
      malformed.push(name);
    }
  }
  const fresh = new Set(
    receipts.filter((receipt) => receipt.renderSha256 === currentRenderSha256).map((receipt) => receipt.step),
  );
  const severity = fresh.size ? "warning" : "error";
  const findings: VisualReviewFinding[] = malformed.map((name) => ({
    severity,
    code: "VISUAL_REVIEW_MISSING",
    stage: "qa",
    message: `Review receipt ${name} does not match VisualReviewSchema and does not count.`,
    ref: { file: relative(name) },
  }));
  if (!files.length)
    findings.push({
      severity: "error",
      code: "VISUAL_REVIEW_MISSING",
      stage: "qa",
      message: "No visual review receipt exists in pipeline/reviews/. Look at the render and record what was seen.",
      ref: { file: path.join("pipeline", "reviews") },
    });
  for (const receipt of receipts)
    if (!fresh.has(receipt.step))
      findings.push({
        severity,
        code: "REVIEW_STALE",
        stage: "qa",
        message: `Review "${receipt.step}" covers render ${receipt.renderSha256.slice(0, 12)}, not the current ${currentRenderSha256.slice(0, 12)}. Review the current render again.`,
        ref: { file: relative(receipt.file), jsonPath: "renderSha256" },
      });
  return findings;
}
