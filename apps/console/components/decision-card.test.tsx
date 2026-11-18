import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Decision } from "@contract";
import { FixtureApiClient } from "@/api/fixture";
import { ApiFailure } from "@/api/errors";
import { fixtureViews } from "@/lib/fixtures";
import { FIXTURE_NOW, fixtureStore, renderWith } from "@/test/utils";
import { DecisionCard } from "./decision-card";

const quote = fixtureViews.filmBuild.waiting[0]!;
const gate = fixtureViews.filmScriptGate.waiting[0]!;

function setup(decision: Decision, language: "en" | "ru" | "zh-Hans" = "en") {
  const client = new FixtureApiClient({ fixture: "view-film-script-gate", now: () => FIXTURE_NOW });
  const store = fixtureStore(client);
  const decide = vi.spyOn(store, "decide");
  const utils = renderWith(<DecisionCard decision={decision} />, { store, language });
  return { ...utils, decide, client };
}

describe("DecisionCard", () => {
  it("shows the §5.4 anatomy: kind, title, material, agent's view, words, actions, status line", () => {
    setup(quote);
    const card = screen.getByRole("article", { name: "Narration quote" });
    expect(within(card).getByText("Paid quote")).toBeTruthy();
    expect(within(card).getByText("$1.40")).toBeTruthy();
    expect(within(card).getByText("elevenlabs")).toBeTruthy();
    expect(within(card).getByText("$4.50")).toBeTruthy();
    expect(within(card).getByRole("complementary", { name: "Agent's view" }).textContent).toContain(
      "narrator-director",
    );
    expect(within(card).getByText(/3 takes, 41 s total/)).toBeTruthy();
    expect((within(card).getByLabelText("Your words") as HTMLTextAreaElement).value).toBe("Approve: Narration quote.");
    expect(within(card).getByText("Bound to dddddddd")).toBeTruthy();
    expect(within(card).getByText(/^Waiting 10 min/)).toBeTruthy();
    expect(card.getAttribute("data-card")).toBe("decision");
  });

  it("prefills the phrase in the UI language; the title stays as written", () => {
    setup(gate, "ru");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(`Одобряю: ${gate.title}.`);
    expect(screen.getByRole("button", { name: /Одобрить/ })).toBeTruthy();
  });

  it("approves a gate with the words as edited, the choice and the bound hash", async () => {
    const { decide } = setup(gate);
    const user = userEvent.setup();
    const words = screen.getByLabelText("Your words");
    await user.clear(words);
    await user.type(words, "B, but shorter hook");
    await user.click(screen.getByRole("button", { name: /Approve · Send/ }));
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide).toHaveBeenCalledWith("teaser-nova", {
      decisionId: gate.id,
      choice: "approve",
      answer: "B, but shorter hook",
      expect: gate.expect,
    });
    expect(await screen.findByText(new RegExp(`^Applied: ${gate.title}`))).toBeTruthy();
  });

  it("switching to the rejecting action swaps the untouched phrase and focuses the words", async () => {
    setup(gate);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    const words = screen.getByLabelText("Your words") as HTMLTextAreaElement;
    expect(words.value).toBe(`Reject: ${gate.title}.`);
    await waitFor(() => expect(document.activeElement).toBe(words));
  });

  it("keeps the user's own words when the action changes", async () => {
    setup(gate);
    const user = userEvent.setup();
    const words = screen.getByLabelText("Your words") as HTMLTextAreaElement;
    await user.type(words, " Really.");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(words.value).toBe(`Approve: ${gate.title}. Really.`);
  });

  it("asks before a spending action and shows the exact command with the words", async () => {
    const { decide } = setup(quote);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Approve · Send/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      'pnpm film:approve --project promo-acme --step narration --answer "Approve: Narration quote." --expect',
    );
    expect(decide).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Run it" }));
    await waitFor(() => expect(decide).toHaveBeenCalledOnce());
  });

  it("shows a refused CLI result verbatim", async () => {
    const { store } = setup(gate);
    vi.spyOn(store.client, "decide").mockResolvedValueOnce({
      ok: false,
      decision: {
        ...gate,
        status: "refused",
        decidedAt: "2026-11-17T09:31:00Z",
        answer: "x",
        result: { ok: false, error: "VALIDATION", message: "--expect is stale: script.md changed" },
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Approve · Send/ }));
    expect(await screen.findByText("Refused: --expect is stale: script.md changed")).toBeTruthy();
  });

  it("refuses to send empty words", async () => {
    const { decide } = setup(gate);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Your words"));
    await user.click(screen.getByRole("button", { name: /Approve · Send/ }));
    expect(screen.getByText("Write a few words first.")).toBeTruthy();
    expect(decide).not.toHaveBeenCalled();
  });

  it("marks itself stale when the bound file changes, until reloaded", async () => {
    const { rerender } = setup(gate);
    const changed = { ...gate, bindTo: [{ path: gate.bindTo[0]!.path, sha256: "1".repeat(64) }] };
    rerender(<DecisionCard decision={changed} />);
    expect(screen.getByRole("alert").textContent).toContain("Stale: the file changed");
    expect((screen.getByRole("button", { name: /Approve · Send/ }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("approves with the a key from the focused card, and r focuses the words", async () => {
    const { decide } = setup(gate);
    const card = screen.getByRole("article");
    act(() => card.focus());
    const { handleHotkey } = await import("@/lib/keyboard");
    act(() => {
      handleHotkey(new KeyboardEvent("keydown", { key: "r" }), { search: () => {} });
    });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Your words")));
    expect((screen.getByLabelText("Your words") as HTMLTextAreaElement).value).toBe(`Reject: ${gate.title}.`);
    // typing "a" in the words field must not approve
    fireEvent.keyDown(screen.getByLabelText("Your words"), { key: "a" });
    expect(decide).not.toHaveBeenCalled();
    act(() => card.focus());
    act(() => {
      handleHotkey(new KeyboardEvent("keydown", { key: "a" }), { search: () => {} });
    });
    await waitFor(() => expect(decide).toHaveBeenCalledOnce());
    expect(decide.mock.calls[0]?.[1]).toMatchObject({ choice: "approve", answer: `Approve: ${gate.title}.` });
  });

  it("binds to the snapshot the user reviewed and closes Confirm when the material changes underneath (FR3)", async () => {
    const { decide, rerender } = setup(quote);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Approve · Send/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    const requoted = { ...quote, quote: { ...quote.quote!, amountUsd: 9.9, quoteHash: "2".repeat(64) } };
    rerender(<DecisionCard decision={requoted} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("Stale");
    // the card still shows what the user reviewed, not the new quote
    expect(screen.getByText("$1.40")).toBeTruthy();
    expect(screen.queryByText("$9.90")).toBeNull();
    expect(decide).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByText("$9.90")).toBeTruthy();
  });

  it("sends once on a double click and stays locked after an applied reply", async () => {
    const { store } = setup(gate);
    let resolve!: (value: Awaited<ReturnType<typeof store.client.decide>>) => void;
    const decide = vi.spyOn(store.client, "decide").mockImplementation(() => new Promise((done) => (resolve = done)));
    const button = screen.getByRole("button", { name: /Approve · Send/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(decide).toHaveBeenCalledOnce();
    expect(decide.mock.calls[0]?.[1]).toMatchObject({ decisionId: gate.id, expect: gate.expect });
    await act(async () =>
      resolve({ ok: true, decision: { ...gate, status: "applied", decidedAt: "2026-11-17T09:31:00Z", answer: "x" } }),
    );
    expect(await screen.findByText(/Waiting for the updated view/)).toBeTruthy();
    expect((screen.getByLabelText("Your words") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("after a network failure shows the ambiguous state and re-checks the view before allowing a resend", async () => {
    const { store } = setup(gate);
    const decide = vi.spyOn(store.client, "decide").mockRejectedValueOnce(new ApiFailure("NETWORK", "Failed to fetch"));
    const load = vi.spyOn(store, "loadView");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Approve · Send/ }));
    expect(await screen.findByText(/Could not confirm that your answer arrived: Failed to fetch/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Approve · Send/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(load).toHaveBeenCalledWith(gate.project);
    expect(await screen.findByText("Not recorded yet. You can send it again.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Approve · Send/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(decide).toHaveBeenCalledOnce();
  });
});
