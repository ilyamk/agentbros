/**
 * Demo data for the concept preview: one step per contract status ("every status"), and a scripted run that advances
 * the current step, opens a gate, fails and recovers, marks an input stale, adds a step mid-run and skips one, so
 * every animation can be seen without a real project.
 */
import { STEP_STATUSES, type StepRow, type StepStatus } from "@contract";
import type { RailInput } from "./model";

const TITLES: Record<StepStatus, string> = {
  done: "Brief and strategy",
  skipped: "Category scan",
  ready: "Ideas",
  blocked: "Material (blocked by a licence)",
  invalid: "Script pool",
  failing: "Narration check",
  unsealed: "Look (styleframes not sealed)",
  stale: "Beat sheet",
  "awaiting-gate": "Concept approval",
  pending: "Delivery check",
  running: "Animatic and build",
};

export function everyStatusInput(): RailInput {
  const steps: StepRow[] = STEP_STATUSES.map((status) => ({
    id: `demo-${status}`,
    title: TITLES[status],
    status,
    reasons: [`This step is ${status} in the demo.`],
    ...(status === "awaiting-gate" ? { gate: true } : {}),
    ...(status === "done" ? { owner: "strategist", durationMs: 252_000 } : {}),
    ...(status === "running" ? { owner: "motion-engineer" } : {}),
  }));
  return { steps, current: "demo-running", route: "film", playbook: "bespoke-film" };
}

type Frame = { current?: string; status: Record<string, StepStatus>; extra?: boolean };

const BASE = [
  { id: "brief", title: "Brief" },
  { id: "script", title: "Script and voice direction", gate: true },
  { id: "look", title: "Look and styleframes" },
  { id: "music", title: "Music" },
  { id: "build", title: "Animatic and build" },
  { id: "qa", title: "Editorial QA" },
  { id: "delivery", title: "Delivery check" },
] as const;
const EXTRA = { id: "critic-2", title: "Critic round 2 (added during the run)" };

const P = "pending" as const;
const FRAMES: Frame[] = [
  { current: "brief", status: { brief: "running" } },
  { current: "script", status: { brief: "done", script: "running" } },
  { current: "script", status: { brief: "done", script: "awaiting-gate" } },
  { current: "look", status: { brief: "done", script: "done", look: "running" } },
  { current: "look", status: { brief: "done", script: "done", look: "failing" } },
  { current: "look", status: { brief: "done", script: "done", look: "running" } },
  { current: "music", status: { brief: "done", script: "done", look: "done", music: "running" } },
  { current: "build", status: { brief: "done", script: "stale", look: "done", music: "done", build: "running" } },
  { current: "script", status: { brief: "done", script: "running", look: "done", music: "done", build: "stale" } },
  { current: "build", status: { brief: "done", script: "done", look: "done", music: "done", build: "running" } },
  {
    current: "critic-2",
    extra: true,
    status: { brief: "done", script: "done", look: "done", music: "done", build: "done", "critic-2": "running" },
  },
  {
    current: "qa",
    extra: true,
    status: {
      brief: "done",
      script: "done",
      look: "done",
      music: "done",
      build: "done",
      "critic-2": "done",
      qa: "running",
    },
  },
  {
    current: "delivery",
    extra: true,
    status: {
      brief: "done",
      script: "done",
      look: "done",
      music: "done",
      build: "done",
      "critic-2": "done",
      qa: "skipped",
      delivery: "running",
    },
  },
  {
    extra: true,
    status: {
      brief: "done",
      script: "done",
      look: "done",
      music: "done",
      build: "done",
      "critic-2": "done",
      qa: "skipped",
      delivery: "done",
    },
  },
];

export const SIMULATION_LENGTH = FRAMES.length;

/** Frame `tick` (wrapping) of the scripted run. */
export function simulatedInput(tick: number): RailInput {
  const frame = FRAMES[((tick % FRAMES.length) + FRAMES.length) % FRAMES.length]!;
  const order: { id: string; title: string; gate?: boolean }[] = [...BASE];
  if (frame.extra)
    order.splice(
      order.findIndex((step) => step.id === "qa"),
      0,
      EXTRA,
    );
  const steps: StepRow[] = order.map((step) => {
    const status = frame.status[step.id] ?? P;
    return {
      id: step.id,
      title: step.title,
      status: frame.current === step.id && status === P ? "running" : status,
      reasons: frame.current === step.id ? [`Simulated: ${step.title} is ${status}.`] : [],
      ...(step.gate ? { gate: true } : {}),
    };
  });
  return { steps, current: frame.current, route: "film", playbook: "bespoke-film" };
}
