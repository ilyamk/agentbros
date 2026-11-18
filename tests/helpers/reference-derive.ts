import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { importAsset } from "../../src/lib/assets/registry";
import type { DerivationStep } from "../../src/types/references";

export const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

function ffmpeg(...args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** Temp root with project "demo": a 3 s 320x240 testsrc clip with a sine track and a 64x48 PNG with alpha. */
export function derivativeFixture(t: TestContext) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "reference-derive-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const project = path.join(rootDir, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const video = path.join(rootDir, "clip.mp4"),
    image = path.join(rootDir, "alpha.png");
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc=s=320x240:r=10:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3:sample_rate=48000",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    video,
  );
  ffmpeg("-f", "lavfi", "-i", "color=c=red@0.5:s=64x48,format=rgba", "-frames:v", "1", "-c:v", "png", image);
  const provenance = { origin: "manual" as const, tool: "offline-fixture" };
  const clip = importAsset({ rootDir, projectId: "demo", sourceFile: video, provenance }).asset;
  const still = importAsset({ rootDir, projectId: "demo", sourceFile: image, provenance }).asset;
  const spec = (id: string, steps: DerivationStep[], input: object = { assetId: clip.id }) => ({
    schemaVersion: 1,
    id,
    input,
    steps,
    purpose: "Synthetic fixture derivative",
  });
  return { rootDir, project, clip, still, spec };
}
