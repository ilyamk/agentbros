/**
 * The guard's writes from the commands that do work, kept out of buildBrief and sealStep (context:budget --simulate
 * renders briefs without dispatching). Each returns a commit to call once the command's own write succeeded.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  appendGuardEvent,
  dispatchKey,
  guardCheck,
  raiseCommand,
  readGuardEvents,
  recordSeal,
  stopping,
} from "./guard";
import { ChainRefusal, stepState, type FilmProject } from "./state";

/** film:brief: refuses a new dispatch while a limit stops dispatching; a re-printed brief of the same round passes and is not counted again. */
export function guardDispatch(
  project: FilmProject,
  step: string,
  role: string,
  lane?: string,
  at?: string,
): { commit: () => void } {
  let key: string;
  try {
    key = dispatchKey(stepState(project, step));
  } catch {
    return { commit: () => {} };
  }
  const last = readGuardEvents(project.projectDir)
    .filter((event) => event.kind === "dispatch" && event.step === step && event.role === role && event.lane === lane)
    .at(-1);
  if (last?.key === key) return { commit: () => {} };
  const check = guardCheck(project.projectDir);
  const crossed = stopping(check, "dispatch");
  if (crossed.length)
    throw new ChainRefusal(
      `The project's limits stop new work: ${crossed.map((limit) => `${limit.name} ${limit.used}/${limit.max}${limit.where ? ` (step ${limit.where})` : ""}`).join("; ")}. Show the user the best version (film:next) and ask; to go on, raise in their words: ${crossed.map((limit) => raiseCommand(project.id, limit)).join(" ; ")}`,
    );
  return {
    commit: () =>
      appendGuardEvent(project.projectDir, {
        kind: "dispatch",
        step,
        role,
        ...(lane ? { lane } : {}),
        key,
        at: at ?? new Date().toISOString(),
      }),
  };
}

/** film:done: a step sealed before whose input changed since was reopened; the seal logs that re-entry once. */
export function guardSeal(project: FilmProject, step: string, at?: string): { commit: () => void } {
  let reopened = false;
  try {
    const sealedBefore = existsSync(path.join(project.projectDir, "pipeline", "chain", `${step}.json`));
    reopened = sealedBefore && stepState(project, step).status === "stale";
  } catch {
    reopened = false;
  }
  return { commit: () => recordSeal(project.projectDir, step, reopened, at) };
}

/** film:approve and feedback --confirm: an approval, or each step the user's feedback reopened. */
export function guardEvent(
  project: FilmProject,
  kind: "approval" | "reentry" | "raise",
  step: string | undefined,
  source: string,
  at: string = new Date().toISOString(),
): void {
  appendGuardEvent(project.projectDir, { kind, ...(step ? { step } : {}), source, at });
}
