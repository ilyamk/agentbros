import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { TEMPLATE_REGISTRY } from "../src/lib/templates/registry";
import { ProjectConfigSchema } from "../src/types/video";
import { projectToVideoProps, PROJECT_COMPOSITION_IDS } from "../src/lib/project-props";
import { importResource } from "../src/lib/font-resources/registry";
import { inspectSfnt } from "../src/lib/font-resources/sfnt";
import {
  createFontManifest,
  generateFontRoleModule,
  FONT_ROLES,
  type FontSelection,
} from "../src/lib/font-resources/manifest";
import { displayedFontText, prepareRenderFontContext } from "../src/lib/font-resources/render-context";
const fontSource = "/System/Library/Fonts/Supplemental/Arial.ttf";
const latinSource = "/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf";
const metadata = {
  source: "local system test original",
  licence: "no redistribution claim",
  licenceEvidence: "temporary local fixture only",
  licenceText: "System font tested locally; not distributed",
  attribution: "Local system font",
  checkedAt: "2026-10-11T00:00:00Z",
};
function cacheFont(root: string, source: string, requiredText: string) {
  const font = inspectSfnt(readFileSync(source));
  importResource(
    "style-demo",
    source,
    {
      ...metadata,
      kind: "font",
      family: font.family,
      weight: font.weight,
      style: font.style as "normal",
      subset: "local-original",
      requiredText,
    },
    root,
  );
  const select: FontSelection = {
    family: font.family,
    style: "normal",
    weights: [font.weight],
    subset: "local-original",
    requiredText,
  };
  const manifest = createFontManifest(
    "style-demo",
    Object.fromEntries(FONT_ROLES.map((role) => [role, select])) as Record<(typeof FONT_ROLES)[number], FontSelection>,
    root,
  );
  const context = path.join(root, `context-${font.weight}.json`);
  writeFileSync(context, JSON.stringify(manifest));
  return {
    font,
    context,
  };
}
test(
  "production font collector rejects missing Cyrillic used only in supplied translation",
  {
    skip: !existsSync(latinSource),
  },
  (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "style-glyph-"));
    t.after(() =>
      rmSync(root, {
        recursive: true,
        force: true,
      }),
    );
    mkdirSync(path.join(root, "public/projects/style-demo"), {
      recursive: true,
    });
    writeFileSync(path.join(root, "public/projects/style-demo/project.json"), "{}");
    const { font, context } = cacheFont(root, latinSource, "Test");
    assert.ok(font.missing("Ж").length);
    const props = {
      projectId: "style-demo",
      scenes: [
        {
          id: "sample",
          template: {
            id: "caption.bilingual",
            version: 1,
            props: {
              sourceLanguage: "en",
              translationLanguage: "ru",
              cues: [
                {
                  start: 0,
                  end: 1,
                  text: "Test",
                  translation: "Ж",
                },
              ],
            },
          },
        },
      ],
    } as never;
    assert.throws(() => prepareRenderFontContext("style-demo", context, props, root), /coverage/);
  },
);
test(
  "style packs render real font outlines, long Cyrillic and bilingual phrases across three formats and seek phases",
  {
    skip: process.env.RUN_RENDER_TESTS !== "1" || !existsSync(fontSource),
    timeout: 240000,
  },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "style-pack-browser-"));
    const artifact = process.env.STYLE_PACK_ARTIFACTS_DIR
      ? path.resolve(process.env.STYLE_PACK_ARTIFACTS_DIR)
      : path.join(root, "evidence");
    const browser = await openBrowser("chrome", {
      logLevel: "error",
    });
    try {
      const directory = path.join(root, "public/projects/style-demo/assets");
      mkdirSync(directory, {
        recursive: true,
      });
      mkdirSync(artifact, {
        recursive: true,
      });
      const image = "projects/style-demo/assets/proof.svg";
      writeFileSync(
        path.join(directory, "proof.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="420"><rect width="960" height="420" fill="#ddd"/><rect x="100" y="70" width="760" height="280" fill="#6C5CE7"/><circle cx="480" cy="210" r="90" fill="#fff"/></svg>',
      );
      writeFileSync(path.join(root, "public/projects/style-demo/project.json"), "{}");
      const entries = TEMPLATE_REGISTRY.filter((e) =>
        ["scene.worked-example", "scene.product-walkthrough", "scene.editorial-evidence", "caption.bilingual"].includes(
          e.id,
        ),
      );
      const instances = entries.map((entry) => {
        const input = structuredClone(entry.sample);
        if ("imageUrl" in input.props) input.props.imageUrl = image;
        if ("headline" in input.props)
          input.props.headline = "Проверяем длинный русский заголовок и понятное доказательство";
        if (input.id === "caption.bilingual") input.props.cues[0].end = 4;
        return input;
      });
      const requiredText = displayedFontText({
        scenes: instances.map((template) => ({
          template,
        })),
      } as never);
      const { font, context } = cacheFont(root, fontSource, requiredText);
      const module = path.join(root, "font-roles.ts");
      generateFontRoleModule("style-demo", context, module, {
        rootDir: root,
        requiredText,
      });
      const serveUrl = await bundle({
        entryPoint: path.resolve("src/index.ts"),
        publicDir: path.join(root, "public"),
        outDir: path.join(root, "bundle"),
        webpackOverride: (config) => {
          const c = enableTailwind(config);
          return {
            ...c,
            resolve: {
              ...c.resolve,
              modules: [path.resolve("node_modules"), "node_modules"],
              alias: {
                ...c.resolve?.alias,
                [path.resolve("src/lib/fonts")]: module,
              },
            },
          };
        },
      });
      const evidence: unknown[] = [];
      for (const template of instances)
        for (const format of ["vertical", "square", "landscape"] as const) {
          const project = ProjectConfigSchema.parse({
            name: "Style pack test",
            productName: "",
            colors: {
              accent: "#6C5CE7",
              background: "#FAFAFA",
              text: "#111111",
            },
            musicVolume: 0,
            scenes: [
              {
                id: "sample",
                text: "",
                visualType: "photo",
                imageUrl: image,
                durationInFrames: 120,
                template,
              },
            ],
          });
          const props = {
            ...projectToVideoProps(project, "style-demo", format, false),
            qaEvidence: true,
          };
          const composition = await selectComposition({
            puppeteerInstance: browser,
            serveUrl,
            id: PROJECT_COMPOSITION_IDS[format],
            inputProps: props,
            logLevel: "error",
          });
          for (const frame of [15, 60, 119]) {
            console.info(`Rendering ${template.id}/${format}/${frame}`);
            let measured:
              | {
                  frame: number;
                  fontsReady: boolean;
                  faces: {
                    family: string;
                    status: string;
                  }[];
                  images: {
                    source: string;
                    naturalWidth: number;
                    naturalHeight: number;
                  }[];
                  findings: unknown[];
                  measurements: {
                    text: string;
                    font: string;
                    loaded: boolean;
                  }[];
                }
              | undefined;
            const output = path.join(artifact, `${template.id}-${format}-${frame}.png`);
            await renderStill({
              puppeteerInstance: browser,
              serveUrl,
              composition,
              inputProps: props,
              output,
              frame,
              logLevel: "error",
              onBrowserLog: (log) => {
                if (!log.text.startsWith("QA_EVIDENCE:")) console.error(log.text);
                if (log.text.startsWith("QA_EVIDENCE:")) {
                  const value = JSON.parse(log.text.slice(12));
                  if (value.frame === frame) measured = value;
                }
              },
            });
            assert.ok(measured, `${template.id}/${format}/${frame} final DOM probe`);
            assert.equal(measured.fontsReady, true);
            assert.deepEqual(measured.findings, [], `${template.id}/${format}/${frame}`);
            assert.ok(measured.faces.some((face) => face.family === font.family && face.status === "loaded"));
            assert.ok(measured.measurements.length > 0);
            assert.ok(measured.measurements.every((m) => m.loaded));
            if (template.id === "scene.product-walkthrough") {
              assert.equal(measured.images.length, 1, "Product proof must not mount a second legacy backdrop");
              assert.ok(measured.images[0].source.endsWith(image));
              assert.ok(measured.images[0].naturalWidth > 0 && measured.images[0].naturalHeight > 0);
            }
            if (template.id === "caption.bilingual") {
              assert.ok(measured.measurements.some((m) => m.text === template.props.cues[0].translation));
              assert.ok(measured.measurements.some((m) => m.text === template.props.cues[0].text));
            }
            assert.equal(readFileSync(output).readUInt32BE(16), composition.width);
            evidence.push({
              template: template.id,
              format,
              phase: frame,
              measurement: measured,
            });
          }
        }
      writeFileSync(
        path.join(artifact, "evidence.json"),
        JSON.stringify(
          {
            fontMode: "cached-production-fonts",
            originalFamily: font.family,
            cases: evidence,
          },
          null,
          2,
        ),
      );
    } finally {
      await browser.close({
        silent: true,
      });
      rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  },
);
