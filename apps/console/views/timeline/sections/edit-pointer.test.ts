/** RU-T16–T18, RU-K03–K05: pointer proposals from lane rectangles (review:ui `pointerCommand` and preview). */
import { describe, expect, it } from "vitest";
import { EditInputError } from "./edit-commands";
import { clip, editState } from "./edit-fixture";
import { passedThreshold, pointerCommand, previewStyle, type Drag, type LaneBox } from "./edit-pointer";

const state = editState();
const visual = state.tracks[0]!;
const broll = state.tracks[1]!;
const rect = (left: number, top: number, width = 1200, height = 52) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});
// 1200 px for 120 frames: 10 px per frame.
const lanes: LaneBox[] = [
  { trackId: "visual", kind: "visual", rect: rect(0, 0) },
  { trackId: "broll", kind: "visual", rect: rect(0, 100) },
  { trackId: "host", kind: "presenter", rect: rect(0, 200) },
];

const drag = (patch: Partial<Drag> = {}): Drag => ({
  pointerId: 1,
  mode: "move",
  track: visual,
  clip: visual.clips[1]!,
  x: 650,
  y: 20,
  grabFrames: 5,
  revision: 3,
  duration: 120,
  timebase: { num: 30, den: 1 },
  moved: true,
  ...patch,
});

const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof EditInputError ? error.key : (error as Error).message;
  }
  return "no error";
};

describe("pointer proposals", () => {
  it("counts a drag only after 3 px", () => {
    expect(passedThreshold({ x: 10, y: 10 }, 13, 10)).toBe(false);
    expect(passedThreshold({ x: 10, y: 10 }, 14, 10)).toBe(true);
    expect(passedThreshold({ x: 10, y: 10 }, 10, 6)).toBe(true);
  });

  it("moves within the neighbours and the timeline (RU-T16)", () => {
    expect(pointerCommand(drag(), 750, 20, lanes)).toEqual({
      type: "move",
      trackId: "visual",
      clipId: "proof",
      start: { num: 70, den: 1 },
    });
    // Clamped to the end of the previous clip (hook ends at 30).
    expect(pointerCommand(drag(), 0, 20, lanes)).toMatchObject({ start: { num: 30, den: 1 } });
    // Clamped to the timeline end (120 - 30).
    expect(pointerCommand(drag(), 1190, 20, lanes)).toMatchObject({ start: { num: 90, den: 1 } });
    expect(message(() => pointerCommand(drag(), 652, 20, lanes))).toBe("Pointer proposal makes no change");
  });

  it("a drop on another visual lane is a transfer keeping the grab offset; elsewhere it is refused (RU-T17)", () => {
    expect(pointerCommand(drag(), 450, 120, lanes)).toEqual({
      type: "transfer",
      trackId: "visual",
      clipId: "proof",
      targetTrackId: "broll",
      start: { num: 40, den: 1 },
    });
    expect(message(() => pointerCommand(drag(), 450, 220, lanes))).toBe("dropLane");
    expect(message(() => pointerCommand(drag(), 450, 80, lanes))).toBe("dropLane");
  });

  it("edge trims are inward only: start keeps the right edge, end is a trim (RU-T18)", () => {
    const start = pointerCommand(drag({ mode: "start" }), 750, 20, lanes);
    expect(start).toEqual({
      type: "batch",
      commands: [
        { type: "trim", trackId: "visual", clipId: "proof", start: { num: 10, den: 1 }, end: { num: 30, den: 1 } },
        { type: "move", trackId: "visual", clipId: "proof", start: { num: 70, den: 1 } },
      ],
    });
    expect(pointerCommand(drag({ mode: "end" }), 550, 20, lanes)).toEqual({
      type: "trim",
      trackId: "visual",
      clipId: "proof",
      start: { num: 0, den: 1 },
      end: { num: 20, den: 1 },
    });
    // Outward is clamped to the current edge: no change.
    expect(message(() => pointerCommand(drag({ mode: "end" }), 750, 20, lanes))).toBe(
      "Pointer proposal makes no change",
    );
    const short = {
      ...clip("tiny", 60, 61),
      source: { start: { num: 0, den: 1 }, end: { num: 1, den: 1 }, timebase: { num: 30, den: 1 } },
    };
    expect(message(() => pointerCommand(drag({ mode: "end", clip: short }), 550, 20, lanes))).toBe(
      "Clip is too short for inward frame trim",
    );
  });

  it("previews by left, width and translate onto the target lane", () => {
    const d = drag();
    expect(previewStyle(d, pointerCommand(d, 750, 20, lanes), lanes)).toEqual({
      left: `${(100 * 70) / 120}%`,
      width: "300px",
      transform: "translate(0px,0px)",
    });
    expect(previewStyle(d, pointerCommand(d, 450, 120, lanes), lanes).transform).toBe("translate(0px,100px)");
    const trim = drag({ mode: "end" });
    expect(previewStyle(trim, pointerCommand(trim, 550, 20, lanes), lanes).width).toBe("200px");
    expect(broll.clips).toHaveLength(1);
  });
});
