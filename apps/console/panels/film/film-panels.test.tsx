import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectViewSchema, type Decision, type ProjectView, type StepStatus } from "@contract";
import { FixtureApiClient } from "@/api/fixture";
import { dictionaries, LANGUAGES } from "@/i18n";
import { fixtureViews } from "@/lib/fixtures";
import { Canvas } from "@/shell/project";
import { FIXTURE_NOW, fixtureStore, renderWith } from "@/test/utils";
import { panelsFor, registeredPanels, WEIGHT, type PanelDef } from "../registry";
import { registerGenericPanels } from "../generic";
import { FILM_PANELS, registerFilmPanels } from "./index";
import { isSoundClaim, withoutSoundClaims } from "@/lib/sound-claims";
import { FILM_GROUPS, groupOfStep, type FilmGroup } from "./steps";
import { VERDICT_AXES } from "./verdict";

beforeAll(() => {
  registerGenericPanels();
  registerFilmPanels();
});

const SHA = (c: string) => c.repeat(64);

/** The fixtures' step order (short aliases), plus the chain's own ids where they differ. */
const ORDER = [
  "intake",
  "strategy",
  "discovery",
  "ideas",
  "music",
  "script",
  "look",
  "beats",
  "material",
  "narration",
  "animatic",
  "build",
  "critic",
  "qa",
  "delivery",
  "human",
];

/** A film view whose steps before `current` are done, `current` is ready (or `status`), the rest pending. */
function viewAt(
  current: string,
  {
    status = "ready",
    order = ORDER,
    waiting = [],
    patch = {},
  }: {
    status?: StepStatus;
    order?: string[];
    waiting?: Decision[];
    patch?: Partial<ProjectView>;
  } = {},
): ProjectView {
  // Without the film material (WP10b): these tests pin the panels' behaviour from the steps and decisions alone.
  const { film: _material, ...base } = fixtureViews.filmScriptGate;
  const at = order.indexOf(current);
  return ProjectViewSchema.parse({
    ...base,
    steps: order.map((id, index) => ({
      id,
      title: id,
      status: index < at ? "done" : index === at ? status : "pending",
      reasons: [],
      ...(index < at ? { durationMs: 60_000 } : {}),
    })),
    current: { step: current, next: { argv: ["pnpm", "film:next", "--project", base.project.id], why: "next" } },
    waiting,
    ...patch,
  });
}

const placed = (view: ProjectView, id: string) => panelsFor(view).find((panel) => panel.def.id === id);
const def = (id: string) => FILM_PANELS.find((panel) => panel.id === id) as PanelDef;

describe("film panel registration", () => {
  it("registers one film panel per step group, for the film route only", () => {
    const ids = registeredPanels()
      .filter((panel) => panel.id.startsWith("film."))
      .map((panel) => panel.id)
      .sort();
    expect(ids).toEqual(
      Object.keys(FILM_GROUPS)
        .map((group) => `film.${group}`)
        .sort(),
    );
    for (const panel of FILM_PANELS) expect(panel.routes).toEqual(["film", "replica"]);
    expect(panelsFor(fixtureViews.footage).some((panel) => panel.def.id.startsWith("film."))).toBe(false);
  });

  it("maps every chain step id and fixture alias to one group", () => {
    const chain = [
      ["intake", "brief"],
      ["rights", "brief"],
      ["strategy", "brief"],
      ["discovery", "discovery"],
      ["truth", "discovery"],
      ["ideas", "ideas"],
      ["idea-review", "ideas"],
      ["concept", "ideas"],
      ["music", "music"],
      ["audio-map", "music"],
      ["script-variants", "script"],
      ["script-review", "script"],
      ["script", "script"],
      ["look", "look"],
      ["beat-sheet", "beats"],
      ["beats", "beats"],
      ["material", "material"],
      ["narration", "narration"],
      ["animatic", "build"],
      ["build", "build"],
      ["sound", "build"],
      ["critic", "critic"],
      ["measure", "critic"],
      ["qa", "qa"],
      ["delivery", "qa"],
      ["human", "human"],
    ] as const;
    for (const [step, group] of chain) expect(groupOfStep(step), step).toBe(group);
  });
});

