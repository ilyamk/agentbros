import { AuditJudgementSchema, type TriageConfig } from "../../types/triage";
import { measureBudget } from "../context/budget";
import { isInstruction, type RepositoryText } from "../context/repository";
import { validatedJudgement } from "./decide";
import { buildPrompt, markdownText, type JudgePrompt } from "./prompt";
import { createJudge, preflightJudges } from "./vendors";

export type InstructionSection = { file: string; heading: string; line: number; text: string; tasks: string[] };
export function splitSections(file: string, text: string): Omit<InstructionSection, "tasks">[] {
  const sections: Omit<InstructionSection, "tasks">[] = [];
  let section = { file, heading: "Preamble", line: 1, text: "" };
  let fence: string | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    }
    const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (section.text.trim()) sections.push(section);
      section = { file, heading: heading[2]!, line: index + 1, text: "" };
    }
    section.text += `${line}\n`;
  }
  if (section.text.trim()) sections.push(section);
  return sections;
}

export function auditPlan(repo: RepositoryText): {
  sections: InstructionSection[];
  prompts: JudgePrompt[];
  limitations: string[];
} {
  const budget = measureBudget(repo);
  const contexts = [
    ...budget.steps,
    ...budget.boot.map((row) => ({
      ...row,
      id: `boot/${row.id}`,
      files: row.files.filter((file) => file === "AGENTS.md"),
    })),
    ...budget.subagents.map((row) => ({ ...row, id: `subagent/${row.id}` })),
    budget.contributor,
  ];
  const sections = repo.files.filter(isInstruction).flatMap((file) =>
    splitSections(file, repo.read(file) ?? "").map((section) => ({
      ...section,
      tasks: contexts.filter((row) => row.files.includes(file)).map((row) => row.id),
    })),
  );
  const hierarchy = repo.files
    .filter(isInstruction)
    .map(
      (file) =>
        `${file}: ${splitSections(file, repo.read(file) ?? "")
          .map((section) => section.heading)
          .join("; ")}`,
    )
    .join("\n");
  const prompts = sections.map((section) =>
    buildPrompt(
      [
        `File: ${section.file}:${section.line}\nHeading: ${section.heading}`,
        `Tasks reading the file: ${section.tasks.join(", ") || "No mapped task (coverage incomplete)"}`,
        `Context-map limitations:\n${budget.limitations.join("\n")}`,
        `Instruction hierarchy (headings only; do not assert conflicts without text evidence):\n${hierarchy}`,
        `Other instruction levels (untrusted comparison material):\n${repo.files
          .filter(
            (file) =>
              file !== section.file &&
              (file === "AGENTS.md" ||
                (file.endsWith("/AGENTS.md") && section.file.startsWith(file.slice(0, -"AGENTS.md".length)))),
          )
          .map((file) => `${file}:\n${repo.read(file) ?? ""}`)
          .join("\n\n")}`,
        `Section text:\n${section.text}`,
      ].join("\n\n"),
      { audit: true },
    ),
  );
  return { sections, prompts, limitations: budget.limitations };
}

export async function runAudit(
  plan: ReturnType<typeof auditPlan>,
  options: { config: TriageConfig; ledger: string; runId: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch },
) {
  const reservedBoundUsd = preflightJudges(options.config, options.ledger, options.runId, plan.prompts, options.env);
  const judges = options.config.judges.map((slot) => createJudge(slot, { ...options, scope: "audit" }));
  const sections = [];
  let costUsd = 0;
  for (const [index, section] of plan.sections.entries()) {
    const prompt = plan.prompts[index]!;
    const results = [await judges[0]!.judge(prompt), await judges[1]!.judge(prompt)];
    costUsd += results.reduce((sum, result) => sum + result.costUsd, 0);
    sections.push({
      ...section,
      text: undefined,
      judgements: results.map((result, vendor) => ({
        label: options.config.judges[vendor]!.label,
        provider: options.config.judges[vendor]!.provider,
        model: options.config.judges[vendor]!.model,
        ...validatedJudgement(result, AuditJudgementSchema, prompt.canary),
      })),
    });
  }
  const findings = sections.flatMap((section) =>
    section.judgements.flatMap((judgement) =>
      "value" in judgement
        ? judgement.value.findings.map((finding) => ({
            ...finding,
            label: judgement.label,
            file: section.file,
            line: section.line,
            heading: section.heading,
          }))
        : [],
    ),
  );
  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const needsHuman = sections.some(
    (section) =>
      section.judgements.some((judgement) => "error" in judgement) ||
      JSON.stringify("value" in section.judgements[0]! ? section.judgements[0].value.findings : null) !==
        JSON.stringify("value" in section.judgements[1]! ? section.judgements[1].value.findings : null),
  );
  const report = {
    version: 1,
    runId: options.runId,
    labels: needsHuman ? ["triage:needs-human"] : [],
    reservedBoundUsd,
    costUsd,
    limitations: plan.limitations,
    sections,
    findings,
  };
  const markdown = [
    "# Instruction audit",
    "",
    "Advisory findings only. Instruction files are never edited by this command.",
    "",
    ...findings.map(
      (finding) =>
        `- **${finding.severity}** ${markdownText(finding.file)}:${finding.line} (${finding.label}): ${markdownText(finding.reason)} Repair: ${markdownText(finding.suggestion)} References: ${finding.files.map(markdownText).join(", ")}`,
    ),
    "",
    ...sections.flatMap((section) =>
      section.judgements.flatMap((judgement) =>
        "error" in judgement
          ? [
              `- Needs human: ${markdownText(section.file)}:${section.line} (${judgement.label}): ${markdownText(judgement.error)}`,
            ]
          : [],
      ),
    ),
    "",
    ...plan.limitations.map((limitation) => `- ${markdownText(limitation)}`),
    "",
  ].join("\n");
  return { report, markdown };
}
