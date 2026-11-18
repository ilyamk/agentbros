import { afterEach, describe, expect, it } from "vitest";
import { fixtureViews } from "@/lib/fixtures";
import { panelsFor, registerPanel, registeredPanels, unregisterPanel, type PanelDef } from "./registry";
import { GENERIC_PANELS, registerGenericPanels } from "./generic";

registerGenericPanels();

const Empty = () => null;
const def = (id: string, weight: number, extra: Partial<PanelDef> = {}): PanelDef => ({
  id,
  routes: ["film"],
  when: () => true,
  weight: () => weight,
  component: Empty,
  ...extra,
});

describe("panel registry", () => {
  afterEach(() => {
    for (const id of ["t.a", "t.b", "t.c", "t.footage", "t.broken"]) unregisterPanel(id);
  });

  it("registers the generic panels for every route", () => {
    const ids = registeredPanels().map((panel) => panel.id);
    for (const panel of GENERIC_PANELS) expect(ids).toContain(panel.id);
    expect(panelsFor(fixtureViews.footage).map((placed) => placed.def.id)).toEqual(
      expect.arrayContaining(["generic.money", "generic.agents", "generic.history"]),
    );
  });

  it("filters by route and when, orders by weight, then id; reports collapsed", () => {
    registerPanel(def("t.a", 500));
    registerPanel(def("t.b", 500, { collapsedWhen: () => true }));
    registerPanel(def("t.c", 501, { when: () => false }));
    registerPanel(def("t.footage", 900, { routes: ["footage"] }));
    registerPanel(
      def("t.broken", 900, {
        when: () => {
          throw new Error("bad panel");
        },
      }),
    );
    const placed = panelsFor(fixtureViews.filmBuild);
    expect(placed.slice(0, 2).map((item) => [item.def.id, item.collapsed])).toEqual([
      ["t.a", false],
      ["t.b", true],
    ]);
    const ids = placed.map((item) => item.def.id);
    expect(ids).not.toContain("t.c");
    expect(ids).not.toContain("t.footage");
    expect(ids).not.toContain("t.broken");
  });

  it("puts open agent cards first and collapses quiet panels", () => {
    const placed = panelsFor(fixtureViews.filmBuild);
    expect(placed[0]?.def.id).toBe("generic.cards");
    expect(placed.find((item) => item.def.id === "generic.history")?.collapsed).toBe(true);
    expect(placed.find((item) => item.def.id === "generic.agents")?.collapsed).toBe(false);
    expect(panelsFor(fixtureViews.empty).some((item) => item.def.id === "generic.cards")).toBe(false);
  });
});
