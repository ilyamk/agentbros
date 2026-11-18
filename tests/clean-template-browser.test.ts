import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderStill } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { TEMPLATE_REGISTRY } from "../src/lib/templates/registry";
import { ProjectConfigSchema } from "../src/types/video";
import { projectToVideoProps, PROJECT_COMPOSITION_IDS, type ProjectVideoProps } from "../src/lib/project-props";
import { artifactHash } from "../src/lib/qa-evidence/frames";
import { adaptLegacyProject } from "../src/lib/timeline-ir/legacy";
test(
  "all registered caption overlays honor clean output in promo and IR without changing base pixels",
  { skip: process.env.RUN_QA_EVIDENCE_TESTS !== "1", timeout: 120000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "clean-template-"));
    mkdirSync(path.join(root, "public/assets"), { recursive: true });
    writeFileSync(
      path.join(root, "public/assets/proof.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><rect width="1080" height="1080" fill="#3090c0"/></svg>',
    );
    try {
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
              alias: {
                ...c.resolve?.alias,
                [path.resolve("src/lib/fonts")]: path.resolve("tests/fixtures/offline-fonts.ts"),
              },
            },
          };
        },
      });
      const render = async (props: ProjectVideoProps, label: string) => {
        const composition = await selectComposition({
          serveUrl,
          id: PROJECT_COMPOSITION_IDS[props.format],
          inputProps: { ...props, qaEvidence: true },
        });
        const file = path.join(root, label + ".png");
        let measure = "";
        await renderStill({
          serveUrl,
          composition,
          inputProps: { ...props, qaEvidence: true },
          frame: 30,
          output: file,
          imageFormat: "png",
          logLevel: "error",
          onBrowserLog: (l) => {
            if (l.text.startsWith("QA_EVIDENCE:")) {
              const v = JSON.parse(l.text.slice(12));
              if (v.frame === 30) measure = JSON.stringify(v.measurements);
            }
          },
        });
        return {
          hash: artifactHash(file),
          measure,
          duration: composition.durationInFrames,
        };
      };
      const entries = TEMPLATE_REGISTRY.filter((e) => e.id.startsWith("caption."));
      for (const [index, entry] of entries.entries()) {
        const template = structuredClone(entry.sample);
        if ("cues" in template.props)
          template.props.cues = [{ start: 0, end: 3, text: "CAPTION_MARKER", translation: "CAPTION_TRANSLATION" }];
        else if ("words" in template.props)
          template.props.words = [{ text: "CAPTION_MARKER", start: 0, end: 3, emphasis: true }];
        else throw new Error("Missing caption text props: " + entry.id);
        const format = (["vertical", "square", "landscape"] as const)[index % 3];
        const project = ProjectConfigSchema.parse({
          name: "proof",
          productName: "proof",
          musicVolume: 0,
          colors: { accent: "#6C5CE7", background: "#fff", text: "#111" },
          scenes: [
            {
              id: "hook",
              text: "",
              headline: "EDITORIAL_TITLE",
              imageUrl: "assets/proof.svg",
              visualType: "photo",
              durationInFrames: 120,
              template,
            },
          ],
        });
        const on = projectToVideoProps(project, "proof", format, false),
          off = { ...on, captionsEnabled: false },
          baseline = {
            ...on,
            scenes: on.scenes.map((scene) => ({
              ...scene,
              template: undefined,
            })),
          };
        const captioned = await render(on, entry.id + "-on"),
          clean = await render(off, entry.id + "-off"),
          base = await render(baseline, entry.id + "-base");
        assert.ok(captioned.measure.includes("CAPTION_MARKER"));
        assert.equal(clean.measure.includes("CAPTION_MARKER"), false);
        assert.ok(clean.measure.includes("EDITORIAL_TITLE"));
        assert.notEqual(captioned.hash, clean.hash);
        assert.equal(clean.hash, base.hash);
        assert.equal(clean.duration, captioned.duration);
        const ir = adaptLegacyProject(project, "proof");
        ir.tracks = ir.tracks.filter((t) => t.kind === "visual");
        const irClean = await render({ ...off, timeline: ir, timelineAssets: {} }, entry.id + "-ir-clean");
        assert.equal(irClean.measure.includes("CAPTION_MARKER"), false);
        assert.ok(irClean.measure.includes("EDITORIAL_TITLE"));
      }
      const captionOnly = ProjectConfigSchema.parse({
        name: "standalone",
        productName: "standalone",
        musicVolume: 0,
        colors: { accent: "#6C5CE7", background: "#fff", text: "#111" },
        scenes: [
          {
            id: "hook",
            text: "",
            visualType: "title",
            durationInFrames: 120,
            template: {
              id: "caption.phrase",
              version: 1,
              props: {
                words: [{ text: "CAPTION_ONLY_MARKER", start: 0, end: 3 }],
              },
            },
          },
        ],
      });
      const only = projectToVideoProps(captionOnly, "standalone", "square", false);
      const clean = await render({ ...only, captionsEnabled: false }, "standalone-clean");
      assert.equal(clean.measure.includes("CAPTION_ONLY_MARKER"), false);
      const reference = await render(
        {
          ...only,
          scenes: only.scenes.map((s) => ({ ...s, template: undefined })),
        },
        "standalone-base",
      );
      assert.equal(clean.hash, reference.hash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
