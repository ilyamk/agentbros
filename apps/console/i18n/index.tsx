/**
 * Console i18n (RFC 0004 D19): English, Russian and Chinese (Simplified); the language follows the system unless the
 * user picks one in Settings. Only interface text is translated; the user's words and agent content never are.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { en } from "./en";
import { ru } from "./ru";
import { zhHans } from "./zh-Hans";
import { LANGUAGES, type Dictionary, type Language, type Plural } from "./types";

export { LANGUAGES, type Dictionary, type Language, type Plural };

export const dictionaries: Record<Language, Dictionary> = { en, ru, "zh-Hans": zhHans };

/** BCP 47 locale used for numbers, money and dates. */
export const LOCALES: Record<Language, string> = { en: "en-US", ru: "ru-RU", "zh-Hans": "zh-Hans-CN" };

/** Best match for the browser's languages; English when none matches. */
export function detectLanguage(languages: readonly string[] = globalThis.navigator?.languages ?? []): Language {
  for (const tag of languages) {
    const lower = tag.toLowerCase();
    if (lower.startsWith("ru")) return "ru";
    if (lower.startsWith("zh")) return "zh-Hans";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export type Vars = Record<string, string | number>;

/** Replaces `{name}` placeholders; unknown placeholders stay visible so a missing variable is noticed. */
export function format(template: string, vars: Vars = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

const rulesCache = new Map<string, Intl.PluralRules>();

/** Picks the plural form for `n` in the locale and fills `{n}` and the other placeholders. */
export function plural(message: Plural, n: number, locale: string, vars: Vars = {}): string {
  let rules = rulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    rulesCache.set(locale, rules);
  }
  const form = message[rules.select(n) as keyof Plural] ?? message.other;
  return format(form, { n, ...vars });
}

export interface I18n {
  language: Language;
  locale: string;
  /** The dictionary, typed: `d.home.title`. */
  d: Dictionary;
  f: (template: string, vars?: Vars) => string;
  p: (message: Plural, n: number, vars?: Vars) => string;
}

export function createI18n(language: Language): I18n {
  const locale = LOCALES[language];
  return {
    language,
    locale,
    d: dictionaries[language],
    f: format,
    p: (message, n, vars) => plural(message, n, locale, vars),
  };
}

const I18nContext = createContext<I18n>(createI18n("en"));

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo(() => createI18n(language), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
