import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { extractPresenterAudio } from "../src/lib/presenter-audio";
import { compileTimeline } from "../src/lib/timeline";
test("embedded captions align actual trimmed presenter speech, not a TTS file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "talkinghead-audio-"));
  try {
    const source = path.join(dir, "source with spaces.wav");
    const out = path.join(dir, "scene.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", source]);
    const t = compileTimeline(
      [
        {
          id: "a",
          text: "first",
          visualType: "title",
          durationInFrames: 42,
          presenterStartSec: 0,
          presenterEndSec: 1.4,
        },
        {
          id: "b",
          text: "second",
          visualType: "title",
          durationInFrames: 60,
          presenterStartSec: 1,
          presenterEndSec: 3,
        },
      ],
      { talkingHead: true },
    );
    extractPresenterAudio(source, out, t.entries[0]);
    const duration = Number(
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out], {
        encoding: "utf8",
      }),
    );
    assert.ok(Math.abs(duration - 1) < 0.001, `owned duration=${duration}`);
    assert.equal(t.entries[1].startFrame, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("invalid audio extraction intervals fail before launching ffmpeg", () => {
  assert.throws(() => extractPresenterAudio("missing", "unused", { sourceStartFrame: 0, durationInFrames: -1 }));
});
