import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliErrorObject } from "../src/lib/cli";
import { parseFrameRange, parseProgress, rangeOutputFile, renderWithWatchdog, runWatched } from "../src/lib/render-run";
import { RenderReceiptSchema } from "../src/types/delivery";

// Allow process startup while other local renders are active; the fixture itself never advances.
const STALL_MS = 2000;
const fake = path.resolve("tests/fixtures/render-watchdog/fake-render.mjs");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
  return check();
};

test("progress lines: Remotion's counters parse, a repeated line is not progress by itself", () => {
  assert.deepEqual(parseProgress("Rendered 7091/18230, time remaining: 5m 43s"), {
    phase: "Rendered",
    done: 7091,
    total: 18230,
  });
  assert.deepEqual(parseProgress("Encoded 12/300"), { phase: "Encoded", done: 12, total: 300 });
  assert.deepEqual(parseProgress("Bundling 45%"), { phase: "Bundling", done: 45, total: null });
  assert.equal(parseProgress("Made new browser"), null);
});

test("a child that keeps printing the same frame is killed with its whole process tree", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "watchdog-"));
  try {
    const pidFile = path.join(dir, "pid");
    const run = await runWatched({
      command: process.execPath,
      args: [fake, "stall", pidFile, path.join(dir, "m")],
      stallMs: STALL_MS,
      pollMs: 50,
      onLine: () => {},
    });
    assert.equal(run.status, "stalled");
    assert.ok(run.status === "stalled" && run.rendered === 3 && run.total === 10, JSON.stringify(run));
    assert.ok(await until(() => !alive(Number(readFileSync(pidFile, "utf8")))), "the renderer's own children die too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stall retries once from scratch; a second stall fails with RENDER_STALLED naming the frame", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "watchdog-"));
  try {
    const notes: string[] = [];
    const once = await renderWithWatchdog({
      command: process.execPath,
      args: [fake, "stall-once", path.join(dir, "pid"), path.join(dir, "marker")],
      stallMs: STALL_MS,
      pollMs: 50,
      onLine: () => {},
      label: "vertical",
      notify: (m) => notes.push(m),
    });
    assert.equal(once.attempts, 2);
    assert.match(notes[0]!, /stalled at frame 3 of 10.*retrying once/);
    await assert.rejects(
      renderWithWatchdog({
        command: process.execPath,
        args: [fake, "stall", path.join(dir, "pid2"), path.join(dir, "m2")],
        stallMs: STALL_MS,
        pollMs: 50,
        onLine: () => {},
        label: "vertical",
      }),
      (error: unknown) =>
        error instanceof CliErrorObject &&
        error.code === "RENDER_STALLED" &&
        /frame 3 of 10/.test(error.message) &&
        error.details?.stuckFrame === 3,
    );
    const ok = await renderWithWatchdog({
      command: process.execPath,
      args: [fake, "ok", path.join(dir, "pid3"), path.join(dir, "m3")],
      stallMs: STALL_MS,
      pollMs: 50,
      onLine: () => {},
      label: "vertical",
    });
    assert.equal(ok.attempts, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--frames: inclusive output range inside the render, excerpt file name, partial receipt", () => {
  assert.deepEqual(parseFrameRange("300-449", 900), { start: 300, end: 449 });
  assert.throws(() => parseFrameRange("449-300", 900));
  assert.throws(() => parseFrameRange("0-900", 900));
  assert.throws(() => parseFrameRange("10", 900));
  assert.equal(
    rangeOutputFile("out/p/vertical-clean.mp4", { start: 3, end: 9 }),
    "out/p/vertical-clean-frames-3-9.mp4",
  );
  const hash = "a".repeat(64);
  const receipt = {
    version: 1,
    sourceSnapshotHash: hash,
    propsHash: hash,
    outputSha256: hash,
    format: "vertical",
    captions: "on",
    createdAt: new Date(0).toISOString(),
    sources: [],
    evidence: "renderer",
    partial: { startFrame: 3, endFrame: 9, totalFrames: 900 },
  };
  assert.deepEqual(RenderReceiptSchema.parse(receipt).partial, { startFrame: 3, endFrame: 9, totalFrames: 900 });
});
