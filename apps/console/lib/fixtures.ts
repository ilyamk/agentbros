/**
 * Contract fixtures (tests/fixtures/console/) for fixture mode, unit tests and Playwright. They are parsed through the
 * schemas, so a fixture that drifts from the contract fails here. Keyed by file basename: `?fixture=view-film-build`.
 */
import {
  CardSchema,
  ConsoleEventSchema,
  HooksStatusSchema,
  LibraryResponseSchema,
  ProjectViewSchema,
  ProjectsResponseSchema,
  type Card,
  type ConsoleEvent,
  type ProjectView,
  type StepStatus,
  STEP_STATUSES,
} from "@contract";
import filmBuild from "@fixtures/view-film-build.json";
import filmScriptGate from "@fixtures/view-film-script-gate.json";
import filmHuman from "@fixtures/view-film-human.json";
import footage from "@fixtures/view-footage.json";
import footageRender from "@fixtures/view-footage-render.json";
import empty from "@fixtures/view-empty.json";
import generations from "@fixtures/view-generations.json";
import projects from "@fixtures/projects-response.json";
import cards from "@fixtures/cards.json";
import events from "@fixtures/events.json";
import replica from "@fixtures/view-replica.json";
import recipe from "@fixtures/view-recipe.json";
import campaign from "@fixtures/view-campaign.json";
import library from "@fixtures/library.json";
import hooksStatus from "@fixtures/hooks-status.json";

export const fixtureViews = {
  filmBuild: ProjectViewSchema.parse(filmBuild),
  filmScriptGate: ProjectViewSchema.parse(filmScriptGate),
  footage: ProjectViewSchema.parse(footage),
  empty: ProjectViewSchema.parse(empty),
  /** A project:new template holding only paid generations: failed, running and published jobs (2026-11-20). */
  generations: ProjectViewSchema.parse(generations),
} satisfies Record<string, ProjectView>;

export const fixtureProjects = ProjectsResponseSchema.parse(projects);
export const fixtureCards: Card[] = cards.map((card) => CardSchema.parse(card));
export const fixtureEvents: ConsoleEvent[] = events.map((event) => ConsoleEventSchema.parse(event));

/** The promo at the build step with every one of the seven card kinds (the view fixture carries five). */
const allCards: ProjectView = ProjectViewSchema.parse({ ...fixtureViews.filmBuild, cards: fixtureCards });

/** The promo later on, at the final verdict (WP10b): replaces the build-step view of the same project when opened. */
const filmHumanView: ProjectView = ProjectViewSchema.parse(filmHuman);

/** WP15 route canvases: a replica, a recipe draft and a campaign container (opened by name, not on the home list). */
const routeViews = {
  replica: ProjectViewSchema.parse(replica),
  recipe: ProjectViewSchema.parse(recipe),
  campaign: ProjectViewSchema.parse(campaign),
};

/** A slice of the motion library catalogue (WP15) for the library page in fixture mode. */
export const fixtureLibrary = LibraryResponseSchema.parse(library);
export const fixtureHooks = HooksStatusSchema.parse(hooksStatus);
/** The same recording at the render step (WP12): every footage panel with material; replaces the approval view. */
const footageRenderView: ProjectView = ProjectViewSchema.parse(footageRender);

/** A title per status for the step rail fixture. */
const STATUS_TITLES: Record<StepStatus, string> = {
  done: "Brief and strategy",
  skipped: "Category scan",
  ready: "Ideas",
  blocked: "Material (blocked by a licence)",
  invalid: "Script pool",
  failing: "Narration check",
  unsealed: "Look (styleframes not sealed)",
  stale: "Beat sheet",
  "awaiting-gate": "Concept approval",
  pending: "Delivery check",
  running: "Animatic and build",
};

/**
 * The step rail with every step status at once (docs/console-steps.md), to see each marker's motion without a run:
 * `?fixture=view-step-rail`.
 */
const stepRailView: ProjectView = (() => {
  const { recipe: _recipe, ...base } = routeViews.recipe;
  return ProjectViewSchema.parse({
    ...base,
    project: {
      ...base.project,
      id: "step-rail-demo",
      route: "film",
      title: "Every step status",
      playbook: "bespoke-film",
    },
    steps: STEP_STATUSES.map((status) => ({
      id: `demo-${status}`,
      title: STATUS_TITLES[status],
      status,
      reasons: [`This step is ${status} in the fixture.`],
      ...(status === "awaiting-gate" ? { gate: true } : {}),
      ...(status === "done" ? { owner: "strategist", durationMs: 252_000 } : {}),
      ...(status === "running" ? { owner: "motion-engineer" } : {}),
    })),
    current: {
      ...base.current!,
      step: "demo-running",
      next: { argv: ["pnpm", "film:next", "--project", "step-rail-demo"], why: "The build runs." },
    },
  });
})();

/** Fixture names for `?fixture=`: the file basenames, plus `cards` (all seven card kinds). */
export const FIXTURES = {
  "view-film-build": fixtureViews.filmBuild,
  "view-film-script-gate": fixtureViews.filmScriptGate,
  "view-film-human": filmHumanView,
  "view-footage": fixtureViews.footage,
  "view-footage-render": footageRenderView,
  "view-empty": fixtureViews.empty,
  "view-generations": fixtureViews.generations,
  cards: allCards,
  "view-replica": routeViews.replica,
  "view-recipe": routeViews.recipe,
  "view-campaign": routeViews.campaign,
  "view-step-rail": stepRailView,
} as const satisfies Record<string, ProjectView>;
export type FixtureName = keyof typeof FIXTURES | "projects-response";

export function isFixtureName(value: string | null | undefined): value is FixtureName {
  return value === "projects-response" || (value != null && value in FIXTURES);
}

/**
 * Fixture mode's frozen clock: the latest `generatedAt` or `updatedAt` in the fixtures, so nothing the fixtures show
 * lies in the future.
 */
export function fixtureNow(): number {
  const times = [
    ...Object.values(fixtureViews).map((view) => view.generatedAt),
    ...fixtureProjects.projects.map((project) => project.updatedAt),
  ]
    .map((at) => Date.parse(at))
    .filter((time) => Number.isFinite(time));
  return times.length ? Math.max(...times) : Date.now();
}
