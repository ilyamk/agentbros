import test from "node:test";
import assert from "node:assert/strict";
import {
  realpathSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { educationFixture } from "./workflow-education-fixture";
import { runEducationWorkflow } from "../src/lib/workflows/education";
import { projectChapterPlan, renderChapters } from "../src/lib/longform/runner";
import { assembleChapters } from "../src/lib/longform/assembly";
test("production assembly binds chapter SHA/frame counts, rejects symlink output and reuses verified final", async () => {
  const f = educationFixture();
  try {
    const created = runEducationWorkflow(f.request, {
      action: "create",
      rootDir: f.root,
    });
    const plan = projectChapterPlan(f.request.projectId, created.metadata.chapterManifest, { rootDir: f.root });
    const rendered = await renderChapters(plan, {
      dryRun: false,
      render: async (job, file) => {
        const p = spawnSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=teal:s=320x180:r=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=330:sample_rate=48000",
            "-t",
            String(job.durationInFrames / 30),
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            file,
          ],
          { encoding: "utf8" },
        );
        assert.equal(p.status, 0, p.stderr);
      },
    });
    const assembly = assembleChapters(plan, rendered, { rootDir: f.root });
    assert.equal(assembly.report.totalFrames, 360);
    assert.equal(assembly.report.fullDecodeVerified, true);
    assert.equal(assembleChapters(plan, rendered, { rootDir: f.root }).metadata.reused, true);
    // Exercise clean namespace and root inference with real encoded inputs. The
    // fixture reuses technical frames; production clean plans bind distinct hashes.
    const cleanDirectory = path.join(path.dirname(plan.cacheFile), "clean");
    mkdirSync(cleanDirectory);
    const cleanCache = JSON.parse(readFileSync(plan.cacheFile, "utf8"));
    const cleanOutputs = rendered.outputs.map((file) => {
      const next = path.join(cleanDirectory, path.basename(file));
      copyFileSync(file, next);
      return next;
    });
    for (const entry of Object.values(cleanCache) as { output: string }[])
      entry.output = path.join(cleanDirectory, path.basename(entry.output));
    const cleanPlan = {
      ...plan,
      captions: "off" as const,
      cacheFile: path.join(cleanDirectory, "cache.json"),
      jobs: plan.jobs.map((job, i) => ({
        ...job,
        output: cleanOutputs[i],
        props: { ...job.props, captionsEnabled: false },
      })),
    };
    writeFileSync(cleanPlan.cacheFile, JSON.stringify(cleanCache));
    const clean = assembleChapters(cleanPlan, { outputs: cleanOutputs });
    assert.equal(clean.report.captions, "off");
    assert.equal(clean.report.totalFrames, 360);
    assert.throws(
      () =>
        assembleChapters({
          ...cleanPlan,
          jobs: cleanPlan.jobs.map((job, i) =>
            i === 0 ? { ...job, props: { ...job.props, captionsEnabled: true } } : job,
          ),
        }),
      /mix clean/,
    );
    assert.throws(
      () =>
        assembleChapters(
          {
            ...plan,
            jobs: plan.jobs.map((job, i) =>
              i === 0 ? { ...job, props: { ...job.props, projectId: "unrelated" } } : job,
            ),
          },
          undefined,
          { rootDir: f.root },
        ),
      /mix projects/,
    );
    const external = path.join(f.root, "outside");
    mkdirSync(external);
    symlinkSync(external, path.join(f.root, "out", f.request.projectId, "escape"));
    assert.throws(
      () =>
        assembleChapters(plan, rendered, {
          rootDir: f.root,
          outputFile: path.join(realpathSync(f.root), "out", f.request.projectId, "escape", "bad.mp4"),
        }),
      /symlink/,
    );
    assert.throws(
      () => assembleChapters(plan, { outputs: [...rendered.outputs].reverse() }, { rootDir: f.root }),
      /identity/,
    );
    appendFileSync(rendered.outputs[0], "changed bytes");
    assert.throws(() => assembleChapters(plan, rendered, { rootDir: f.root }), /checksum/);
  } finally {
    f.cleanup();
  }
});
