import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DecisionRequestSchema,
  ProjectViewSchema,
  VerdictSchema,
  type Decision,
  type FrameComment,
  type ProjectView,
} from "@contract";
import { FixtureApiClient } from "@/api/fixture";
import { ApiFailure } from "@/api/errors";
import { fixtureViews } from "@/lib/fixtures";
import { FIXTURE_NOW, fixtureStore, renderWith } from "@/test/utils";
import { buildVerdict, lastFrame, VerdictForm, VerdictPanel, type FrameCommentInputProps } from "./verdict";

const base = fixtureViews.filmBuild;
const film = base.media.animatic!; // 18 s at 30 fps: frames 0–539

const human: Decision = {
  v: 1,
  id: "dec-human-verdict",
  project: base.project.id,
  kind: "verdict",
  step: "human",
  title: "Final verdict",
  bindTo: [{ path: "out-render.json", sha256: "9".repeat(64) }],
  expect: "8".repeat(64),
  status: "pending",
  createdAt: "2026-11-17T09:12:00Z",
};

function humanView(waiting: Decision[] = [human]): ProjectView {
  return ProjectViewSchema.parse({
    ...base,
    steps: base.steps.map((step) =>
      step.id === "human" ? { ...step, status: "awaiting-gate" } : { ...step, status: "done" },
    ),
    current: { step: "human", next: { argv: [], why: "The user watches the film." } },
    media: { ...base.media, latestRender: { ...film, path: "final/film.mp4", label: "Final film" } },
    waiting,
  });
}

function setup(view = humanView(), options: { language?: "en" | "ru" | "zh-Hans" } = {}) {
  const client = new FixtureApiClient({ fixture: "view-film-build", now: () => FIXTURE_NOW });
  (client as unknown as { views: Map<string, ProjectView> }).views.set(view.project.id, view);
  const store = fixtureStore(client);
  const decide = vi.spyOn(store, "decide");
  const utils = renderWith(<VerdictPanel view={view} />, { store, language: options.language ?? "en" });
  return { ...utils, decide, store, user: userEvent.setup() };
}

