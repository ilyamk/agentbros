/**
 * Footage route panels (RFC 0004 §5.2, US19, A15; WP12), one per group of footage:next steps (./steps.ts): source,
 * transcript, recut plan, captions, shorts, cameras, reframe and renders. The console calls
 * {@link registerFootagePanels} once at boot (panels/index.ts); registration is a call, not an import side effect.
 *
 * Every panel: shown once its steps are reached (or it has a waiting decision); the optional ones (captions, shorts,
 * cameras, reframe) only when their step is current or waiting or their material exists. Expanded and weighing most
 * while its step is current or waits for the user, collapsed and low once all its steps are done. Decisions are made
 * on the pinned card only; panels point to it.
 */
import type { ProjectView } from "@contract";
import { format, plural, type Dictionary } from "@/i18n";
import { formatDuration } from "@/lib/format";
import { registerPanels, type PanelDef } from "../registry";
import { CaptionsPanel } from "./captions";
import { CamerasPanel, RenderPanel, ReframePanel, ShortsPanel } from "./outputs";
import { PlanPanel } from "./plan";
import { SourcePanel, TranscriptPanel } from "./source";
import {
  footageGroupCollapsed,
  footageGroupSteps,
  footageGroupWeight,
  footageLeadStep,
  isCurrentFootageGroup,
  isFootageGroupReached,
  isWaitingFootageGroup,
  material,
  type FootageGroup,
} from "./steps";

export { FOOTAGE_GROUPS, type FootageGroup } from "./steps";

type Extra = (d: Dictionary, view: ProjectView, locale: string) => string | undefined;

function groupSummary(group: FootageGroup, extra?: Extra): NonNullable<PanelDef["summary"]> {
  return (d, view, locale) => {
    let state: string | undefined;
    if (isWaitingFootageGroup(view, group)) state = d.film.common.waiting;
    else {
      const step = footageLeadStep(view, group);
      if (step)
        state =
          step.durationMs !== undefined
            ? format(d.film.common.statusWithTime, {
                status: d.stepStatus[step.status],
                time: formatDuration(step.durationMs, d.units),
              })
            : d.stepStatus[step.status];
    }
    return [state, extra?.(d, view, locale)].filter(Boolean).join(" · ") || undefined;
  };
}

/** A footage panel over a step group; `optional` panels need their step to be live or their material to exist. */
function footagePanel(
  group: FootageGroup,
  component: PanelDef["component"],
  options: { extra?: Extra; has?: (view: ProjectView) => boolean; optional?: boolean } = {},
): PanelDef {
  return {
    id: `footage.${group}`,
    routes: ["footage"],
    when: (view) => {
      const steps = footageGroupSteps(view, group).length > 0;
      const live = isCurrentFootageGroup(view, group) || isWaitingFootageGroup(view, group);
      const has = !!options.has?.(view);
      if (options.optional) return live || has;
      return (steps && isFootageGroupReached(view, group)) || has;
    },
    weight: (view) => footageGroupWeight(view, group),
    collapsedWhen: (view) => footageGroupCollapsed(view, group),
    component,
    title: (d) => d.footage.titles[group],
    summary: groupSummary(group, options.extra),
  };
}

export const FOOTAGE_PANELS: PanelDef[] = [
  footagePanel("source", SourcePanel, { has: (view) => !!material(view).source }),
  footagePanel("transcript", TranscriptPanel, {
    has: (view) => !!material(view).transcript,
    extra: (d, view, locale) => {
      const transcript = material(view).transcript;
      return transcript ? plural(d.footage.transcript.words, transcript.wordCount, locale) : undefined;
    },
  }),
  footagePanel("plan", PlanPanel, {
    has: (view) => !!material(view).plan,
    extra: (d, view, locale) => {
      const plan = material(view).plan;
      return plan ? plural(d.footage.plan.cuts, plan.cuts.length, locale) : undefined;
    },
  }),
  footagePanel("captions", CaptionsPanel, {
    optional: true,
    has: (view) => !!material(view).captions?.style || !!material(view).captions?.wanted,
    extra: (_d, view) => material(view).captions?.style ?? material(view).captions?.wanted,
  }),
  footagePanel("shorts", ShortsPanel, {
    optional: true,
    has: (view) => !!material(view).shorts,
    extra: (d, view) => {
      const items = material(view).shorts?.items ?? [];
      const proposed = items.filter((item) => item.proposed).length;
      return items.length ? `${proposed}/${items.length}` : undefined;
    },
  }),
  footagePanel("cameras", CamerasPanel, {
    optional: true,
    has: (view) => !!material(view).cameras,
    extra: (_d, view) => material(view).cameras?.angles.join(", ") || undefined,
  }),
  footagePanel("reframe", ReframePanel, {
    optional: true,
    has: (view) => !!material(view).reframe,
    extra: (d, view) =>
      material(view)
        .reframe?.formats.filter((row) => row.reframed)
        .map((row) => d.footage.formats[row.format])
        .join(", ") || undefined,
  }),
  footagePanel("render", RenderPanel, {
    has: (view) => !!material(view).renders?.some((render) => render.state !== "missing"),
    extra: (d, view) => {
      const renders = material(view).renders ?? [];
      const fresh = renders.filter((render) => render.state === "fresh").length;
      return renders.length ? `${d.footage.render.state.fresh} ${fresh}/${renders.length}` : undefined;
    },
  }),
];

/** Every footage step group has exactly one panel. */
export const FOOTAGE_PANEL_GROUPS = FOOTAGE_PANELS.map((panel) => panel.id.slice("footage.".length) as FootageGroup);

export function registerFootagePanels(): void {
  registerPanels(FOOTAGE_PANELS);
}
