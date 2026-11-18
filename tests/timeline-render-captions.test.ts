import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { importLegacyCaptions } from "../src/lib/timeline-ir/caption-import";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import type { TimelineIR } from "../src/types/timeline";
test("caption initialization imports local words once in exact source frame coordinates", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "timeline-words-"));
  try {
    mkdirSync(path.join(dir, "voiceover"));
    writeFileSync(
      path.join(dir, "voiceover/a.words.json"),
      JSON.stringify({ words: [{ text: "actual", start: 0.5, end: 1 }] }),
    );
    const ir: TimelineIR = {
      version: 1,
      projectId: "x",
      timebase: { num: 30, den: 1 },
      tracks: [
        {
          id: "presenter",
          kind: "presenter",
          clips: [
            {
              id: "a",
              assetId: "source.mp4",
              start: { num: 30, den: 1 },
              source: {
                start: { num: 48, den: 1 },
                end: { num: 96, den: 1 },
                timebase: { num: 24, den: 1 },
              },
              rate: { num: 2, den: 1 },
              transition: { kind: "cut" },
              captions: [],
            },
          ],
        },
      ],
    };
    const imported = importLegacyCaptions(ir, dir);
    assert.deepEqual(imported.tracks[0].clips[0].captions[0].start, {
      num: 60,
      den: 1,
    });
    assert.deepEqual(compileTimelineIR(imported).tracks[0].clips[0].captions[0].start, { num: 75, den: 2 });
    assert.deepEqual(ir.tracks[0].clips[0].captions, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
