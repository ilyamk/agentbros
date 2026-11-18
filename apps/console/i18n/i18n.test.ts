import { describe, expect, it } from "vitest";
import { ENV_KEYS } from "../../../src/lib/setup/keys";
import { en } from "./en";
import { dictionaries, LANGUAGES, LOCALES, detectLanguage, format, plural } from "./index";

type Tree = { [key: string]: string | Tree };
const isPlural = (value: unknown): value is Record<string, string> =>
  typeof value === "object" && value !== null && "other" in value && typeof (value as Tree).other === "string";

/** Every key path of a dictionary; plural messages count as one leaf. */
function leaves(tree: Tree, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string" || isPlural(value)) out.set(path, value);
    else for (const [inner, leaf] of leaves(value, path)) out.set(inner, leaf);
  }
  return out;
}

const placeholders = (value: unknown) => [...new Set(JSON.stringify(value).match(/\{\w+\}/g) ?? [])].sort().join(",");

describe("i18n dictionaries", () => {
  const reference = leaves(en as unknown as Tree);

  for (const language of LANGUAGES) {
    const dict = leaves(dictionaries[language] as unknown as Tree);

    it(`${language} has every key of en and no extra key`, () => {
      expect([...reference.keys()].filter((key) => !dict.has(key))).toEqual([]);
      expect([...dict.keys()].filter((key) => !reference.has(key))).toEqual([]);
    });

    it(`${language} has no empty message and keeps every placeholder`, () => {
      for (const [key, value] of dict) {
        const texts = typeof value === "string" ? [value] : Object.values(value as Record<string, string>);
        for (const text of texts) expect(text.trim(), key).not.toBe("");
        expect(placeholders(value), key).toBe(placeholders(reference.get(key)));
      }
    });

    it(`${language} plurals cover the locale's plural categories`, () => {
      const categories = new Intl.PluralRules(LOCALES[language]).resolvedOptions().pluralCategories;
      for (const [key, value] of dict)
        if (isPlural(value))
          for (const category of categories) expect(value[category] ?? value.other, `${key}.${category}`).toBeTruthy();
      if (language === "ru")
        for (const [key, value] of dict)
          if (isPlural(value)) expect(Object.keys(value).sort(), key).toEqual(["few", "many", "one", "other"]);
    });
  }

  it("describes every registered API credential in each language", () => {
    const names = ENV_KEYS.map(({ name }) => name).sort();
    for (const language of LANGUAGES)
      expect(Object.keys(dictionaries[language].credentials.integrations).sort(), language).toEqual(names);
  });

  it("formats placeholders and plural forms", () => {
    expect(format("Approve: {title}.", { title: "Script B" })).toBe("Approve: Script B.");
    expect(format("{missing} stays")).toBe("{missing} stays");
    expect(plural(dictionaries.ru.agents.runs, 1, "ru-RU")).toBe("1 запуск");
    expect(plural(dictionaries.ru.agents.runs, 3, "ru-RU")).toBe("3 запуска");
    expect(plural(dictionaries.ru.agents.runs, 5, "ru-RU")).toBe("5 запусков");
    expect(plural(dictionaries.en.agents.runs, 1, "en-US")).toBe("1 run");
    expect(plural(dictionaries["zh-Hans"].agents.runs, 2, "zh-Hans-CN")).toBe("2 次运行");
  });

  it("detects the language from the system, English by default", () => {
    expect(detectLanguage(["ru-RU", "en"])).toBe("ru");
    expect(detectLanguage(["zh-TW"])).toBe("zh-Hans");
    expect(detectLanguage(["de-DE"])).toBe("en");
    expect(detectLanguage([])).toBe("en");
  });

  it("prefills a decision phrase in every language", () => {
    for (const language of LANGUAGES)
      expect(format(dictionaries[language].decision.phrases.approve, { title: "X" })).toContain("X");
  });
});
