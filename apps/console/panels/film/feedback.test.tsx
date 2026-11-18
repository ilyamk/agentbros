/**
 * Ratings and frame feedback from the console (RFC 0004 WP9, US10, US11): the look panel rates each styleframe with
 * stars and the user's optional words, a frame comment on a render in the build panel goes out as frame feedback, and
 * both reach the server as one contract request, verbatim.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DecisionRequestSchema, type DecisionRequest, type DecisionResponse, type MediaRef } from "@contract";
import { FixtureApiClient } from "@/api/fixture";
import { ApiFailure } from "@/api/errors";
import { fixtureViews } from "@/lib/fixtures";
import { VideoViewer } from "@/media";
import { FIXTURE_NOW, fixtureStore, renderWith } from "@/test/utils";
import { FrameFeedbackProvider, frameFeedbackRequest, ratable, ratingRequest } from "./feedback";
import { LookPanel } from "./material";

const view = fixtureViews.filmBuild;
const PROJECT = view.project.id;
const END = "pipeline/look/frame-end.png";

/** A fixture client whose decide is a spy; `reply` replaces the fixture's applied answer. */
function spyClient(reply?: (request: DecisionRequest) => DecisionResponse) {
  const client = new FixtureApiClient({ fixture: "view-film-build", now: () => FIXTURE_NOW });
  const real = client.decide.bind(client);
  const decide = vi.fn(async (project: string, request: DecisionRequest) =>
    reply ? reply(request) : real(project, request),
  );
  client.decide = decide;
  return { client, decide };
}

