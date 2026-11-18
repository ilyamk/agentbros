import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hashFile } from "../src/lib/assets/registry";
import { mediaProbe } from "../src/lib/audio/analysis";
import { tmpdir } from "node:os";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { importResource } from "../src/lib/font-resources/registry";
import { inspectSfnt } from "../src/lib/font-resources/sfnt";
import { createFontManifest, FONT_ROLES, type FontSelection } from "../src/lib/font-resources/manifest";
import { projectChapterPlan, remotionChapterBackend, renderChapters } from "../src/lib/longform/runner";
const sfnt = "/System/Library/Fonts/Supplemental/Arial.ttf";
const r = (num: number) => ({ num, den: 1 });
test(
  "chapter font plans validate actual SFNT, preserve identical fingerprints, separate role contexts and reject changed captured bytes",
  { skip: !existsSync(sfnt) },
  async (t) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chapter-font-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, "public/projects/lesson");
    mkdirSync(path.join(project, "pipeline"), { recursive: true });
    const scene = { id: "hook", text: "", headline: "Lesson", visualType: "title", durationInFrames: 30 };
    writeFileSync(
      path.join(project, "project.json"),
      JSON.stringify({
        name: "Lesson",
        productName: "Lesson",
        formats: ["landscape"],
        colors: {},
        musicVolume: 0,
        scenes: [scene],
      }),
    );
    new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json")).initialize({
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
              source: { start: r(0), end: r(30), timebase: r(30) },
              rate: r(1),
              transition: { kind: "cut" },
              captions: [],
              payload: { scene },
            },
          ],
        },
      ],
    });
    const actual = inspectSfnt(readFileSync(sfnt));
    const record = importResource(
      "lesson",
      sfnt,
      {
        source: "local system acceptance fixture",
        licence: "test only",
        licenceText: "no redistribution claim",
        licenceEvidence: "system installed font",
        attribution: "system fixture",
        checkedAt: "2026-10-11T00:00:00Z",
        kind: "font",
        family: actual.family,
        weight: actual.weight,
        style: actual.style as "normal",
        subset: "latin",
        requiredText: "Lesson",
      },
      root,
    );
    const selection: FontSelection = {
      family: actual.family,
      weights: [actual.weight],
      style: actual.style as "normal",
      subset: "latin",
      requiredText: "Lesson",
    };
    const manifest = createFontManifest(
      "lesson",
      Object.fromEntries(FONT_ROLES.map((role) => [role, selection])) as Record<
        (typeof FONT_ROLES)[number],
        FontSelection
      >,
      root,
    );
    const context = path.join(project, "fonts.json");
    writeFileSync(context, JSON.stringify(manifest));
    const chapters = {
      version: 1,
      revision: 1,
      chapters: [{ id: "hook", title: "Lesson", revision: 1, start: r(0), end: r(30) }],
      protectedSpans: [],
    };
    const first = projectChapterPlan("lesson", chapters, { rootDir: root, fontContext: context });
    const second = projectChapterPlan("lesson", chapters, { rootDir: root, fontContext: context });
    assert.equal(first.jobs[0].fingerprint, second.jobs[0].fingerprint);
    assert.equal(existsSync(path.join(root, ".cache")), false, "read-only plan must not cache generated code");
    const bold = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
    if (existsSync(bold)) {
      const face = inspectSfnt(readFileSync(bold));
      const alternative = importResource(
        "lesson",
        bold,
        {
          source: "local system acceptance fixture",
          licence: "test only",
          licenceText: "no redistribution claim",
          licenceEvidence: "system installed font",
          attribution: "system fixture",
          checkedAt: "2026-10-11T00:00:00Z",
          kind: "font",
          family: face.family,
          weight: face.weight,
          style: face.style as "normal",
          subset: "latin",
          requiredText: "Lesson",
        },
        root,
      );
      const role = { ...selection, family: face.family, weights: [face.weight], style: face.style as "normal" };
      const other = createFontManifest(
        "lesson",
        Object.fromEntries(FONT_ROLES.map((name) => [name, role])) as Record<
          (typeof FONT_ROLES)[number],
          FontSelection
        >,
        root,
      );
      const otherContext = path.join(project, "bold.json");
      writeFileSync(otherContext, JSON.stringify(other));
      const otherPlan = projectChapterPlan("lesson", chapters, { rootDir: root, fontContext: otherContext });
      assert.notEqual(otherPlan.jobs[0].fingerprint, first.jobs[0].fingerprint);
      assert.notEqual(alternative.hash, record.hash);
      assert.ok(otherPlan.jobs[0].fontCapture?.hashes[path.join(root, "public", alternative.original)]);
      // Refresh original capture because the registry now contains another exact face.
      Object.assign(first, projectChapterPlan("lesson", chapters, { rootDir: root, fontContext: context }));
    }

    assert.ok(first.jobs[0].fontCapture?.hashes[path.join(root, "public", record.original)]);
    mkdirSync(path.dirname(first.cacheFile), { recursive: true });
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:r=30:d=1",
      "-c:v",
      "libx264",
      first.jobs[0].output,
    ]);
    writeFileSync(
      first.cacheFile,
      JSON.stringify({
        hook: {
          fingerprint: first.jobs[0].fingerprint,
          output: first.jobs[0].output,
          outputHash: hashFile(first.jobs[0].output),
        },
      }),
    );
    assert.equal(
      projectChapterPlan("lesson", chapters, { rootDir: root, fontContext: context }).jobs[0].action,
      "reuse",
    );
    assert.notEqual(
      first.jobs[0].fingerprint,
      projectChapterPlan("lesson", chapters, { rootDir: root }).jobs[0].fingerprint,
    );
    const clean = projectChapterPlan("lesson", chapters, { rootDir: root, fontContext: context, captions: "off" });
    assert.equal(clean.jobs[0].props.captionsEnabled, false);
    assert.notEqual(clean.cacheFile, first.cacheFile);
    assert.notEqual(clean.jobs[0].fingerprint, first.jobs[0].fingerprint);
    writeFileSync(
      context,
      JSON.stringify({
        ...manifest,
        faces: manifest.faces.map((face) => ({ ...face, testedText: face.testedText + "!" })),
      }),
    );
    const changed = projectChapterPlan("lesson", chapters, { rootDir: root, fontContext: context });
    assert.notEqual(first.jobs[0].fingerprint, changed.jobs[0].fingerprint);
    assert.equal(changed.jobs[0].action, "render");
    await assert.rejects(
      remotionChapterBackend(root)(first.jobs[0], path.join(root, "unused.mp4")),
      /font source changed/,
    );
    await assert.rejects(
      renderChapters(first, {
        dryRun: false,
        render: async () => {
          throw new Error("must not render stale fonts");
        },
      }),
      /font source changed/,
    );
    writeFileSync(
      context,
      JSON.stringify({ ...manifest, faces: manifest.faces.map((face) => ({ ...face, hash: "0".repeat(64) })) }),
    );
    assert.throws(
      () => projectChapterPlan("lesson", chapters, { rootDir: root, fontContext: context }),
      /not an exact registered original/,
    );
    writeFileSync(context, JSON.stringify(manifest));
    if (process.env.RUN_CHAPTER_FONT_RENDER_TESTS === "1") {
      const final = projectChapterPlan("lesson", chapters, { rootDir: root, fontContext: context });
      const output = path.join(root, "font-render.mp4");
      await remotionChapterBackend(root)(final.jobs[0], output);
      assert.ok(readFileSync(output).length > 1000);
      const probe = mediaProbe(output);
      assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.08);
      assert.ok(
        probe.streams.some(
          (stream) => stream.codec_type === "video" && stream.width === 1920 && stream.height === 1080,
        ),
      );
    }
    rmSync(path.join(root, "public", record.original));
    assert.throws(() => projectChapterPlan("lesson", chapters, { rootDir: root, fontContext: context }));
  },
);
