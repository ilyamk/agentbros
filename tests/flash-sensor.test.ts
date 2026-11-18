import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyAllow, mergeOccurrences, tally } from "../src/lib/sensors/findings";
import { probeVideo } from "../src/lib/vision/media";
import {
  cellsFromRgb,
  chromaticity,
  FLASH_AREA_LIMIT,
  FLASH_GRID,
  FlashTracker,
  flashOccurrences,
  LINEAR,
  measureFlashesInFile,
  relativeLuminance,
  type FlashReport,
} from "../src/lib/sensors/flash";
import { measureFilm } from "../src/lib/film/measure";
import type { FilmEvidence } from "../src/lib/film/evidence";

type Rgb = [number, number, number];
const FPS = 30;

/** A FLASH_GRID-square rgb24 frame, one pixel per cell: `share` of the rows show `on`, the rest `off`. */
function frame(on: Rgb, off: Rgb, share = 1): Buffer {
  const raw = Buffer.alloc(FLASH_GRID * FLASH_GRID * 3);
  const rows = Math.round(share * FLASH_GRID);
  for (let pixel = 0; pixel < FLASH_GRID * FLASH_GRID; pixel++)
    raw.set(Math.floor(pixel / FLASH_GRID) < rows ? on : off, pixel * 3);
  return raw;
}

/** Alternates `a` and `b` every `hold` frames over the flashing share of the frame. */
function strobe(
  a: Rgb,
  b: Rgb,
  hold: number,
  options: { seconds?: number; share?: number; ground?: Rgb } = {},
): FlashReport {
  const tracker = new FlashTracker();
  const ground = options.ground ?? [0, 0, 0];
  for (let index = 0; index < (options.seconds ?? 2) * FPS; index++) {
    const colour = Math.floor(index / hold) % 2 ? b : a;
    tracker.push(cellsFromRgb(frame(colour, ground, options.share ?? 1), FLASH_GRID, FLASH_GRID));
  }
  return tracker.report(FPS);
}

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
const general = (report: FlashReport) => report.ranges.filter((range) => range.kind === "general");
const red = (report: FlashReport) => report.ranges.filter((range) => range.kind === "red");

test("linearised sRGB and the area limit follow WCAG", () => {
  assert.equal(LINEAR[0], 0);
  assert.equal(LINEAR[255], 1);
  assert.ok(Math.abs(LINEAR[60]! - 0.0452) < 0.001);
  assert.ok(Math.abs(relativeLuminance(1, 0, 0) - 0.2126) < 1e-9);
  assert.ok(Math.abs(FLASH_AREA_LIMIT - 0.111) < 0.001);
  const pureRed = chromaticity(1, 0, 0);
  assert.equal(pureRed.red, true);
  assert.equal(chromaticity(0, 0, 0).red, false);
  assert.ok(Number.isFinite(chromaticity(0, 0, 0).u));
});

test("black and white across the whole frame at 4 Hz fails; at 3 Hz it passes", () => {
  const fast = strobe(BLACK, WHITE, 4);
  assert.equal(general(fast).length, 1);
  assert.equal(general(fast)[0]!.area, 1);
  assert.ok(general(fast)[0]!.flashes >= 3);
  assert.equal(fast.worstArea.general, 1);
  const slow = strobe(BLACK, WHITE, 5);
  assert.deepEqual(slow.ranges, []);
});

test("a small flashing area passes, a quarter of the frame fails", () => {
  assert.deepEqual(strobe(BLACK, WHITE, 2, { share: 3 / 32 }).ranges, []);
  assert.equal(general(strobe(BLACK, WHITE, 2, { share: 0.25 })).length, 1);
});

test("a slow fade, however deep, is not a flash", () => {
  const tracker = new FlashTracker();
  for (let index = 0; index < 3 * FPS; index++) {
    const level = Math.round(255 * Math.abs(((index / FPS) % 2) - 1));
    tracker.push(cellsFromRgb(frame([level, level, level], BLACK), FLASH_GRID, FLASH_GRID));
  }
  assert.deepEqual(tracker.report(FPS).ranges, []);
});

test("the swing is judged in relative luminance, with the darker side below 0.80", () => {
  assert.deepEqual(strobe([0, 0, 0], [60, 60, 60], 2).ranges, [], "0 to 60 of 255 is under 0.05 in relative luminance");
  assert.deepEqual(strobe([235, 235, 235], WHITE, 2).ranges, [], "both sides are above 0.80");
  assert.equal(general(strobe([220, 220, 220], WHITE, 2)).length, 1);
});

