/**
 * Footage panels (RFC 0004 US19, A15, WP12): one panel per group of footage:next steps over `view.footage` — the
 * source and transcript, the recut plan with before/after timing and cue markers, caption styles, shorts, cameras,
 * reframe paths and renders. Placement follows the current step; gates without a console command say "in the chat";
 * every language renders without placeholders.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { ProjectViewSchema, type ProjectView } from "@contract";
import { LANGUAGES } from "@/i18n";
import { FIXTURES, fixtureViews } from "@/lib/fixtures";
import { Canvas } from "@/shell/project";
import { renderWith } from "@/test/utils";
import { registerGenericPanels } from "../generic";
import { panelsFor } from "../registry";
import { CaptionsPanel } from "./captions";
import { registerFootagePanels, FOOTAGE_GROUPS, FOOTAGE_PANEL_GROUPS } from "./index";
import { CamerasPanel, RenderPanel, ReframePanel, ShortsPanel } from "./outputs";
import { PlanPanel, planLength, planTiming } from "./plan";
import { SourcePanel, TranscriptPanel } from "./source";

beforeAll(() => {
  registerGenericPanels();
  registerFootagePanels();
});

const planView = fixtureViews.footage;
const renderView = FIXTURES["view-footage-render"];
const patched = (view: ProjectView, footage: Partial<NonNullable<ProjectView["footage"]>> | undefined) =>
  ProjectViewSchema.parse({ ...view, footage: footage === undefined ? undefined : { ...view.footage, ...footage } });

describe("placement", () => {
  it("has one panel per step group", () => {
    expect(FOOTAGE_PANEL_GROUPS).toEqual(Object.keys(FOOTAGE_GROUPS));
  });

  it("leads with the recut plan while its approval waits, and hides groups not reached", () => {
    const ids = panelsFor(planView).map((panel) => panel.def.id);
    expect(ids[0]).toBe("footage.plan");
    expect(ids).toContain("footage.transcript");
    expect(ids).not.toContain("footage.shorts");
    expect(ids).not.toContain("footage.render");
    expect(panelsFor(planView).some((panel) => panel.def.id.startsWith("film."))).toBe(false);
  });

  it("shows the outputs once rendered", () => {
    const ids = panelsFor(renderView).map((panel) => panel.def.id);
    expect(ids[0]).toBe("footage.render");
    for (const id of ["footage.shorts", "footage.cameras", "footage.reframe", "footage.captions"])
      expect(ids).toContain(id);
  });
});

describe("source and transcript", () => {
  it("shows the recording and its transcript excerpt with fillers marked", () => {
    const { container } = renderWith(<SourcePanel view={planView} />);
    expect(container.textContent).toContain("talk.mp4");
    const transcript = renderWith(<TranscriptPanel view={planView} />).container;
    expect(transcript.querySelector(".underline")?.getAttribute("title")).toMatch(/filler/i);
  });

  it("says nothing yet without material", () => {
    renderWith(<TranscriptPanel view={patched(planView, undefined)} />);
    expect(screen.getByText("Nothing to show for this step yet")).toBeTruthy();
  });
});

describe("recut plan", () => {
  it("draws every cut on the before bar, the shorter after bar, the cut list and the stale approval", () => {
    const { container } = renderWith(<PlanPanel view={planView} />);
    const plan = planView.footage!.plan!;
    expect(container.querySelectorAll("[data-cut]")).toHaveLength(plan.cuts.length);
    expect(container.querySelectorAll("[data-cut-row]")).toHaveLength(plan.cuts.length);
    expect(container.querySelector("[data-after-bar]")).toBeTruthy();
    expect(container.querySelector('[role="img"][aria-label]')).toBeTruthy();
    expect(screen.getByText("An older hash is approved; this plan needs a new approval")).toBeTruthy();
    const timing = planTiming(plan, planLength(plan));
    expect(timing.after).toBeLessThan(timing.before);
  });

  it("says approved when the approved hash is the plan's", () => {
    const plan = planView.footage!.plan!;
    renderWith(<PlanPanel view={patched(planView, { plan: { ...plan, approvedEditHash: plan.editHash } })} />);
    expect(screen.getAllByText("Approved").length).toBeGreaterThan(0);
    expect(screen.queryByText(/needs a new approval/)).toBeNull();
  });
});

describe("outputs", () => {
  it("previews the caption styles with the chosen one marked", () => {
    const { container } = renderWith(<CaptionsPanel view={planView} />);
    expect(container.querySelectorAll("[data-caption-style]").length).toBe(planView.footage!.captions!.choices.length);
  });

  it("lists proposed shorts, keeps the others folded, shows angles, reframe and render states", () => {
    const shorts = renderWith(<ShortsPanel view={renderView} />).container;
    expect(shorts.querySelectorAll("[data-short]")).toHaveLength(3);
    expect(shorts.querySelector("details")).toBeTruthy();
    const cameras = renderWith(<CamerasPanel view={renderView} />).container;
    expect(cameras.textContent).toContain("guest");
    const reframe = renderWith(<ReframePanel view={renderView} />).container;
    expect(reframe.querySelector("svg")).toBeTruthy();
    const renders = renderWith(<RenderPanel view={renderView} />).container;
    expect([...renders.querySelectorAll("[data-render]")].map((item) => item.getAttribute("data-render"))).toEqual([
      "landscape",
      "vertical",
      "vertical-clean",
    ]);
    expect(
      within(renders.querySelector('[data-render="vertical"]') as HTMLElement).getAllByText(/Stale/).length,
    ).toBeGreaterThan(0);
  });
});

describe("chat-only gates", () => {
  it("a footage choice without a console command says to answer in the chat", () => {
    const gate = planView.waiting[0]!;
    const view = ProjectViewSchema.parse({
      ...planView,
      waiting: [{ ...gate, step: "5-captions", kind: "choice", options: undefined }],
      current: { ...planView.current, step: "5-captions" },
    });
    renderWith(<CaptionsPanel view={view} />);
    expect(screen.getByRole("note").textContent).toMatch(/Answer this one in the chat/);
  });
});

describe("languages", () => {
  for (const language of LANGUAGES)
    for (const [name, view] of [
      ["plan", planView],
      ["render", renderView],
    ] as const)
      it(`renders every footage panel (${name}) in ${language}`, () => {
        const { container } = renderWith(<Canvas view={view} />, { language });
        for (const button of container.querySelectorAll<HTMLButtonElement>(
          '[data-panel] > h2 > button[aria-expanded="false"]',
        ))
          button.click();
        expect(container.querySelectorAll('[data-panel^="footage."]').length).toBeGreaterThan(2);
        expect(container.textContent).not.toMatch(/\{[a-zA-Z]+\}/);
      });
});
