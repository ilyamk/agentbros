import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { brand } from "./theme";

const css = readFileSync(path.join(import.meta.dirname, "..", "styles.css"), "utf8").toLowerCase();
const block = (selector: string) =>
  css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));

describe("theme tokens", () => {
  it("map the brand palettes from src/lib/design-tokens.ts", () => {
    for (const [selector, palette] of [
      [":root", brand.light],
      [".dark", brand.dark],
    ] as const) {
      const vars = block(selector);
      expect(vars).toContain(`--background: ${palette.background.toLowerCase()};`);
      expect(vars).toContain(`--foreground: ${palette.text.toLowerCase()};`);
      expect(vars).toContain(`--primary: ${palette.accent.toLowerCase()};`);
    }
  });

  it("load no web font or remote resource", () => {
    expect(css).not.toMatch(/@font-face|url\(|https?:/);
  });
});
