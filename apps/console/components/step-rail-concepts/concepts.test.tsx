import { describe, expect, it, vi } from "vitest";
import { screen, within, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectViewSchema, STEP_STATUSES, type StepStatus } from "@contract";
import { FIXTURES } from "@/lib/fixtures";
import { renderWith } from "@/test/utils";
import { ConceptA } from "./concept-a";
import { ConceptB } from "./concept-b";
import { ConceptC } from "./concept-c";
import { StepMarker } from "./marker";
import { MOTIONS, railInput, railProgress, stepMotion, stepOrigin, type RailInput } from "./model";
import { everyStatusInput, simulatedInput, SIMULATION_LENGTH } from "./demo";
import { StepRailSwitch } from "./switch";

const CONCEPTS = { a: ConceptA, b: ConceptB, c: ConceptC } as const;

const EXPECTED_MOTION: Record<StepStatus, string> = {
  done: "check",
  skipped: "skipped",
  ready: "ready",
  blocked: "error",
  invalid: "error",
  failing: "error",
  unsealed: "stale",
  stale: "stale",
  "awaiting-gate": "pulse",
  pending: "pending",
  running: "orbit",
};

const ANIMATION: Partial<Record<string, string>> = {
  orbit: "motion-safe:animate-rail-trace",
  pulse: "motion-safe:animate-rail-pulse",
  check: "motion-safe:animate-rail-draw",
  stale: "motion-safe:animate-rail-crawl",
};

const template = railInput(FIXTURES["view-step-rail"]);

describe("step rail model", () => {
  it("maps every status to one motion", () => {
    for (const status of STEP_STATUSES) expect(stepMotion(status)).toBe(EXPECTED_MOTION[status]);
    expect(stepMotion("pending", true)).toBe("orbit");
    expect(new Set(STEP_STATUSES.map((status) => stepMotion(status)))).toEqual(new Set(MOTIONS));
  });

  it("says where steps come from", () => {
    expect(stepOrigin(template)).toBe("template");
    expect(stepOrigin(railInput(FIXTURES["view-film-build"]))).toBe("film");
    expect(stepOrigin(railInput(FIXTURES["view-footage"]))).toBe("footage");
    expect(
      stepOrigin({
        ...template,
        steps: [...template.steps, { id: "model", title: "Model", status: "running", reasons: [] }],
      }),
    ).toBe("route");
  });

  it("counts position and closed steps", () => {
    expect(railProgress(template)).toMatchObject({ total: 4, closed: 0, position: 1 });
    expect(railProgress(template).nextStep?.id).toBe("qa");
    const last = simulatedInput(SIMULATION_LENGTH - 1);
    expect(railProgress(last)).toMatchObject({ total: 8, closed: 8, position: undefined });
  });

  it("parses the preview fixture through the contract", () => {
    expect(() => ProjectViewSchema.parse(FIXTURES["view-step-rail"])).not.toThrow();
    expect(FIXTURES["view-step-rail"].project.route).toBe("timeline");
  });
});

