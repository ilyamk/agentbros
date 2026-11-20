import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assemblePatch, publishRenderFiles, renderPatchDependencies } from "../src/lib/delivery/render-patch";
import type { RenderIdentity } from "../src/types/delivery";
import type { RenderJob } from "../src/lib/render-plan";

test("headline-only edits keep the render dependency fingerprint and its transition-inclusive span", () => {
  const job = {
    format: "landscape",
    compositionId: "ProjectLandscape",
    durationInFrames: 228,
    props: {
      projectId: "example",
      format: "landscape",
      productName: "Test",
      tagline: "",
      accentColor: "#fff",
      bgColor: "#000",
      textColor: "#fff",
      musicVolume: 0,
      voiceoverEnabled: false,
      scenes: [
        { id: "intro", text: "", headline: "Intro", visualType: "title", durationInFrames: 120 },
        { id: "close", text: "", headline: "Close", visualType: "cta", durationInFrames: 120 },
      ],
    },
    command: "pnpm",
    args: [],
    outputFile: "out/example/landscape.mp4",
  } satisfies RenderJob;
  const identity = {
    projectId: "example",
    sourceSnapshotHash: "a".repeat(64),
    sources: [],
  } as unknown as RenderIdentity;
  const before = renderPatchDependencies(job, identity)!;
  job.props.scenes[1]!.headline = "A different close";
  const after = renderPatchDependencies(job, identity)!;
  assert.equal(before.dependencies, after.dependencies);
  assert.notEqual(before.scenes.close!.content, after.scenes.close!.content);
  assert.equal(after.scenes.close!.start, 108);
  assert.equal(after.scenes.close!.end, 228);
  job.props.scenes[1]!.durationInFrames++;
  assert.notEqual(renderPatchDependencies(job, identity)!.dependencies, after.dependencies);
  job.props.scenes[1]!.durationInFrames--;
  job.props.musicVolume = 0.3;
  assert.notEqual(renderPatchDependencies(job, identity)!.dependencies, after.dependencies);
});

test("assembly preserves decoded outside frames and the original sound, and refuses a bad patch length", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "render-patch-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ffmpeg = (args: string[]) => {
    const result = spawnSync("ffmpeg", ["-v", "error", ...args], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  };
  const base = path.join(directory, "base.mp4");
  const patch = path.join(directory, "changed.mp4");
  const video = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "60", "-bf", "0", "-sc_threshold", "0"];
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=30:d=6",
    "-f",
    "lavfi",
    "-i",
    "sine=d=6",
    ...video,
    "-c:a",
    "aac",
    base,
  ]);
  ffmpeg(["-f", "lavfi", "-i", "color=blue:s=160x90:r=30:d=2", ...video, patch]);
  await assert.doesNotReject(() =>
    assemblePatch(base, patch, { start: 60, end: 120 }, 180, path.join(directory, "output.mp4")),
  );
  const bad = mkdtempSync(path.join(directory, "bad-"));
  const badPatch = path.join(bad, "changed.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=blue:s=160x90:r=30:d=1", ...video, badPatch]);
  await assert.rejects(() => assemblePatch(base, badPatch, { start: 60, end: 120 }, 180, path.join(bad, "output.mp4")));
});

test("a failure replacing the receipt restores the previous canonical master", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "render-publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = ["picture", "receipt"].map((name) => ({
    target: path.join(dir, name),
    staged: path.join(dir, "new-" + name),
  }));
  for (const row of paths) {
    writeFileSync(row.target, "old");
    writeFileSync(row.staged, "new");
  }
  assert.throws(
    () =>
      publishRenderFiles(dir, paths, (from, to) => {
        if (to === paths[1]!.target) throw new Error("Injected receipt failure");
        renameSync(from, to);
      }),
    /Injected receipt failure/,
  );
  for (const row of paths) assert.equal(readFileSync(row.target, "utf8"), "old");
});
