/**
 * Keyboard shortcuts (RFC 0004 FR9): `j`/`k` move between cards, `a` approve, `r` reject, `/` search, space play.
 * Cards are elements with `data-card`; the actions are buttons inside the focused card marked `data-hotkey="approve"`,
 * `"reject"` or `"play"`, so a shortcut does exactly what a click does (a spending action still asks for confirmation).
 * Shortcuts are ignored while typing (inputs, textareas, selects, contenteditable, IME composition), with Ctrl, Alt or
 * Meta held, and while a dialog is open.
 */
import { useEffect } from "react";

export const CARD_SELECTOR = "[data-card]";

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='combobox']"))
    return true;
  return false;
}

function cards(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR)).filter(
    (element) => !element.closest("[inert], [aria-hidden='true']"),
  );
}

/** Moves focus to the next (`1`) or previous (`-1`) card from the one holding focus. */
export function moveCard(direction: 1 | -1, root: ParentNode = document): HTMLElement | undefined {
  const list = cards(root);
  if (!list.length) return undefined;
  const active = document.activeElement?.closest<HTMLElement>(CARD_SELECTOR);
  const index = active ? list.indexOf(active) : -1;
  const next =
    list[
      index === -1 ? (direction === 1 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, index + direction))
    ];
  next?.focus();
  next?.scrollIntoView?.({ block: "nearest" });
  return next;
}

export type CardHotkey = "approve" | "reject" | "play";
/** Event a card receives for a shortcut it declared in `data-hotkeys` (space-separated names). */
export const CARD_HOTKEY_EVENT = "console-hotkey";

/**
 * Runs a shortcut on the focused card: a card that lists the name in `data-hotkeys` gets a {@link CARD_HOTKEY_EVENT}
 * and does exactly what its buttons do; otherwise an enabled button marked `data-hotkey=<name>` inside it is clicked
 * (the media slot's play control). Returns whether anything handled it.
 */
export function triggerCardAction(name: CardHotkey): boolean {
  const card = document.activeElement?.closest<HTMLElement>(CARD_SELECTOR);
  if (!card) return false;
  if (card.dataset.hotkeys?.split(/\s+/).includes(name)) {
    card.dispatchEvent(new CustomEvent<CardHotkey>(CARD_HOTKEY_EVENT, { detail: name }));
    return true;
  }
  const button = card.querySelector<HTMLButtonElement>(`[data-hotkey="${name}"]`);
  if (!button || button.disabled) return false;
  button.click();
  return true;
}

/** Subscribes a card element to its shortcuts. */
export function useCardHotkeys(ref: { current: HTMLElement | null }, handler: (name: CardHotkey) => void): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const listener = (event: Event) => handler((event as CustomEvent<CardHotkey>).detail);
    element.addEventListener(CARD_HOTKEY_EVENT, listener);
    return () => element.removeEventListener(CARD_HOTKEY_EVENT, listener);
  }, [ref, handler]);
}

export interface HotkeyHandlers {
  search: () => void;
}

export function handleHotkey(event: KeyboardEvent, handlers: HotkeyHandlers): boolean {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (isTypingTarget(event.target)) return false;
  if (document.querySelector("[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']"))
    return false;
  switch (event.key) {
    case "j":
      return !!moveCard(1);
    case "k":
      return !!moveCard(-1);
    case "/":
      handlers.search();
      return true;
    case "a":
      return triggerCardAction("approve");
    case "r":
      return triggerCardAction("reject");
    case " ": {
      // Space plays only from the card itself; on a focused button it keeps its native meaning.
      const target = event.target as Element | null;
      if (!target?.matches?.(CARD_SELECTOR)) return false;
      return triggerCardAction("play");
    }
    default:
      return false;
  }
}

export function useHotkeys(handlers: HotkeyHandlers): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (handleHotkey(event, handlers)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers]);
}
