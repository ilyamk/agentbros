import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePlaybook } from "../playbooks/resolve";
import { resolveRoute } from "../film/routes";
import { filmRead, footageRead, FOOTAGE_STEP_READ, timelineRead, TIMELINE_STEP_READ } from "../pipeline/route";
import { descriptionOf, isAgent, isSkill, repositoryText, type RepositoryText } from "./repository";

export type Size = { bytes: number; estimatedTokens: number };
export type ContextRow = Size & { id: string; files: string[]; missing: string[] };
export type ContextBudget = {
  version: 1;
  estimate: string;
  boot: ContextRow[];
  steps: ContextRow[];
  playbooks: ContextRow[];
  subagents: ContextRow[];
  contributor: ContextRow;
  mcp: { status: "unknown"; declared: Size; sources: string[]; reason: string };
  limitations: string[];
};

export function measureText(text: string): Size {
  let quarters = 0;
  for (const char of text) quarters += char.codePointAt(0)! <= 127 ? 1 : 4;
  return { bytes: Buffer.byteLength(text), estimatedTokens: Math.ceil(quarters / 4) };
}

function row(repo: RepositoryText, id: string, paths: string[]): ContextRow {
  const files = [
    ...new Set(
      paths.flatMap((file) => {
        const children = repo.files.filter((name) => name.startsWith(`${file.replace(/\/$/, "")}/`));
        return children.length ? children : [file];
      }),
    ),
  ].sort();
  const texts = files.map((file) => repo.read(file));
  return {
    id,
    files,
    missing: files.filter((_, index) => texts[index] === undefined),
    ...measureText(texts.map((text) => text ?? "").join("")),
  };
}

