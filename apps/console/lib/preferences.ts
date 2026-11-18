/**
 * Per-browser preferences (language, theme): conveniences kept in localStorage, wrapped in try/catch so a blocked
 * storage never breaks the page. `?lang=` and `?theme=` override them for one page load (screenshots, tests).
 */
import { useSyncExternalStore } from "react";
import { detectLanguage, isLanguage, type Language } from "@/i18n";

export type ThemeChoice = "dark" | "light" | "system";
export type LanguageChoice = Language | "system";

export interface Preferences {
  language: LanguageChoice;
  theme: ThemeChoice;
}

const KEY = "agentbros.console.preferences";
const listeners = new Set<() => void>();
let current: Preferences = { language: "system", theme: "dark" };
let overrides: Partial<Preferences> = {};

function read(): Preferences {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return { language: "system", theme: "dark" };
    const value = JSON.parse(raw) as Partial<Preferences>;
    return {
      language: value.language === "system" || isLanguage(value.language) ? value.language : "system",
      theme: value.theme === "light" || value.theme === "system" ? value.theme : "dark",
    };
  } catch {
    return { language: "system", theme: "dark" };
  }
}

/** Loads stored preferences and the one-load overrides from the query string. */
export function initPreferences(search: string = globalThis.location?.search ?? ""): Preferences {
  current = read();
  const params = new URLSearchParams(search);
  const lang = params.get("lang");
  const theme = params.get("theme");
  overrides = {
    ...(isLanguage(lang) ? { language: lang } : {}),
    ...(theme === "dark" || theme === "light" ? { theme } : {}),
  };
  return preferences();
}

export function preferences(): Preferences {
  return { ...current, ...overrides };
}

let snapshot = preferences();

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  current = { ...current, [key]: value };
  delete overrides[key];
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(current));
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  snapshot = preferences();
  for (const listener of listeners) listener();
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => {
      const next = preferences();
      if (next.language !== snapshot.language || next.theme !== snapshot.theme) snapshot = next;
      return snapshot;
    },
  );
}

export function resolveLanguage(choice: LanguageChoice): Language {
  return choice === "system" ? detectLanguage() : choice;
}

export function resolveTheme(choice: ThemeChoice): "dark" | "light" {
  if (choice !== "system") return choice;
  return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Applies the theme class and the document language. */
export function applyDocument(theme: "dark" | "light", language: Language, doc: Document = document): void {
  doc.documentElement.classList.toggle("dark", theme === "dark");
  doc.documentElement.lang = language;
}
