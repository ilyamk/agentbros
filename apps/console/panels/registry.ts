/**
 * The project canvas's panel registry (RFC 0004 §5.2). A panel is a component shown for some routes when its `when`
 * holds, ordered by `weight` (the current step's panels weigh most) and collapsed when `collapsedWhen` holds. WP4
 * registers the generic panels (panels/generic); WP10 registers the film panels from panels/film/index.ts and WP12 the
 * footage panels from panels/footage/index.ts, by calling {@link registerPanel} at module load.
 */
import type { ComponentType } from "react";
import type { ProjectView, Route } from "@contract";
import type { Dictionary } from "@/i18n";

export interface PanelProps {
  view: ProjectView;
}

export type PanelDef = {
  /** Unique, dotted: `film.ideas-pool`, `generic.money`. */
  id: string;
  /** film, footage, recipe, campaign, replica, timeline. */
  routes: Route[];
  /** Show at all. */
  when: (view: ProjectView) => boolean;
  /** Order on the canvas, highest first; the current step's panels weigh most (100+). */
  weight: (view: ProjectView) => number;
  /** Start collapsed (the user can still open it). */
  collapsedWhen?: (view: ProjectView) => boolean;
  component: ComponentType<PanelProps>;
  /** Heading of the panel's section, in the UI language. Defaults to the id. */
  title?: (d: Dictionary, view: ProjectView) => string;
  /** One line shown next to the title when collapsed ("3 runs · 41 min"). */
  summary?: (d: Dictionary, view: ProjectView, locale: string) => string | undefined;
};

export interface PlacedPanel {
  def: PanelDef;
  weight: number;
  collapsed: boolean;
}

const registry = new Map<string, PanelDef>();
const listeners = new Set<() => void>();

/** Adds a panel, or replaces the one with the same id (hot reload, tests). */
export function registerPanel(def: PanelDef): void {
  registry.set(def.id, def);
  for (const listener of listeners) listener();
}

export function registerPanels(defs: readonly PanelDef[]): void {
  for (const def of defs) registerPanel(def);
}

export function unregisterPanel(id: string): void {
  if (registry.delete(id)) for (const listener of listeners) listener();
}

export function registeredPanels(): PanelDef[] {
  return [...registry.values()];
}

/** Registry changes (for the canvas to re-render when a panel module registers late). */
export function onPanelsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The panels for a view: route match, `when`, sorted by weight (then id, for a stable order). */
export function panelsFor(view: ProjectView): PlacedPanel[] {
  const placed: PlacedPanel[] = [];
  for (const def of registry.values()) {
    if (!def.routes.includes(view.project.route)) continue;
    let show = false;
    try {
      show = def.when(view);
    } catch {
      show = false;
    }
    if (!show) continue;
    placed.push({ def, weight: def.weight(view), collapsed: def.collapsedWhen?.(view) ?? false });
  }
  return placed.sort((a, b) => b.weight - a.weight || a.def.id.localeCompare(b.def.id));
}

/** Every route the console knows; generic panels apply to all of them. */
export const ALL_ROUTES: Route[] = ["film", "footage", "recipe", "campaign", "replica", "timeline"];

/** Weight helpers: the current step's panels weigh most. */
export const WEIGHT = { current: 100, attention: 80, normal: 50, background: 20, history: 5 } as const;
