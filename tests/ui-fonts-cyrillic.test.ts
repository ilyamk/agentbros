import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const UI = path.resolve("src/motion/library/ui");

// motion:check's FALLBACK_FONT found Russian copy in ui blocks drawn in Times New Roman when Geist loaded only its latin
// subset. Every Google font a ui block loads must carry Cyrillic, and every family a sans fallback.
test("ui blocks load their Google fonts with the Cyrillic subset", () => {
  let checked = 0;
  for (const file of readdirSync(UI).filter((name) => /\.tsx?$/.test(name))) {
    const source = readFileSync(path.join(UI, file), "utf8");
    for (const call of source.matchAll(/load\w*\(\s*"normal",\s*\{[^}]*\}/g)) {
      const subsets = /subsets:\s*(\w+|\[[^\]]*\])/.exec(call[0])?.[1] ?? "";
      const listed = subsets.startsWith("[")
        ? subsets
        : (new RegExp(`const ${subsets}[^=]*=\\s*(\\[[^\\]]*\\])`).exec(source)?.[1] ?? "");
      assert.match(listed, /"cyrillic"/, `${file}: ${call[0]}`);
      checked++;
    }
  }
  assert.ok(checked >= 2);
});

test("the ui font families fall back to a sans, never the browser's serif", async () => {
  const { geist, geistMono } = await import("../src/motion/library/ui/fonts");
  assert.match(geist, /sans-serif$/);
  assert.match(geistMono, /monospace$/);
});