describe("when, weight and collapse per step", () => {
  const cases: [string, FilmGroup][] = [
    ["intake", "brief"],
    ["strategy", "brief"],
    ["discovery", "discovery"],
    ["ideas", "ideas"],
    ["music", "music"],
    ["script", "script"],
    ["look", "look"],
    ["beats", "beats"],
    ["material", "material"],
    ["narration", "narration"],
    ["animatic", "build"],
    ["build", "build"],
    ["critic", "critic"],
    ["qa", "qa"],
    ["delivery", "qa"],
    ["human", "human"],
  ];

  for (const [step, group] of cases)
    it(`${step}: film.${group} is shown, expanded and first; done panels collapse; later ones are hidden`, () => {
      const view = viewAt(step);
      const panel = placed(view, `film.${group}`);
      expect(panel, "shown").toBeDefined();
      expect(panel?.collapsed).toBe(false);
      expect(panel?.weight).toBeGreaterThanOrEqual(WEIGHT.current);
      expect(panelsFor(view)[0]?.def.id).toBe(`film.${group}`);
      const at = ORDER.indexOf(step);
      for (const other of FILM_PANELS) {
        if (other.id === `film.${group}`) continue;
        const otherGroup = other.id.slice("film.".length) as FilmGroup;
        const ids: readonly string[] = FILM_GROUPS[otherGroup];
        const indexes = ORDER.map((id, index) => (ids.includes(id) ? index : -1)).filter((index) => index >= 0);
        const result = placed(view, other.id);
        if (indexes.every((index) => index < at)) {
          expect(result?.collapsed, `${other.id} done → collapsed`).toBe(true);
          expect(result?.weight ?? 0).toBeLessThan(WEIGHT.normal);
        } else if (indexes.every((index) => index > at) && other.id !== "film.build") {
          expect(result, `${other.id} not reached → hidden`).toBeUndefined();
        }
      }
    });

  it("follows the chain's own ids (beat-sheet, script-review, idea-review, audio-map, measure)", () => {
    const chainOrder = [
      "intake",
      "strategy",
      "idea-review",
      "audio-map",
      "script-review",
      "look",
      "beat-sheet",
      "build",
      "measure",
      "human",
    ];
    for (const [step, id] of [
      ["idea-review", "film.ideas"],
      ["audio-map", "film.music"],
      ["script-review", "film.script"],
      ["beat-sheet", "film.beats"],
      ["measure", "film.critic"],
    ] as const) {
      const view = viewAt(step, { order: chainOrder });
      expect(panelsFor(view)[0]?.def.id, step).toBe(id);
      expect(placed(view, id)?.collapsed).toBe(false);
    }
  });

  it("build fixture: build current and first, narration's waiting quote expanded, brief collapsed, critic and verdict hidden", () => {
    const view = fixtureViews.filmBuild;
    expect(panelsFor(view).find((panel) => panel.def.id.startsWith("film."))?.def.id).toBe("film.build");
    expect(placed(view, "film.build")?.weight).toBe(WEIGHT.current + 5);
    expect(placed(view, "film.narration")).toMatchObject({ collapsed: false, weight: WEIGHT.current + 2 });
    expect(placed(view, "film.brief")?.collapsed).toBe(true);
    expect(placed(view, "film.critic")).toBeUndefined();
    expect(placed(view, "film.human")).toBeUndefined();
    expect(def("film.narration").summary?.(dictionaries.en, view, "en-US")).toBe("Waiting for you");
    expect(def("film.build").summary?.(dictionaries.en, view, "en-US")).toBe("Ready · 1 finding");
    expect(def("film.material").summary?.(dictionaries.en, view, "en-US")).toBe("Done · 1 min · 3 items");
  });

  it("script-gate fixture: the script panel is current and first", () => {
    const view = fixtureViews.filmScriptGate;
    expect(panelsFor(view)[0]?.def.id).toBe("film.script");
    expect(placed(view, "film.script")?.collapsed).toBe(false);
    expect(placed(view, "film.look")).toBeUndefined();
  });

  it("a failing step that is not current is expanded above the quiet panels", () => {
    const view = viewAt("build", { order: ORDER });
    const failing = ProjectViewSchema.parse({
      ...view,
      steps: view.steps.map((step) => (step.id === "look" ? { ...step, status: "failing" } : step)),
    });
    expect(placed(failing, "film.look")).toMatchObject({ collapsed: false });
    expect(placed(failing, "film.look")?.weight).toBeGreaterThanOrEqual(WEIGHT.attention);
  });

  it("never throws on a view without steps, current or media", () => {
    const bare = ProjectViewSchema.parse({ ...fixtureViews.filmScriptGate, steps: [], current: undefined });
    for (const panel of FILM_PANELS) {
      expect(() => panel.when(bare)).not.toThrow();
      expect(() => panel.weight(bare)).not.toThrow();
      expect(() => panel.collapsedWhen?.(bare)).not.toThrow();
      expect(() => panel.summary?.(dictionaries.en, bare, "en-US")).not.toThrow();
      expect(panel.when(bare)).toBe(false);
    }
  });
});

