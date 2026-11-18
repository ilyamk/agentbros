import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAudioMix, duckMix, measureDuck } from "../src/lib/audio/local-mix";

function tone(file: string, hz: number, seconds: number, gain: number) {
  const result = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${gain}*sin(2*PI*${hz}*t):s=48000:d=${seconds}`,
    file,
  ]);
  assert.equal(result.status, 0, String(result.stderr));
}

test("duck depth is capped by duckDb and measured under the voice", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "duck-"));
  try {
    tone(path.join(dir, "music.wav"), 220, 4, 0.1);
    tone(path.join(dir, "speech.wav"), 660, 2, 0.14);
    const plan = (duckDb?: number) => ({
      version: 1,
      durationSec: 4,
      ...(duckDb === undefined ? {} : { duckDb }),
      tracks: [
        { source: path.join(dir, "music.wav"), role: "music" },
        { source: path.join(dir, "speech.wav"), role: "speech", startSec: 1 },
      ],
    });
    assert.match(buildAudioMix(plan()).filter, /mix=0\.645\[musicduck\]/);
    assert.equal(duckMix(-6), 0.499);
    const capped = measureDuck(plan())!;
    assert.ok(capped.speechWindows > 20);
    assert.ok(capped.medianDuckDb >= -9.5 && capped.medianDuckDb <= -7.5, `median ${capped.medianDuckDb}`);
    assert.ok(capped.deepestDuckDb >= -9.5, `deepest ${capped.deepestDuckDb}`);
    const deep = measureDuck(plan(-14))!;
    assert.ok(deep.medianDuckDb < capped.medianDuckDb - 2, `deeper cap dips further: ${deep.medianDuckDb}`);
    assert.ok(capped.bedUnderVoiceDb < 0, "the bed sits under the voice");
    assert.equal(measureDuck({ ...plan(), duckMusic: false }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
