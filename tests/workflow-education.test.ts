import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { runEducationWorkflow } from "../src/lib/workflows/education";
import { educationFixture } from "./workflow-education-fixture";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { planChapters } from "../src/lib/longform/plans";
import { ChapterManifestSchema } from "../src/types/longform";
import { readAssetRegistry } from "../src/lib/assets/registry";
import { planProjectRender } from "../src/lib/render-plan";
import { validateContext } from "../src/lib/longform/slice";
test("4.5-minute source-backed lesson plans without writes and materializes renderable exact tracks", () => {
  const f = educationFixture(true);
  try {
    const before = readdirSync(f.root);
    const p = runEducationWorkflow(f.request, {
      action: "plan",
      rootDir: f.root,
    });
    assert.deepEqual(readdirSync(f.root), before);
    assert.equal(p.metadata.durationSec, 270);
    assert.equal(p.outputs.length, 0);
    const result = runEducationWorkflow(f.request, {
      action: "create",
      rootDir: f.root,
      scopeRoot: f.root,
    });
    assert.equal(result.outputs.length, 4);
    assert.deepEqual(result.metadata.approvals, []);
    const dir = path.join(f.root, "public/projects/education-demo");
    const ir = new TimelineEditStore(path.join(dir, "pipeline/timeline-edit.json")).read().timeline;
    const render = planProjectRender("education-demo", "landscape", f.root, {
      timeline: true,
    });
    assert.equal(render.jobs[0].durationInFrames, 8100);
    assert.equal(ir.tracks[1].clips[7].source.start.num, 3150);
    assert.equal(ir.tracks[2].clips[7].captions.at(-1)!.end.num, 450);
    const manifest = ChapterManifestSchema.parse(
      JSON.parse(readFileSync(path.join(dir, "pipeline/chapters.json"), "utf8")),
    );
    const hashes = Object.fromEntries(
      readAssetRegistry("education-demo", f.root).assets.flatMap((a) => [
        [a.id, a.hash],
        [`path:${a.files.original}`, a.hash],
      ]),
    );
    const old = planChapters(ir, manifest, { assetHashes: hashes });
    const changed = structuredClone(ir);
    changed.tracks[0].clips[7].payload!.lessonEvidenceHash = "updated reviewed explanation";
    const next = planChapters(changed, manifest, { assetHashes: hashes });
    assert.equal(next.jobs[0].fingerprint, old.jobs[0].fingerprint);
    assert.notEqual(next.jobs[1].fingerprint, old.jobs[1].fingerprint);
    assert.equal(next.jobs[2].fingerprint, old.jobs[2].fingerprint);
    const recap = manifest.protectedSpans.find((s) => s.id === "context-beat-0-5")!;
    assert.throws(() =>
      validateContext([{ start: { num: recap.start.num + 1, den: 1 }, end: recap.end }], manifest.protectedSpans),
    );
    assert.throws(() => runEducationWorkflow(f.request, { action: "create", rootDir: f.root }), /already exists/);
    assert.ok(existsSync(path.join(dir, "pipeline/evidence/primer.md")));
  } finally {
    f.cleanup();
  }
});
test("rejects stale sources, invented quotations, missing caveats/captions and scope escapes before publication", () => {
  const f = educationFixture();
  try {
    const run = (request: unknown) =>
      runEducationWorkflow(request, {
        action: "plan",
        rootDir: f.root,
        scopeRoot: f.root,
      });
    const quoted = structuredClone(f.request);
    quoted.claims[0].evidence[0].excerpt = "fabricated quote";
    assert.throws(() => run(quoted), /absent/);
    const caveat = structuredClone(f.request);
    caveat.chapters[0].beats[5].context = [];
    assert.throws(() => run(caveat), /Recap/);
    const captions = structuredClone(f.request);
    captions.chapters[0].beats[0].captions[0].text = "wrong speech";
    assert.throws(() => run(captions), /Captions/);
    const span = structuredClone(f.request);
    span.chapters[0].beats[0].sourceStartFrame = 999999;
    assert.throws(() => run(span), /duration/);
    const other = educationFixture();
    try {
      symlinkSync(path.join(other.root, "diagram.png"), path.join(f.root, "escaped.png"));
      const escape = structuredClone(f.request);
      escape.media[0].file = "escaped.png";
      assert.throws(() => run(escape), /scopeRoot/);
    } finally {
      other.cleanup();
    }
    writeFileSync(path.join(f.root, "source.md"), "changed");
    assert.throws(() => run(f.request), /checksum/);
    assert.equal(existsSync(path.join(f.root, "public")), false);
  } finally {
    f.cleanup();
  }
});
test("rejects inference without uncertainty, invalid references and malformed timing contracts", () => {
  const f = educationFixture();
  try {
    const run = (request: unknown) => runEducationWorkflow(request, { action: "plan", rootDir: f.root });
    const inferred = structuredClone(f.request);
    inferred.claims[0].basis = "inference";
    assert.throws(() => run(inferred), /uncertainty/);
    const ref = structuredClone(f.request);
    ref.media[0].provenance.referenceAssetIds = [`sha256:${"a".repeat(64)}`];
    assert.throws(() => run(ref), /preceding immutable/);
    const word = structuredClone(f.request);
    word.chapters[0].beats[0].captions[1].startFrame = 0;
    assert.throws(() => run(word), /ordered/);
    const order = structuredClone(f.request);
    order.chapters[0].beats[0].stage = "recap";
    assert.throws(() => run(order), /six-stage/);
    const missing = structuredClone(f.request);
    missing.chapters[0].beats[0].claimIds = ["missing"];
    assert.throws(() => run(missing), /Unknown claim/);
    assert.equal(existsSync(path.join(f.root, "public")), false);
  } finally {
    f.cleanup();
  }
});
test("destination ancestor symlink is rejected before any outside project directory is created", () => {
  const f = educationFixture(),
    outside = educationFixture();
  try {
    symlinkSync(outside.root, path.join(f.root, "public"));
    assert.throws(() => runEducationWorkflow(f.request, { action: "create", rootDir: f.root }), /symlink escapes/);
    assert.equal(existsSync(path.join(outside.root, "projects")), false);
  } finally {
    f.cleanup();
    outside.cleanup();
  }
});
test("music cannot replay voice through an alias of the same immutable source", () => {
  const f = educationFixture();
  try {
    const alias = structuredClone(f.request);
    alias.media[3].file = alias.media[2].file;
    alias.media[3].sha256 = alias.media[2].sha256;
    assert.throws(() => runEducationWorkflow(alias, { action: "plan", rootDir: f.root }), /duplicate speech/);
  } finally {
    f.cleanup();
  }
});
test("one canonical lesson shares original references and exact timing across all three formats", () => {
  const f = educationFixture();
  try {
    f.request.formats = ["vertical", "square", "landscape"];
    runEducationWorkflow(f.request, { action: "create", rootDir: f.root });
    const jobs = planProjectRender(f.request.projectId, undefined, f.root, {
      timeline: true,
    }).jobs;
    assert.equal(jobs.length, 3);
    assert.ok(jobs.every((job) => job.durationInFrames === 360));
    assert.deepEqual(jobs[0].props.timeline, jobs[1].props.timeline);
    assert.deepEqual(jobs[1].props.timelineAssets, jobs[2].props.timelineAssets);
  } finally {
    f.cleanup();
  }
});
test("unrelated spoken statistics cannot inherit a lesson claim's evidence merely by ID", () => {
  const f = educationFixture();
  try {
    const request = structuredClone(f.request);
    request.chapters[0].beats[0].spokenText = "Revenue increases 900%. Nonzero whole.";
    request.chapters[0].beats[0].captions = [
      {
        text: request.chapters[0].beats[0].spokenText,
        startFrame: 0,
        endFrame: 30,
      },
    ];
    assert.throws(() => runEducationWorkflow(request, { action: "plan", rootDir: f.root }), /claim statement/);
  } finally {
    f.cleanup();
  }
});
