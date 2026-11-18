/**
 * Step groups of a route's panels (RFC 0004 §5.2): one panel covers a group of step ids. When, weight and collapse
 * derive from one place so every route's panels behave the same way: the current step's panel (or one with a decision
 * waiting) is expanded and weighs most, a panel whose steps are all done or skipped is collapsed and sinks, a panel
 * whose steps were not reached yet is hidden. None of these functions throws on a partial view. Film (WP10) and
 * footage (WP12) each build their helpers with {@link groupHelpers}.
 */
import type { Decision, ProjectView, StepRow, StepStatus } from "@contract";
import { WEIGHT } from "./registry";

/** Statuses of a step the route has not reached: nothing to show yet. */
const NOT_REACHED: ReadonlySet<StepStatus> = new Set(["pending", "blocked"]);
const CLOSED: ReadonlySet<StepStatus> = new Set(["done", "skipped"]);
/** Statuses that need someone's attention even when the step is not the current one. */
const ATTENTION: ReadonlySet<StepStatus> = new Set(["awaiting-gate", "failing", "invalid", "stale", "unsealed"]);

export function groupHelpers<G extends string>(groups: Readonly<Record<G, readonly string[]>>) {
  const order = Object.keys(groups) as G[];
  const ids = (group: G): readonly string[] => groups[group];

  function groupSteps(view: ProjectView, group: G): StepRow[] {
    const wanted = ids(group);
    return view.steps.filter((step) => wanted.includes(step.id));
  }

  function groupOfStep(step: string | undefined): G | undefined {
    if (!step) return undefined;
    return order.find((group) => ids(group).includes(step));
  }

  /** Pending decisions of the group's steps (the view's `waiting`, FR2). */
  function groupDecisions(view: ProjectView, group: G): Decision[] {
    const wanted = ids(group);
    return view.waiting.filter((decision) => decision.step !== undefined && wanted.includes(decision.step));
  }

  function isCurrentGroup(view: ProjectView, group: G): boolean {
    const current = view.current?.step;
    return current !== undefined && ids(group).includes(current);
  }

  const isWaitingGroup = (view: ProjectView, group: G): boolean => groupDecisions(view, group).length > 0;

  function isReached(view: ProjectView, group: G): boolean {
    if (isCurrentGroup(view, group) || isWaitingGroup(view, group)) return true;
    return groupSteps(view, group).some((step) => !NOT_REACHED.has(step.status));
  }

  /** Every step of the group is closed (done or skipped) and nothing waits on it. */
  function isClosed(view: ProjectView, group: G): boolean {
    const steps = groupSteps(view, group);
    if (!steps.length || isCurrentGroup(view, group) || isWaitingGroup(view, group)) return false;
    return steps.every((step) => CLOSED.has(step.status));
  }

  function needsAttention(view: ProjectView, group: G): boolean {
    return isWaitingGroup(view, group) || groupSteps(view, group).some((step) => ATTENTION.has(step.status));
  }

  /** The group's most telling step: the current one, else the first needing attention, else the latest reached. */
  function leadStep(view: ProjectView, group: G): StepRow | undefined {
    const steps = groupSteps(view, group);
    const current = view.current?.step;
    return (
      steps.find((step) => step.id === current) ??
      steps.find((step) => ATTENTION.has(step.status)) ??
      [...steps].reverse().find((step) => !NOT_REACHED.has(step.status)) ??
      steps[0]
    );
  }

  /**
   * Canvas weight: the current step's panel weighs most (100+), a waiting decision or a failing step next (80+), an
   * open but quiet step in the middle, closed steps low (later steps above earlier ones, all under the generic panels).
   */
  function groupWeight(view: ProjectView, group: G): number {
    const position = order.indexOf(group) / 100;
    if (isCurrentGroup(view, group)) return WEIGHT.current + 5;
    if (isWaitingGroup(view, group)) return WEIGHT.current + 2;
    if (needsAttention(view, group)) return WEIGHT.attention + position;
    if (isClosed(view, group)) return WEIGHT.background - 10 + position;
    return WEIGHT.normal - 10 + position;
  }

  /** Collapsed unless current, waiting or in trouble. */
  const groupCollapsed = (view: ProjectView, group: G): boolean =>
    !(isCurrentGroup(view, group) || needsAttention(view, group));

  return {
    order,
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
  };
}
