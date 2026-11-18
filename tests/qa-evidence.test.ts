import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectConfigSchema } from "../src/types/video";
import { projectToVideoProps } from "../src/lib/project-props";
import { planEvidenceEvents } from "../src/lib/qa-evidence/events";
import { extractEvidenceFrames, artifactHash } from "../src/lib/qa-evidence/frames";
import { recordRepairEvidence } from "../src/lib/qa-evidence/repair";
const props = () =>
  projectToVideoProps(
    ProjectConfigSchema.parse({
      name: "fixture",
      productName: "fixture",
      colors: { accent: "#6C5CE7", background: "#fff", text: "#111" },
      scenes: [
        {
          id: "hook",
          text: "",
          headline: "Hook",
          visualType: "title",
          durationInFrames: 60,
        },
        {
          id: "cta",
          text: "",
          headline: "Try",
          visualType: "cta",
          durationInFrames: 60,
        },
      ],
    }),
    "fixture",
    "vertical",
    false,
  );
test("QA CLI reports missing FFmpeg with the canonical error while dry-run needs no media tools", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-cli-missing-tool-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "public/projects/fixture");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "project.json"),
    JSON.stringify({
      name: "Fixture",
      formats: ["vertical"],
      productName: "Fixture",
      colors: {},
      musicVolume: 0,
      scenes: [{ id: "hook", text: "", headline: "Fixture", visualType: "title", durationInFrames: 30 }],
    }),
  );
  const command = [
    path.resolve("node_modules/tsx/dist/cli.mjs"),
    path.resolve("scripts/qa-evidence.ts"),
    "--project",
    "fixture",
  ];
  const options = { cwd: root, encoding: "utf8" as const, env: { ...process.env, PATH: "" } };
  const dry = spawnSync(process.execPath, [...command, "--dry-run"], options);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).metadata.productionApproval, false);
  const missing = spawnSync(process.execPath, command, options);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(missing.stdout).error, "FFMPEG_MISSING");
});
test("event planner includes first/last, transition start/mid/end, CTA and exact IR cut", () => {
  const plan = planEvidenceEvents(props());
  assert.equal(plan.durationInFrames, 108);
  for (const f of [0, 48, 54, 59, 107]) assert.ok(plan.events.some((e) => e.frame === f));
  assert.ok(plan.events.some((e) => e.reasons.some((r) => r.includes(":cta"))));
  const p = props();
  p.timeline = {
    version: 1,
    projectId: "fixture",
    timebase: { num: 24, den: 1 },
    tracks: [
      {
        id: "visual",
        kind: "visual",
        clips: [
          {
            id: "x",
            assetId: "scene:hook",
            start: { num: 1, den: 2 },
            source: {
              start: { num: 0, den: 1 },
              end: { num: 24, den: 1 },
              timebase: { num: 24, den: 1 },
            },
            rate: { num: 1, den: 1 },
            transition: { kind: "cut" },
            captions: [],
          },
        ],
      },
    ],
  };
  const ir = planEvidenceEvents(p);
  assert.equal(ir.durationInFrames, 31);
  assert.ok(ir.events.some((e) => e.frame === 1));
  assert.ok(ir.events.some((e) => e.frame === 30));
});
test("real FFmpeg evidence extracts exact first/last frames and flags black tails without banning declared darkness", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const video = path.join(root, "tail.mp4");
  const generated = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=64x64:r=30:d=1",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:r=30:d=0.2",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const events = [
    { frame: 0, reasons: ["first"] },
    { frame: 29, reasons: ["transition-start"] },
    { frame: 30, reasons: ["transition-mid"] },
    { frame: 35, reasons: ["last"] },
  ];
  const result = extractEvidenceFrames(video, path.join(root, "evidence"), events, 36, 30);
  assert.equal(result.frames.length, 4);
  assert.ok(result.frames[0].meanLuma > 200);
  assert.ok(result.frames.at(-1)!.meanLuma < 3);
  assert.ok(result.findings.some((f) => f.code === "UNEXPECTED_BLACK_TAIL"));
  assert.equal(result.actualFrames, 36);
  const dark = extractEvidenceFrames(video, path.join(root, "intent"), events, 36, 30, [30, 35]);
  assert.equal(dark.findings.length, 0);
  assert.equal(dark.status, "needs-manual-review");
  const mismatch = extractEvidenceFrames(video, path.join(root, "mismatch"), events, 40, 30);
  assert.ok(mismatch.findings.some((f) => f.code === "DURATION_MISMATCH"));
});
test("repair evidence freezes artifact hashes, caps attempts and rejects stale or modified evidence", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-repair-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = path.join(root, "before.json"),
    after = path.join(root, "after.json");
  const artifact = path.join(root, "proof.png");
  writeFileSync(artifact, "local artifact hash fixture");
  const frame = { file: artifact, sha256: artifactHash(artifact) };
  writeFileSync(
    before,
    JSON.stringify({
      version: 1,
      sourceHash: "a".repeat(64),
      extraction: { frames: [frame] },
    }),
  );
  writeFileSync(
    after,
    JSON.stringify({
      version: 1,
      sourceHash: "b".repeat(64),
      extraction: { frames: [frame] },
    }),
  );
  const request = {
    before,
    after,
    description: "Shortened headline and rerendered",
    actor: "Declared reviewer",
    expectedAttempt: 0,
    maxAttempts: 1,
  };
  const journal = recordRepairEvidence(path.join(root, "journal"), request);
  assert.equal(journal.attempts[0].status, "requires-manual-review");
  assert.equal(journal.attempts[0].beforeSourceHash, "a".repeat(64));
  assert.throws(
    () =>
      recordRepairEvidence(path.join(root, "journal"), {
        ...request,
        expectedAttempt: 1,
        maxAttempts: 3,
      }),
    /cap reached/,
  );
  assert.throws(() => recordRepairEvidence(path.join(root, "journal"), request), /revision conflict/);
  writeFileSync(artifact, "tampered");
  assert.throws(() => recordRepairEvidence(path.join(root, "different-journal"), request), /artifact hash/);
});
