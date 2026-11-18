import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { projectChapterPlan, renderChapters } from "../src/lib/longform/runner";
import { mediaProbe } from "../src/lib/audio/analysis";
import { spacing } from "../src/lib/design-tokens";
test(
  "canonical chapter job renders actual production Root locally with rebased captions and reusable checksum",
  { skip: process.env.RUN_LONGFORM_RENDER_TESTS !== "1", timeout: 120000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "chapter-root-browser-"));
    const directory = path.join(root, "public/projects/lesson");
    mkdirSync(path.join(directory, "pipeline"), { recursive: true });
    const scene = {
      id: "hook",
      text: "",
      headline: "Lesson proof",
      visualType: "title",
      durationInFrames: 120,
    };
    writeFileSync(
      path.join(directory, "project.json"),
      JSON.stringify({
        name: "lesson",
        productName: "lesson",
        formats: ["vertical", "square", "landscape"],
        colors: { accent: "#6C5CE7", background: "#fff", text: "#111" },
        musicVolume: 0,
        scenes: [scene],
      }),
    );
    const r = (num: number) => ({ num, den: 1 });
    new TimelineEditStore(path.join(directory, "pipeline/timeline-edit.json")).initialize({
      version: 1,
      projectId: "lesson",
      timebase: r(30),
      tracks: [
        {
          id: "visual",
          kind: "visual",
          clips: [
            {
              id: "hook",
              assetId: "scene:hook",
              start: r(0),
              source: { start: r(0), end: r(120), timebase: r(30) },
              rate: r(2),
              transition: { kind: "cut" },
              captions: [],
              payload: { scene },
            },
          ],
        },
        {
          id: "captions",
          kind: "captions",
          clips: [
            {
              id: "line",
              assetId: "caption:inline",
              start: r(0),
              source: { start: r(0), end: r(120), timebase: r(30) },
              rate: r(2),
              transition: { kind: "cut" },
              captions: [
                {
                  id: "word",
                  text: "CHAPTER_CAPTION",
                  start: r(84),
                  end: r(110),
                },
              ],
            },
          ],
        },
      ],
    });
    const manifest = {
      version: 1,
      revision: 1,
      chapters: [
        {
          id: "second",
          title: "Second half",
          revision: 1,
          start: r(30),
          end: r(60),
        },
      ],
    };
    try {
      const plan = projectChapterPlan("lesson", manifest, { rootDir: root });
      assert.equal(plan.jobs[0].durationInFrames, 30);
      assert.equal(plan.jobs[0].timeline.tracks[0].clips[0].source.start.num, 60);
      assert.equal(plan.jobs[0].timeline.tracks[0].clips[0].source.end.num, 120);
      assert.equal(plan.jobs[0].timeline.tracks[0].clips[0].rate.num, 2);
      const captionTrack = plan.jobs[0].snapshot.tracks.find((t) => t.kind === "captions")!;
      assert.equal(captionTrack.clips[0].captions[0].start.num, 12);
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
      const backend = async (job: (typeof plan.jobs)[number], output: string) => {
        const composition = await selectComposition({
          serveUrl,
          id: job.compositionId,
          inputProps: job.props,
        });
        await renderMedia({
          serveUrl,
          composition,
          inputProps: job.props,
          codec: "h264",
          outputLocation: output,
          concurrency: 1,
          logLevel: "error",
          scale: 0.25,
        });
      };
      const result = await renderChapters(plan, {
        dryRun: false,
        render: backend,
      });
      assert.equal(result.outputs.length, 1);
      const probe = mediaProbe(result.outputs[0]);
      assert.ok(probe.streams.some((s) => s.codec_type === "video"));
      assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.08);
      const job = plan.jobs[0],
        inputProps = { ...job.props, qaEvidence: true };
      const composition = await selectComposition({
        serveUrl,
        id: job.compositionId,
        inputProps,
      });
      let measurement = "";
      await renderStill({
        serveUrl,
        composition,
        inputProps,
        frame: 17,
        output: path.join(root, "caption-proof.png"),
        logLevel: "error",
        onBrowserLog: (log) => {
          if (log.text.startsWith("QA_EVIDENCE:")) {
            const value = JSON.parse(log.text.slice(12));
            if (value.frame === 17) measurement = JSON.stringify(value.measurements);
          }
        },
      });
      assert.ok(measurement.includes("CHAPTER_CAPTION"));
      measurement = "";
      await renderStill({
        serveUrl,
        composition,
        inputProps,
        frame: 11,
        output: path.join(root, "caption-before.png"),
        logLevel: "error",
        onBrowserLog: (log) => {
          if (log.text.startsWith("QA_EVIDENCE:")) {
            const value = JSON.parse(log.text.slice(12));
            if (value.frame === 11) measurement = JSON.stringify(value.measurements);
          }
        },
      });
      assert.equal(measurement.includes("CHAPTER_CAPTION"), false);
      // Use actual DOM glyph bounds from ProductionRoot in every output format.
      // A full-frame Sequence would ignore the bottom slot and fail these checks.
      for (const format of ["vertical", "square", "landscape"] as const) {
        const formatJob = projectChapterPlan("lesson", manifest, {
          rootDir: root,
          format,
        }).jobs[0];
        const formatProps = { ...formatJob.props, qaEvidence: true };
        const formatComposition = await selectComposition({
          serveUrl,
          id: formatJob.compositionId,
          inputProps: formatProps,
        });
        type Measurement = {
          text: string;
          rect: { x: number; y: number; width: number; height: number };
        };
        let glyph: Measurement | undefined;
        await renderStill({
          serveUrl,
          composition: formatComposition,
          inputProps: formatProps,
          frame: 17,
          output: path.join(root, `caption-position-${format}.png`),
          logLevel: "error",
          onBrowserLog: (log) => {
            if (!log.text.startsWith("QA_EVIDENCE:")) return;
            const evidence = JSON.parse(log.text.slice(12));
            if (evidence.frame === 17)
              glyph = evidence.measurements.find((m: Measurement) => m.text === "CHAPTER_CAPTION");
          },
        });
        assert.ok(glyph, `${format}: timed caption must be mounted`);
        const { rect } = glyph;
        const { width, height } = formatComposition;
        assert.ok(
          Math.abs(rect.x + rect.width / 2 - width / 2) <= 1,
          `${format}: caption glyph must be centered, got ${JSON.stringify(rect)}`,
        );
        assert.ok(rect.x >= spacing.sidePadding[format] - 1);
        assert.ok(rect.x + rect.width <= width - spacing.sidePadding[format] + 1);
        assert.ok(rect.y >= spacing.safeTop[format] - 1);
        const bottom = rect.y + rect.height;
        assert.ok(
          bottom <= height - spacing.safeBottom[format] + 1 && bottom >= height - spacing.safeBottom[format] - 12,
          `${format}: caption must occupy the safe bottom slot, got ${JSON.stringify(rect)}`,
        );
      }
      const reused = projectChapterPlan("lesson", manifest, { rootDir: root });
      assert.equal(reused.jobs[0].action, "reuse");
      await renderChapters(reused, {
        dryRun: false,
        render: async () => {
          throw new Error("Cached verified chapter should not render");
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
