import { describe, expect, it } from "vitest";
import { FrameCommentSchema, type MediaRef } from "@contract";
import * as server from "../../../src/lib/console/thumbs";
import {
  DEFAULT_FPS,
  clampFrame,
  clock,
  frameAt,
  frameCount,
  resolveDuration,
  resolveFps,
  stepFrame,
  timeOfFrame,
  timecode,
} from "./frame-math";
import { computePeaks } from "./peaks";
import { buildFrameComment, clampRegion, containRect, frameCommentText, regionFromDrag } from "./region";
import { THUMB_TIME_STEP, THUMB_WIDTHS, frameSrc, posterTime, quantizeTime, stripTimes, widthBucket } from "./thumbs";

const render: MediaRef = { root: "out", path: "scenes/scene-3.mp4", kind: "video", durationSec: 4.2, fps: 30 };

describe("frame math", () => {
  it("maps times to frames and frames to mid-frame seek times", () => {
    expect(frameAt(0, 30)).toBe(0);
    expect(frameAt(1, 30)).toBe(30);
    expect(frameAt(0.7, 30)).toBe(21); // 0.7 * 30 = 20.999… in floating point
    expect(frameAt(Number.NaN, 30)).toBe(0);
    for (const n of [0, 1, 29, 125]) expect(frameAt(timeOfFrame(n, 30), 30)).toBe(n);
    expect(timeOfFrame(0, 25)).toBeCloseTo(0.02);
  });

  it("counts, clamps and steps frames inside the media", () => {
    expect(frameCount(4.2, 30)).toBe(126);
    expect(frameCount(0, 30)).toBe(1);
    expect(clampFrame(-3, 4.2, 30)).toBe(0);
    expect(clampFrame(500, 4.2, 30)).toBe(125);
    expect(stepFrame(timeOfFrame(10, 30), 1, 4.2, 30)).toBe(11);
    expect(stepFrame(timeOfFrame(10, 30), -30, 4.2, 30)).toBe(0);
    expect(stepFrame(timeOfFrame(120, 30), 30, 4.2, 30)).toBe(125);
  });

  it("falls back to an assumed frame rate and a usable duration", () => {
    expect(resolveFps(24)).toEqual({ fps: 24, assumed: false });
    expect(resolveFps(undefined)).toEqual({ fps: DEFAULT_FPS, assumed: true });
    expect(resolveFps(0).assumed).toBe(true);
    expect(resolveDuration(Number.NaN, 4.2)).toBe(4.2);
    expect(resolveDuration(Infinity, undefined)).toBe(0);
    expect(resolveDuration(3, 4.2)).toBe(3);
  });

  it("formats timecodes and clocks", () => {
    expect(timecode(0, 30)).toBe("00:00:00");
    expect(timecode(95, 30)).toBe("00:03:05");
    expect(timecode(30 * 3725 + 7, 30)).toBe("1:02:05:07");
    expect(timecode(25, 23.976)).toBe("00:01:01");
    expect(clock(18)).toBe("0:18");
    expect(clock(3725)).toBe("1:02:05");
  });
});