describe("rating a styleframe", () => {
  it("sends the score with the user's words verbatim, then says it was saved", async () => {
    const user = userEvent.setup();
    const { client, decide } = spyClient();
    const { container } = renderWith(<LookPanel view={view} />, { store: fixtureStore(client) });
    const frame = container.querySelector(`[data-styleframe="${END}"]`) as HTMLElement;
    expect(frame.textContent).toContain("Not rated yet");
    const stars = within(frame).getByRole("radiogroup", { name: "Your rating of frame-end.png" });
    expect(within(frame).queryByRole("button", { name: "Save rating" })).toBeNull();
    await user.click(within(stars).getByRole("radio", { name: "4 out of 5" }));
    const words = "  Warmer, like the hook — «да» ";
    await user.type(within(frame).getByRole("textbox", { name: "Your words about it (optional)" }), words);
    await user.click(within(frame).getByRole("button", { name: "Save rating" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    const [project, request] = decide.mock.calls[0]!;
    expect(project).toBe(PROJECT);
    expect(DecisionRequestSchema.parse(request)).toEqual({
      kind: "rating",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      step: "look",
      answer: words,
      ratings: { [END]: 4 },
    });
    expect((await within(frame).findByRole("status")).textContent).toContain("Rating saved: 4 of 5.");
  });

  it("without words sends the bare score, which is not a note", async () => {
    const user = userEvent.setup();
    const { client, decide } = spyClient();
    const { container } = renderWith(<LookPanel view={view} />, { store: fixtureStore(client) });
    const frame = container.querySelector(`[data-styleframe="${END}"]`) as HTMLElement;
    await user.click(within(frame).getByRole("radio", { name: "2 out of 5" }));
    await user.click(within(frame).getByRole("button", { name: "Save rating" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide.mock.calls[0]![1]).toMatchObject({ answer: "2/5", ratings: { [END]: 2 } });
  });

  it("shows a refusal from ref:rate as an alert with the command's message", async () => {
    const user = userEvent.setup();
    const { client } = spyClient((request) => ({
      ok: false,
      decision: {
        v: 1,
        id: "rating-1",
        project: PROJECT,
        kind: "rating",
        title: "Rating",
        bindTo: [],
        answer: request.answer,
        status: "refused",
        createdAt: "2026-11-17T09:18:00Z",
        decidedAt: "2026-11-17T09:18:00Z",
        argv: ["pnpm", "ref:rate"],
        result: { ok: false, error: "VALIDATION", message: "the file changed since you saw it" },
      },
    }));
    const { container } = renderWith(<LookPanel view={view} />, { store: fixtureStore(client) });
    const frame = container.querySelector(`[data-styleframe="${END}"]`) as HTMLElement;
    await user.click(within(frame).getByRole("radio", { name: "5 out of 5" }));
    await user.click(within(frame).getByRole("button", { name: "Save rating" }));
    expect((await within(frame).findByRole("alert")).textContent).toContain("the file changed since you saw it");
  });

  it("an uncertain failure keeps the request id, so sending again cannot rate twice", async () => {
    const user = userEvent.setup();
    let first = true;
    const { client, decide } = spyClient();
    const real = decide.getMockImplementation()!;
    decide.mockImplementation(async (project, request) => {
      if (first) {
        first = false;
        throw new ApiFailure("NETWORK", "connection reset");
      }
      return real(project, request);
    });
    const { container } = renderWith(<LookPanel view={view} />, { store: fixtureStore(client) });
    const frame = container.querySelector(`[data-styleframe="${END}"]`) as HTMLElement;
    await user.click(within(frame).getByRole("radio", { name: "3 out of 5" }));
    await user.click(within(frame).getByRole("button", { name: "Save rating" }));
    expect((await within(frame).findByRole("alert")).textContent).toContain("connection reset");
    await user.click(within(frame).getByRole("button", { name: "Save rating" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
    expect(decide.mock.calls[1]![1].requestId).toBe(decide.mock.calls[0]![1].requestId);
  });

  it("renders in every language with the rating form named", () => {
    for (const language of ["ru", "zh-Hans"] as const) {
      const { unmount } = renderWith(<LookPanel view={view} />, { language });
      expect(screen.getAllByRole("form").length).toBeGreaterThanOrEqual(3);
      unmount();
    }
  });
});

describe("frame feedback", () => {
  const scene = view.media.latestRender as MediaRef;

  it("a comment on a render's frame goes out as frame feedback and is confirmed in a notification", async () => {
    const { client, decide } = spyClient();
    const store = fixtureStore(client);
    renderWith(
      <FrameFeedbackProvider project={PROJECT}>
        <VideoViewer project={PROJECT} media={scene} />
      </FrameFeedbackProvider>,
      { store },
    );
    fireEvent.click(screen.getByRole("button", { name: "Comment on this frame" }));
    const form = screen.getByRole("form", { name: /Comment on frame 0/ });
    fireEvent.change(within(form).getByRole("textbox", { name: "Comment" }), {
      target: { value: "-h the logo is cut off" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add comment" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    const request = DecisionRequestSchema.parse(decide.mock.calls[0]![1]);
    expect(request).toEqual({
      kind: "frame-feedback",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      answer: "-h the logo is cut off",
      frameComments: [{ media: scene, frame: 0, text: "-h the logo is cut off" }],
    });
    await waitFor(() =>
      expect(store.getState().notices[0]?.text).toBe(
        "Your comment on frame 0 goes to the build; the fixer answers it next round.",
      ),
    );
  });
});

describe("requests", () => {
  it("binds a rating to the hash the user saw, and only project files are ratable", () => {
    const media: MediaRef = { path: END, kind: "image", sha256: "a".repeat(64) };
    expect(ratingRequest(media, 3, "")).toEqual({
      kind: "rating",
      answer: "3/5",
      ratings: { [END]: 3 },
      expect: "a".repeat(64),
    });
    expect(ratable(media)).toBe(true);
    expect(ratable({ ...media, root: "out" })).toBe(false);
    const comment = { media: { path: "film.mp4", kind: "video" as const, root: "out" as const }, frame: 3, text: "x" };
    expect(frameFeedbackRequest(comment)).toEqual({ kind: "frame-feedback", answer: "x", frameComments: [comment] });
  });
});
