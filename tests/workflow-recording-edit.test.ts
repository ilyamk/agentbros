import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { hashFile } from "../src/lib/assets/registry";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import { planProjectRender } from "../src/lib/render-plan";
import { recordingFixture, reviewedRequest } from "./workflow-recording-edit-fixtures";
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-recording-"));
  t.after(() =>
    rmSync(root, {
      recursive: true,
      force: true,
    }),
  );
  return root;
}
test("pure plan binds Russian negation/context and leaves original/project untouched", async (t) => {
  const root = fixture(t);
  const request = recordingFixture(root);
  const result = await runRecordingEditWorkflow(request, {
    action: "plan",
    rootDir: root,
  });
  assert.deepEqual(result.outputs, []);
  assert.equal(result.metadata.durationInFrames, 60);
  assert.equal(result.metadata.reviewStatus, "needs-review");
  assert.ok(!existsSync(path.join(root, "public")));
  assert.ok(!existsSync(path.join(root, ".cache")));
  assert.equal(hashFile(request.source.file), request.source.sha256);
});
test("atomic create imports originals and synchronized editable picture, audio and captions; undo is reversible", async (t) => {
  const root = fixture(t);
  const request = await reviewedRequest(root);
  const result = await runRecordingEditWorkflow(request, {
    action: "create",
    rootDir: root,
  });
  assert.equal(result.metadata.humanRenderReviewRequired, true);
  const store = new TimelineEditStore(path.join(root, "public/projects/recut/pipeline/timeline-edit.json"));
  const ir = store.read().timeline;
  assert.deepEqual(
    ir.tracks.map((t) => t.kind),
    ["visual", "voiceover", "captions"],
  );
  for (const track of ir.tracks) {
    assert.deepEqual(
      track.clips.map((c) => c.start.num),
      [0, 30],
    );
    assert.deepEqual(
      track.clips.map((c) => c.source.start.num),
      [0, 60],
    );
  }
  const compiled = compileTimelineIR(ir);
  assert.deepEqual(
    compiled.tracks[2].clips[1].captions.map((w) => [w.text, w.start.num, w.end.num]),
    [
      ["Если", 30, 38],
      ["проверено.", 38, 55],
    ],
  );
  const applied = store.apply(
    {
      type: "batch",
      commands: ir.tracks.map((track) => ({
        type: "trim" as const,
        trackId: track.id,
        clipId: "last",
        start: {
          num: 60,
          den: 1,
        },
        end: {
          num: 86,
          den: 1,
        },
      })),
    },
    0,
  );
  assert.equal(applied.revision, 1);
  assert.deepEqual(store.undo(1).timeline, ir);
  assert.deepEqual(store.redo(2).timeline, applied.timeline);
  const render = planProjectRender("recut", "landscape", root, {
    timeline: true,
  });
  assert.equal(render.jobs[0].durationInFrames, 56);
  assert.equal(hashFile(request.source.file), request.source.sha256);
  await assert.rejects(
    () =>
      runRecordingEditWorkflow(request, {
        action: "create",
        rootDir: root,
      }),
    /already exists/,
  );
});
test("review required; stale review, omitted negation, split caveat, partial word and undeclared cuts refuse without output", async (t) => {
  const root = fixture(t);
  const request = await reviewedRequest(root);
  for (const [name, change, pattern] of [
    ["missing review", (r: any) => delete r.review, /human review/],
    ["stale reason", (r: any) => (r.keepSpans[0].reason = "different"), /stale/],
    [
      "negation removed",
      (r: any) => {
        r.keepSpans[0].startFrame = 12;
        r.cuts = [
          {
            startFrame: 0,
            endFrame: 12,
            reason: "bad",
          },
          ...r.cuts,
        ];
      },
      /protected/,
    ],
    ["protection omitted", (r: any) => (r.protectedSpans = []), /protected negation/],
    [
      "word cut",
      (r: any) => {
        r.keepSpans[1].startFrame = 64;
      },
      /spoken word/,
    ],
    ["undeclared cut", (r: any) => (r.cuts = []), /complement/],
  ] as const) {
    const changed = structuredClone(request);
    change(changed);
    await assert.rejects(
      () =>
        runRecordingEditWorkflow(changed, {
          action: "create",
          rootDir: root,
        }),
      pattern,
      name,
    );
  }
  assert.ok(!existsSync(path.join(root, "public/projects/recut")));
});
test("stale checksum, noninteger/rational source frames, unsupported fps and trusted scope escape reject", async (t) => {
  const root = fixture(t);
  const request = recordingFixture(root);
  const bad = structuredClone(request);
  bad.source.sha256 = "0".repeat(64);
  await assert.rejects(
    () =>
      runRecordingEditWorkflow(bad, {
        action: "plan",
        rootDir: root,
      }),
    /checksum/,
  );
  for (const value of [
    0.5,
    {
      num: 1,
      den: 2,
    },
  ]) {
    const bad: any = structuredClone(request);
    bad.keepSpans[0].startFrame = value;
    await assert.rejects(() =>
      runRecordingEditWorkflow(bad, {
        action: "plan",
        rootDir: root,
      }),
    );
  }
  const rational: any = structuredClone(request);
  rational.source.fps = {
    num: 30000,
    den: 1001,
  };
  await assert.rejects(() =>
    runRecordingEditWorkflow(rational, {
      action: "plan",
      rootDir: root,
    }),
  );
  const scope = path.join(root, "scope");
  mkdirSync(scope);
  await assert.rejects(
    () =>
      runRecordingEditWorkflow(request, {
        action: "plan",
        rootDir: root,
        scopeRoot: scope,
      }),
    /scope/,
  );
});
test("actual VFR with matching nominal rate is rejected by decoded frame timestamps", async (t) => {
  const root = fixture(t);
  const request = recordingFixture(root);
  const vfr = path.join(root, "vfr.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-i",
    request.source.file,
    "-vf",
    "select='not(eq(n,15))'",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-c:a",
    "copy",
    vfr,
  ]);
  request.source.file = vfr;
  request.source.sha256 = hashFile(vfr);
  await assert.rejects(
    () =>
      runRecordingEditWorkflow(request, {
        action: "plan",
        rootDir: root,
      }),
    /CFR|Variable-frame/,
  );
  assert.ok(!existsSync(path.join(root, "public")));
});
test("output symlink rejected before create; existing source stays intact", async (t) => {
  const root = fixture(t);
  const request = await reviewedRequest(root);
  mkdirSync(path.join(root, "public"));
  symlinkSync(root, path.join(root, "public/projects"));
  await assert.rejects(
    () =>
      runRecordingEditWorkflow(request, {
        action: "create",
        rootDir: root,
      }),
    /symlink/,
  );
  assert.equal(hashFile(request.source.file), request.source.sha256);
});
test("whole irrelevant negative statement may be removed, but partial semantic group cannot survive", async (t) => {
  const root = fixture(t);
  const request = recordingFixture(root);
  request.transcript.words[3].text = "нет";
  request.protectedSpans.push({
    startFrame: 30,
    endFrame: 60,
    kind: "context",
    reason: "Entire irrelevant statement removed by declared cut",
  });
  const plan = await runRecordingEditWorkflow(request, {
    action: "plan",
    rootDir: root,
  });
  assert.equal(plan.metadata.durationInFrames, 60);
  const reviewed = {
    ...request,
    review: {
      reviewer: "test declaration",
      reviewedAt: "2026-10-11T00:00:00Z",
      approvedEditHash: plan.metadata.editHash,
      meaningPreserved: true,
    },
  };
  await runRecordingEditWorkflow(reviewed, {
    action: "create",
    rootDir: root,
  });
  const partial = structuredClone(request);
  partial.projectId = "partial";
  partial.keepSpans[0].endFrame = 33;
  partial.cuts[0].startFrame = 33;
  await assert.rejects(
    () =>
      runRecordingEditWorkflow(partial, {
        action: "plan",
        rootDir: root,
      }),
    /protected context/,
  );
});
test("revision creates a new lineage-bound project and never replaces the previous edit", async (t) => {
  const root = fixture(t);
  const original = await reviewedRequest(root);
  const created = await runRecordingEditWorkflow(original, {
    action: "create",
    rootDir: root,
  });
  const next: any = {
    ...original,
    projectId: "recut-v2",
    revision: 2,
    previousEdit: {
      projectId: "recut",
      editHash: created.metadata.editHash,
    },
  };
  delete next.review;
  const plan = await runRecordingEditWorkflow(next, {
    action: "plan",
    rootDir: root,
  });
  next.review = {
    ...original.review,
    approvedEditHash: plan.metadata.editHash,
  };
  await runRecordingEditWorkflow(next, {
    action: "create",
    rootDir: root,
  });
  const prior = JSON.parse(readFileSync(path.join(root, "public/projects/recut/pipeline/recording-edit.json"), "utf8"));
  assert.equal(prior.editHash, created.metadata.editHash);
  const wrong: any = {
    ...next,
    projectId: "bad-v3",
    revision: 3,
    previousEdit: {
      projectId: "recut",
      editHash: created.metadata.editHash,
    },
  };
  delete wrong.review;
  await assert.rejects(
    () =>
      runRecordingEditWorkflow(wrong, {
        action: "plan",
        rootDir: root,
      }),
    /lineage/,
  );
});
test("two actual processes competing to create one recording project publish one complete project", async (t) => {
  const root = fixture(t);
  const request = await reviewedRequest(root);
  const file = path.join(root, "request.json");
  writeFileSync(file, JSON.stringify(request));
  const entry = path.resolve("src/lib/workflows/recording-edit.ts");
  const program = `import * as recordingModule from ${JSON.stringify("file://" + entry)};const {runRecordingEditWorkflow}=recordingModule.default??recordingModule;import {readFileSync} from 'node:fs';runRecordingEditWorkflow(JSON.parse(readFileSync(process.argv[1],'utf8')),{action:'create',rootDir:process.argv[2]}).then(()=>process.exit(0)).catch(()=>process.exit(2));`;
  const run = () =>
    new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program, file, root], {
        stdio: "ignore",
      });
      child.once("exit", resolve);
    });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.sort(), [0, 2]);
  assert.equal(
    planProjectRender("recut", "landscape", root, {
      timeline: true,
    }).jobs[0].durationInFrames,
    60,
  );
  assert.ok(!existsSync(path.join(root, "public/projects/recut.recording-create.lock")));
  assert.equal(hashFile(request.source.file), request.source.sha256);
});
