/**
 * Film panels by chain step (RFC 0004 §5.2). Each panel covers a group of step ids: the chain's own ids
 * (src/lib/film/chain.ts) and the short aliases the console fixtures use (`beats`, `qa`, `delivery`). The when, weight
 * and collapse rules are the shared ones of ../groups.ts.
 */
import type { ProjectView } from "@contract";
import { groupHelpers } from "../groups";

export const FILM_GROUPS = {
  brief: ["intake", "rights", "strategy"],
  discovery: ["discovery", "truth", "reference", "replica-reference", "replica-spec"],
  ideas: ["ideas", "idea-review", "concept"],
  music: ["music", "audio-map"],
  script: ["script-variants", "script-review", "script"],
  look: ["look"],
  beats: ["beats", "beat-sheet"],
  material: ["material"],
  narration: ["narration"],
  build: ["animatic", "build", "sound"],
  critic: ["critic", "fixer", "measure", "replica-compare"],
  qa: ["qa", "delivery"],
  human: ["human"],
} as const satisfies Record<string, readonly string[]>;

export type FilmGroup = keyof typeof FILM_GROUPS;

const film = groupHelpers<FilmGroup>(FILM_GROUPS);

export const FILM_GROUP_ORDER = film.order;
export const {
  groupSteps,
  groupOfStep,
  groupDecisions,
  isCurrentGroup,
  isWaitingGroup,
  isReached,
  isClosed,
  needsAttention,
  leadStep,
  groupWeight,
  groupCollapsed,
} = film;

/** Every step of the group is skipped by the route (a replica skips the ideas, the script, the look…): no panel. */
export function isSkippedGroup(view: ProjectView, group: FilmGroup): boolean {
  const steps = groupSteps(view, group);
  return steps.length > 0 && steps.every((step) => step.status === "skipped") && !isWaitingGroup(view, group);
}