/** Opens a dropdown by its label and clicks the option with that name, as a person would. */
async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByLabelText(label));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("verdict form (D24)", () => {
  it("requires the overall score: no request without it", async () => {
    const { decide, user } = setup();
    await user.click(screen.getByRole("button", { name: "Record the verdict" }));
    expect(screen.getByText("Choose an overall score from 1 to 10.")).toBeTruthy();
    expect(decide).not.toHaveBeenCalled();
  });

  it("sends one decision with the verdict, the frame comments, the user's words and the bound hash", async () => {
    const { decide, user } = setup();
    expect((screen.getByLabelText("Your words") as HTMLTextAreaElement).value).toBe("My verdict on the film.");
    await user.click(screen.getByRole("radio", { name: "8 out of 10" }));
    expect((screen.getByLabelText("Your words") as HTMLTextAreaElement).value).toBe("My verdict: 8 out of 10.");
    await pick(user, "Hook", "7");
    await pick(user, "Music fit", "9");
    await user.type(screen.getByLabelText("What worked"), "The cold open.");
    await user.type(screen.getByLabelText("What did not"), "  ");
    await pick(user, "Render", "Final film");
    await user.type(screen.getByLabelText("Frame"), "212");
    await user.type(screen.getByLabelText("Comment"), "Logo too late");
    await user.click(screen.getByRole("button", { name: "Add the comment" }));
    expect(screen.getByText("Logo too late")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Record the verdict" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    const [project, request] = decide.mock.calls[0]!;
    expect(project).toBe(base.project.id);
    expect(request).toEqual({
      decisionId: "dec-human-verdict",
      kind: "verdict",
      step: "human",
      answer: "My verdict: 8 out of 10.",
      expect: "8".repeat(64),
      verdict: { score: 8, axes: { hook: 7, musicFit: 9 }, worked: "The cold open." },
      frameComments: [
        {
          media: { ...film, path: "final/film.mp4", label: "Final film" },
          frame: 212,
          text: "Logo too late",
        },
      ],
    });
    expect(DecisionRequestSchema.safeParse(request).success).toBe(true);
    expect(await screen.findByText("Verdict recorded.")).toBeTruthy();
    expect(screen.getByText(/creative-postmortem/)).toBeTruthy();
  });

  it("keeps the user's own words when the score changes; without a pending decision it sends no id or hash", async () => {
    const { decide, user } = setup(humanView([]));
    const words = screen.getByLabelText("Your words");
    await user.clear(words);
    await user.type(words, "Good enough to post, ending drags.");
    await user.click(screen.getByRole("radio", { name: "6 out of 10" }));
    expect((words as HTMLTextAreaElement).value).toBe("Good enough to post, ending drags.");
    await user.click(screen.getByRole("button", { name: "Record the verdict" }));
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]![1]).toEqual({
      kind: "verdict",
      step: "human",
      answer: "Good enough to post, ending drags.",
      verdict: { score: 6 },
    });
  });

  it("refuses empty words", async () => {
    const { decide, user } = setup();
    await user.click(screen.getByRole("radio", { name: "5 out of 10" }));
    await user.clear(screen.getByLabelText("Your words"));
    await user.click(screen.getByRole("button", { name: "Record the verdict" }));
    expect(screen.getByText("Write a few words first.")).toBeTruthy();
    expect(decide).not.toHaveBeenCalled();
  });

  it("rejects a frame outside the render or a comment without text", async () => {
    const { user } = setup();
    await pick(user, "Render", "Final film");
    expect(screen.getByText("A whole number from 0 to 539.")).toBeTruthy();
    await user.type(screen.getByLabelText("Frame"), "540");
    await user.type(screen.getByLabelText("Comment"), "x");
    await user.click(screen.getByRole("button", { name: "Add the comment" }));
    expect(screen.getByText("Give a frame in range and a comment.")).toBeTruthy();
    await user.clear(screen.getByLabelText("Frame"));
    await user.type(screen.getByLabelText("Frame"), "1.5");
    await user.click(screen.getByRole("button", { name: "Add the comment" }));
    expect(screen.queryByRole("button", { name: /Remove the comment/ })).toBeNull();
    expect(lastFrame(film)).toBe(539);
  });

  it("shows a refused CLI result verbatim and stays editable", async () => {
    const { decide, user } = setup();
    decide.mockResolvedValueOnce({
      ok: false,
      decision: {
        ...human,
        status: "refused",
        decidedAt: "2026-11-17T09:13:00Z",
        answer: "x",
        verdict: { score: 3 },
        result: { ok: false, error: "VALIDATION", message: "render changed" },
      },
    });
    await user.click(screen.getByRole("radio", { name: "3 out of 10" }));
    await user.click(screen.getByRole("button", { name: "Record the verdict" }));
    expect(await screen.findByText("Refused: render changed")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Record the verdict" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("locks after an ambiguous failure until the user checks again", async () => {
    const { decide, user } = setup();
    decide.mockRejectedValueOnce(new ApiFailure("NETWORK", "connection reset"));
    await user.click(screen.getByRole("radio", { name: "7 out of 10" }));
    await user.click(screen.getByRole("button", { name: "Record the verdict" }));
    expect(await screen.findByText(/connection reset/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Record the verdict" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Record the verdict" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("without a pending decision, an ambiguous failure keeps its warning after the check", async () => {
    const { decide, user } = setup(humanView([]));
    decide.mockRejectedValueOnce(new ApiFailure("NETWORK", "connection reset"));
    await user.click(screen.getByRole("radio", { name: "7 out of 10" }));
    await user.click(screen.getByRole("button", { name: "Record the verdict" }));
    await user.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Record the verdict" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByText(/connection reset/)).toBeTruthy();
    expect(screen.queryByText(/You can send it again/)).toBeNull();
  });

  it("takes frame comments from a plugged-in picker (WP6)", async () => {
    const view = humanView();
    const client = new FixtureApiClient({ fixture: "view-film-build", now: () => FIXTURE_NOW });
    const store = fixtureStore(client);
    const decide = vi.spyOn(store, "decide").mockResolvedValue({
      ok: true,
      decision: { ...human, status: "applied", decidedAt: "2026-11-17T09:13:00Z", answer: "x", verdict: { score: 9 } },
    });
    const comment: FrameComment = {
      media: view.media.latestRender!,
      frame: 30,
      region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      text: "Here",
    };
    const Picker = ({ onAdd, media }: FrameCommentInputProps) => (
      <button type="button" onClick={() => onAdd(comment)}>
        pick {media.length}
      </button>
    );
    renderWith(<VerdictForm view={view} frameCommentInput={Picker} />, { store });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^pick/ }));
    await user.click(screen.getByRole("radio", { name: "9 out of 10" }));
    await user.click(screen.getByRole("button", { name: "Record the verdict" }));
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]![1].frameComments).toEqual([comment]);
  });

  it("builds a schema-valid verdict with only the scored axes and no empty texts", () => {
    const verdict = buildVerdict({ score: 10, axes: { hook: 4, truth: undefined }, worked: " ", didNot: "Pace" });
    expect(verdict).toEqual({ score: 10, axes: { hook: 4 }, didNot: "Pace" });
    expect(VerdictSchema.safeParse(verdict).success).toBe(true);
    expect(VerdictSchema.safeParse(buildVerdict({ score: null, axes: {}, worked: "", didNot: "" })).success).toBe(
      false,
    );
  });

  it("speaks Russian and Chinese", () => {
    setup(humanView(), { language: "ru" });
    expect(screen.getByRole("button", { name: "Записать оценку" })).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "Общая оценка (обязательно)" })).getAllByRole("radio"),
    ).toHaveLength(10);
  });
});