/** Uses the same playbook resolver and step readers as next/playbook/film:next, without opening a project. */
export function measureBudget(repo: RepositoryText): ContextBudget {
  const skillFiles = repo.files.filter(isSkill);
  const agentFiles = repo.files.filter(isAgent);
  const descriptions = [...skillFiles, ...agentFiles].map((file) => descriptionOf(repo.read(file) ?? "")).join("");
  const mcpSources: string[] = [];
  const instructions: string[] = [];
  const config = repo.read(".mcp.json");
  if (config) {
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if (key === "instructions" && typeof item === "string") instructions.push(item);
        else visit(item);
      }
    };
    visit(JSON.parse(config));
    if (instructions.length) mcpSources.push(".mcp.json");
  }
  const bootSize = measureText((repo.read("AGENTS.md") ?? "") + descriptions + instructions.join(""));
  const boot = ["claude-code", "codex"].map((id) => ({
    id,
    ...bootSize,
    files: ["AGENTS.md", ...skillFiles, ...agentFiles, ...mcpSources],
    missing: repo.read("AGENTS.md") === undefined ? ["AGENTS.md"] : [],
  }));
  const steps: ContextRow[] = [];
  const playbooks: ContextRow[] = [];
  const temporary = mkdtempSync(path.join(tmpdir(), "context-budget-"));
  try {
    for (const file of repo.files.filter((name) => /^playbooks\/[^/]+\/playbook\.json$/.test(name))) {
      const target = path.join(temporary, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, repo.read(file)!);
      const id = file.split("/")[1]!;
      const resolved = resolvePlaybook(id, temporary);
      const base = [...resolved.read, resolved.route.guide];
      const ownSteps: ContextRow[] = [];
      const add = (step: string, files: string[]) =>
        ownSteps.push(row(repo, `${id}/${step}`, [...base, ...(resolved.stepRead[step] ?? []), ...files]));
      const route = resolved.playbook.route;
      if (route.kind === "film") {
        const types = [route.filmType, ...(route.secondaryFilmType ? [route.secondaryFilmType] : [])];
        for (const step of resolveRoute(route.filmType, route.secondaryFilmType).steps) {
          add(step.id, [
            ...filmRead(step.id, types),
            `.agents/agents/${step.agent}.md`,
            ...step.tools.flatMap((tool) =>
              tool.kind === "skill" ? [`.agents/skills/${tool.id}/SKILL.md`] : tool.kind === "path" ? [tool.id] : [],
            ),
          ]);
        }
      } else if (route.kind === "footage") {
        for (const step of Object.keys(FOOTAGE_STEP_READ)) add(step, footageRead(step));
      } else if (route.kind === "template") {
        for (const step of Object.keys(TIMELINE_STEP_READ)) add(step, timelineRead(step));
      } else add("start", []);
      steps.push(...ownSteps);
      playbooks.push(
        row(
          repo,
          id,
          ownSteps.flatMap((step) => step.files),
        ),
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const categories = repo.files
    .filter((file) => /^contrib\/categories\/[^/]+\.md$/.test(file))
    .sort(
      (a, b) => measureText(repo.read(b) ?? "").bytes - measureText(repo.read(a) ?? "").bytes || a.localeCompare(b),
    );
  return {
    version: 1,
    estimate: "v1: ASCII code points / 4 + non-ASCII code points; round up once per context; UTF-8 bytes",
    boot,
    steps,
    playbooks,
    subagents: agentFiles.map((file) => row(repo, path.basename(file, ".md"), [file])),
    contributor: row(repo, "contributor", ["CONTRIBUTING.md", "contrib/AGENTS.md", ...categories.slice(0, 1)]),
    mcp: {
      status: "unknown",
      declared: measureText(instructions.join("")),
      sources: mcpSources,
      reason:
        "Only literal .mcp.json instructions are measurable offline; server handshake instructions and harness loading are unknown.",
    },
    limitations: [
      "Harness rows model the same declared boot payload, not observed harness loading. Skill and agent bodies are excluded from boot.",
      "Film owner definitions and static STEP_RULES/route tools are measured; project artefacts, spine, memory, conditional inputs, critic/fixer briefs and dispatch text require a project and are excluded. Subagents count definitions only.",
      "Footage/template rows cover the shared step-reader keys; workflow routes expose only their start guide. Alternative routes and runtime choices are excluded.",
      "Git refs supply historical text and playbook data, resolved by the current trusted route functions; historical resolver code is never executed. Resolver-code-only changes need separate review.",
    ],
  };
}

export function budgetFor(root: string, ref?: string): ContextBudget {
  return measureBudget(repositoryText(root, ref));
}

export function budgetDelta(current: ContextBudget, base: ContextBudget): ContextRow[] {
  const rows = (budget: ContextBudget) => [
    ...budget.boot.map((item) => ({ ...item, id: `boot/${item.id}` })),
    ...budget.steps.map((item) => ({ ...item, id: `step/${item.id}` })),
    ...budget.playbooks.map((item) => ({ ...item, id: `playbook/${item.id}` })),
    ...budget.subagents.map((item) => ({ ...item, id: `subagent/${item.id}` })),
    budget.contributor,
  ];
  const before = new Map(rows(base).map((item) => [item.id, item]));
  const after = new Map(rows(current).map((item) => [item.id, item]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().map((id) => ({
    id,
    files: after.get(id)?.files ?? [],
    missing: after.get(id)?.missing ?? [],
    bytes: (after.get(id)?.bytes ?? 0) - (before.get(id)?.bytes ?? 0),
    estimatedTokens: (after.get(id)?.estimatedTokens ?? 0) - (before.get(id)?.estimatedTokens ?? 0),
  }));
}

export function budgetMarkdown(budget: ContextBudget, delta?: ContextRow[]): string {
  const differences = new Map(delta?.map((item) => [item.id, item]));
  const rows = [
    ...budget.boot.map((item) => ({ ...item, id: `boot/${item.id}` })),
    ...budget.playbooks.map((item) => ({ ...item, id: `playbook/${item.id}` })),
    ...budget.steps.map((item) => ({ ...item, id: `step/${item.id}` })),
    ...budget.subagents.map((item) => ({ ...item, id: `subagent/${item.id}` })),
    budget.contributor,
  ];
  for (const item of delta ?? [])
    if (!rows.some((entry) => entry.id === item.id)) rows.push({ ...item, bytes: 0, estimatedTokens: 0 });
  return [
    "| Context | Bytes | Estimated tokens | Δ bytes | Δ tokens |",
    "|---|---:|---:|---:|---:|",
    ...rows.map(
      (item) =>
        `| ${item.id} | ${item.bytes} | ${item.estimatedTokens} | ${differences.get(item.id)?.bytes ?? "—"} | ${differences.get(item.id)?.estimatedTokens ?? "—"} |`,
    ),
    "",
    `Estimate: ${budget.estimate}. MCP total: unknown.`,
    "",
    ...budget.limitations.map((item) => `- ${item}`),
    "",
  ].join("\n");
}
