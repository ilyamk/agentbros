import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { startReviewServer } from "../src/lib/review-ui/server";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { writeReviewPack } from "../src/lib/vision/review-pack";

test(
  "review service verifies a declared pack and serves its pages as text, never HTML",
  { timeout: 90000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "vision-review-ui-")),
      project = path.join(root, "public/projects/demo");
    mkdirSync(path.join(project, "pipeline"), { recursive: true });
    writeFileSync(path.join(project, "project.json"), "{}");
    new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json")).initialize({
      version: 1,
      projectId: "demo",
      timebase: { num: 30, den: 1 },
      tracks: [
        {
          id: "visual",
          kind: "visual",
          clips: [
            {
              id: "hook",
              assetId: "scene:hook",
              start: { num: 0, den: 1 },
              source: { start: { num: 0, den: 1 }, end: { num: 30, den: 1 }, timebase: { num: 30, den: 1 } },
              rate: { num: 1, den: 1 },
              transition: { kind: "cut" },
              captions: [],
            },
          ],
        },
      ],
    });
    const input = path.join(root, "source.mp4");
    assert.equal(
      spawnSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=320x180:r=30:d=1",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        input,
      ]).status,
      0,
    );
    const run = path.join(project, "pipeline/qa-evidence", `landscape-${randomUUID()}`),
      directory = path.join(run, `review-${randomUUID()}`);
    const pack = writeReviewPack(
      {
        input,
        count: 2,
        crops: [{ frame: 0, x: 0, y: 0, width: 100, height: 80 }],
        events: [{ frame: 0, reasons: ["<script>window.hacked=true</script>"] }],
      },
      directory,
    );
    const relative = path.relative(project, pack.manifest).split(path.sep).join("/");
    const app = await startReviewServer({ projectId: "demo", rootDir: root });
    t.after(async () => {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    });
    const headers = { "x-review-token": app.token };
    assert.equal((await fetch(`${app.origin}/api/review-pack?path=${encodeURIComponent(relative)}`)).status, 403);
    const response = await fetch(`${app.origin}/api/review-pack?path=${encodeURIComponent(relative)}`, { headers });
    const data = (await response.json()) as { frames: unknown[] };
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.frames.length, 2);
    assert.equal((await fetch(`${app.origin}/api/review-pack?path=../../outside.json`, { headers })).status, 400);
    const htmlResponse = await fetch(
      `${app.origin}/file?path=${encodeURIComponent(path.relative(project, path.join(directory, pack.data.pages[0]!.html)))}`,
      { headers },
    );
    assert.match(htmlResponse.headers.get("content-type")!, /text\/plain/);
    // The pack navigator (pages, originals, crops; no HTML execution) is the console's QA section (RU-Q, WP13c):
    // apps/console/views/timeline/sections/review-sections.test.tsx and apps/console/e2e/timeline-review.e2e.ts.
    const file = path.join(directory, pack.data.frames[0]!.path),
      original = readFileSync(file);
    writeFileSync(file, "changed");
    assert.equal(
      (await fetch(`${app.origin}/api/review-pack?path=${encodeURIComponent(relative)}`, { headers })).status,
      400,
    );
    writeFileSync(file, original);
  },
);
