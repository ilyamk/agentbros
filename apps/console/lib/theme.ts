/**
 * Where the console's colours come from (RFC 0004 §10.1): the brand palettes in src/lib/design-tokens.ts. styles.css
 * holds the shadcn CSS variables; theme.test.ts checks that the brand values below appear there.
 */
import { palettes } from "@tokens";

/** Dark "studio" theme (default) and light theme. */
export const brand = {
  dark: palettes.darkTech,
  light: palettes.minimalLight,
} as const;

export type ThemeName = keyof typeof brand;