describe("region normalisation", () => {
  it("normalises a drag to the picture, in any direction", () => {
    const picture = { left: 100, top: 50, width: 200, height: 400 };
    expect(regionFromDrag({ x: 150, y: 150 }, { x: 250, y: 250 }, picture)).toEqual({
      x: 0.25,
      y: 0.25,
      w: 0.5,
      h: 0.25,
    });
    expect(regionFromDrag({ x: 250, y: 250 }, { x: 150, y: 150 }, picture)).toEqual({
      x: 0.25,
      y: 0.25,
      w: 0.5,
      h: 0.25,
    });
  });

  it("clamps drags outside the picture and ignores clicks", () => {
    const picture = { left: 0, top: 0, width: 100, height: 100 };
    expect(regionFromDrag({ x: -50, y: -50 }, { x: 500, y: 40 }, picture)).toEqual({ x: 0, y: 0, w: 1, h: 0.4 });
    expect(regionFromDrag({ x: 10, y: 10 }, { x: 10.5, y: 60 }, picture)).toBeUndefined();
    expect(regionFromDrag({ x: 0, y: 0 }, { x: 1, y: 1 }, { ...picture, width: 0 })).toBeUndefined();
  });

  it("keeps a region inside the frame for the contract", () => {
    expect(clampRegion({ x: 0.9, y: 0.5, w: 0.5, h: 0.2 })).toEqual({ x: 0.9, y: 0.5, w: 0.1, h: 0.2 });
    expect(clampRegion({ x: 0.123456, y: 0, w: 0.333333, h: 1 })).toEqual({ x: 0.1235, y: 0, w: 0.3333, h: 1 });
    expect(clampRegion({ x: 0.5, y: 0.5, w: Number.NaN, h: 0.2 })).toBeUndefined();
  });

  it("finds the letterboxed picture inside its box", () => {
    // a 9:16 render in a 16:9 box: pillarboxed
    const rect = containRect({ left: 0, top: 0, width: 1600, height: 900 }, 1080, 1920);
    expect(rect.height).toBeCloseTo(900);
    expect(rect.width).toBeCloseTo(506.25);
    expect(rect.left).toBeCloseTo(546.875);
    expect(containRect({ left: 0, top: 0, width: 10, height: 10 }, undefined, 5)).toEqual({
      left: 0,
      top: 0,
      width: 10,
      height: 10,
    });
  });

  it("builds a contract-valid FrameComment or names the problem", () => {
    const result = buildFrameComment({
      media: render,
      frame: 42,
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      text: "  logo too small ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(FrameCommentSchema.parse(result.comment)).toEqual({
      media: render,
      frame: 42,
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      text: "logo too small",
    });
    expect(frameCommentText(result.comment, "00:01:12")).toBe(
      "out/scenes/scene-3.mp4 frame 42 (00:01:12) region x=0.1 y=0.2 w=0.3 h=0.4: logo too small",
    );
    expect(buildFrameComment({ media: render, frame: 3, text: "ok" })).toMatchObject({ ok: true });
    expect(buildFrameComment({ media: render, frame: 3, text: "   " })).toEqual({ ok: false, problem: "text" });
    expect(buildFrameComment({ media: render, frame: -1, text: "x" })).toEqual({ ok: false, problem: "frame" });
    expect(buildFrameComment({ media: render, frame: 1.5, text: "x" })).toEqual({ ok: false, problem: "frame" });
    expect(buildFrameComment({ media: render, frame: 1, region: { x: 0.5, y: 0.5, w: 0, h: 0 }, text: "x" })).toEqual({
      ok: false,
      problem: "region",
    });
  });
});

describe("thumbnail URLs", () => {
  it("rounds like the server, so a frame has one URL", () => {
    expect(THUMB_WIDTHS).toEqual(server.THUMB_WIDTHS);
    expect(THUMB_TIME_STEP).toBe(server.THUMB_TIME_STEP);
    for (const w of [1, 96, 97, 300, 5000]) expect(widthBucket(w)).toBe(server.widthBucket(w));
    for (const [t, duration] of [
      [0.04, 4.2],
      [1.26, 4.2],
      [9, 4.2],
      [-1, undefined],
      [3.33, undefined],
    ] as const)
      expect(quantizeTime(t, duration)).toBe(server.quantizeTime(t, duration));
  });

  it("spreads strip frames across the duration and builds /thumb URLs", () => {
    expect(stripTimes(4, 4)).toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(stripTimes(0, 4)).toEqual([]);
    expect(frameSrc("promo-acme", render, 1.26, 80)).toBe("/thumb/promo-acme/@out/scenes/scene-3.mp4?t=1.3&w=160");
    expect(posterTime(4.2)).toBe(1);
    expect(posterTime(1)).toBe(0.5);
    expect(posterTime(undefined)).toBe(0);
  });
});

describe("waveform peaks", () => {
  it("folds samples into min/max pairs over the mean of channels", () => {
    const left = Float32Array.from([0, 1, -1, 0.5, 0.2, -0.2, 0, 0]);
    const right = Float32Array.from([0, 1, -1, 0.5, 0.2, -0.2, 0, 0]);
    const peaks = computePeaks([left, right], 4);
    expect(Array.from(peaks)).toEqual([0, 1, -1, 0.5, -0.2, 0.2, 0, 0].map(Math.fround));
    expect(Array.from(computePeaks([], 2))).toEqual([0, 0, 0, 0]);
  });
});
