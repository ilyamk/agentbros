/**
 * Film panels with their material (RFC 0004 G2, §5.2, WP10b): each panel shows `view.film` beside its decision — the
 * strategy, the claims by status, the blind pools with scores and pairwise results, rated styleframes, the shot list
 * and cue sheet over the music, the takes with their caption words, the critic rounds with ranked fixes and before /
 * after, and the verdict on the project's frozen rubric with the media viewer's frame picker. Blind and sound-claim
 * rules hold; every language renders.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectViewSchema, type ProjectView } from "@contract";
import { LANGUAGES } from "@/i18n";
import { FIXTURES, fixtureViews } from "@/lib/fixtures";
import { DecisionCard } from "@/components/decision-card";
import { Canvas } from "@/shell/project";
import { renderWith } from "@/test/utils";
import { registerGenericPanels } from "../generic";
import { registerFilmPanels } from "./index";
import { BeatsPanel, BriefPanel, DiscoveryPanel } from "./early";
import { LookPanel, NarrationPanel } from "./material";
import { IdeasPanel, ScriptPanel } from "./pool";
import { BuildPanel, CriticPanel } from "./build";
import { VerdictPanel } from "./verdict";

beforeAll(() => {
  registerGenericPanels();
  registerFilmPanels();
});

const build = fixtureViews.filmBuild;
const gate = fixtureViews.filmScriptGate;
const human = FIXTURES["view-film-human"];
const TEAMS = /metaphor|product-in-use|provocation|human-moment|team|author/i;

const patched = (view: ProjectView, film: Partial<NonNullable<ProjectView["film"]>>) =>
  ProjectViewSchema.parse({ ...view, film: { ...view.film, ...film } });

describe("brief and discovery", () => {
  it("shows the proposition, the strategy's lists and both excerpts", () => {
    renderWith(<BriefPanel view={build} />);
    expect(screen.getByText("One list that empties itself as you work.")).toBeTruthy();
    expect(screen.getByText("naming competitors")).toBeTruthy();
    expect(screen.getByText("result first")).toBeTruthy();
    expect(screen.getByText(/^Brief/, { selector: "summary > span" })).toBeTruthy();
    expect(screen.getByText(/^Strategy on one page/, { selector: "summary > span" })).toBeTruthy();
  });

  it("groups the claims by status and lists the clichés and the white space", () => {
    const { container } = renderWith(<DiscoveryPanel view={build} />);
    const claims = container.querySelector("[data-claims]") as HTMLElement;
    expect(within(claims).getByRole("region", { name: "Working" }).textContent).toContain(
      "Drafts replies in your voice",
    );
    expect(within(claims).getByRole("region", { name: "Unverified" }).textContent).toContain("Saves two hours a day");
    expect(container.querySelectorAll("[data-cliches] li")).toHaveLength(3);
    expect(screen.getByText("The reader's side of the reply")).toBeTruthy();
  });

  it("says so when the view carries no discovery material", () => {
    renderWith(<DiscoveryPanel view={ProjectViewSchema.parse({ ...build, film: undefined })} />);
    expect(screen.getByText("The console does not show this step's material yet")).toBeTruthy();
  });
});

describe("blind pools", () => {
  it("lists the ideas by anonymous id with per-axis scores, the agent's top three and pairwise results", () => {
    const { container } = renderWith(<IdeasPanel view={build} />);
    const ids = [...container.querySelectorAll("[data-candidate]")].map((item) => item.getAttribute("data-candidate"));
    expect(ids).toEqual(["I1", "I2", "I3", "I4", "I5", "I6"]);
    const first = container.querySelector('[data-candidate="I1"]') as HTMLElement;
    expect(first.querySelectorAll("[data-scores] > div")).toHaveLength(7);
    expect(within(first).getByText("Your choice")).toBeTruthy();
    expect(within(first).getByLabelText("Picture: 4 of 5")).toBeTruthy();
    const agent = screen.getByRole("complementary", { name: "Agent's view" });
    expect(agent.querySelectorAll("[data-top] li")).toHaveLength(3);
    expect(agent.textContent).toContain("I1 over I2");
    expect(agent.textContent).toContain("the two orders disagree");
    for (const item of container.querySelectorAll("[data-candidate]")) expect(item.textContent).not.toMatch(TEAMS);
  });

  it("shows the script pool before the decision with nothing chosen", () => {
    const { container } = renderWith(<ScriptPanel view={gate} />);
    expect([...container.querySelectorAll("[data-candidate]")].map((el) => el.getAttribute("data-candidate"))).toEqual([
      "S1",
      "S2",
      "S3",
    ]);
    expect(screen.queryByText("Your choice")).toBeNull();
    expect(screen.getByText("Reading overrun")).toBeTruthy();
  });
});

describe("look, beats and narration", () => {
  it("shows each styleframe with the user's rating", () => {
    const { container } = renderWith(<LookPanel view={build} />);
    const frame = container.querySelector('[data-styleframe="pipeline/look/frame-hook.png"]') as HTMLElement;
    expect(frame.textContent).toContain("Your rating: 5 of 5");
    const unrated = container.querySelector('[data-styleframe="pipeline/look/frame-end.png"]') as HTMLElement;
    expect(unrated.textContent).toContain("Not rated yet");
  });

  it("plays the music with the cue markers and lists the shots and cues", () => {
    const { container } = renderWith(<BeatsPanel view={build} />);
    expect(container.querySelectorAll("[data-shot]")).toHaveLength(4);
    expect(container.querySelector('[data-shot="turn"]')?.textContent).toContain("3–8 s");
    expect(container.querySelectorAll("[data-cues] li")).toHaveLength(6);
    expect(container.querySelector("audio")).toBeTruthy();
  });

  it("shows the direction, the takes and their caption words with emphasis", () => {
    const { container } = renderWith(<NarrationPanel view={human} />);
    expect(container.querySelectorAll("[data-direction] li")).toHaveLength(3);
    expect(container.querySelectorAll("[data-take]")).toHaveLength(3);
    const words = container.querySelector('[data-take="voiceover/hook.mp3"] [data-words]') as HTMLElement;
    expect(words.textContent).toBe("Your inbox, empty by nine.");
    expect(words.querySelector("strong")?.textContent).toBe("empty");
  });

  it("drops an agent line claiming the voice sounds good", () => {
    const view = patched(human, {
      narration: { ...human.film!.narration!, voiceWhy: "The voice sounds great over the track." },
    });
    renderWith(<NarrationPanel view={view} />);
    expect(screen.queryByText(/sounds great/)).toBeNull();
  });
});

describe("critic rounds", () => {
  it("shows each round's scores, ranked fixes, frames and the before/after of the previous round", () => {
    const { container } = renderWith(<CriticPanel view={human} />);
    const rounds = [...container.querySelectorAll("[data-critic-round]")].map((el) =>
      el.getAttribute("data-critic-round"),
    );
    expect(rounds).toEqual(["critic-2", "critic-1", "look-2", "look-1"]);
    const first = container.querySelector('[data-critic-round="critic-1"]') as HTMLElement;
    expect(first.querySelectorAll("[data-fixes] li")).toHaveLength(4);
    expect(first.querySelector("[data-compare]")).toBeNull();
    const second = container.querySelector('[data-critic-round="critic-2"]') as HTMLElement;
    expect(second.querySelector("[data-compare]")).toBeTruthy();
    expect(within(second).getByText("Before and after: round 1 and round 2")).toBeTruthy();
    // live styleframes: both look rounds read the same file, so there is no before/after to show
    expect(container.querySelector('[data-critic-round="look-2"] [data-compare]')).toBeNull();
    expect(screen.queryByText(/not in the view yet/)).toBeNull();
  });

  it("never shows a fix that claims something sounds good", () => {
    const rounds = human.film!.critic!.rounds.map((round, index) =>
      index === 2 ? { ...round, fixes: ["The music sounds perfect here", ...round.fixes] } : round,
    );
    renderWith(<CriticPanel view={patched(human, { critic: { rounds } })} />);
    expect(screen.queryByText(/sounds perfect/)).toBeNull();
  });

  it("gives the build panel the critic's trail of rounds", () => {
    const { container } = renderWith(<BuildPanel view={human} />);
    expect(container.querySelector("[data-critic-trail]")?.textContent).toBe("Critic round 1: 24 → Critic round 2: 31");
  });
});

describe("final verdict", () => {
  it("offers the project's frozen rubric axes and the media viewer's frame picker on the film", () => {
    const view = patched(human, { human: { rubric: { version: 1, axes: ["hook", "truth"] } } });
    const { container } = renderWith(<VerdictPanel view={view} />);
    expect([...container.querySelectorAll("[data-axis]")].map((el) => el.getAttribute("data-axis"))).toEqual([
      "hook",
      "truth",
    ]);
    expect(screen.getByText(/Rubric v1/)).toBeTruthy();
    expect(container.querySelector('[data-frame-comment-input="player"]')).toBeTruthy();
    expect(container.querySelectorAll("video")).toHaveLength(1);
  });

  it("the pinned verdict card has no approve button and opens the verdict form", async () => {
    const decision = human.waiting[0]!;
    expect(decision.kind).toBe("verdict");
    expect((decision.options ?? []).map((option) => option.id)).toEqual(["changes"]);
    const { container } = renderWith(
      <>
        <DecisionCard decision={decision} />
        <Canvas view={human} />
      </>,
    );
    const card = container.querySelector('[data-card="decision"]') as HTMLElement;
    expect(within(card).queryByRole("button", { name: /Approve|Accept/ })).toBeNull();
    expect(card.textContent).not.toContain("answer in the chat");
    await userEvent.setup().click(within(card).getByRole("button", { name: "Open the verdict form" }));
    const panel = container.querySelector('[data-panel="film.human"]') as HTMLElement;
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
  });
});

describe("verdict card off the canvas", () => {
  it("goes to the project's canvas when the verdict form is not on the page", async () => {
    window.location.hash = "#/";
    const { container } = renderWith(<DecisionCard decision={human.waiting[0]!} />);
    await userEvent.setup().click(within(container).getByRole("button", { name: "Open the verdict form" }));
    expect(window.location.hash).toBe("#/projects/promo-acme");
  });
});

describe("languages", () => {
  for (const language of LANGUAGES)
    it(`renders every film panel with material in ${language}`, () => {
      const { container } = renderWith(<Canvas view={human} />, { language });
      for (const button of container.querySelectorAll<HTMLButtonElement>(
        '[data-panel] > h2 > button[aria-expanded="false"]',
      ))
        button.click();
      expect(container.querySelectorAll('[data-panel^="film."]').length).toBeGreaterThan(8);
      expect(container.textContent).not.toMatch(/\{[a-zA-Z]+\}/);
    });
});
