/**
 * WP15 route canvases (RFC 0004 US23): replica, recipe and campaign panels over their fixture views, in every language;
 * the replica keeps the film panels for its shared steps; the user's rights words are shown as written.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { dictionaries, LANGUAGES } from "@/i18n";
import { FIXTURES } from "@/lib/fixtures";
import { Canvas } from "@/shell/project";
import { renderWith } from "@/test/utils";
import { panelsFor } from "../registry";
import { registerGenericPanels } from "../generic";
import { registerFilmPanels } from "../film";
import { registerRoutePanels, ROUTE_PANELS } from "./index";

beforeAll(() => {
  registerGenericPanels();
  registerFilmPanels();
  registerRoutePanels();
});

const ids = (view: (typeof FIXTURES)[keyof typeof FIXTURES]) => panelsFor(view).map((panel) => panel.def.id);

describe("route panels", () => {
  it("register for their own route only", () => {
    for (const panel of ROUTE_PANELS) expect(panel.routes).toHaveLength(1);
    expect(ids(FIXTURES["view-film-build"]).some((id) => /^(replica|recipe|campaign)\./.test(id))).toBe(false);
  });

  it("replica: rights, spec and compare beside the film panels of its shared steps", () => {
    const placed = ids(FIXTURES["view-replica"]);
    expect(placed).toEqual(expect.arrayContaining(["replica.rights", "replica.spec", "replica.compare", "film.build"]));
    expect(placed).not.toContain("film.ideas");
    // The compare step fails: its panel is in front of the done steps' panels.
    expect(placed.indexOf("replica.compare")).toBeLessThan(placed.indexOf("replica.rights"));
  });

  it("replica canvas shows the user's words as written, the study-only note, the swaps and the failing measure", async () => {
    renderWith(<Canvas view={FIXTURES["view-replica"]} />);
    const user = userEvent.setup();
    // Rights and spec are done steps: their panels start collapsed.
    for (const id of ["replica.rights", "replica.spec"]) {
      const button = document.querySelector<HTMLButtonElement>(`[data-panel="${id}"] button[aria-expanded]`)!;
      if (button.getAttribute("aria-expanded") === "false") await user.click(button);
    }
    expect(screen.getByText("It is a practice copy of a film I like; keep it private.")).toBeTruthy();
    expect(screen.getByText(/never published/)).toBeTruthy();
    expect(screen.getByText("logo: the reference's logo → a plain wordmark")).toBeTruthy();
    const failed = document.querySelector("tr[data-failed]");
    expect(failed?.textContent).toContain("cuts");
  });

  it("recipe canvas lists every beat with its purpose and flags placeholders", () => {
    renderWith(<Canvas view={FIXTURES["view-recipe"]} />);
    const beats = document.querySelectorAll("[data-beat]");
    expect(beats).toHaveLength(3);
    expect(screen.getByText("Stop the scroll in the first second")).toBeTruthy();
    expect(screen.getAllByText(dictionaries.en.routes.recipe.placeholder)).toHaveLength(2);
    expect(screen.getByText("Draft: no approved music/mix")).toBeTruthy();
  });

  it("campaign canvas counts members and links the review on the Timeline page", () => {
    renderWith(<Canvas view={FIXTURES["view-campaign"]} />);
    const table = screen.getByRole("region", { name: dictionaries.en.routes.campaign.member });
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    const link = screen.getByRole("link", { name: dictionaries.en.routes.campaign.review });
    expect(link.getAttribute("href")).toBe("#/projects/spring-campaign/timeline");
  });

  it("renders in every language without missing strings", () => {
    for (const language of LANGUAGES) {
      const { unmount } = renderWith(<Canvas view={FIXTURES["view-replica"]} />, { language });
      expect(screen.getAllByText(dictionaries[language].routes.titles.replicaSpec).length).toBeGreaterThan(0);
      unmount();
    }
  });
});
