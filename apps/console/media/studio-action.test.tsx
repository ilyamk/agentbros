/**
 * The Remotion Studio launcher (2026-11-18): status available → a blank tab opened in the click, then pointed at the
 * server's URL; failure → the tab closed and the message shown; unavailable → the reason and the copy fallback; a
 * project target with several formats asks which; the header button only where Studio can open the project.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FixtureApiClient } from "@/api/fixture";
import { ApiFailure } from "@/api/errors";
import { dictionaries } from "@/i18n";
import { setSnapshotMode } from "@/lib/snapshot-mode";
import { FIXTURE_NOW, fixtureStore, renderWith } from "@/test/utils";
import { launchStudio, OpenInStudio, StudioHeaderButton } from "./studio-action";

const studio = dictionaries.en.media.studio;

function fakeTab() {
  return { location: { href: "" }, close: vi.fn(), opener: {} as unknown };
}

function setup(fixture: "view-film-build" | "view-campaign" | "view-recipe" = "view-film-build") {
  const client = new FixtureApiClient({ fixture, now: () => FIXTURE_NOW });
  const store = fixtureStore(client);
  const tab = fakeTab();
  const calls: string[] = [];
  const open = vi.spyOn(window, "open").mockImplementation(() => {
    calls.push("open");
    return tab as unknown as Window;
  });
  const realOpen = client.studioOpen.bind(client);
  const studioOpen = vi.spyOn(client, "studioOpen").mockImplementation(async (project, request) => {
    calls.push("studioOpen");
    const reply = await realOpen(project, request);
    calls.push("studioOpen:resolved");
    return reply;
  });
  return { client, store, tab, open, studioOpen, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  setSnapshotMode(undefined);
});

describe("Open in Remotion Studio", () => {
  it("opens a blank tab in the click, starts Studio, then points the tab at it", async () => {
    const { store, tab, open, studioOpen, calls } = setup();
    renderWith(<OpenInStudio project="promo-acme" composition="Main" />, { store });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: studio.open }));
    await waitFor(() => expect(tab.location.href).toBe("http://127.0.0.1:3000/Film"));
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(calls).toEqual(["open", "studioOpen", "studioOpen:resolved"]);
    expect(tab.opener).toBeNull();
    expect(studioOpen).toHaveBeenCalledWith("promo-acme", {});
    expect(tab.close).not.toHaveBeenCalled();
    expect(await screen.findByText(studio.opened)).toBeTruthy();
  });

  it("shows progress while Studio starts", async () => {
    const { store, studioOpen } = setup();
    let release: (value: { ok: true; url: string; reused: boolean }) => void = () => {};
    studioOpen.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    renderWith(<OpenInStudio project="promo-acme" />, { store });
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: studio.open });
    await user.click(button);
    expect(await screen.findByText(studio.starting)).toBeTruthy();
    expect(button.hasAttribute("disabled")).toBe(true);
    release({ ok: true, url: "http://127.0.0.1:3000/X", reused: true });
    expect(await screen.findByText(studio.reused)).toBeTruthy();
  });

  it("closes the tab and says why when Studio does not start", async () => {
    const { store, tab, studioOpen } = setup();
    studioOpen.mockRejectedValue(new ApiFailure("CONSOLE_CLI_FAILED", "port 3000 is taken", 500));
    renderWith(<OpenInStudio project="promo-acme" />, { store });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: studio.open }));
    expect(await screen.findByText("Studio did not start: port 3000 is taken")).toBeTruthy();
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe("");
  });

  it("says when the browser blocks the tab and asks nothing of the server", async () => {
    const { store, open, studioOpen } = setup();
    open.mockImplementation(() => null);
    renderWith(<OpenInStudio project="promo-acme" />, { store });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: studio.open }));
    expect(await screen.findByText(studio.popupBlocked)).toBeTruthy();
    expect(studioOpen).not.toHaveBeenCalled();
  });

  it("where unavailable, gives the reason and keeps the copyable command", async () => {
    const { store, open } = setup("view-campaign");
    renderWith(<OpenInStudio project="spring-campaign" composition="Main" />, { store });
    expect(await screen.findByText(/Studio cannot open this project: A campaign container/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: studio.open }));
    expect(screen.getByText("pnpm studio")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it("asks for the format of a project target with several", async () => {
    const { store, studioOpen, tab } = setup("view-recipe");
    renderWith(<OpenInStudio project="recipe-launch" />, { store });
    const format = await screen.findByRole("combobox", { name: studio.format });
    expect(format.textContent).toContain(studio.formats.vertical);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: studio.open }));
    await waitFor(() => expect(studioOpen).toHaveBeenCalledWith("recipe-launch", { format: "vertical" }));
    await waitFor(() => expect(tab.location.href).toBe("http://127.0.0.1:3000/ProjectVertical"));
  });

  it("the header button shows only where Studio can open the project, never on a snapshot", async () => {
    const film = setup();
    const { unmount } = renderWith(<StudioHeaderButton project="promo-acme" />, { store: film.store });
    expect(await screen.findByRole("button", { name: studio.open })).toBeTruthy();
    unmount();
    vi.restoreAllMocks();
    const campaign = setup("view-campaign");
    const status = vi.spyOn(campaign.client, "studioStatus");
    const { container } = renderWith(<StudioHeaderButton project="spring-campaign" />, { store: campaign.store });
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(container.querySelector("[data-studio]")).toBeNull();
    setSnapshotMode({ project: "promo-acme", takenAt: "2026-11-17T09:18:00Z" });
    const snap = renderWith(<OpenInStudio project="promo-acme" />, { store: film.store });
    expect(snap.container.textContent).toBe("");
  });

  it("several launchers of one project share one status request", async () => {
    const { client, store } = setup();
    const status = vi.spyOn(client, "studioStatus");
    renderWith(
      <>
        <OpenInStudio project="promo-acme" />
        <OpenInStudio project="promo-acme" />
        <StudioHeaderButton project="promo-acme" />
      </>,
      { store },
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: studio.open })).toHaveLength(3));
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("launchStudio clears the session the blank tab inherited before cutting its opener", async () => {
    const order: string[] = [];
    const tab = {
      location: { href: "" },
      close: vi.fn(),
      sessionStorage: { clear: () => order.push("clear") },
      set opener(_value: unknown) {
        order.push("opener");
      },
    };
    const client = new FixtureApiClient({ fixture: "view-film-build", now: () => FIXTURE_NOW });
    const result = await launchStudio(client, "promo-acme", undefined, () => tab as unknown as Window);
    expect(result.ok).toBe(true);
    expect(order).toEqual(["clear", "opener"]);
    expect(tab.location.href).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it("launchStudio still opens Studio when the tab's sessionStorage cannot be reached", async () => {
    const tab = {
      location: { href: "" },
      close: vi.fn(),
      opener: {} as unknown,
      get sessionStorage(): Storage {
        throw new DOMException("denied", "SecurityError");
      },
    };
    const client = new FixtureApiClient({ fixture: "view-film-build", now: () => FIXTURE_NOW });
    const result = await launchStudio(client, "promo-acme", undefined, () => tab as unknown as Window);
    expect(result.ok).toBe(true);
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
  });

  it("launchStudio without server routes closes the tab", async () => {
    const tab = fakeTab();
    const client = new FixtureApiClient();
    const bare = { ...client, mode: "http" as const, studioOpen: undefined } as unknown as FixtureApiClient;
    const result = await launchStudio(bare, "promo-acme", undefined, () => tab as unknown as Window);
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(tab.close).toHaveBeenCalled();
  });
});
