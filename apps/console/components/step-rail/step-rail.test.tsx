import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectViewSchema, STEP_STATUSES, type StepRow, type StepStatus } from "@contract";
import { FIXTURES } from "@/lib/fixtures";
import { renderWith } from "@/test/utils";
import { StepRail, StepTrack } from "./index";
import { StepMarker } from "./marker";
import { MOTIONS, railInput, railProgress, stepMotion, stepOrigin, type RailInput } from "./model";

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

const every = FIXTURES["view-step-rail"];
const template = railInput(FIXTURES["view-recipe"]);
const row = (id: string, status: StepStatus = "pending"): StepRow => ({ id, title: id, status, reasons: [] });

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
    expect(stepOrigin({ ...template, steps: [...template.steps, row("model", "running")] })).toBe("route");
  });

  it("counts position and closed steps", () => {
    expect(railProgress(template)).toMatchObject({ total: 3, closed: 0, position: 1 });
    expect(railProgress(template).nextStep?.id).toBe("qa");
    const closed: RailInput = {
      ...template,
      current: undefined,
      steps: template.steps.map((s) => ({ ...s, status: "done" })),
    };
    expect(railProgress(closed)).toMatchObject({ total: 3, closed: 3, position: undefined });
  });

  it("parses the every-status fixture through the contract", () => {
    expect(() => ProjectViewSchema.parse(every)).not.toThrow();
    expect(every.steps.map((step) => step.status)).toEqual([...STEP_STATUSES]);
  });
});

describe("StepMarker", () => {
  it.each(STEP_STATUSES)("renders %s with its motion, animated only when motion is allowed", (status) => {
    const { container } = renderWith(<StepMarker status={status} number={3} />);
    expect(container.querySelector("[data-motion]")!.getAttribute("data-motion")).toBe(EXPECTED_MOTION[status]);
    const animation = ANIMATION[EXPECTED_MOTION[status]!];
    if (animation) expect(container.innerHTML).toContain(animation);
    for (const match of container.innerHTML.matchAll(/([^\s"]*)animate-rail-[a-z]+/g))
      expect(match[1]).toBe("motion-safe:");
  });

  it("draws a check on done and a halo on a gate", () => {
    expect(renderWith(<StepMarker status="done" />).container.querySelector('[data-part="check"]')).toBeTruthy();
    expect(
      renderWith(<StepMarker status="awaiting-gate" />).container.querySelector('[data-part="halo"]'),
    ).toBeTruthy();
  });
});

describe("StepRail", () => {
  it("renders every status with its name, motion and the current step", () => {
    renderWith(<StepRail view={every} label="Steps" />);
    const nav = screen.getByRole("navigation", { name: "Steps" });
    expect(within(nav).getAllByRole("button")).toHaveLength(STEP_STATUSES.length);
    for (const status of STEP_STATUSES) {
      const button = nav.querySelector(`button[data-status="${status}"]`)!;
      expect(button.querySelector("[data-motion]")?.getAttribute("data-motion"), status).toBe(EXPECTED_MOTION[status]);
      expect(button.textContent).toContain(
        { "awaiting-gate": "Waiting for you", unsealed: "Not sealed", pending: "Not started" }[status as string] ??
          status.charAt(0).toUpperCase(),
      );
    }
    expect(nav.querySelector('[aria-current="step"]')!.getAttribute("data-status")).toBe("running");
    expect(nav.querySelector('button[data-status="awaiting-gate"]')!.textContent).not.toContain("Gate");
  });

  it("shows the progress, the origin and the legend", () => {
    const { container } = renderWith(<StepRail view={FIXTURES["view-recipe"]} label="Steps" />);
    expect(container.querySelector('[data-part="position"]')!.textContent).toBe("Step 1 of 3");
    expect(screen.getByText("0 of 3 closed")).toBeTruthy();
    const origin = container.querySelector("[data-origin]")!;
    expect(origin.getAttribute("data-origin")).toBe("template");
    expect(origin.textContent).toContain("Template steps · 3 steps");
    expect(screen.getByText("What the icons mean")).toBeTruthy();
    expect(container.querySelectorAll("[data-legend]")).toHaveLength(MOTIONS.length);
  });

  it("fills the connector of a closed step and says when all are closed", () => {
    const input: RailInput = {
      ...template,
      current: undefined,
      steps: template.steps.map((s) => ({ ...s, status: "done" })),
    };
    const { container } = renderWith(<StepTrack input={input} label="Steps" />);
    expect(container.querySelector('[data-part="position"]')!.textContent).toBe("All 3 steps closed");
    for (const connector of container.querySelectorAll('[data-part="connector"]'))
      expect(connector.className).toContain("w-full");
  });

  it("selects a step and moves with the arrow keys", async () => {
    const onSelect = vi.fn();
    renderWith(<StepTrack input={template} selected="render" onSelect={onSelect} label="Steps" />);
    const nav = screen.getByRole("navigation", { name: "Steps" });
    const first = nav.querySelector<HTMLButtonElement>('button[data-step="render"]')!;
    expect(first.tabIndex).toBe(0);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("data-step")).toBe("qa");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.getAttribute("data-step")).toBe("delivery");
    await userEvent.setup().click(nav.querySelector<HTMLButtonElement>('button[data-step="qa"]')!);
    expect(onSelect).toHaveBeenCalledWith("qa");
  });

  it("animates in a step added after mount, and keeps the mark across later updates", () => {
    const { rerender, container } = renderWith(<StepTrack input={template} label="Steps" />);
    expect(container.querySelector("[data-added]")).toBeNull();
    const withExtra: RailInput = { ...template, steps: [...template.steps, row("critic-2")] };
    rerender(<StepTrack input={withExtra} label="Steps" />);
    const added = () => [...container.querySelectorAll("[data-added]")];
    expect(added().map((item) => item.getAttribute("data-step-item"))).toEqual(["critic-2"]);
    expect(added()[0]!.className).toContain("motion-safe:animate-rail-enter");
    rerender(<StepTrack input={{ ...withExtra, current: "qa" }} label="Steps" />);
    expect(added().map((item) => item.getAttribute("data-step-item"))).toEqual(["critic-2"]);
  });
});
