import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectView } from "@contract";
import { FIXTURES } from "@/lib/fixtures";
import { renderWith } from "@/test/utils";
import { HEADER_CONCEPTS } from "./concepts";
import { HeaderPreview } from "./preview";

const film = FIXTURES["view-film-build"];
const withControl = (state: ProjectView["control"]["state"]): ProjectView => ({
  ...film,
  control: { ...film.control, state },
});
const idle: ProjectView = { ...film, agents: { ...film.agents, active: undefined } };

describe.each(Object.entries(HEADER_CONCEPTS))("header concept %s", (name, Header) => {
  it("shows identity, the current step, waiting, money and the fitting action", () => {
    const { container } = renderWith(<Header view={film} page="canvas" />);
    const header = screen.getByRole("banner", { name: "Project" });
    expect(header.getAttribute("data-header-concept")).toBe(name);
    expect(within(header).getByRole("heading", { level: 1 }).textContent).toBe(film.project.title);
    expect(container.querySelector("[data-header-step]")?.getAttribute("data-header-step")).toBe(film.current!.step);
    expect(container.querySelector("[data-header-waiting]")?.textContent).toContain("1 waits for you");
    expect(container.querySelector("[data-header-spend]")?.textContent).toMatch(/\$3\.10.*of \$10\.00/);
    expect(within(header).getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "Stop" })).toBeNull();
    const tabs = within(header).getByRole("navigation", { name: film.project.title });
    expect(within(tabs).getByRole("link", { name: "Canvas" }).getAttribute("aria-current")).toBe("page");
  });

  it("says who works and breathes only while an agent works", () => {
    const { container, unmount } = renderWith(<Header view={film} page="canvas" />);
    expect(container.querySelector('[data-live="working"]')?.innerHTML).toContain("motion-safe:animate-rail-pulse");
    expect(container.textContent).toContain(film.agents.active!.name);
    unmount();
    const quiet = renderWith(<Header view={idle} page="canvas" />);
    expect(quiet.container.querySelector('[data-live="idle"]')?.innerHTML).not.toContain("animate-rail-pulse");
    expect(quiet.container.textContent).toContain("No agent working");
  });

  it("offers resume when paused and keeps stop in the menu while running", async () => {
    const paused = renderWith(<Header view={withControl("paused")} page="canvas" />);
    expect(paused.container.textContent).toContain("Paused by you");
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    paused.unmount();
    renderWith(<Header view={film} page="history" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "More project actions" }));
    expect(await screen.findByRole("menuitem", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Change autonomy and budget" })).toBeTruthy();
  });

  it("hides the waiting pill when nothing waits", () => {
    const { container } = renderWith(<Header view={{ ...film, waiting: [] }} page="canvas" />);
    expect(container.querySelector("[data-header-waiting]")).toBeNull();
  });
});

describe("HeaderPreview", () => {
  it("renders the page's own header by default and a concept from the query", async () => {
    window.history.replaceState(null, "", "/");
    renderWith(
      <HeaderPreview view={film} page="canvas">
        <p>legacy header</p>
      </HeaderPreview>,
    );
    expect(screen.getByText("legacy header")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "C · Live strip" }));
    expect(screen.queryByText("legacy header")).toBeNull();
    expect(document.querySelector('[data-header-concept="c"]')).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("header")).toBe("c");
    window.history.replaceState(null, "", "/");
  });
});
