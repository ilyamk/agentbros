/**
 * The metrics page (RFC 0004 §12, A19, WP12): reads the client's metrics, shows unknown prices beside the sums (never
 * as $0), the months, steps, refusals, agents and projects; every language renders; a client without metrics degrades.
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { LANGUAGES } from "@/i18n";
import { fixtureStore, renderWith } from "@/test/utils";
import { MetricsPage } from "./metrics";

describe("metrics page", () => {
  it("shows decisions, spend with unknown prices, steps and projects", async () => {
    const { container } = renderWith(<MetricsPage />);
    expect(await screen.findByText("Time to decision", { selector: "span" })).toBeTruthy();
    expect(screen.getAllByText("1 item with an unknown price").length).toBeGreaterThan(0);
    expect(screen.getByText("1 project's spend could not be read: unknown, not $0")).toBeTruthy();
    expect(screen.getAllByText("unknown").length).toBeGreaterThan(0);
    expect(screen.getByText("2026-11")).toBeTruthy();
    expect(screen.getByText("STEP_GUARD")).toBeTruthy();
    expect(screen.getByRole("link", { name: "talk-recut" }).getAttribute("href")).toBe("#/projects/talk-recut");
    expect(container.textContent).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("says so when the client has no metrics", async () => {
    const store = fixtureStore();
    Object.defineProperty(store.client, "metrics", { value: undefined });
    renderWith(<MetricsPage />, { store });
    expect(await screen.findByText("Metrics are not available")).toBeTruthy();
  });

  for (const language of LANGUAGES)
    it(`renders in ${language}`, async () => {
      const { container, findAllByRole } = renderWith(<MetricsPage />, { language });
      await findAllByRole("table");
      expect(container.textContent).not.toMatch(/\{[a-zA-Z]+\}/);
    });
});
