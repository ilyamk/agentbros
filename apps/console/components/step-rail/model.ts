/**
 * Step rail model (docs/console-steps.md): what the rail reads from a project view, the status → motion map, where
 * the steps came from, progress, keyboard movement and the steps that appeared after the rail mounted.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ProjectView, Route, StepRow, StepStatus } from "@contract";
import { stepTone, type Tone } from "@/lib/status";

/** What the rail renders: the steps, the current step and the route facts that say where the steps come from. */
export interface RailInput {
  steps: StepRow[];
  current?: string;
  route: Route;
  playbook?: string;
}

export const railInput = (view: ProjectView): RailInput => ({
  steps: view.steps,
  current: view.current?.step,
  route: view.project.route,
  playbook: view.project.playbook,
});

/** One motion per status (the marker and the legend). */
export const MOTIONS = ["orbit", "pulse", "check", "error", "stale", "skipped", "ready", "pending"] as const;
export type Motion = (typeof MOTIONS)[number];

export function stepMotion(status: StepStatus, isCurrent = false): Motion {
  switch (status) {
    case "running":
      return "orbit";
    case "awaiting-gate":
      return "pulse";
    case "done":
      return "check";
    case "failing":
    case "blocked":
    case "invalid":
      return "error";
    case "stale":
    case "unsealed":
      return "stale";
    case "skipped":
      return "skipped";
    case "ready":
      return isCurrent ? "orbit" : "ready";
    case "pending":
      return isCurrent ? "orbit" : "pending";
  }
}

/** The tone of a motion's colour, from the console's status vocabulary (lib/status.ts). */
export const motionTone = (status: StepStatus, isCurrent = false): Tone => stepTone(status, isCurrent);

export const CLOSED: ReadonlySet<StepStatus> = new Set(["done", "skipped"]);

/** Where the steps of a view come from. `template` is the fixed render → QA → delivery finish of `timeline-next.ts`. */
export type Origin = "template" | "film" | "footage" | "route";

const TEMPLATE_IDS = new Set(["render", "qa", "delivery", "done"]);

export function stepOrigin(input: RailInput): Origin {
  if (input.route === "film" || input.route === "replica") return "film";
  if (input.route === "footage") return "footage";
  if (
    (input.route === "timeline" || input.route === "recipe") &&
    input.steps.length > 0 &&
    input.steps.every((step) => TEMPLATE_IDS.has(step.id))
  )
    return "template";
  return "route";
}

export interface RailProgress {
  total: number;
  closed: number;
  /** 1-based position of the current step, or undefined when there is none. */
  position?: number;
  currentStep?: StepRow;
  nextStep?: StepRow;
}

export function railProgress(input: RailInput): RailProgress {
  const total = input.steps.length;
  const closed = input.steps.filter((step) => CLOSED.has(step.status)).length;
  const index = input.current ? input.steps.findIndex((step) => step.id === input.current) : -1;
  const currentStep = index >= 0 ? input.steps[index] : undefined;
  const nextStep = index >= 0 ? input.steps.slice(index + 1).find((step) => !CLOSED.has(step.status)) : undefined;
  return { total, closed, position: index >= 0 ? index + 1 : undefined, currentStep, nextStep };
}

/**
 * Ids that were not there when the rail mounted. They keep the mark, so their enter animation plays once on insertion
 * and is never cut short by the next view update.
 */
export function useAddedSteps(steps: readonly StepRow[]): ReadonlySet<string> {
  const [initial] = useState(() => new Set(steps.map((step) => step.id)));
  return useMemo(() => new Set(steps.filter((step) => !initial.has(step.id)).map((step) => step.id)), [steps, initial]);
}

/** Roving focus over `button[data-step]`: arrows, Home and End, one tab stop (WAI-ARIA toolbar pattern). */
export function useRailKeys(count: number) {
  const list = useRef<HTMLOListElement>(null);
  const focusAt = (index: number) => {
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>("button[data-step]");
    if (!buttons?.length) return;
    const target = buttons[Math.max(0, Math.min(buttons.length - 1, index))];
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const keys: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: count - 1,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    focusAt(next);
  };
  return { list, onKeyDown };
}

export const focusIndexOf = (input: RailInput, selected?: string): number =>
  Math.max(
    0,
    input.steps.findIndex((step) => step.id === (selected ?? input.current)),
  );
