import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FixtureApiClient } from "@/api/fixture";
import { HttpApiClient } from "@/api/http";
import { ApiFailure } from "@/api/errors";
import { fixtureProjects, fixtureViews } from "@/lib/fixtures";
import { initPreferences } from "@/lib/preferences";
import { FIXTURE_NOW, fixtureStore } from "@/test/utils";
import { createConsoleStore } from "@/store/store";

async function renderApp(
  hash = "#/",
  client = new FixtureApiClient({ fixture: "view-film-build", now: () => FIXTURE_NOW }),
) {
  window.location.hash = hash;
  initPreferences("?lang=en&theme=dark");
  const store = fixtureStore(client);
  await act(async () => {
    await store.start();
  });
  render(<App store={store} />);
  return { store, client };
}

describe("console shell", () => {
  it("uses the live connection on a Library deep link", async () => {
    const client = new FixtureApiClient({ fixture: "view-film-build", now: () => FIXTURE_NOW });
    const subscribe = vi.spyOn(client, "subscribe");
    const { store } = await renderApp("#/library", client);
    await waitFor(() => expect(subscribe).toHaveBeenCalledExactlyOnceWith(undefined, expect.any(Object)));
    expect(store.getState().stream).toBe("live");
  });

  it("shows that the current tab needs pairing when it has no session", async () => {
    window.location.hash = "#/";
    window.sessionStorage.clear();
    initPreferences("?lang=en&theme=dark");
    const fetch = vi.fn();
    const store = createConsoleStore(new HttpApiClient({ fetch, fragment: {} }));
    await store.start();
    render(<App store={store} />);
    expect(screen.getByText("Session required")).toBeTruthy();
    expect(screen.getByText(/Open a fresh console link in this tab/)).toBeTruthy();
    expect(screen.queryByText("Connecting…")).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith("/api/session", expect.anything());
  });

  it("renders the home page: projects, waiting, deliveries and month spend", async () => {
    await renderApp("#/");
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeTruthy();
    const projects = await screen.findByRole("region", { name: "Projects" });
    for (const project of fixtureProjects.projects)
      expect(within(projects).getByRole("link", { name: new RegExp(`^${project.title ?? project.id}`) })).toBeTruthy();
    expect(screen.getByRole("region", { name: /Waiting for you/ })).toBeTruthy();
    expect(screen.getByText("$3.52")).toBeTruthy();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("lists projects in the sidebar with their waiting count", async () => {
    await renderApp("#/");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    await waitFor(() => expect(within(nav).getByRole("link", { name: /Acme launch promo/ })).toBeTruthy());
    expect(within(nav).getAllByLabelText("1 decision waiting").length).toBeGreaterThan(0);
    expect(within(nav).getByText("Fixture data")).toBeTruthy();
  });

  it("renders the project canvas: top bar, waiting, step rail, panels, done steps", async () => {
    await renderApp("#/projects/promo-acme");
    const top = await screen.findByRole("banner", { name: "Project" });
    expect(within(top).getByRole("heading", { level: 1 }).textContent).toBe("Acme launch promo");
    expect(top.textContent).toContain("motion-engineer is working · 6 min");
    expect(top.textContent).toContain("$3.10 of $10.00");
    expect(top.textContent).toContain("Interactive");
    expect(screen.getByRole("heading", { name: "Waiting for you (1)" })).toBeTruthy();
    const rail = screen.getByRole("navigation", { name: "Steps" });
    expect(within(rail).getAllByRole("button").length).toBe(fixtureViews.filmBuild.steps.length);
    expect(rail.querySelector("[aria-current='step']")?.textContent).toContain("Build");
    for (const title of ["Agent cards", "Money", "Agents", "Assets", "Step guard", "Advisories", "History"])
      expect(screen.getByRole("button", { name: new RegExp(`^${title}`), expanded: undefined })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^9 done steps/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("pauses through a dialog with the user's words and shows the server's refusal verbatim", async () => {
    const client = new FixtureApiClient({ fixture: "view-film-build", now: () => FIXTURE_NOW });
    vi.spyOn(client, "control").mockRejectedValueOnce(
      new ApiFailure("INTERNAL", "console:control is not implemented yet", 501),
    );
    await renderApp("#/projects/promo-acme", client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Pause" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Pause the project.");
    await user.click(within(dialog).getByRole("button", { name: "Pause" }));
    expect(await within(dialog).findByText(/console:control is not implemented yet/)).toBeTruthy();
    expect(client.control).toHaveBeenCalledWith("promo-acme", { state: "paused", answer: "Pause the project." });
    await user.click(within(dialog).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Paused", { selector: "span" })).toBeTruthy();
  });

  it("switches the language from Settings; agent text stays as written", async () => {
    await renderApp("#/settings");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: "Language" }));
    await user.click(await screen.findByRole("option", { name: "Русский" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Настройки" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("ru");
    window.location.hash = "#/projects/promo-acme";
    expect(await screen.findByText("Voice 2 matches the brief's warm, direct tone.")).toBeTruthy();
    expect((screen.getAllByRole("textbox")[0] as HTMLTextAreaElement).value).toBe("Одобряю: Narration quote.");
  });

  it("opens the search palette with /", async () => {
    await renderApp("#/");
    await screen.findByRole("heading", { level: 1, name: "Home" });
    const user = userEvent.setup();
    await user.keyboard("/");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByPlaceholderText("Search projects, steps and pages…")).toBeTruthy();
  });
});
