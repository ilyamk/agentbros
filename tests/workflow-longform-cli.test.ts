import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { educationFixture } from "./workflow-education-fixture";
import { runEducationWorkflow } from "../src/lib/workflows/education";
import { projectChapterPlan, renderChapters } from "../src/lib/longform/runner";
import { mediaProbe } from "../src/lib/audio/analysis";
import { COMMANDS } from "../src/mcp/catalog";
import { invokeCommand } from "../src/mcp/bridge";

const repo = path.resolve(import.meta.dirname, "..");
test("public longform CLI and scoped MCP assemble verified caption variants without rendering or API replay", async () => {
  const f = educationFixture();
  try {
    const created = runEducationWorkflow(f.request, { action: "create", rootDir: f.root });
    const manifest = created.metadata.chapterManifest;
    // Synthetic cache fixtures exercise the public assembly route. Actual ProductionRoot
    // rendering/caption pixels are independently tested by the scenario browser suites.
    for (const captions of ["on", "off"] as const) {
      const plan = projectChapterPlan(f.request.projectId, manifest, { rootDir: f.root, codeDir: repo, captions });
      await renderChapters(plan, {
        dryRun: false,
        render: async (job, output) => {
          const result = spawnSync(
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
              output,
            ],
            { encoding: "utf8", timeout: 30000 },
          );
          assert.equal(result.status, 0, result.stderr);
        },
      });
    }
    const base = [
      "--project",
      f.request.projectId,
      "--chapters",
      `public/projects/${f.request.projectId}/pipeline/chapters.json`,
      "--assemble",
    ];
    const cli = (flags: string[]) =>
      spawnSync(
        process.execPath,
        [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "scripts/longform.ts"), ...base, ...flags],
        { cwd: f.root, encoding: "utf8", timeout: 60000 },
      );
    const output = path.join(realpathSync(f.root), "out", f.request.projectId, "lesson.mp4");
    const planned = cli(["--output", output]);
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(planned.stdout.trim().split("\n").length, 1);
    const preview = JSON.parse(planned.stdout);
    assert.equal(preview.ok, true);
    assert.equal(preview.metadata.dryRun, true);
    assert.equal(preview.metadata.assemblyRequested, true);
    assert.ok(preview.metadata.plan.jobs.every((job: { action: string }) => job.action === "reuse"));
    assert.equal(existsSync(output), false);
    const applied = cli(["--apply", "--output", output]);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    const assembled = JSON.parse(applied.stdout);
    assert.equal(assembled.ok, true);
    assert.equal(assembled.metadata.apiCalls, 0);
    assert.equal(assembled.metadata.apiSpendUsd, 0);
    assert.equal(assembled.metadata.assembly.totalFrames, 360);
    assert.ok(assembled.outputs.includes(output));
    assert.equal(Number(mediaProbe(output).streams.find((stream) => stream.codec_type === "video")?.nb_frames), 360);
    const replay = JSON.parse(cli(["--apply", "--output", output]).stdout);
    assert.equal(replay.metadata.assembly.reused, true);
    const clean = await invokeCommand(
      COMMANDS.find((command) => command.name === "longform")!,
      {
        project: f.request.projectId,
        chapters: `public/projects/${f.request.projectId}/pipeline/chapters.json`,
        captions: "off",
        assemble: true,
        apply: true,
        output: `out/${f.request.projectId}/lesson-clean.mp4`,
      },
      { root: f.root, codeRoot: repo, allowPaid: false, stderr: () => {} },
    );
    assert.equal(clean.ok, true, clean.message ?? "Clean assembly failed");
    assert.ok(existsSync(path.join(f.root, "out", f.request.projectId, "lesson-clean.mp4")));
    const rejected = cli(["--apply", "--output", path.join(f.root, "escape.mp4")]);
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stdout).ok, false);
    assert.equal(existsSync(path.join(f.root, "escape.mp4")), false);
  } finally {
    f.cleanup();
  }
});
