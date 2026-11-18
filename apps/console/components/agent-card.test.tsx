import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CARD_KINDS } from "@contract";
import { ApiFailure } from "@/api/errors";
import { fixtureCards } from "@/lib/fixtures";
import { renderWith } from "@/test/utils";
import { AgentCard } from "./agent-card";

const card = (id: string) => fixtureCards.find((item) => item.id === id)!;

describe("AgentCard", () => {
  it("renders every one of the seven kinds", () => {
    expect(new Set(fixtureCards.map((item) => item.kind))).toEqual(new Set(CARD_KINDS));
    renderWith(
      <>
        {fixtureCards.map((item) => (
          <AgentCard key={item.id} card={item} />
        ))}
      </>,
    );
    const articles = screen.getAllByRole("article");
    expect(articles.map((article) => article.getAttribute("data-card-kind")).sort()).toEqual([...CARD_KINDS].sort());
    for (const item of fixtureCards) expect(screen.getByRole("article", { name: item.title })).toBeTruthy();
  });

  it("answers a compare card with a choice and a note", async () => {
    const { store } = renderWith(<AgentCard card={card("card-endings")} />);
    const answer = vi.spyOn(store, "answerCard");
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "B" }));
    await user.type(screen.getByLabelText("Note"), "B lands the logo.");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith("promo-acme", "card-endings", { choice: "b", text: "B lands the logo." }),
    );
  });

  it("refuses an empty answer", async () => {
    const { store } = renderWith(<AgentCard card={card("card-tagline")} />);
    const answer = vi.spyOn(store, "answerCard");
    await userEvent.setup().click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Pick an option, rate, or write something first.")).toBeTruthy();
    expect(answer).not.toHaveBeenCalled();
  });

  it("shows an answered rating card read-only with the user's text", () => {
    const rated = card("card-rate-frames");
    renderWith(<AgentCard card={rated} />);
    const article = screen.getByRole("article");
    expect(within(article).queryByRole("button", { name: "Send" })).toBeNull();
    expect(within(article).getAllByRole("img", { name: /Rating/ }).length).toBe(
      rated.kind === "rating" ? rated.media.length : 0,
    );
  });

  it("renders a Markdown body as text, never as HTML", () => {
    const notes = card("card-notes");
    renderWith(<AgentCard card={notes} />);
    const article = screen.getByRole("article");
    expect(article.querySelector("script, iframe, img[src]")).toBeNull();
    expect(article.textContent).toContain(notes.title);
  });

  it("rates each media item of an open rating card", async () => {
    const open = { ...card("card-rate-frames"), answer: undefined } as (typeof fixtureCards)[number];
    const { store } = renderWith(<AgentCard card={open} />);
    const answer = vi.spyOn(store, "answerCard").mockResolvedValue({ ok: true, card: card("card-rate-frames") });
    const user = userEvent.setup();
    const groups = screen.getAllByRole("radiogroup");
    await user.click(within(groups[0]!).getByRole("radio", { name: "4 out of 5" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    const media = open.kind === "rating" ? open.media[0]!.path : "";
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith("promo-acme", "card-rate-frames", { ratings: { [media]: 4 } }),
    );
  });

  it("locks after sending and shows the ambiguous state on a network failure", async () => {
    const { store } = renderWith(<AgentCard card={card("card-tagline")} />);
    const answer = vi.spyOn(store.client, "answerCard").mockRejectedValueOnce(new ApiFailure("NETWORK", "offline"));
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "Yes, show it.");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Could not confirm that your answer arrived: offline/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Not recorded yet. You can send it again.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Sent. Waiting for the updated view…" })).toBeTruthy();
  });
});
