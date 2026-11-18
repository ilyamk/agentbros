/** WP15 library page (RFC 0004 US21): catalogue from the client, search, category filter, previews and credits. */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LibraryResponse } from "@contract";
import { FixtureApiClient } from "@/api/fixture";
import { dictionaries } from "@/i18n";
import { fixtureLibrary } from "@/lib/fixtures";
import { fixtureStore, renderWith } from "@/test/utils";
import { filterLibrary, LibraryPage, previewUrl } from "./index";

const d = dictionaries.en.library;

describe("library", () => {
  it("filters by every word and by category", () => {
    const items = fixtureLibrary.items;
    const first = items[0]!;
    expect(filterLibrary(items, "", "")).toHaveLength(items.length);
    expect(filterLibrary(items, first.title.toUpperCase(), "").map((item) => item.id)).toContain(first.id);
    expect(filterLibrary(items, "", first.category).every((item) => item.category === first.category)).toBe(true);
    expect(filterLibrary(items, "zzz-nothing", "")).toHaveLength(0);
  });

  it("shows the catalogue with previews and credits, searches and filters", async () => {
    renderWith(<LibraryPage />, { store: fixtureStore(new FixtureApiClient()) });
    await screen.findByText(fixtureLibrary.items[0]!.title);
    expect(document.querySelectorAll("[data-block]")).toHaveLength(fixtureLibrary.items.length);
    const img = document.querySelector<HTMLImageElement>(`[data-block="${fixtureLibrary.items[0]!.id}"] img`);
    expect(img?.getAttribute("src")).toBe(previewUrl(fixtureLibrary.items[0]!.id));
    const credited = fixtureLibrary.items.find((item) => item.inspiredBy.length)!;
    expect(screen.getByText(credited.inspiredBy[0]!)).toBeTruthy();

    const user = userEvent.setup();
    const category = fixtureLibrary.categories[1]!;
    await user.click(screen.getByRole("button", { name: new RegExp(`^${category.id}`) }));
    await waitFor(() => expect(document.querySelectorAll("[data-block]")).toHaveLength(category.count));
    await user.click(screen.getByRole("button", { name: new RegExp(`^${d.all}`) }));
    await user.type(screen.getByLabelText(d.search), "zzz-nothing");
    expect(await screen.findByText(d.noMatch)).toBeTruthy();
  });

  it("says so when the client has no library, and offers a retry on failure", async () => {
    const none = new FixtureApiClient();
    Object.defineProperty(none, "library", { value: undefined });
    const first = renderWith(<LibraryPage />, { store: fixtureStore(none) });
    expect(await screen.findByText(d.unavailable)).toBeTruthy();
    first.unmount();

    let calls = 0;
    const failing = new FixtureApiClient();
    Object.defineProperty(failing, "library", {
      value: async (): Promise<LibraryResponse> => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return fixtureLibrary;
      },
    });
    renderWith(<LibraryPage />, { store: fixtureStore(failing) });
    await userEvent.setup().click(await screen.findByRole("button", { name: d.retry }));
    await screen.findByText(fixtureLibrary.items[0]!.title);
  });
});