test("saturated red against a grey of equal luminance is a red flash and not a general one", () => {
  const report = strobe([255, 0, 0], [127, 127, 127], 4);
  assert.deepEqual(general(report), []);
  assert.equal(red(report).length, 1);
  assert.deepEqual(
    strobe([0, 0, 255], [0, 120, 255], 4, { share: 1 }).ranges.filter((range) => range.kind === "red"),
    [],
  );
});

test("a near-black red grade jittering by one code value is not a red flash", () => {
  assert.deepEqual(strobe([9, 0, 0], [10, 0, 0], 1).ranges, []);
  assert.deepEqual(strobe([40, 0, 0], [0, 0, 0], 4).ranges, [], "too dim to change (R-G-B)x320 by more than 20");
});

test("motion:check findings carry the range, allow by frames, and count under flashRisk", () => {
  const occurrences = flashOccurrences(strobe(BLACK, WHITE, 3, { seconds: 2 }), 60);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0]!.code, "FLASH_RISK");
  assert.equal(occurrences[0]!.frame, 60);
  assert.match(occurrences[0]!.message, /general flashes at 2-4 s \(frames 60-119\)/);
  assert.equal(tally(occurrences, {}).flashRisk, 1);
  assert.equal(mergeOccurrences(occurrences).length, 1);
  assert.equal(
    applyAllow(occurrences, [{ code: "FLASH_RISK", frames: "60-119", reason: "warned strobe" }]).kept.length,
    0,
  );
});

test("film:measure fails a flashing render on its own leg and skips when flashes were not measured", () => {
  const evidence = {
    schemaVersion: 3,
    sha256: "a".repeat(64),
    path: "x.mp4",
    video: { width: 64, height: 64, fps: FPS, frameCount: 60, durationSec: 2, hasAudio: false },
    detector: "test",
    boundaries: [],
    candidateCount: 0,
    motion: [],
  } as unknown as FilmEvidence;
  const leg = (flash?: FlashReport) =>
    measureFilm({ evidence: { ...evidence, ...(flash ? { flash } : {}) } }).legs.find(
      (item) => item.id === "flash-risk",
    )!;
  const failing = leg(strobe(BLACK, WHITE, 4));
  assert.equal(failing.status, "fail");
  assert.match(failing.message, /^FLASH_RISK/);
  assert.match(failing.evidence[0]!, /general flashes at 0-2 s/);
  assert.equal(leg(strobe(BLACK, WHITE, 5)).status, "pass");
  assert.equal(leg().status, "skipped");
});

test("an encoded strobe is found frame by frame in the file", (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg is not installed");
  const directory = mkdtempSync(path.join(tmpdir(), "flash-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const encode = (name: string, expression: string) => {
    const file = path.join(directory, name);
    const result = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=96x96:r=30:d=2",
      "-vf",
      `geq=lum='${expression}':cb=128:cr=128`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    assert.equal(result.status, 0, result.stderr.toString());
    return file;
  };
  const fast = measureFlashesInFile(encode("fast.mp4", "if(mod(floor(N/4),2),235,16)"), FPS);
  assert.equal(general(fast).length, 1);
  assert.equal(fast.frames, 60);
  assert.deepEqual(measureFlashesInFile(encode("fade.mp4", "16+219*N/59"), FPS).ranges, []);
  const vfr = path.join(directory, "vfr.mp4");
  const made = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=96x96:r=60:d=3",
    "-vf",
    "geq=lum='if(mod(floor(T*10),2),235,16)':cb=128:cr=128,select='lt(t,0.5)+mod(n,2)'",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    vfr,
  ]);
  assert.equal(made.status, 0, made.stderr.toString());
  const probed = probeVideo(vfr);
  assert.ok(probed.fps < 59, `a variable-rate fixture (avg ${probed.fps} fps)`);
  assert.equal(
    general(measureFlashesInFile(vfr, probed.fps)).length,
    1,
    "a 5 Hz strobe in a variable-rate file is found on its real clock",
  );
  const run = (file: string) => {
    const child = spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs"),
        path.resolve(import.meta.dirname, "../scripts/flash-check.ts"),
        "--render",
        file,
      ],
      { encoding: "utf8" },
    );
    const lines = child.stdout.trim().split("\n");
    assert.equal(lines.length, 1, child.stdout);
    return { status: child.status, result: JSON.parse(lines[0]!) };
  };
  const failing = run(path.join(directory, "fast.mp4"));
  assert.equal(failing.status, 1);
  assert.equal(failing.result.error, "VALIDATION");
  assert.match(failing.result.message, /^FLASH_RISK/);
  const passing = run(path.join(directory, "fade.mp4"));
  assert.equal(passing.status, 0);
  assert.deepEqual(passing.result.metadata.ranges, []);
});
