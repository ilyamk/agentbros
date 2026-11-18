/** A playbook with what it points to: its route's guide, film-type tools and QA, recipe or workflow, and the read list. */
import type { Playbook } from "../../types/playbook";
import { filmTypeDoc, resolveRoute, type RouteTool, type RouteWorkflow } from "../film/routes";
import { RECIPES } from "../templates/recipes";
import { WORKFLOWS } from "../workflows/dispatch";
import { loadPlaybook, playbookStepFiles, playbooksRoot } from "./project";

export const FOOTAGE_GUIDE = "docs/footage-editing.md";

export type ResolvedPlaybookRoute =
  | { kind: "campaign"; id: string; guide: string }
  | {
      kind: "film";
      type: string;
      secondary?: string;
      title: string;
      material?: string;
      tools: Record<string, RouteTool[]>;
      qa: string[];
      workflow?: RouteWorkflow;
      guide: string;
    }
  | { kind: "footage"; goals: string[]; guide: string }
  | { kind: "workflow"; id: string; description: string; guide: string }
  | {
      kind: "template";
      id: string;
      title: string;
      durationSec: number;
      style: string;
      beats: readonly string[];
      guide: ".agents/skills/video-recipes/SKILL.md";
    };

export type ResolvedPlaybook = {
  playbook: Playbook;
  start: string;
  route: ResolvedPlaybookRoute;
  /** The playbook's QA lines first, then the film type's, without repeats. */
  qa: string[];
  /** The playbook's AGENTS.md first, then its `read` files: read at every step. */
  read: string[];
  /** Files read only at the named steps, after `read`. */
  stepRead: Record<string, string[]>;
};

export function expandRoute(route: Playbook["route"]): ResolvedPlaybookRoute {
  switch (route.kind) {
    case "campaign":
      return { kind: "campaign", id: route.scenario, guide: "docs/campaign-production.md" };
    case "film": {
      const resolved = resolveRoute(route.filmType, route.secondaryFilmType);
      return {
        kind: "film",
        type: resolved.type,
        ...(resolved.secondary ? { secondary: resolved.secondary } : {}),
        title: resolved.title,
        ...(resolved.material ? { material: resolved.material } : {}),
        tools: Object.fromEntries(
          resolved.steps.filter((step) => step.tools.length).map((step) => [step.id, step.tools]),
        ),
        qa: resolved.qa,
        ...(resolved.workflow ? { workflow: resolved.workflow } : {}),
        guide: filmTypeDoc(resolved.type),
      };
    }
    case "footage":
      return { kind: "footage", goals: route.footageGoals, guide: FOOTAGE_GUIDE };
    case "workflow": {
      const workflow = WORKFLOWS.find((entry) => entry.id === route.workflow)!;
      return { kind: "workflow", id: workflow.id, description: workflow.description, guide: workflow.guide };
    }
    case "template": {
      const recipe = RECIPES.find((entry) => entry.id === route.recipe)!;
      return {
        kind: "template",
        id: recipe.id,
        title: recipe.title,
        durationSec: recipe.durationSec,
        style: recipe.style,
        beats: recipe.beats,
        guide: ".agents/skills/video-recipes/SKILL.md",
      };
    }
  }
}

export function resolvePlaybook(id: string, root = playbooksRoot()): ResolvedPlaybook {
  const playbook = loadPlaybook(id, root);
  const route = expandRoute(playbook.route);
  const qa = [...new Set([...playbook.qa, ...(route.kind === "film" ? route.qa : [])])];
  return {
    playbook,
    start: playbook.route.start,
    route,
    qa,
    read: playbookStepFiles(playbook),
    stepRead: playbook.stepRead ?? {},
  };
}
