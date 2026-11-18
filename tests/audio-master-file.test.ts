import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { analyzeAudio, mediaProbe } from "../src/lib/audio/analysis";
import { masterRenderedFile } from "../src/lib/audio/master-file";

function render(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "audio-master-file-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "render.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=orange:s=160x90:r=30:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3,volume=0.05",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    input,
  ]);
  return { root, input };
}

test("masters a rendered mp4 to the social preset and keeps its video stream", (t) => {
  const { root, input } = render(t);
  const output = path.join(root, "render-master.mp4");
  const result = masterRenderedFile(input, output);
  assert.equal(result.container, "video");
  const measured = analyzeAudio(output);
  assert.ok(Math.abs(measured.integratedLufs! - -14) <= 1, `${measured.integratedLufs}`);
  assert.ok(measured.truePeakDb! <= -1.2);
  const video = (file: string) => mediaProbe(file).streams.find((stream) => stream.codec_type === "video");
  assert.deepEqual([video(output)?.width, video(output)?.nb_frames], [video(input)?.width, video(input)?.nb_frames]);
  assert.throws(() => masterRenderedFile(input, output), /already exists/);
});

test("audio:master writes a review wav and one JSON line", (t) => {
  const { root, input } = render(t);
  const output = path.join(root, "master.wav");
  const run = spawnSync(
    "pnpm",
    ["-s", "exec", "tsx", "scripts/master-audio.ts", "--input", input, "--output", output, "--preset", "review"],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const json = JSON.parse(lines[0]!);
  assert.equal(json.ok, true);
  assert.equal(json.metadata.master.targetLufs, -16);
  assert.ok(Math.abs(json.metadata.master.integratedLufs - -16) <= 1);
  assert.ok(existsSync(`${output}.json`));
  assert.equal(JSON.parse(readFileSync(`${output}.json`, "utf8")).container, "wav");
  const bad = spawnSync(
    "pnpm",
    ["-s", "exec", "tsx", "scripts/master-audio.ts", "--input", input, "--output", path.join(root, "x.mp3")],
    { encoding: "utf8" },
  );
  assert.notEqual(bad.status, 0);
  assert.equal(JSON.parse(bad.stdout.trim()).ok, false);
});
