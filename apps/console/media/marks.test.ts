import { describe, expect, it } from "vitest";
import { FrameCommentSchema } from "@contract";
import { commentWords, contractMarks, drawMarks, markFromGesture, overlayBase64, wrapWords } from "./marks";
import { frameAtPointer, frameClock } from "./frame-math";
import { rulerStep } from "./timeline";

const picture = { left: 100, top: 50, width: 400, height: 200 };

/** A canvas context that records what is drawn; text is 10 px per character. */
function recorder() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "top" as CanvasTextBaseline,
    lineJoin: "round" as CanvasLineJoin,
    measureText: (text: string) => ({ width: text.length * 10 }) as TextMetrics,
    fillText: (text: string, x: number, y: number) => calls.push(`text ${text} ${Math.round(x)},${Math.round(y)}`),
    strokeRect: (x: number, y: number, w: number, h: number) => calls.push(`rect ${x},${y},${w},${h}`),
    arc: (x: number, y: number) => calls.push(`arc ${Math.round(x)},${Math.round(y)}`),
    clearRect: () => calls.push("clear"),
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    fill: () => {},
    stroke: () => {},
    roundRect: () => {},
    save: () => {},
    restore: () => {},
  };
  return { ctx, calls };
}

describe("marks", () => {
  it("a click is a point, a drag a box, both in picture coordinates", () => {
    expect(markFromGesture({ x: 300, y: 150 }, { x: 301, y: 150 }, picture)).toEqual({ x: 0.5025, y: 0.5, text: "" });
    expect(markFromGesture({ x: 100, y: 50 }, { x: 300, y: 150 }, picture)).toEqual({
      x: 0,
      y: 0,
      w: 0.5,
      h: 0.5,
      text: "",
    });
    // outside the picture clamps to its edge
    expect(markFromGesture({ x: 700, y: 400 }, { x: 700, y: 400 }, picture)).toEqual({ x: 1, y: 1, text: "" });
    expect(markFromGesture({ x: 0, y: 0 }, { x: 1, y: 1 }, { ...picture, width: 0 })).toBeUndefined();
  });

  it("the words sent are the comment, then each mark's words by number", () => {
    const marks = [
      { x: 0.1, y: 0.1, text: " logo " },
      { x: 0.2, y: 0.2, w: 0.1, h: 0.1, text: "noise" },
    ];
    expect(commentWords("", marks)).toBe("1. logo\n2. noise");
    expect(commentWords(" too dark ", marks)).toBe("too dark\n\n1. logo\n2. noise");
    expect(commentWords("only words", [])).toBe("only words");
    const sent = contractMarks(marks)!;
    expect(sent[0]!.text).toBe("logo");
    expect(
      FrameCommentSchema.safeParse({ media: { kind: "video", path: "a.mp4" }, frame: 1, text: "x", marks: sent })
        .success,
    ).toBe(true);
    expect(contractMarks([])).toBeUndefined();
  });

  it("wraps words to the width and cuts with an ellipsis after the last line", () => {
    const { ctx } = recorder();
    expect(wrapWords(ctx, "one two three four", 90)).toEqual(["one two", "three", "four"]);
    expect(wrapWords(ctx, "a b c d e f g h", 30, 2)).toEqual(["a b", "c…"]);
  });

  it("draws a box with its numbered label above it and a point with a label towards the middle", () => {
    const { ctx, calls } = recorder();
    drawMarks(
      ctx as unknown as CanvasRenderingContext2D,
      [
        { x: 0.5, y: 0.5, w: 0.2, h: 0.2, text: "logo" },
        { x: 0.9, y: 0.9, text: "noise" },
      ],
      1000,
      500,
    );
    expect(calls[0]).toBe("clear");
    expect(calls).toContain("rect 500,250,200,100");
    expect(calls.some((call) => call.startsWith("text 1 "))).toBe(true);
    expect(calls.some((call) => call.startsWith("text logo "))).toBe(true);
    // the point's dot is drawn where it points
    expect(calls).toContain("arc 900,450");
    const label = calls.find((call) => call.startsWith("text noise "))!;
    const [x, y] = label.split(" ").at(-1)!.split(",").map(Number);
    expect(x!).toBeLessThan(900);
    expect(y!).toBeLessThan(450);
  });

  it("keeps a label clear of the labels drawn before it", () => {
    const { ctx, calls } = recorder();
    // a point whose label would go right-down, and a box whose label above would land on it
    drawMarks(
      ctx as unknown as CanvasRenderingContext2D,
      [
        { x: 0.2, y: 0.2, text: "first" },
        { x: 0.3, y: 0.55, w: 0.2, h: 0.2, text: "second" },
      ],
      1000,
      500,
    );
    const at = (word: string) =>
      calls
        .find((call) => call.startsWith(`text ${word} `))!
        .split(" ")
        .at(-1)!
        .split(",")
        .map(Number);
    const [, y1] = at("first");
    const [x2, y2] = at("second");
    const [x1] = at("first");
    // text rows are 25 px apart here; two labels on the same row must not share columns
    expect(Math.abs(y1! - y2!) >= 25 || Math.abs(x1! - x2!) >= 100).toBe(true);
  });

  it("makes no overlay where the browser draws no canvas, or without marks", () => {
    expect(overlayBase64([], 100, 100)).toBeUndefined();
    expect(overlayBase64([{ x: 0.5, y: 0.5, text: "x" }], 100, 100)).toBeUndefined();
  });

  it("reads a timeline position as a frame and its start to the millisecond", () => {
    expect(frameAtPointer(150, { left: 50, width: 200 }, 101)).toBe(50);
    expect(frameAtPointer(-10, { left: 50, width: 200 }, 101)).toBe(0);
    expect(frameAtPointer(999, { left: 50, width: 200 }, 101)).toBe(100);
    expect(frameClock(484, 30)).toBe("00:16.133");
    expect(frameClock(30 * 3725, 30)).toBe("1:02:05.000");
    expect(rulerStep(3)).toBe(0.5);
    expect(rulerStep(21)).toBe(5);
    expect(rulerStep(600)).toBe(120);
  });
});