describe("StepMarker", () => {
  it.each(STEP_STATUSES)("renders %s with its motion, animated only when motion is allowed", (status) => {
    const { container } = renderWith(<StepMarker status={status} number={3} />);
    const marker = container.querySelector("[data-motion]")!;
    expect(marker.getAttribute("data-motion")).toBe(EXPECTED_MOTION[status]);
    const animation = ANIMATION[EXPECTED_MOTION[status]!];
    if (animation) expect(container.innerHTML).toContain(animation);
    // Every animation class is behind motion-safe.
    for (const match of container.innerHTML.matchAll(/([^\s"]*)animate-rail-[a-z]+/g))
      expect(match[1]).toBe("motion-safe:");
  });

  it("draws a check on done and a halo on a gate", () => {
    const done = renderWith(<StepMarker status="done" />);
    expect(done.container.querySelector('[data-part="check"]')).toBeTruthy();
    const gate = renderWith(<StepMarker status="awaiting-gate" />);
    expect(gate.container.querySelector('[data-part="halo"]')).toBeTruthy();
  });
});

describe.each(Object.entries(CONCEPTS))("concept %s", (name, Concept) => {
  const every = everyStatusInput();

  it("renders every status with its name, motion and the current step", () => {
    renderWith(<Concept input={every} label="Steps" />);
    const nav = screen.getByRole("navigation", { name: "Steps" });
    const buttons = within(nav).getAllByRole("button");
    expect(buttons).toHaveLength(STEP_STATUSES.length);
    for (const status of STEP_STATUSES) {
      const button = nav.querySelector(`button[data-status="${status}"]`)!;
      expect(button, status).toBeTruthy();
      const motion =
        button.getAttribute("data-motion") ?? button.querySelector("[data-motion]")?.getAttribute("data-motion");
      expect(motion, status).toBe(EXPECTED_MOTION[status]);
    }
    const current = nav.querySelector('[aria-current="step"]')!;
    expect(current.getAttribute("data-status")).toBe("running");
    expect(document.querySelector(`[data-concept="${name}"]`)).toBeTruthy();
  });

  it("shows the progress and the template origin", () => {
    const { container } = renderWith(<Concept input={template} label="Steps" />);
    const position = container.querySelector('[data-part="position"]')!.textContent!;
    expect(position.replace(/\s+/g, " ")).toMatch(name === "b" ? /1 \/ 4/ : /Step 1 of 4/);
    const origin = container.querySelector("[data-origin]")!;
    expect(origin.getAttribute("data-origin")).toBe("template");
    expect(origin.textContent).toContain("Template steps · 4 steps");
    expect(screen.getByText("What the icons mean")).toBeTruthy();
  });

  it("selects a step and moves with the arrow keys", async () => {
    const onSelect = vi.fn();
    renderWith(<Concept input={template} selected="render" onSelect={onSelect} label="Steps" />);
    const nav = screen.getByRole("navigation", { name: "Steps" });
    const first = nav.querySelector<HTMLButtonElement>('button[data-step="render"]')!;
    expect(first.tabIndex).toBe(0);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("data-step")).toBe("qa");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.getAttribute("data-step")).toBe("done");
    await userEvent.setup().click(nav.querySelector<HTMLButtonElement>('button[data-step="delivery"]')!);
    expect(onSelect).toHaveBeenCalledWith("delivery");
  });

  it("marks a step added after the first render so it animates in", () => {
    const before: RailInput = simulatedInput(9);
    const after: RailInput = simulatedInput(10);
    const { rerender, container } = renderWith(<Concept input={before} label="Steps" />);
    expect(container.querySelector("[data-entering]")).toBeNull();
    rerender(<Concept input={after} label="Steps" />);
    const entering = [...container.querySelectorAll("[data-entering]")];
    expect(entering).toHaveLength(1);
    expect(entering[0]!.querySelector("button")?.getAttribute("data-step")).toBe("critic-2");
    expect(entering[0]!.className).toContain("motion-safe:animate-rail-enter");
  });
});

describe("StepRailSwitch", () => {
  it("switches concepts and data sources and keeps the choice in the query", async () => {
    window.history.replaceState(null, "", "/?fixture=view-step-rail#/projects/step-rail-demo");
    const user = userEvent.setup();
    const { container } = renderWith(<StepRailSwitch view={FIXTURES["view-step-rail"]} label="Steps" />);
    expect(container.querySelector("[data-rail-concept]")?.getAttribute("data-rail-concept")).toBe("current");

    await user.click(screen.getByRole("button", { name: "All four" }));
    expect(container.querySelectorAll("[data-rail-preview]")).toHaveLength(4);
    expect(new URLSearchParams(window.location.search).get("rail")).toBe("all");
    for (const name of ["Current", "A · Orbit", "B · Progress bar", "C · Checklist"])
      expect(screen.getByRole("navigation", { name: `Steps (${name})` })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Every status" }));
    expect(new URLSearchParams(window.location.search).get("railData")).toBe("every");
    const nav = screen.getByRole("navigation", { name: "Steps (A · Orbit)" });
    expect(within(nav).getAllByRole("button")).toHaveLength(STEP_STATUSES.length);

    await user.click(screen.getByRole("button", { name: "This project" }));
    expect(new URLSearchParams(window.location.search).get("railData")).toBeNull();
  });

  it("advances the simulated run on a timer", () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/?rail=c&railData=simulate");
      const { container } = renderWith(<StepRailSwitch view={FIXTURES["view-step-rail"]} label="Steps" />);
      const current = () => container.querySelector('[aria-current="step"]')?.getAttribute("data-step");
      expect(current()).toBe("brief");
      act(() => vi.advanceTimersByTime(1800));
      expect(current()).toBe("script");
    } finally {
      vi.useRealTimers();
      window.history.replaceState(null, "", "/");
    }
  });
});
