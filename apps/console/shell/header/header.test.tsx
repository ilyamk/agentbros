import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectView } from "@contract";
import { FIXTURES } from "@/lib/fixtures";
import { renderWith } from "@/test/utils";
import { ProjectHeader } from "./index";

const film = FIXTURES["view-film-build"];
const withControl = (state: ProjectView["control"]["state"]): ProjectView => ({
  ...film,
  control: { ...film.control, state },
});
const idle: ProjectView = { ...film, agents: { ...film.agents, active: undefined } };

describe("ProjectHeader", () => {
  it("shows identity, the current step, waiting, money, autonomy and the fitting action", () => {
    const { container } = renderWith(<ProjectHeader view={film} page="canvas" />);
    const header = screen.getByRole("banner", { name: "Project" });
    expect(within(header).getByRole("heading", { level: 1 }).textContent).toBe(film.project.title);
    expect(container.querySelector("[data-header-step]")?.getAttribute("data-header-step")).toBe(film.current!.step);
    expect(container.querySelector("[data-header-waiting]")?.textContent).toContain("1 waits for you");
    expect(header.textContent).toContain("$3.10 spent · $1.40 reserved of $10.00");
    expect(within(header).getByRole("button", { name: /Change autonomy and budget/ }).textContent).toContain(
      "Interactive",
    );
    expect(within(header).getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("switches pages with icons and marks the current one", () => {
    renderWith(<ProjectHeader view={film} page="history" />);
    const tabs = screen.getByRole("navigation", { name: film.project.title });
    const links = within(tabs).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Canvas", "Media", "History", "Timeline"]);
    for (const link of links) expect(link.querySelector("svg")).toBeTruthy();
    expect(within(tabs).getByRole("link", { name: "History" }).getAttribute("aria-current")).toBe("page");
  });

  it("says who works, tints the strip by state and breathes only while an agent works", () => {
    const { container, unmount } = renderWith(<ProjectHeader view={film} page="canvas" />);
    expect(container.querySelector("[data-live-strip]")?.getAttribute("data-live-strip")).toBe("working");
    expect(container.querySelector('[data-live="working"]')?.innerHTML).toContain("motion-safe:animate-rail-pulse");
    expect(container.textContent).toContain(`${film.agents.active!.name} is working`);
    unmount();
    const quiet = renderWith(<ProjectHeader view={idle} page="canvas" />);
    expect(quiet.container.querySelector("[data-live-strip]")?.getAttribute("data-live-strip")).toBe("idle");
    expect(quiet.container.querySelector('[data-live="idle"]')?.innerHTML).not.toContain("animate-rail-pulse");
    expect(quiet.container.textContent).toContain("No agent running");
  });

  it("offers resume when paused or stopped and keeps stop in the menu while running", async () => {
    const paused = renderWith(<ProjectHeader view={withControl("paused")} page="canvas" />);
    expect(paused.container.querySelector("[data-live-strip]")?.getAttribute("data-live-strip")).toBe("paused");
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    paused.unmount();
    const stopped = renderWith(<ProjectHeader view={withControl("stopped")} page="canvas" />);
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More project actions" })).toBeNull();
    stopped.unmount();
    renderWith(<ProjectHeader view={film} page="canvas" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "More project actions" }));
    expect(await screen.findByRole("menuitem", { name: "Stop" })).toBeTruthy();
  });

  it("hides the waiting pill when nothing waits", () => {
    const { container } = renderWith(<ProjectHeader view={{ ...film, waiting: [] }} page="canvas" />);
    expect(container.querySelector("[data-header-waiting]")).toBeNull();
  });
});
