/**
 * Where each aspect of the user's feedback goes: a deterministic table from aspect to the chain step that owns it.
 * Each aspect lists candidate steps in order; the first one the film's type runs wins, and none means `ask`.
 * A target must be agent-owned and not a judge (FEEDBACK_STEPS in chain.ts carries its tracked input). The concept and the
 * script's words go to the pool authors (ideas, script-variants): their open feedback reopens the blind pool for a new
 * round whose briefs carry the user's quotes (src/lib/film/studio.ts), and the pick reruns on the new pool.
 */
import { FEEDBACK_STEPS, stepById } from "../film/chain";
import { IDEA_AXES, SCRIPT_AXES } from "../film/creative-rubric";
import { stepEnabled } from "../film/routes";
import type { FilmType } from "../../types/pipeline";
import { ASPECTS, type Aspect } from "../../types/feedback";

export type AspectRoute = {
  /** Candidate film steps, first enabled wins. Empty: always ask. */
  film: readonly string[];
  /** Why the remaining cases go to the user, said in the preview. */
  askWhy?: string;
  /** The creative rubric axis a lesson about this aspect bears on (creative-postmortem); none when no axis fits. */
  axis?: (typeof IDEA_AXES)[number] | (typeof SCRIPT_AXES)[number];
};

export const ASPECT_ROUTES: Record<Aspect, AspectRoute> = {
  concept: { film: ["ideas"], axis: "picture" },
  audience: { film: ["strategy", "intake"], axis: "native" },
  "hook-line": { film: ["script-variants", "replica-spec"], axis: "hookLine" },
  "opening-picture": { film: ["beat-sheet", "replica-spec"], axis: "hook" },
  words: { film: ["script-variants", "replica-spec"], axis: "oneMessage" },
  claim: { film: ["truth"], axis: "truth" },
  "ending-cta": { film: ["script-variants", "replica-spec"], axis: "oneMessage" },
  music: { film: ["music"], axis: "musicFit" },
  "sfx-mix": { film: ["sound"] },
  voice: { film: ["narration", "sound"] },
  captions: { film: ["build"], axis: "reading" },
  pacing: { film: ["beat-sheet", "replica-spec"] },
  length: { film: ["beat-sheet", "replica-spec"] },
  look: { film: ["look", "replica-spec"], axis: "distinctiveness" },
  shot: { film: ["build"] },
  material: { film: ["material", "build"] },
  framing: { film: ["build"] },
  cuts: { film: ["beat-sheet", "replica-spec"] },
  shorts: {
    film: [],
    askWhy: "a film has no shorts step: ask the user whether they want cut-downs, and plan them as a new film",
  },
  unclear: {
    film: [],
    askWhy: "the user's words do not say what should change: ask them which part of the film they mean",
  },
};

export type RouteContext = { type: FilmType; secondary?: FilmType; silence?: boolean };
export type Routed = { step: string } | { step: "ask"; why: string };

/** A step the film runs, that feedback may reopen. */
export function feedbackTarget(stepId: string, context: RouteContext): boolean {
  const step = stepById(stepId);
  if (!step || !FEEDBACK_STEPS.includes(stepId)) return false;
  if (step.skipWhenSilence && context.silence) return false;
  return stepEnabled(stepId, context.type, context.secondary);
}

/** The film step an aspect goes to for this film, or ask with the reason. */
export function routeAspect(aspect: Aspect, context: RouteContext): Routed {
  const route = ASPECT_ROUTES[aspect];
  const step = route.film.find((candidate) => feedbackTarget(candidate, context));
  if (step) return { step };
  return {
    step: "ask",
    why: route.askWhy ?? `no step of a ${context.type} film owns ${aspect}: ask the user where the change belongs`,
  };
}

export const aspectAxis = (aspect: Aspect): string | undefined => ASPECT_ROUTES[aspect].axis;

export { ASPECTS };
