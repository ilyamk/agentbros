import type { en } from "./en";

/** A plural message: Intl.PluralRules categories, `other` always present. */
export type Plural = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };

export type Widen<T> = T extends string
  ? string
  : T extends { other: string }
    ? Plural
    : { [K in keyof T]: Widen<T[K]> };

/** The shape every dictionary must have: English's keys, any wording. */
export type Dictionary = Widen<typeof en>;

export const LANGUAGES = ["en", "ru", "zh-Hans"] as const;
export type Language = (typeof LANGUAGES)[number];
