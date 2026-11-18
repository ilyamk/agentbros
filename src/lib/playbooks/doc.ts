/** The generated tables in playbooks/AGENTS.md, between their markers: the index and the coverage. */
import type { Playbook } from "../../types/playbook";
import { coverageTable } from "./coverage";
import { loadPlaybooks } from "./match";
import { playbooksRoot } from "./project";

export const INDEX_DOC = "playbooks/AGENTS.md";
export const INDEX_START = "<!-- playbooks:start -->";
export const INDEX_END = "<!-- playbooks:end -->";
export const COVERAGE_START = "<!-- coverage:start -->";
export const COVERAGE_END = "<!-- coverage:end -->";

export function routeText(route: Playbook["route"]): string {
  switch (route.kind) {
    case "campaign":
      return `campaign: \`${route.scenario}\``;
    case "film":
      return `film: \`${route.filmType}\`${route.secondaryFilmType ? ` + \`${route.secondaryFilmType}\`` : ""}`;
    case "footage":
      return `footage: ${route.footageGoals.join(", ")}`;
    case "workflow":
      return `workflow: \`${route.workflow}\``;
    case "template":
      return `template: \`${route.recipe}\``;
  }
}

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/** Titles, not summaries, keep the file within its 10 KiB as playbooks are added; `--list` and `--match` give the summaries. */
export function indexTable(playbooks: Playbook[]): string {
  return [
    "| Playbook | Task | Route and technique | Status |",
    "|---|---|---|---|",
    ...playbooks.map(
      (playbook) =>
        `| [${playbook.id}](${playbook.id}/AGENTS.md) | ${cell(playbook.title)} | ${routeText(playbook.route)} | ${playbook.status} |`,
    ),
  ].join("\n");
}

function between(markdown: string, startMarker: string, endMarker: string, body: string): string {
  const start = markdown.indexOf(startMarker);
  const end = markdown.indexOf(endMarker);
  if (start < 0 || end < start) throw new Error(`${INDEX_DOC} lacks the ${startMarker} … ${endMarker} markers.`);
  return `${markdown.slice(0, start + startMarker.length)}\n${body}\n${markdown.slice(end)}`;
}

/** The index file with its index and coverage tables regenerated; throws when either pair of markers is missing. */
export function withIndexTable(markdown: string, root = playbooksRoot()): string {
  return between(
    between(markdown, INDEX_START, INDEX_END, indexTable(loadPlaybooks(root))),
    COVERAGE_START,
    COVERAGE_END,
    coverageTable(),
  );
}
