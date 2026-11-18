import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { handleHotkey, isTypingTarget, moveCard } from "./keyboard";

function cards() {
  return render(
    <div>
      <article data-card tabIndex={0}>
        one <input aria-label="field" />
      </article>
      <article data-card tabIndex={0}>
        two <button data-hotkey="play">play</button>
      </article>
    </div>,
  );
}

describe("keyboard shortcuts", () => {
  it("j and k move between cards", () => {
    const { getAllByRole } = cards();
    const [first, second] = getAllByRole("article");
    expect(moveCard(1)).toBe(first);
    expect(document.activeElement).toBe(first);
    handleHotkey(new KeyboardEvent("keydown", { key: "j" }), { search: () => {} });
    expect(document.activeElement).toBe(second);
    handleHotkey(new KeyboardEvent("keydown", { key: "k" }), { search: () => {} });
    expect(document.activeElement).toBe(first);
  });

  it("ignores keys while typing or with modifiers; / opens search", () => {
    const { getByLabelText } = cards();
    const search = vi.fn();
    const field = getByLabelText("field");
    expect(isTypingTarget(field)).toBe(true);
    const typing = new KeyboardEvent("keydown", { key: "/" });
    Object.defineProperty(typing, "target", { value: field });
    expect(handleHotkey(typing, { search })).toBe(false);
    expect(handleHotkey(new KeyboardEvent("keydown", { key: "/", metaKey: true }), { search })).toBe(false);
    expect(handleHotkey(new KeyboardEvent("keydown", { key: "/" }), { search })).toBe(true);
    expect(search).toHaveBeenCalledOnce();
  });

  it("space plays from the focused card only", () => {
    const { getAllByRole, getByText } = cards();
    const play = vi.fn();
    getByText("play").addEventListener("click", play);
    const second = getAllByRole("article")[1]!;
    second.focus();
    const space = new KeyboardEvent("keydown", { key: " " });
    Object.defineProperty(space, "target", { value: second });
    expect(handleHotkey(space, { search: () => {} })).toBe(true);
    expect(play).toHaveBeenCalledOnce();
    const onButton = new KeyboardEvent("keydown", { key: " " });
    Object.defineProperty(onButton, "target", { value: getByText("play") });
    expect(handleHotkey(onButton, { search: () => {} })).toBe(false);
  });
});
