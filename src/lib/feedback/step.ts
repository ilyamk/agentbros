/**
 * A step-level rejection (`pnpm feedback --project P --step S --answer "<words>" [--aspect A] [--expect H] --confirm`,
 * RFC 0004 §8): the user asks for changes at a film gate, or for one more round at a critic step, in their own words.
 * The words become one feedback item bound to the artefact the user saw and routed to the step's revise owner: a gate
 * whose artefact an author pool writes goes back to that pool (concept → ideas, script → script-variants), a critic
 * step to what its judge judges, and any other feedback step to itself. The open file then reopens it through the
 * receipts, like every feedback.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Aspect } from "../../types/feedback";
import { stepById } from "../film/chain";
import { artefactsExpect } from "../film/expect";
import { baseTokens, ChainRefusal, fill, stepState, type FilmProject } from "../film/state";
import { planFeedback, routeContext, type FeedbackPlan } from "./apply";
import { feedbackTarget } from "./route";

/** Where a rejection at this step goes when the step itself does not take feedback. */
export const REVISE_TARGET: Readonly<Record<string, string>> = {
  concept: "ideas",
  "idea-review": "ideas",
  script: "script-variants",
  "script-review": "script-variants",
  animatic: "beat-sheet",
  critic: "build",
  human: "build",
};

/** The aspect a step's rejection is filed under unless the user names one (`--aspect`). */
export const STEP_ASPECT: Readonly<Record<string, Aspect>> = {
  intake: "audience",
  "replica-spec": "shot",
  truth: "claim",
  strategy: "audience",
  ideas: "concept",
  "idea-review": "concept",
  concept: "concept",
  music: "music",
  "script-variants": "words",
  "script-review": "words",
  script: "words",
  narration: "voice",
  material: "material",
  look: "look",
  "beat-sheet": "pacing",
  animatic: "pacing",
  build: "shot",
  sound: "sfx-mix",
  critic: "shot",
  human: "shot",
};

const fileSha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The artefact the user saw at this step (root-relative) and the hash `--expect` compares with. */
export function stepArtefact(project: FilmProject, stepId: string): { watched: string; expect: string } {
  const step = stepById(stepId);
  if (!step) throw new ChainRefusal(`Unknown step "${stepId}".`);
  const state = stepState(project, stepId);
  const tokens = baseTokens(project);
  const outputs = Object.keys(state.outputs);
  const shown = (step.question?.show ?? []).map((item) => fill(item, tokens)).filter(Boolean) as string[];
  const critic = step.critic ? fill(step.critic.target, tokens) : undefined;
  const watched =
    shown.find((item) => outputs.includes(item)) ??
    outputs[0] ??
    (critic && existsSync(path.resolve(project.rootDir, critic)) ? critic : undefined);
  if (!watched) throw new ChainRefusal(`Step ${stepId} has no artefact yet: there is nothing to ask changes of.`);
  const expect = outputs.length
    ? artefactsExpect(Object.values(state.outputs))
    : fileSha(path.resolve(project.rootDir, watched));
  return { watched, expect };
}

/** Validates and routes a step-level rejection; writes nothing (writeFeedback does, on --confirm). */
export function planStepFeedback(
  project: FilmProject,
  stepId: string,
  words: string,
  options: { aspect?: Aspect; expect?: string; at?: string } = {},
): FeedbackPlan & { target: string } {
  const step = stepById(stepId);
  if (!step) throw new ChainRefusal(`Unknown step "${stepId}".`);
  const target = REVISE_TARGET[stepId] ?? stepId;
  const context = routeContext(project);
  if (!feedbackTarget(target, context) || !context.enabled.has(target))
    throw new ChainRefusal(
      `Step ${stepId} has no revise owner this film runs (${target}): ask the user what should change and file it with --file.`,
    );
  const { watched, expect } = stepArtefact(project, stepId);
  if (options.expect !== undefined && options.expect !== expect)
    throw new ChainRefusal(
      `Step ${stepId}'s artefacts changed since the user saw them (${options.expect.slice(0, 12)} seen, ${expect.slice(0, 12)} now): show them the current version first.`,
    );
  const aspect = options.aspect ?? STEP_ASPECT[stepId] ?? STEP_ASPECT[target] ?? "unclear";
  const plan = planFeedback(
    project,
    { verdict: "revise", watched: { path: watched }, items: [{ quote: words, aspect, severity: "must" }] },
    options.at,
    { routeTo: target },
  );
  return { ...plan, target };
}
