import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { loadAssets } from "../src/lib/shared-assets";
import {
  plateFrameSrc,
  plateIndex,
  plateSchema,
  plateSource,
  renderPlateFrame,
} from "../src/motion/library/three/plate-plan";
import { ACE_ORB, CASHFREE_TRUCK, FLEX_FAN, POLYMARKET_SLIP } from "../src/motion/library/three/three-plan";

/** A Python dict literal's number for `key` in a shot script (the defaults passed to args()). */
const pyNumber = (source: string, key: string): number => {
  const match = new RegExp(`"${key}":\\s*(-?[0-9.]+)`).exec(source);
  assert.ok(match, `${key} in the shot's defaults`);
  return Number(match[1]);
};
const shot = (name: string) => readFileSync(`scripts/blender/${name}`, "utf8");

test("external render plates start on the timeline cue and advance at the source rate", () => {
  assert.equal(renderPlateFrame(29, 25, 30, 30), 0);
  assert.equal(renderPlateFrame(30, 25, 30, 30), 0);
  assert.equal(renderPlateFrame(60, 25, 30, 30), 25);
  assert.equal(renderPlateFrame(61, 25, 30, 30), 25);
  assert.equal(renderPlateFrame(60, 60, 30, 30), 60);
});

test("plateIndex holds the first frame before `at` and the last after the plate", () => {
  const plate = { src: "x.mp4", frameCount: 10, at: 4 };
  assert.equal(plateIndex(0, plate), 0);
  assert.equal(plateIndex(4, plate), 0);
  assert.equal(plateIndex(9, plate), 5);
  assert.equal(plateIndex(13, plate), 9);
  assert.equal(plateIndex(400, plate), 9);
  assert.equal(plateIndex(3, { frameCount: 10 }), 3);
});

test("plateSource numbers a frame pattern from firstFrame and freezes a video on the index", () => {
  assert.deepEqual(plateSource(2, { src: "p/frame-######.png", frameCount: 60 }), {
    kind: "image",
    src: "p/frame-000003.png",
  });
  assert.deepEqual(plateSource(2, { src: "p/frame-####.png", frameCount: 60, firstFrame: 10 }), {
    kind: "image",
    src: "p/frame-0012.png",
  });
  assert.deepEqual(plateSource(70, { src: "shared/3d/plates/card-fan.mp4", frameCount: 60 }), {
    kind: "video",
    src: "shared/3d/plates/card-fan.mp4",
    frame: 59,
  });
  assert.equal(plateFrameSrc("a/frame-######.png", 7), "a/frame-000007.png");
});

test("a plate needs a source and a positive length", () => {
  assert.ok(plateSchema.safeParse({ src: "a.mp4", frameCount: 1 }).success);
  assert.equal(plateSchema.safeParse({ src: "", frameCount: 1 }).success, false);
  assert.equal(plateSchema.safeParse({ src: "a.mp4", frameCount: 0 }).success, false);
});

test("each Blender shot keeps its block's timing, so the block's cues land on the plate", () => {
  const orb = shot("glossy_orb.py");
  for (const [key, value] of Object.entries(ACE_ORB)) assert.equal(pyNumber(orb, key), value, `glossy_orb ${key}`);
  const fan = shot("card_fan.py");
  assert.equal(pyNumber(fan, "copies"), FLEX_FAN.copies);
  assert.equal(pyNumber(fan, "fanFrames"), FLEX_FAN.frames);
  assert.equal(pyNumber(fan, "delay"), FLEX_FAN.delay);
  assert.equal(pyNumber(fan, "spread"), 70);
  const slip = shot("printing_slip.py");
  assert.equal(pyNumber(slip, "unrollFrames"), POLYMARKET_SLIP.frames);
  assert.equal(pyNumber(slip, "at"), 2);
  assert.equal(pyNumber(slip, "header"), 0.2);
  const array = shot("device_array.py");
  assert.equal(pyNumber(array, "x"), CASHFREE_TRUCK.x);
  assert.equal(pyNumber(array, "y"), CASHFREE_TRUCK.y);
});

test("every plate recipe renders a shot script that exists, slow, into its own git-ignored folder", () => {
  const plates = loadAssets().filter((asset) => asset.family === "plates" && asset.source.kind === "recipe");
  assert.ok(plates.length >= 7);
  for (const plate of plates) {
    if (plate.source.kind !== "recipe") continue;
    const command = plate.source.command;
    const script = command[command.indexOf("--script") + 1]!;
    assert.ok(existsSync(script), `${plate.id}: ${script}`);
    assert.equal(plate.source.slow, true, plate.id);
    assert.ok(plate.source.requires.includes("blender"), plate.id);
    assert.equal(command[command.indexOf("--encode-to") + 1], plate.target, plate.id);
    assert.ok(command.includes("--encode") && command.includes("h264"), plate.id);
  }
});
