import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderStill } from "@remotion/renderer";
import { importResource } from "../src/lib/font-resources/registry";
import { inspectSfnt } from "../src/lib/font-resources/sfnt";
import { renderBrowserEvidence } from "../src/lib/qa-evidence/browser";
import { ProjectConfigSchema } from "../src/types/video";
import { projectToVideoProps } from "../src/lib/project-props";
import {
  createFontManifest,
  generateFontRoleModule,
  FONT_ROLES,
  type FontSelection,
} from "../src/lib/font-resources/manifest";
const source = "/System/Library/Fonts/Supplemental/Arial.ttf";
test(
  "real cached font loads in offline Remotion browser and renders Cyrillic",
  {
    skip: process.env.RUN_RENDER_TESTS !== "1" || !existsSync(source),
    timeout: 120000,
  },
  async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "font-browser-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, "public/projects/fonts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "project.json"), "{}");
    const font = inspectSfnt(readFileSync(source));
    importResource(
      "fonts",
      source,
      {
        source: "local system test only",
        licence: "no redistribution claim",
        licenceEvidence: "Local temporary fixture",
        licenceText: "System font fixture only; not distributed",
        attribution: "Local system font",
        checkedAt: "2026-10-11T00:00:00Z",
        kind: "font",
        family: font.family,
        weight: font.weight,
        style: font.style as "normal",
        subset: "latin-cyrillic",
        requiredText: "Привет мир",
      },
      root,
    );
    const selection: FontSelection = {
      family: font.family,
      style: "normal",
      weights: [font.weight],
      subset: "latin-cyrillic",
      requiredText: "Привет мир",
    };
    const manifest = createFontManifest(
      "fonts",
      Object.fromEntries(FONT_ROLES.map((role) => [role, selection])) as Record<
        (typeof FONT_ROLES)[number],
        FontSelection
      >,
      root,
    );
    const context = path.join(root, "context.json");
    writeFileSync(context, JSON.stringify(manifest));
    const module = path.join(root, "fonts.ts");
    generateFontRoleModule("fonts", context, module, {
      rootDir: root,
      requiredText: "Привет мир",
    });
    // Entry uses production loader and actual outlines. No alias to a system CSS family.
    const entry = path.join(root, "entry.tsx");
    writeFileSync(
      entry,
      `import React from "react"; import {registerRoot,Composition,AbsoluteFill} from "remotion"; import {primaryFont} from ${JSON.stringify(module)}; const Video=()=> <AbsoluteFill style={{background:"white",color:"black",fontFamily:primaryFont,fontSize:32}}>Привет мир</AbsoluteFill>; registerRoot(()=> <Composition id="Fonts" component={Video} durationInFrames={1} fps={30} width={256} height={64}/>);`,
    );
    const serveUrl = await bundle({
      entryPoint: entry,
      publicDir: path.join(root, "public"),
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          modules: [path.resolve("node_modules"), "node_modules"],
        },
      }),
    });
    const composition = await selectComposition({ serveUrl, id: "Fonts" });
    const output = path.join(root, "actual.png");
    await renderStill({ serveUrl, composition, output, imageFormat: "png" });
    assert.ok(readFileSync(output).length > 500);
    const project = ProjectConfigSchema.parse({
      name: "Fonts",
      productName: "Fonts",
      formats: ["vertical"],
      colors: { accent: "#123456", background: "#ffffff", text: "#111111" },
      musicVolume: 0,
      scenes: [{ id: "hook", text: "", headline: "Привет мир", visualType: "title", durationInFrames: 60 }],
    });
    writeFileSync(path.join(dir, "project.json"), JSON.stringify(project));
    const props = projectToVideoProps(project, "fonts", "vertical", false);
    const evidence = await renderBrowserEvidence(
      props,
      [{ frame: 20, reasons: ["exact-font-proof"] }],
      path.join(root, "production-evidence"),
      { rootDir: root, codeDir: process.cwd(), fontContext: context },
    );
    assert.equal(evidence.fontMode, "cached-production-fonts");
    const measured = evidence.frames[0].measurement as {
      faces: { family: string; status: string }[];
      measurements: { text: string; font: string; loaded: boolean }[];
    };
    assert.ok(
      measured.faces.some((face) => face.family === font.family && face.status === "loaded"),
      "A real local FontFace must be registered, not a system-family substitute",
    );
    assert.ok(
      measured.measurements.some((row) => row.text.includes("Привет") && row.font.includes(font.family) && row.loaded),
    );
    await assert.rejects(
      () =>
        renderBrowserEvidence(props, [], path.join(root, "invalid-evidence"), {
          rootDir: root,
          fontContext: context,
          offlineFonts: true,
        }),
      /Choose/,
    );
  },
);
