/**
 * The console's clock: live time in the browser, fixed time in fixture mode so screenshots and tests are stable.
 * UI code only (RFC 0004 §10.1: the determinism law does not apply to apps/console).
 */
import { useSyncExternalStore } from "react";

let fixed: number | undefined;
let current = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

/** Freezes the clock (fixture mode, tests); `undefined` returns to live time. */
export function setFixedNow(value: number | undefined): void {
  fixed = value;
  current = value ?? Date.now();
  for (const listener of listeners) listener();
}

export function now(): number {
  return fixed ?? Date.now();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer && fixed === undefined)
    timer = setInterval(() => {
      if (fixed !== undefined) return;
      current = Date.now();
      for (const fn of listeners) fn();
    }, 1000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Current time, re-rendering every second while live. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => fixed ?? current);
}
