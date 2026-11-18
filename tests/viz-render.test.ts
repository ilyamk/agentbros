import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { renderStill, selectComposition } from "@remotion/renderer";
import { VIZ_RECIPES } from "../src/types/viz";
import { compileViz } from "../src/lib/viz/compile";
import { exampleViz } from "../src/lib/viz/store";
import { eventFixture } from "./viz-events.fixture";
import { withComposition } from "../src/lib/vision/composition";
const enabled = process.env.RUN_VIZ_RENDER_TESTS === "1";
test(
  "all recipes and formats render real opening, reading and final frames",
  { skip: !enabled, timeout: 900000 },
  async () => {
    const output = path.resolve("out/qa/viz-acceptance");
    mkdirSync(output, { recursive: true });
    const initial = await compileViz(exampleViz("bars"), "landscape");
    const propsFile = path.join(output, "initial.json");
    writeFileSync(propsFile, JSON.stringify({ plans: [initial], ground: "opaque" }));
    await withComposition(
      {
        entry: path.resolve("src/motion/viz/index.tsx"),
        composition: "VizScene",
        publicDir: path.resolve("public"),
        gl: "angle",
        propsFile,
      },
      async (session) => {
        for (const recipe of VIZ_RECIPES)
          for (const format of ["landscape", "vertical", "square"] as const) {
            const plan = await compileViz(
              {
                ...exampleViz(recipe),
                title: `${recipe}: данные`,
                layout: recipe.includes("network") ? "force" : "layered",
              },
              format,
            );
            const folder = path.join(output, recipe, format);
            mkdirSync(folder, { recursive: true });
            const selected = await selectComposition({
              serveUrl: session.serveUrl,
              id: "VizScene",
              inputProps: { plans: [plan], ground: "opaque" },
              puppeteerInstance: session.browser,
              chromiumOptions: session.chromiumOptions,
              logLevel: "error",
            });
            for (const frame of [0, 75, 149]) {
              const output = path.join(folder, `frame-${frame}.png`);
              await renderStill({
                serveUrl: session.serveUrl,
                composition: selected,
                inputProps: { plans: [plan], ground: "opaque" },
                frame,
                output,
                imageFormat: "png",
                puppeteerInstance: session.browser,
                chromiumOptions: session.chromiumOptions,
                logLevel: "error",
              });
              assert.ok(readFileSync(output).length > 1000);
            }
          }
        const events = await eventFixture();
        const folder = path.join(output, "events");
        mkdirSync(folder, { recursive: true });
        const props = { plans: [events], ground: "opaque" };
        const selected = await selectComposition({
          serveUrl: session.serveUrl,
          id: "VizScene",
          inputProps: props,
          puppeteerInstance: session.browser,
          chromiumOptions: session.chromiumOptions,
          logLevel: "error",
        });
        for (const frame of [0, 19, 20, 30, 40, 50, 70, 105, 125, 149])
          await renderStill({
            serveUrl: session.serveUrl,
            composition: selected,
            inputProps: props,
            frame,
            output: path.join(folder, `frame-${frame}.png`),
            imageFormat: "png",
            puppeteerInstance: session.browser,
            chromiumOptions: session.chromiumOptions,
            logLevel: "error",
          });
      },
    );
  },
);
