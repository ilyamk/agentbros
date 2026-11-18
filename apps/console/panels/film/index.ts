/**
 * Film route panels (RFC 0004 §5.2, WP10), one per group of chain steps (./steps.ts). The console calls
 * {@link registerFilmPanels} once at boot (panels/index.ts). Registration is a call, not an import side effect: the
 * repository's package.json `sideEffects` list lets the bundler drop side-effect-only imports.
 *
 * Every panel: shown once its steps are reached (or it has a waiting decision), expanded and weighing most while its
 * step is current or waits for the user, collapsed and low once all its steps are done.
 */
import type { ProjectView } from "@contract";
import { formatDuration } from "@/lib/format";
import { format, plural, type Dictionary } from "@/i18n";
import { registerPanels, type PanelDef } from "../registry";
import { BuildPanel, CriticPanel, buildFindings } from "./build";
import { BeatsPanel, BriefPanel, DiscoveryPanel } from "./early";
import {
  LookPanel,
  MaterialPanel,
  MusicPanel,
  NarrationPanel,
  materialItems,
  narrationTakes,
  musicTracks,
  styleframes,
} from "./material";
import { IdeasPanel, ScriptPanel, poolSize } from "./pool";
import { QaPanel, qaFindings } from "./qa";
import {
  FILM_GROUPS,
  groupCollapsed,
  groupSteps,
  groupWeight,
  isReached,
  isSkippedGroup,
  isWaitingGroup,
  leadStep,
  type FilmGroup,
} from "./steps";
import { PlayerFrameCommentInput, setVerdictFrameCommentInput, VerdictPanel } from "./verdict";

export { FILM_GROUPS, type FilmGroup } from "./steps";
export {
  PlayerFrameCommentInput,
  setVerdictFrameCommentInput,
  VerdictForm,
  type FrameCommentInputProps,
} from "./verdict";
export { isSoundClaim, withoutSoundClaims } from "@/lib/sound-claims";

type Extra = (d: Dictionary, view: ProjectView, locale: string) => string | undefined;

/** The group's state in one line: "Waiting for you", or the lead step's status and duration, plus a panel fact. */
function groupSummary(group: FilmGroup, extra?: Extra): NonNullable<PanelDef["summary"]> {
  return (d, view, locale) => {
    let state: string | undefined;
    if (isWaitingGroup(view, group)) state = d.film.common.waiting;
    else {
      const step = leadStep(view, group);
      if (step)
        state =
          step.durationMs !== undefined
            ? format(d.film.common.statusWithTime, {
                status: d.stepStatus[step.status],
                time: formatDuration(step.durationMs, d.units),
              })
            : d.stepStatus[step.status];
    }
    const fact = extra?.(d, view, locale);
    return [state, fact].filter(Boolean).join(" · ") || undefined;
  };
}

const count = (n: number, message: Parameters<typeof plural>[0], locale: string) =>
  n ? plural(message, n, locale) : undefined;

/** A film panel over a step group, with the shared when/weight/collapse rules. */
function filmPanel(
  group: FilmGroup,
  component: PanelDef["component"],
  options: { extra?: Extra; also?: (view: ProjectView) => boolean } = {},
): PanelDef {
  return {
    id: `film.${group}`,
    // A replica is a film of type `replica`: its shared steps use the film panels (WP15).
    routes: ["film", "replica"],
    when: (view) =>
      // A replica skips most film steps: a group it skips entirely has no panel there (WP15).
      !(view.project.route === "replica" && isSkippedGroup(view, group)) &&
      ((groupSteps(view, group).length > 0 && isReached(view, group)) || !!options.also?.(view)),
    weight: (view) => groupWeight(view, group),
    collapsedWhen: (view) => groupCollapsed(view, group),
    component,
    title: (d) => d.film.titles[group],
    summary: groupSummary(group, options.extra),
  };
}

export const FILM_PANELS: PanelDef[] = [
  filmPanel("brief", BriefPanel, { extra: (_d, view) => view.project.filmType }),
  filmPanel("discovery", DiscoveryPanel),
  filmPanel("ideas", IdeasPanel, {
    extra: (d, view, locale) => count(poolSize(view, "ideas"), d.film.pool.count, locale),
  }),
  filmPanel("music", MusicPanel, {
    extra: (d, view, locale) => count(musicTracks(view).length, d.film.pool.count, locale),
  }),
  filmPanel("script", ScriptPanel, {
    extra: (d, view, locale) => count(poolSize(view, "script"), d.film.pool.count, locale),
  }),
  filmPanel("look", LookPanel, {
    extra: (d, view, locale) => count(styleframes(view).length, d.film.material.count, locale),
  }),
  filmPanel("beats", BeatsPanel),
  filmPanel("material", MaterialPanel, {
    extra: (d, view, locale) => count(materialItems(view).length, d.film.material.count, locale),
  }),
  filmPanel("narration", NarrationPanel, {
    extra: (d, view, locale) => count(narrationTakes(view).length, d.film.material.count, locale),
  }),
  filmPanel("build", BuildPanel, {
    extra: (d, view, locale) => count(buildFindings(view).length, d.film.qa.findingsCount, locale),
    also: (view) => !!(view.media.animatic || view.media.latestRender),
  }),
  filmPanel("critic", CriticPanel, {
    extra: (d, view) => {
      const critic = [...view.steps].reverse().find((step) => step.critic)?.critic;
      if (!critic) return undefined;
      return critic.score !== undefined
        ? format(d.canvas.criticScore, { round: critic.round, score: critic.score })
        : format(d.canvas.critic, { round: critic.round });
    },
  }),
  filmPanel("qa", QaPanel, {
    extra: (d, view, locale) =>
      view.qa.delivery
        ? view.qa.delivery.ok
          ? d.film.qa.passed
          : d.film.qa.failed
        : count(qaFindings(view).length, d.film.qa.findingsCount, locale),
    also: (view) => view.qa.delivery !== undefined,
  }),
  filmPanel("human", VerdictPanel),
];

/** Every film step group has exactly one panel. */
export const FILM_PANEL_GROUPS = Object.keys(FILM_GROUPS) as FilmGroup[];

export function registerFilmPanels(): void {
  registerPanels(FILM_PANELS);
  // The verdict's frame comments come from the media viewer's own frame picker (WP6), not the numeric fallback.
  setVerdictFrameCommentInput(PlayerFrameCommentInput);
}
