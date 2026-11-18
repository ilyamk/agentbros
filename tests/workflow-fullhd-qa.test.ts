import { generateLongformFontAlias } from "./helpers/longform-fonts";
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { renderStill, selectComposition } from "@remotion/renderer";
import { projectChapterPlan } from "../src/lib/longform/runner";
import { assertFullHDFrameEvidence, type FullHDFrameEvidence } from "./workflow-fullhd-evidence";

const valid: FullHDFrameEvidence = {
  frame: 15,
  fontsReady: true,
  findings: [],
  measurements: [
    { text: "Headline", role: "media-headline", rect: { x: 100, y: 200, width: 800, height: 100 } },
    { text: "word", role: "spoken-caption", rect: { x: 100, y: 950, width: 150, height: 60 } },
  ],
};
test("fullHD QA rejects code-only findings, missing glyphs and real caption collisions", () => {
  assertFullHDFrameEvidence(valid);
  assert.throws(() => assertFullHDFrameEvidence({ ...valid, findings: [{ code: "TEXT_CLIPPED" }] }));
  assert.throws(() => assertFullHDFrameEvidence({ ...valid, fontsReady: false }));
  assert.throws(() => assertFullHDFrameEvidence({ ...valid, measurements: [] }));
  const collision = structuredClone(valid);
  collision.measurements[1].rect.y = 220;
  assert.throws(() => assertFullHDFrameEvidence(collision));
});

test(
  "fresh fullHD ProductionRoot stills verify final DOM layout from retained benchmark project",
  {
    skip: process.env.RUN_WORKFLOW_FULLHD_QA !== "1",
    timeout: 180000,
  },
  async () => {
    assert.ok(process.env.WORKFLOW_ARTIFACTS_DIR, "Specify retained benchmark root");
    const durationSec = Number(process.env.WORKFLOW_FULLHD_DURATION_SEC ?? 180);
    assert.ok([180, 600, 1200].includes(durationSec));
    const beatFrames = (durationSec * 30) / 36;
    const artifact = path.resolve(
      process.env.WORKFLOW_ARTIFACTS_DIR,
      durationSec === 180 ? "fullhd-longform" : `fullhd-${durationSec}s`,
    );
    const boundary = JSON.parse(readFileSync(path.join(artifact, "boundary-evidence.json"), "utf8"));
    const tail = boundary.pixels.find((p: { frame: number }) => p.frame === durationSec * 30 - 1);
    assert.ok(tail, "Final decoded frame evidence missing");
    assert.ok(tail.rgb[0] > tail.rgb[2] + 10, "Final frame must retain orange visual, not empty dark background");
    const root = mkdtempSync(path.join(tmpdir(), "fullhd-final-qa-"));
    try {
      const project = path.join(root, "public/projects/education-demo");
      mkdirSync(path.dirname(project), { recursive: true });
      cpSync(path.join(artifact, "initial-project"), project, { recursive: true });
      const manifest = JSON.parse(readFileSync(path.join(project, "pipeline/chapters.json"), "utf8"));
      const fonts =
        durationSec > 180
          ? generateLongformFontAlias(root, "education-demo", path.join(project, "fonts.json"))
          : undefined;
      const plan = projectChapterPlan("education-demo", manifest, {
        rootDir: root,
        codeDir: process.cwd(),
        fontContext: fonts?.context,
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
              alias: {
                ...c.resolve?.alias,
                [path.resolve("src/lib/fonts")]: fonts?.alias ?? path.resolve("tests/fixtures/offline-fonts.ts"),
              },
            },
          };
        },
      });
      const evidence: Array<FullHDFrameEvidence & { chapterId: string }> = [];
      for (const job of durationSec > 180 ? plan.jobs : [plan.jobs.at(-1)!]) {
        const props = { ...job.props, qaEvidence: true };
        const composition = await selectComposition({ serveUrl, id: job.compositionId, inputProps: props });
        for (const frame of [15, beatFrames * 3 + 15, beatFrames * 5 + 15, job.durationInFrames - 1]) {
          let finalEvidence: FullHDFrameEvidence | undefined;
          await renderStill({
            serveUrl,
            composition,
            inputProps: props,
            frame,
            output: path.join(artifact, `fresh-qa-${job.chapterId}-${frame}.png`),
            logLevel: "error",
            onBrowserLog: (log) => {
              if (!log.text.startsWith("QA_EVIDENCE:")) return;
              const record = JSON.parse(log.text.slice(12)) as FullHDFrameEvidence;
              if (record.frame === frame) finalEvidence = record;
            },
          });
          assert.ok(finalEvidence, `Frame ${frame} QA probe missing`);
          assertFullHDFrameEvidence(finalEvidence);
          evidence.push({ ...finalEvidence, chapterId: job.chapterId });
        }
      }
      writeFileSync(path.join(artifact, "fresh-qa-evidence.json"), JSON.stringify(evidence, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
