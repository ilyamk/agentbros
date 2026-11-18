import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VisionRequestSchema } from "../src/types/vision-review";
import {
  inspectReviewPack,
  reviewHash,
  selectReviewFrames,
  verifyReviewClock,
  writeReviewPack,
} from "../src/lib/vision/review-pack";
import { reviewLayout, renderReviewHtml } from "../src/lib/vision/review-view";
import { attachStillReview } from "../src/lib/vision/review-adapters";
import { probeVideo } from "../src/lib/vision/media";
const info = { width: 1920, height: 1080, fps: 30, frameCount: 300, durationSec: 10, hasAudio: false };
const request = (value: object = {}) => VisionRequestSchema.parse({ input: "source.mp4", ...value });
function workspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "vision-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}
function source(root: string, rate = "30") {
  const file = path.join(root, "source.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=320x180:r=${rate}:d=1,format=gray,geq=lum='16+4*N'`,
    "-c:v",
    "libx264",
    "-qp",
    "0",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv444p",
    file,
  ]);
  return file;
}
test("selection covers the whole window, preserves evidence basis and reports omissions", () => {
  const selected = selectReviewFrames(
    info,
    request({ count: 12, maxFrames: 4, events: [{ frame: 0, reasons: ["detected boundary"], basis: "measured" }] }),
  );
  assert.equal(selected.selected[0]!.frame, 0);
  assert.equal(selected.selected.at(-1)!.frame, 299);
  assert.equal(selected.selected[0]!.basis, "measured");
  assert.ok(selected.selected[0]!.reasons.includes("window first"));
  assert.equal(selected.selected.length, 4);
  assert.equal(selected.omitted.length, 8);
  assert.equal(selectReviewFrames({ ...info, frameCount: 1 }, request()).selected.length, 1);
  assert.throws(() => selectReviewFrames(info, request({ events: [{ frame: 300, reasons: ["outside"] }] })), /outside/);
});
test("motion windows include every requested frame and expose skipped coverage", () => {
  const selected = selectReviewFrames(info, request({ profile: "motion", startFrame: 10, endFrame: 21 }));
  assert.deepEqual(
    selected.selected.map((f) => f.frame),
    Array.from({ length: 12 }, (_, n) => n + 10),
  );
  assert.throws(() => selectReviewFrames(info, request({ startFrame: 300 })), /outside/);
});
test("all formats paginate within the viewer budget while preserving tile size", () => {
  for (const [width, height] of [
    [1920, 1080],
    [1080, 1920],
    [1080, 1080],
  ])
    for (const profile of ["overview", "motion", "ui"]) {
      const layout = reviewLayout({ width: width!, height: height! }, profile);
      assert.ok(layout.width <= 2000);
      assert.ok(layout.height(layout.perPage) <= 2000);
      assert.equal(layout.tileWidth, profile === "overview" ? 300 : height! > width! ? 460 : 600);
    }
  assert.equal(reviewLayout(info, "ui", true).tileWidth, 390);
  assert.throws(() => reviewLayout({ width: 100, height: 5000 }, "ui"), /aspect ratio/);
});
test("request schema rejects executable templates and out-of-bounds controls", () => {
  assert.throws(() => request({ templateCode: "arbitrary()" }));
  assert.throws(() => request({ maxFrames: 301 }));
  assert.throws(() => request({ step: 0 }));
});
test("actual frames, pages, crops and metadata agree; tampering and stale sources fail", { timeout: 60000 }, (t) => {
  const root = workspace(t),
    input = source(root),
    directory = path.join(root, "pack");
  const pack = writeReviewPack(
    {
      input,
      count: 2,
      profile: "ui",
      events: [
        {
          frame: 5,
          reasons: ["Тест <script>alert(1)</script>"],
          text: "Кириллица / English / 東京",
          basis: "declared",
        },
      ],
      crops: [{ frame: 5, x: 10, y: 20, width: 100, height: 60 }],
      measurements: [
        {
          frame: 5,
          name: "overlap",
          value: 0,
          basis: "measured",
          sourceSha256: reviewHash(input),
          evidence: "caller assertion",
        },
        {
          frame: 5,
          name: "long context",
          value: "X".repeat(5000),
          basis: "declared",
          sourceSha256: reviewHash(input),
          evidence: "bounded inspection fixture",
        },
      ],
    },
    directory,
    { scopeRoot: root },
  );
  const inspected = inspectReviewPack(pack.manifest, { scopeRoot: root });
  assert.deepEqual(
    inspected.frames.map((f) => f.frame),
    [0, 5, 29],
  );
  assert.equal(inspected.frames[1]!.measurements[0]!.basis, "declared");
  assert.match(inspected.frames[1]!.measurements[0]!.evidence, /unverified/);
  const repo = path.resolve(import.meta.dirname, "..");
  const cli = spawnSync(
    process.execPath,
    [
      path.join(repo, "node_modules/tsx/dist/cli.mjs"),
      path.join(repo, "scripts/vision-inspect.ts"),
      "--manifest",
      pack.manifest,
      "--frame",
      "5",
      "--limit",
      "1",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const bounded = JSON.parse(cli.stdout).metadata;
  assert.equal(bounded.frames[0].measurementsTruncated, true);
  assert.ok(
    bounded.frames[0].measurements[1].value.length < inspected.frames[1]!.measurements[1]!.value.toString().length,
  );
  assert.equal(bounded.request.events, undefined, "bounded inspection must not repeat the entire input event stream");
  const f = inspected.frames[1]!,
    bytes = ffmpeg([
      "-i",
      path.join(directory, f.path),
      "-vf",
      "scale=1:1",
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
  assert.ok(bytes[0]! > 15 && bytes[0]! < 40, `F5 luma-coded pixels ${bytes[0]}`);
  const crop = f.crops[0]!,
    cropBytes = readFileSync(path.join(directory, crop.path));
  assert.equal(cropBytes.readUInt32BE(16), 100);
  assert.equal(cropBytes.readUInt32BE(20), 60);
  const html = readFileSync(path.join(directory, inspected.pages[0]!.html), "utf8");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes(`href="${crop.path}"`));
  assert.ok(html.includes("Кириллица"));
  assert.ok(inspected.pages.every((page) => Math.max(page.width, page.height) <= 2000));
  const omitted = writeReviewPack(
    {
      input,
      count: 2,
      maxFrames: 2,
      events: ["a", "b"].map((prefix) => ({
        frame: 5,
        reasons: Array.from({ length: 20 }, (_, i) => `${prefix}-${i}`),
      })),
    },
    path.join(root, "omitted"),
  );
  assert.equal(omitted.data.omitted[0]!.reasons.length, 40, "normalised omissions retain all merged input reasons");
  const omittedCli = spawnSync(
    process.execPath,
    [
      path.join(repo, "node_modules/tsx/dist/cli.mjs"),
      path.join(repo, "scripts/vision-inspect.ts"),
      "--manifest",
      omitted.manifest,
      "--limit",
      "1",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(omittedCli.status, 0, omittedCli.stderr);
  assert.equal(JSON.parse(omittedCli.stdout).metadata.omitted[0].reasonsTotal, 40);
  assert.equal(
    JSON.parse(omittedCli.stdout).metadata.omitted[0].reasons.length,
    8,
    "the CLI keeps merged omissions bounded as well",
  );
  assert.throws(() => writeReviewPack({ input }, directory), /already exists/);
  const original = readFileSync(path.join(directory, f.path));
  writeFileSync(path.join(directory, f.path), "tampered");
  assert.throws(() => inspectReviewPack(pack.manifest), /hash mismatch/);
  writeFileSync(path.join(directory, f.path), original);
  writeFileSync(input, "changed");
  assert.throws(() => inspectReviewPack(pack.manifest), /stale/);
});
test("CFR timestamp verification accepts fractional fps and rejects VFR", (t) => {
  const root = workspace(t),
    input = source(root, "30000/1001");
  verifyReviewClock(input, probeVideo(input));
  const vfr = path.join(root, "vfr.mp4");
  ffmpeg(["-i", input, "-vf", "select='not(eq(n,5))'", "-fps_mode", "vfr", "-c:v", "libx264", "-threads", "2", vfr]);
  assert.throws(() => verifyReviewClock(vfr, probeVideo(vfr)), /CFR|frame count/);
});
test("scope, playlists, stale measurements and invalid crops are refused before capture", (t) => {
  const root = workspace(t),
    input = source(root);
  const outside = workspace(t);
  symlinkSync(input, path.join(outside, "linked.mp4"));
  assert.throws(
    () => writeReviewPack({ input: path.join(outside, "linked.mp4") }, path.join(root, "p"), { scopeRoot: root }),
    /escapes|symlink/,
  );
  symlinkSync(source(outside), path.join(root, "escape.mp4"));
  assert.throws(
    () => writeReviewPack({ input: path.join(root, "escape.mp4") }, path.join(root, "p"), { scopeRoot: root }),
    /escapes/,
  );
  const playlist = path.join(root, "local.mp4");
  writeFileSync(playlist, "#EXTM3U\n#EXTINF:1\nhttp://127.0.0.1:9/not-allowed.ts\n");
  assert.throws(() => writeReviewPack({ input: playlist }, path.join(root, "p")), /ffprobe/);
  assert.throws(
    () => writeReviewPack({ input, crops: [{ frame: 0, x: 300, y: 0, width: 100, height: 10 }] }, path.join(root, "p")),
    /outside/,
  );
  assert.throws(
    () =>
      writeReviewPack(
        {
          input,
          measurements: [
            { frame: 0, name: "luma", value: 0, basis: "measured", evidence: "stale", sourceSha256: "a".repeat(64) },
          ],
        },
        path.join(root, "p"),
      ),
    /hash/,
  );
});
test("composition still packages bind their declared identity separately from video", { timeout: 60000 }, (t) => {
  const root = workspace(t),
    input = source(root),
    png = path.join(root, "still.png");
  ffmpeg(["-i", input, "-frames:v", "1", png]);
  const events = Array.from({ length: 25 }, (_, i) => ({
    frame: 5,
    reasons: [`cue ${i}`],
    basis: "declared" as const,
  }));
  const result = attachStillReview([{ frame: 5, path: png }], { ...info, width: 320, height: 180 }, root, events);
  const pack = inspectReviewPack(result.reviewPack);
  assert.equal(pack.source.kind, "composition");
  assert.equal(pack.source.clock, "composition-frames");
  assert.equal(pack.frames[0]!.frame, 5);
  assert.equal(pack.request.events[0]!.reasons.length, 20);
  assert.ok(pack.frames[0]!.reasons.some((reason) => reason.includes("more reasons")));
  assert.equal(
    JSON.parse(readFileSync(pack.source.path, "utf8")).events.length,
    25,
    "all coincident cue provenance remains hash-bound",
  );
  assert.ok(
    renderReviewHtml(pack, pack.frames, reviewLayout(pack.source, "ui"), path.dirname(result.reviewPack)).includes(
      "composition",
    ),
  );
});
test("motion diff records the actual previous selected frame and tamper-evident maps", { timeout: 60000 }, (t) => {
  const root = workspace(t),
    input = source(root);
  const result = writeReviewPack({ input, profile: "motion", startFrame: 3, endFrame: 6 }, path.join(root, "pack"));
  const pack = inspectReviewPack(result.manifest);
  assert.equal(pack.frames[1]!.diff!.previousFrame, 3);
  assert.ok(pack.frames[1]!.diff!.mean > 0);
  assert.ok(pack.pages.some((p) => p.kind === "diff"));
});
