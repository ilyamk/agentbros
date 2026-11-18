import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureScriptSchema, planFrames } from "../src/lib/capture-app/steps";

const runBrowser = process.env.RUN_CAPTURE_APP === "1";
const fixtureDir = path.resolve("tests/fixtures/capture-app");

test("capture steps need exactly one of at or time, and known actions", () => {
  assert.equal(captureScriptSchema.safeParse({ steps: [{ action: "click", selector: "#go" }] }).success, false);
  assert.equal(
    captureScriptSchema.safeParse({ steps: [{ at: 1, time: 1, action: "click", selector: "#go" }] }).success,
    false,
  );
  assert.equal(captureScriptSchema.safeParse({ steps: [{ at: 1, action: "drag" }] }).success, false);
  assert.equal(
    captureScriptSchema.safeParse(JSON.parse(readFileSync(path.join(fixtureDir, "steps.json"), "utf8"))).success,
    true,
  );
});

test("plan expands typing per character and scrolling to eased deltas that sum to dy", () => {
  const { steps } = captureScriptSchema.parse({
    steps: [
      { at: 2, action: "type", selector: "#q", text: "abc", framesPerChar: 3 },
      { time: 1, action: "scroll", dy: 500, durationFrames: 10 },
      { at: 99, action: "click", selector: "#late" },
    ],
  });
  const plan = planFrames(steps, 30, 60);
  assert.deepEqual(plan.get(2), [
    { kind: "focus", selector: "#q" },
    { kind: "char", text: "a" },
  ]);
  assert.deepEqual(plan.get(5), [{ kind: "char", text: "b" }]);
  assert.deepEqual(plan.get(8), [{ kind: "char", text: "c" }]);
  const scrolls = [...plan.entries()].filter(([frame]) => frame >= 30).flatMap(([, actions]) => actions);
  assert.equal(
    scrolls.reduce((sum, a) => sum + (a.kind === "scroll" ? a.dy : 0), 0),
    500,
  );
  assert.ok(!plan.has(99), "steps past the end are dropped");
});

test("capture:app rejects bad arguments with the JSON contract", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/capture-app.ts", "--url", "x.html", "--duration", "0", "--output", tmpdir()],
    { encoding: "utf8" },
  );
  const line = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { ok: boolean; error: string };
  assert.equal(result.status, 1);
  assert.deepEqual([line.ok, line.error], [false, "INVALID_INPUT"]);
});

test(
  "capture:app repeats the same frames and records the scripted input",
  { skip: runBrowser ? false : "set RUN_CAPTURE_APP=1 (needs Remotion's headless Chromium)", timeout: 180_000 },
  () => {
    const capture = () => {
      const output = mkdtempSync(path.join(tmpdir(), "capture-app-test-"));
      const stdout = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/capture-app.ts",
          "--url",
          path.join(fixtureDir, "page.html"),
          "--script",
          path.join(fixtureDir, "steps.json"),
          "--duration",
          "1.6",
          "--output",
          output,
          "--width",
          "900",
          "--height",
          "600",
          "--scale",
          "1",
          "--format",
          "png",
        ],
        { encoding: "utf8" },
      );
      assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)!).ok, true);
      const manifest = JSON.parse(readFileSync(path.join(output, "capture.json"), "utf8")) as {
        frames: number;
        frameHashes: string[];
        events: { frame: number; action: string }[];
        route: string;
      };
      rmSync(output, { recursive: true, force: true });
      return manifest;
    };
    const first = capture();
    const second = capture();
    assert.equal(first.frames, 48);
    assert.equal(first.route, "injected-clock");
    assert.deepEqual(
      second.frameHashes,
      first.frameHashes,
      "two captures of the same script are identical frame for frame",
    );
    const hashes = first.frameHashes;
    assert.notEqual(hashes[9], hashes[28], "typing changes the picture");
    assert.notEqual(hashes[4], hashes[16], "the clicked transition moves the button");
    assert.equal(new Set(hashes).size, hashes.length, "the page clock advances every frame");
    assert.deepEqual(
      first.events.filter((e) => e.action === "click").map((e) => e.frame),
      [4],
    );
    assert.equal(first.events.filter((e) => e.action === "char").length, "Find sales leaders".length);
  },
);