describe("titles and summaries in every language", () => {
  it("has a title for every panel, verdict axis names and no unfilled placeholder in summaries", () => {
    for (const language of LANGUAGES) {
      const d = dictionaries[language];
      for (const panel of FILM_PANELS) {
        const title = panel.title?.(d, fixtureViews.filmBuild);
        expect(title, `${language} ${panel.id}`).toBeTruthy();
        const summary = panel.summary?.(d, fixtureViews.filmBuild, "en-US");
        if (summary) expect(summary).not.toMatch(/\{\w+\}/);
      }
      for (const axis of VERDICT_AXES)
        expect((d.film.verdict.axisNames as Record<string, string>)[axis], `${language} ${axis}`).toBeTruthy();
    }
  });

  it("renders every reached panel in en, ru and zh-Hans", () => {
    const view = ProjectViewSchema.parse({
      ...fixtureViews.filmBuild,
      steps: fixtureViews.filmBuild.steps.map((step) => ({ ...step, status: "done" })),
      current: { ...fixtureViews.filmBuild.current!, step: "human" },
      waiting: [],
      qa: { ...fixtureViews.filmBuild.qa, delivery: { ok: true, checkedAt: "2026-11-17T09:15:00Z" } },
    });
    for (const language of LANGUAGES) {
      for (const panel of FILM_PANELS) {
        if (!panel.when(view)) continue;
        const { container, unmount } = renderWith(<panel.component view={view} />, { language });
        expect(container.textContent, `${language} ${panel.id}`).not.toMatch(/\{\w+\}/);
        unmount();
      }
    }
  });
});

describe("panel content", () => {
  it("script gate: blind pool material, no author, and a pointer that focuses the pinned decision card", async () => {
    const view = fixtureViews.filmScriptGate;
    renderWith(<Canvas view={view} />);
    const panel = document.querySelector('[data-panel="film.script"]') as HTMLElement;
    expect(within(panel).getByText(/Shown blind/)).toBeTruthy();
    expect(within(panel).getByText("Script B")).toBeTruthy();
    expect(within(panel).queryByText(/creative-director/)).toBeNull();
    expect(document.querySelectorAll('[data-card="decision"]')).toHaveLength(1);
    await userEvent.setup().click(within(panel).getByRole("button", { name: "Go to the decision" }));
    expect(document.activeElement?.getAttribute("data-decision")).toBe("dec-script-gate");
  });

  it("build: animatic, latest render, frame strip and the motion:check finding with its frame", () => {
    renderWith(<Canvas view={fixtureViews.filmBuild} />);
    const panel = document.querySelector('[data-panel="film.build"]') as HTMLElement;
    expect(within(panel).getByText("Animatic v3")).toBeTruthy();
    expect(within(panel).getAllByText("Scene 3").length).toBeGreaterThan(0);
    expect(within(panel).getByText("Frame strip")).toBeTruthy();
    expect(within(panel).getByText("Text leaves the safe zone.")).toBeTruthy();
    expect(within(panel).getByText("Frame 212")).toBeTruthy();
    expect(within(panel).getByText("Critic round 2: 8.1")).toBeTruthy();
  });

  it("material: source, licence, cost and the step's paid jobs", () => {
    renderWith(<Canvas view={fixtureViews.filmBuild} />);
    const panel = document.querySelector('[data-panel="film.material"]') as HTMLElement;
    within(panel).getByRole("button", { expanded: false }).click();
    return waitFor(() => {
      const table = within(panel).getByRole("table");
      expect(within(table).getByText("Pixabay Content License")).toBeTruthy();
      expect(within(table).getAllByText("No licence recorded")).toHaveLength(2);
      expect(within(table).getByText("$0.80")).toBeTruthy();
      expect(within(panel).getByText("fal-ai/flux-pro/v1.1")).toBeTruthy();
      expect(within(panel).getByText("unknown price")).toBeTruthy();
    });
  });

  it("qa: the delivery check per format and the findings", () => {
    const view = viewAt("delivery", {
      patch: {
        qa: {
          findings: [{ id: "q1", severity: "error", source: "qa:editorial", message: "Caption overlaps the logo." }],
          delivery: {
            ok: false,
            checkedAt: "2026-11-17T09:10:00Z",
            formats: [
              { format: "vertical", ok: true },
              { format: "square", ok: false },
            ],
          },
        },
      },
    });
    renderWith(<Canvas view={view} />);
    const panel = document.querySelector('[data-panel="film.qa"]') as HTMLElement;
    expect(within(panel).getByText("Caption overlaps the logo.")).toBeTruthy();
    expect(within(panel).getAllByText("Failed").length).toBe(2);
    expect(within(panel).getByText("Passed")).toBeTruthy();
    expect(def("film.qa").summary?.(dictionaries.en, view, "en-US")).toBe("Ready · Failed");
  });

  it("music: shows no agent recommendation at all and filters sound claims", () => {
    const decision: Decision = {
      ...fixtureViews.filmScriptGate.waiting[0]!,
      id: "dec-music",
      step: "music",
      kind: "choice",
      title: "Choose the music",
      recommendation: { by: "sound-director", text: "Track 2 sounds great." },
      media: [{ path: "music/track-02.mp3", kind: "audio", label: "Track 2" }],
    };
    const view = viewAt("music", { waiting: [decision] });
    renderWith(<Canvas view={view} />);
    const panel = document.querySelector('[data-panel="film.music"]') as HTMLElement;
    expect(within(panel).getByText("Track 2")).toBeTruthy();
    expect(screen.queryByText(/sounds great/)).toBeNull();
    expect(isSoundClaim("Track 2 sounds great.")).toBe(true);
    expect(isSoundClaim("The mix is balanced")).toBe(true);
    expect(isSoundClaim("Voice 2 matches the brief's warm, direct tone.")).toBe(false);
    expect(withoutSoundClaims(decision).recommendation).toBeUndefined();
    const script = fixtureViews.filmScriptGate.waiting[0]!;
    expect(withoutSoundClaims(script)).toBe(script);
  });
});

