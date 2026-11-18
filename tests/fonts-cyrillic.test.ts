import test from "node:test";
import assert from "node:assert/strict";
import { getInfo as golosText } from "@remotion/google-fonts/GolosText";
import { getInfo as rubik } from "@remotion/google-fonts/Rubik";
import { getInfo as sofiaSansExtraCondensed } from "@remotion/google-fonts/SofiaSansExtraCondensed";
import { getInfo as unbounded } from "@remotion/google-fonts/Unbounded";
import * as fonts from "../src/lib/fonts";
import * as cyrillic from "../src/lib/fonts-cyrillic";

// loadFont skips subset and axis checks outside a browser, so compare with getInfo() directly.
const cases = [
  [cyrillic.cyrillicCondensedFont, sofiaSansExtraCondensed],
  [cyrillic.cyrillicWideFont, unbounded],
  [cyrillic.cyrillicGroteskFont, golosText],
  [cyrillic.cyrillicRoundedFont, rubik],
] as const;

test("Cyrillic exports request the Cyrillic subset", () => {
  assert.ok(cyrillic.CYRILLIC_FONT_SUBSETS.includes("cyrillic"));
});

for (const [family, getInfo] of cases) {
  test(`${family} declares Cyrillic in a variable upright face`, () => {
    const info = getInfo();
    assert.equal(family, info.fontFamily);
    assert.ok(info.subsets.includes("cyrillic"));
    const faces = info.variable?.fontFaces.filter((face) => face.style === "normal") ?? [];
    for (const subset of cyrillic.CYRILLIC_FONT_SUBSETS) {
      assert.ok(
        faces.some((face) => face.subset === subset),
        subset,
      );
    }
    const axis = info.variable?.axes.wght;
    assert.ok(axis && axis.max > axis.min);
  });
}

test("Latin-only exports stay unchanged for old projects", () => {
  assert.equal(fonts.displayFont, "Space Grotesk");
  assert.equal(fonts.condensedFont, "Bebas Neue");
  assert.equal(fonts.roundedFont, "DM Sans");
});
