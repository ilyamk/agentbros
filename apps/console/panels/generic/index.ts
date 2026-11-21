/**
 * Generic panels (RFC 0004 §5.2 "always present, collapsed unless relevant"): agent cards, agents, money, assets, step
 * guard, advisories and history, for every route.
 */
import { ALL_ROUTES, registerPanels, WEIGHT, type PanelDef } from "../registry";
import { formatUsd } from "@/lib/format";
import { plural } from "@/i18n";
import { AdvisoriesPanel } from "./advisories";
import { AgentsPanel } from "./agents";
import { AssetsPanel } from "./assets";
import { CardsPanel } from "./cards";
import { activeGenerations, GenerationsPanel } from "./generations";
import { HistoryPanel } from "./history";
import { ceilingOf, MoneyPanel } from "./money";
import { StepGuardPanel } from "./step-guard";

const openCards = (view: Parameters<PanelDef["when"]>[0]) =>
  view.cards.filter((card) => card.expectsAnswer && !card.answer).length;

export const GENERIC_PANELS: PanelDef[] = [
  {
    id: "generic.cards",
    routes: ALL_ROUTES,
    when: (view) => view.cards.length > 0,
    weight: (view) => (openCards(view) ? WEIGHT.current + 10 : WEIGHT.normal),
    collapsedWhen: (view) => openCards(view) === 0,
    component: CardsPanel,
    title: (d) => d.cards.title,
    summary: (d, view, locale) => (openCards(view) ? plural(d.nav.waiting, openCards(view), locale) : undefined),
  },
  {
    id: "generic.advisories",
    routes: ALL_ROUTES,
    when: () => true,
    weight: (view) => (view.advisories.length ? WEIGHT.attention : WEIGHT.background - 2),
    collapsedWhen: (view) => view.advisories.length === 0,
    component: AdvisoriesPanel,
    title: (d) => d.advisories.title,
    summary: (_d, view) => (view.advisories.length ? String(view.advisories.length) : undefined),
  },
  {
    id: "generic.agents",
    routes: ALL_ROUTES,
    when: () => true,
    weight: (view) => (view.agents.active ? WEIGHT.normal + 10 : WEIGHT.background + 5),
    collapsedWhen: (view) => !view.agents.active,
    component: AgentsPanel,
    title: (d) => d.agents.title,
    summary: (d, view, locale) => plural(d.agents.runs, view.agents.today.length, locale),
  },
  {
    // Paid model generations (2026-11-20): the current content of a project that only has generations.
    id: "generic.generations",
    routes: ALL_ROUTES,
    when: (view) => !!view.generations && (view.generations.jobs.length > 0 || !!view.generations.preparation),
    weight: (view) =>
      view.generations?.templateOnly
        ? WEIGHT.current
        : activeGenerations(view.generations?.jobs)
          ? WEIGHT.attention
          : WEIGHT.normal + 5,
    component: GenerationsPanel,
    title: (d) => d.generations.title,
    summary: (d, view, locale) => {
      const jobs = view.generations?.jobs ?? [];
      const running = activeGenerations(jobs);
      return [
        plural(d.generations.summary, jobs.length, locale),
        running ? plural(d.generations.running, running, locale) : "",
      ]
        .filter(Boolean)
        .join(" · ");
    },
  },
  {
    id: "generic.money",
    routes: ALL_ROUTES,
    when: () => true,
    weight: (view) => {
      const ceiling = ceilingOf(view);
      const near = ceiling !== undefined && view.money.spentUsd + view.money.reservedUsd >= ceiling * 0.9;
      return near || view.money.unknownPriced ? WEIGHT.attention - 5 : WEIGHT.normal;
    },
    collapsedWhen: (view) => {
      const ceiling = ceilingOf(view);
      return !(ceiling !== undefined && view.money.spentUsd + view.money.reservedUsd >= ceiling * 0.9);
    },
    component: MoneyPanel,
    title: (d) => d.money.title,
    summary: (_d, view, locale) => {
      const ceiling = ceilingOf(view);
      const spent = formatUsd(view.money.spentUsd, locale);
      const reserved = view.money.reservedUsd > 0 ? ` + ${formatUsd(view.money.reservedUsd, locale)}` : "";
      return ceiling !== undefined ? `${spent}${reserved} / ${formatUsd(ceiling, locale)}` : `${spent}${reserved}`;
    },
  },
  {
    id: "generic.step-guard",
    routes: ALL_ROUTES,
    when: () => true,
    weight: (view) => (view.stepGuard?.violations ? WEIGHT.normal - 5 : WEIGHT.background - 4),
    collapsedWhen: (view) => !view.stepGuard?.violations,
    component: StepGuardPanel,
    title: (d) => d.guard.title,
    summary: (d, view, locale) =>
      view.stepGuard?.violations ? plural(d.guard.violations, view.stepGuard.violations, locale) : undefined,
  },
  {
    id: "generic.assets",
    routes: ALL_ROUTES,
    when: () => true,
    weight: () => WEIGHT.background,
    collapsedWhen: () => true,
    component: AssetsPanel,
    title: (d) => d.assets.title,
    summary: (d, view, locale) => plural(d.assets.count, view.assets.length, locale),
  },
  {
    id: "generic.history",
    routes: ALL_ROUTES,
    when: () => true,
    weight: () => WEIGHT.history,
    collapsedWhen: () => true,
    component: HistoryPanel,
    title: (d) => d.history.title,
  },
];

/** Registers the generic panels (idempotent: a panel id registered again replaces the earlier one). */
export function registerGenericPanels(): void {
  registerPanels(GENERIC_PANELS);
}