describe("pool choice through the generic decision card", () => {
  const pool: Decision = {
    v: 1,
    id: "dec-ideas-pick",
    project: "teaser-nova",
    kind: "choice",
    step: "idea-review",
    title: "Choose an idea",
    summary: "Blind round 1: two ideas pass.",
    bindTo: [{ path: "pipeline/idea-review.json", sha256: SHA("a") }],
    expect: SHA("e"),
    media: [
      { path: "pipeline/ideas/idea-c.md", kind: "document", label: "Idea C" },
      { path: "pipeline/ideas/idea-a.md", kind: "document", label: "Idea A" },
    ],
    options: [
      {
        id: "idea-c",
        label: "Idea C",
        argv: ["pnpm", "film:approve", "--project", "teaser-nova", "--step", "idea-review", "--answer", "<words>"],
      },
      {
        id: "idea-a",
        label: "Idea A",
        argv: ["pnpm", "film:approve", "--project", "teaser-nova", "--step", "idea-review", "--answer", "<words>"],
      },
    ],
    status: "pending",
    createdAt: "2026-11-17T09:10:00Z",
  };

  it("lists candidates in label order and sends the option's choice id with the prefilled words", async () => {
    const view = viewAt("idea-review", {
      order: ["intake", "strategy", "ideas", "idea-review", "music", "human"],
      waiting: [pool],
    });
    const client = new FixtureApiClient({ fixture: "view-film-script-gate", now: () => FIXTURE_NOW });
    const store = fixtureStore(client);
    (client as unknown as { views: Map<string, ProjectView> }).views.set(view.project.id, view);
    const decide = vi.spyOn(store, "decide");
    renderWith(<Canvas view={view} />, { store });
    const panel = document.querySelector('[data-panel="film.ideas"]') as HTMLElement;
    const candidates = within(panel)
      .getAllByRole("listitem")
      .filter((item) => item.hasAttribute("data-candidate"))
      .map((item) => item.textContent);
    expect(candidates).toEqual(["Idea A", "Idea C"]);
    expect(def("film.ideas").summary?.(dictionaries.en, view, "en-US")).toBe("Waiting for you · 2 candidates");

    const card = document.querySelector('[data-decision="dec-ideas-pick"]') as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Idea A" }));
    expect((within(card).getByLabelText("Your words") as HTMLTextAreaElement).value).toBe("Choose Idea A.");
    await user.click(within(card).getByRole("button", { name: "Idea A · Send" }));
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide).toHaveBeenCalledWith("teaser-nova", {
      decisionId: "dec-ideas-pick",
      choice: "idea-a",
      answer: "Choose Idea A.",
      expect: SHA("e"),
    });
  });

  it("prefills the choice phrase in Russian", async () => {
    const view = viewAt("idea-review", {
      order: ["intake", "strategy", "ideas", "idea-review", "human"],
      waiting: [pool],
    });
    renderWith(<Canvas view={view} />, { language: "ru" });
    const card = document.querySelector('[data-decision="dec-ideas-pick"]') as HTMLElement;
    await userEvent.setup().click(within(card).getByRole("button", { name: "Idea A" }));
    expect((within(card).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Выбираю Idea A.");
  });
});
