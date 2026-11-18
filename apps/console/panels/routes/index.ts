/**
 * Replica, recipe and campaign canvases (RFC 0004 WP15, US23). A replica is a film of type `replica`: the film panels
 * serve its shared steps (registered for both routes in panels/film), and these panels add its rights, spec and
 * comparison, weighted like the film group their steps belong to. A recipe draft and a campaign container each get one
 * panel over their material. Registration is a call (panels/index.ts), not an import side effect.
 */
import type { ProjectView } from "@contract";
import { format, plural } from "@/i18n";
import { registerPanels, WEIGHT, type PanelDef } from "../registry";
import { groupCollapsed, groupWeight, isReached, isSkippedGroup, type FilmGroup } from "../film/steps";

/** The replica step a panel covers has not started (pending or blocked): no panel until it has material. */
const REPLICA_STEP: Record<string, string> = { rights: "rights", spec: "replica-spec", compare: "replica-compare" };
const notStarted = (view: ProjectView, id: string) => {
  const step = view.steps.find((row) => row.id === REPLICA_STEP[id]);
  return !step || step.status === "pending" || step.status === "blocked";
};
import { CampaignSummaryPanel } from "./campaign";
import { RecipePanel } from "./recipe";
import { ReplicaComparePanel, ReplicaRightsPanel, ReplicaSpecPanel } from "./replica";

/** A replica panel shown once its film group is reached or its material exists; just above that group's film panel. */
function replicaPanel(
  id: string,
  group: FilmGroup,
  has: (view: ProjectView) => boolean,
  component: PanelDef["component"],
  title: PanelDef["title"],
  summary?: PanelDef["summary"],
): PanelDef {
  return {
    id: `replica.${id}`,
    routes: ["replica"],
    when: (view) => has(view) || (isReached(view, group) && !isSkippedGroup(view, group) && !notStarted(view, id)),
    weight: (view) => groupWeight(view, group) + 0.5,
    collapsedWhen: (view) => groupCollapsed(view, group),
    component,
    title,
    summary,
  };
}

export const ROUTE_PANELS: PanelDef[] = [
  replicaPanel(
    "rights",
    "brief",
    (view) => !!view.replica?.rights,
    ReplicaRightsPanel,
    (d) => d.routes.titles.replicaRights,
    (d, view) => (view.replica?.rights ? d.routes.replica.status[view.replica.rights.status] : undefined),
  ),
  replicaPanel(
    "spec",
    "discovery",
    (view) => !!view.replica?.spec || !!view.replica?.check,
    ReplicaSpecPanel,
    (d) => d.routes.titles.replicaSpec,
    (d, view, locale) =>
      view.replica?.spec ? plural(d.routes.replica.shotsCount, view.replica.spec.shots.length, locale) : undefined,
  ),
  replicaPanel(
    "compare",
    "critic",
    (view) => !!view.replica?.compare,
    ReplicaComparePanel,
    (d) => d.routes.titles.replicaCompare,
    (d, view) => {
      const compare = view.replica?.compare;
      if (!compare) return undefined;
      if (!compare.ok) return d.routes.replica.compareError;
      const failed = compare.measures.filter((row) => row.failed > 0).length;
      return failed ? `${d.routes.replica.failed}: ${failed}` : d.routes.replica.compare;
    },
  ),
  {
    id: "recipe.draft",
    routes: ["recipe"],
    when: (view) => !!view.recipe,
    weight: () => WEIGHT.current - 10,
    collapsedWhen: (view) => view.steps.length > 0 && view.steps.every((step) => step.status === "done"),
    component: RecipePanel,
    title: (d) => d.routes.titles.recipe,
    summary: (d, view) =>
      view.recipe
        ? `${view.recipe.recipeId} · ${view.recipe.productionReady ? d.routes.recipe.ready : d.routes.recipe.draft}`
        : undefined,
  },
  {
    id: "campaign.summary",
    routes: ["campaign"],
    when: (view) => !!view.campaign,
    weight: () => WEIGHT.current,
    component: CampaignSummaryPanel,
    title: (d) => d.routes.titles.campaign,
    summary: (d, view, locale) =>
      view.campaign
        ? format("{members} · {outputs}", {
            members: plural(d.routes.campaign.members, view.campaign.members.length, locale),
            outputs: `${d.routes.campaign.outputs}: ${view.campaign.members.reduce((sum, member) => sum + member.outputs, 0)}`,
          })
        : undefined,
  },
];

export function registerRoutePanels(): void {
  registerPanels(ROUTE_PANELS);
}
