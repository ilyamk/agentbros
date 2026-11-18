/**
 * The editing table (2026-11-18): "Editing table" opens the Timeline page in a new tab with an opener (so the session
 * travels in sessionStorage); "Edit myself" opens it first, then pauses with the editing-table marker; the Timeline page
 * shows the banner for that pause only, and "Done" resumes with the user's words and the revision when known.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectView } from "@contract";
import { FixtureApiClient } from "@/api/fixture";
import { dictionaries } from "@/i18n";
import { fixtureViews } from "@/lib/fixtures";
import { setSnapshotMode } from "@/lib/snapshot-mode";
import { FIXTURE_NOW, fixtureStore, renderWith } from "@/test/utils";
import {
  EDITING_TABLE_REASON,
  EditingBanner,
  EditingTableActions,
  editingTableUrl,
  isEditingPause,
} from "./editing-table";
import { ProjectPage } from "./project";

const PROJECT = "promo-acme";
const en = dictionaries.en.editing;

function setup() {
  const client = new FixtureApiClient({ fixture: "view-film-build", now: () => FIXTURE_NOW });
  const store = fixtureStore(client);
  const calls: string[] = [];
  const open = vi.spyOn(window, "open").mockImplementation(() => {
    calls.push("open");
    return {} as Window;
  });
  const control = vi.spyOn(store, "control");
  const realControl = client.control.bind(client);
  vi.spyOn(client, "control").mockImplementation(async (project, request) => {
    calls.push(`control:${request.state}`);
    return realControl(project, request);
  });
  return { client, store, open, control, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  setSnapshotMode(undefined);
});

describe("editing table", () => {
  it("builds the Timeline URL from this page's path and query", () => {
    const location = { pathname: "/", search: "?fixture=view-film-build&lang=ru" } as Location;
    expect(editingTableUrl("promo-acme", location)).toBe(
      "/?fixture=view-film-build&lang=ru#/projects/promo-acme/timeline",
    );
  });

  it("detects only the editing-table pause", () => {
    expect(isEditingPause({ state: "paused", reason: EDITING_TABLE_REASON })).toBe(true);
    expect(isEditingPause({ state: "paused" })).toBe(false);
    expect(isEditingPause({ state: "paused", reason: "lunch" })).toBe(false);
    expect(isEditingPause({ state: "running", reason: EDITING_TABLE_REASON })).toBe(false);
  });

  it("opens the Timeline page in a new tab with an opener (no noopener) and does not pause", async () => {
    const { store, open, control } = setup();
    renderWith(<ProjectPage project={PROJECT} view="canvas" />, { store });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.open }));
    expect(open).toHaveBeenCalledWith(`/#/projects/${PROJECT}/timeline`, "_blank");
    // Exactly two arguments: no "noopener" feature string.
    expect(open.mock.calls[0]).toHaveLength(2);
    expect(control).not.toHaveBeenCalled();
  });

  it("Edit myself opens the tab first, then pauses with the marker; the Timeline page shows the banner; Done resumes", async () => {
    const { store, client, calls } = setup();
    const user = userEvent.setup();
    const { unmount } = renderWith(<ProjectPage project={PROJECT} view="timeline" />, { store });
    expect(screen.queryByRole("region", { name: en.bannerTitle })).toBeNull();
    await user.click(await screen.findByRole("button", { name: en.more }));
    await user.click(await screen.findByRole("menuitem", { name: en.myself }));
    await waitFor(() => expect(calls).toEqual(["open", "control:paused"]));
    expect(client.control).toHaveBeenCalledWith(PROJECT, {
      state: "paused",
      answer: en.pausePhrase,
      reason: EDITING_TABLE_REASON,
    });
    const banner = await screen.findByRole("region", { name: en.bannerTitle });
    expect(banner.textContent).toContain(en.bannerBody);
    await user.click(screen.getByRole("button", { name: en.done }));
    await waitFor(() =>
      expect(client.control).toHaveBeenLastCalledWith(PROJECT, { state: "running", answer: en.resumePhraseNoRevision }),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: en.bannerTitle })).toBeNull());
    // The generic controls still work: the top bar offers Pause again.
    expect(screen.getByRole("button", { name: dictionaries.en.control.pause })).toBeTruthy();
    unmount();
  });

  it("Edit myself is offered only while the project runs", async () => {
    const { store } = setup();
    const paused: ProjectView = { ...fixtureViews.filmBuild, control: { state: "paused" } };
    renderWith(<EditingTableActions view={paused} />, { store });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.more }));
    const item = await screen.findByRole("menuitem", { name: en.myself });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("a blocked tab is said, and nothing is paused", async () => {
    const { store, client } = setup();
    vi.mocked(window.open).mockImplementation(() => null);
    const notify = vi.spyOn(store, "notify");
    renderWith(<EditingTableActions view={fixtureViews.filmBuild} />, { store });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.more }));
    await user.click(await screen.findByRole("menuitem", { name: en.myself }));
    expect(client.control).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: "error", text: en.popupBlocked }));
  });

  it("a refused pause is shown in the opener", async () => {
    const { store, client } = setup();
    vi.mocked(client.control).mockRejectedValue(new Error("server down"));
    const notify = vi.spyOn(store, "notify");
    renderWith(<EditingTableActions view={fixtureViews.filmBuild} />, { store });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.more }));
    await user.click(await screen.findByRole("menuitem", { name: en.myself }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "error", text: "The agent was not paused: server down" }),
      ),
    );
  });

  it("the banner hands back with the timeline revision and is absent for a generic pause", async () => {
    const { store, client } = setup();
    const editing: ProjectView = {
      ...fixtureViews.filmBuild,
      control: { state: "paused", by: "user", reason: EDITING_TABLE_REASON },
    };
    const { rerender } = renderWith(<EditingBanner view={editing} revision={7} />, { store });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.done }));
    await waitFor(() =>
      expect(client.control).toHaveBeenCalledWith(PROJECT, {
        state: "running",
        answer: "I finished editing the timeline myself at revision 7. Continue from there.",
      }),
    );
    rerender(<EditingBanner view={{ ...editing, control: { state: "paused" } }} revision={7} />);
    expect(screen.queryByRole("region", { name: en.bannerTitle })).toBeNull();
  });

  it("is absent on a static snapshot", () => {
    const { store } = setup();
    setSnapshotMode({ project: PROJECT, takenAt: "2026-11-17T09:18:00Z" });
    const { container } = renderWith(<EditingTableActions view={fixtureViews.filmBuild} />, { store });
    expect(container.querySelector("[data-editing-table]")).toBeNull();
  });

  it("speaks Russian and Chinese", () => {
    expect(dictionaries.ru.editing.open).toBe("Монтажный стол");
    expect(dictionaries.ru.editing.myself).toBe("Править самому (агент на паузе)");
    expect(dictionaries["zh-Hans"].editing.open).toBe("剪辑台");
  });
});
