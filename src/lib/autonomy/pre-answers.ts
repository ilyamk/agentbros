/**
 * Which pre-answers fit which project, and whether each value is still one of the options its question offers.
 * film:policy refuses a misfit (INVALID_INPUT); the consumers (src/lib/film/autonomy.ts for swaps, src/lib/footage/policy.ts
 * for captionStyle and shorts) call the same checks again and ignore a pre-answer the option set no longer holds, with
 * a warning, so the user is asked instead.
 */
import { CaptionProfileIdSchema } from "../../types/caption-style";
import type { PreAnswers } from "../../types/policy";

/** The caption profiles footage:next offers and the timeline accepts. */
export const CAPTION_STYLE_OPTIONS: readonly string[] = CaptionProfileIdSchema.options;
/** A shorts series holds 2 to 30 episodes (ShortsSeriesRequestSchema). */
export const SHORTS_PRE_ANSWER_RANGE = { min: 2, max: 30 } as const;

export type PolicyProjectKind = { route: "film"; filmType?: string } | { route: "footage" };

export const normSwap = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** Why the caption style pre-answer is not an option today, or undefined when it is. */
export function captionStyleProblem(style: string): string | undefined {
  return CAPTION_STYLE_OPTIONS.includes(style)
    ? undefined
    : `captionStyle "${style}" is not a caption profile; known: ${CAPTION_STYLE_OPTIONS.join(", ")}.`;
}

/** Why the shorts count is out of range, or undefined. */
export function shortsCountProblem(count: number): string | undefined {
  return Number.isInteger(count) && count >= SHORTS_PRE_ANSWER_RANGE.min && count <= SHORTS_PRE_ANSWER_RANGE.max
    ? undefined
    : `shorts=${count} is out of range: a series approves ${SHORTS_PRE_ANSWER_RANGE.min} to ${SHORTS_PRE_ANSWER_RANGE.max} clips.`;
}

/** Every reason these pre-answers do not fit this project; empty when they all do. */
export function preAnswerProblems(answers: PreAnswers, project: PolicyProjectKind): string[] {
  const out: string[] = [];
  const footageOnly = (key: string) => `${key} pre-answers footage:next; this project is a film.`;
  if (answers.captionStyle !== undefined) {
    if (project.route !== "footage") out.push(footageOnly("captionStyle"));
    const problem = captionStyleProblem(answers.captionStyle);
    if (problem) out.push(problem);
  }
  if (answers.shorts !== undefined) {
    if (project.route !== "footage") out.push(footageOnly("shorts"));
    const problem = shortsCountProblem(answers.shorts);
    if (problem) out.push(problem);
  }
  if (answers.swaps !== undefined) {
    if (project.route !== "film" || project.filmType !== "replica")
      out.push("swaps pre-answers a replica's replica-spec; this project is not a replica film.");
    const seen = answers.swaps.map(normSwap);
    if (new Set(seen).size !== seen.length) out.push("swaps lists the same swap twice.");
  }
  return out;
}
