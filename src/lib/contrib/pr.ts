import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrBlockSchema, type PrBlock } from "../../types/contrib";
import { ContributionEvidenceSchema, type ContributionEvidence } from "../../types/contrib-tools";
import { parseChangeEntry } from "./changes";
import { changedFiles, contributionBase } from "./git";
import { sizeClass } from "./intake";
import { commitOf } from "../context/repository";
import { parsePrBlock } from "./pr-block";
import { uncommittedCode } from "./git";

export function prMarkdown(
  block: PrBlock,
  what: string,
  why: string,
  risks: string,
  evidence?: ContributionEvidence,
): string {
  const scalar = (value: string | number) =>
    typeof value === "number"
      ? String(value)
      : !value.includes('"') && !/[\r\n]/.test(value)
        ? `"${value}"`
        : !value.includes("'") && !/[\r\n]/.test(value)
          ? `'${value}'`
          : (() => {
              throw new Error("PR fields cannot contain newlines or both quote styles");
            })();
  const fields = Object.entries(PrBlockSchema.parse(block))
    .map(([key, value]) => `${key}: ${scalar(value)}`)
    .join("\n");
  const opening = `<!-- agentbros:pr\n${fields}\n-->`;
  parsePrBlock(opening);
  const verification =
    evidence?.gates
      .map(
        (gate) =>
          `- ${gate.exitCode === 0 ? "PASS" : "FAIL"}: ${gate.command.join(" ")} (exit ${gate.exitCode}, ${gate.durationMs} ms) — ${gate.summary.replace(/[\r\n]/g, " ")}`,
      )
      .join("\n") || "No local gate evidence recorded.";
  const notVerified = [
    ...(evidence?.notVerified ?? []),
    ...(evidence?.gates.filter((gate) => gate.exitCode !== 0).map((gate) => `${gate.name} did not pass`) ?? []),
  ];
  return `${opening}\n\n## What\n\n${what.trim()}\n\n## Why\n\n${why.trim()}\n\n## Evidence\n\n${verification}\n\n## Not verified\n\n${notVerified.length ? notVerified.map((item) => `- ${item}`).join("\n") : evidence ? "Human creative review and live provider behaviour were not verified by these local gates." : "Local gates have not been run."}\n\n## Risks\n\n${risks.trim()}\n`;
}
export function draftContributionPr(options: {
  root: string;
  base?: string;
  category?: string;
  size?: string;
  issue?: number;
  autonomy?: string;
  harness?: string;
  model: string;
  owner: string;
  what?: string;
  why?: string;
  risks?: string;
}): string {
  const base = contributionBase(options.root, options.base);
  const files = changedFiles(options.root, base);
  const entries = files.filter(
    (file) => file.status === "A" && file.path !== ".changes/README.md" && /^\.changes\/[^/]+\.md$/.test(file.path),
  );
  if (entries.length !== 1) throw new Error("Exactly one added .changes entry is required to draft a PR.");
  const file = entries[0]!,
    entry = parseChangeEntry(file.content ?? "", file.path);
  if (options.category && options.category !== entry.category)
    throw new Error("Category flag disagrees with the change entry.");
  const block = PrBlockSchema.parse({
    category: entry.category,
    size: options.size ?? sizeClass(files.reduce((sum, item) => sum + item.additions + item.deletions, 0)),
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    autonomy: options.autonomy ?? "assisted",
    harness: options.harness ?? entry.harness ?? "other",
    model: options.model,
    owner: options.owner,
    change: file.path,
  });
  const evidenceFile = path.join(options.root, ".contrib/evidence.json");
  let evidence = existsSync(evidenceFile)
    ? ContributionEvidenceSchema.parse(JSON.parse(readFileSync(evidenceFile, "utf8")))
    : undefined;
  if (evidence && (evidence.base !== base || evidence.head !== commitOf(options.root, "HEAD")))
    evidence = {
      ...evidence,
      gates: [],
      notVerified: ["Recorded evidence is stale: base or HEAD differs. Rerun contrib:check."],
    };
  if (evidence && (evidence.dirtyPaths?.length || uncommittedCode(options.root).length))
    evidence = {
      ...evidence,
      gates: [],
      notVerified: [
        ...evidence.notVerified,
        "Uncommitted changes: gate results do not verify committed HEAD. Commit the changes and rerun contrib:check.",
      ],
    };
  return prMarkdown(
    block,
    options.what ?? entry.body,
    options.why ?? "Explain the concrete problem and why this change solves it.",
    options.risks ?? "Describe remaining risks and limitations before submitting.",
    evidence,
  );
}
