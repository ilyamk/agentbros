import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { hashFile } from "../src/lib/assets/registry";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { reviewClaims, type Finding } from "../src/lib/delivery/reviews";
import { DeliveryRequestSchema, type DeliverySnapshot } from "../src/types/delivery";
const r = (num: number) => ({
  num,
  den: 1,
});
const statement = "Это не гарантия.";
function fixture(t: test.TestContext, spoken = true, captionKind = "voiceover") {
  const root = mkdtempSync(path.join(tmpdir(), "active-claims-"));
  t.after(() =>
    rmSync(root, {
      recursive: true,
      force: true,
    }),
  );
  const project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline/evidence"), {
    recursive: true,
  });
  const scene = {
    id: "proof",
    text: spoken ? statement : "Other narration",
    headline: statement,
    visualType: "title",
    durationInFrames: 30,
  };
  writeFileSync(
    path.join(project, "project.json"),
    JSON.stringify({
      scenes: [scene],
    }),
  );
  const evidence = path.join(project, "pipeline/evidence/source.txt");
  writeFileSync(evidence, statement);
  writeFileSync(
    path.join(project, "pipeline/workflow-claims.json"),
    JSON.stringify({
      version: 1,
      projectId: "demo",
      claims: [
        {
          id: "claim:proof",
          text: statement,
          sceneId: "proof",
          sourceUrls: ["https://example.invalid/source"],
          evidence: [
            {
              path: "projects/demo/pipeline/evidence/source.txt",
              sha256: hashFile(evidence),
              excerpt: statement,
            },
          ],
        },
      ],
    }),
  );
  const journal = path.join(project, "pipeline/timeline-edit.json");
  const clip = {
    id: "proof",
    assetId: "scene:proof",
    start: r(0),
    source: {
      start: r(0),
      end: r(30),
      timebase: r(30),
    },
    rate: r(1),
    transition: {
      kind: "cut" as const,
    },
    captions: [],
    payload: {
      scene,
    },
  };
  const words = [
    {
      id: "one",
      text: "Это",
      start: r(1),
      end: r(6),
    },
    {
      id: "negation",
      text: "не",
      start: r(6),
      end: r(11),
    },
    {
      id: "last",
      text: "гарантия.",
      start: r(11),
      end: r(25),
    },
  ];
  new TimelineEditStore(journal).initialize({
    version: 1,
    projectId: "demo",
    timebase: r(30),
    tracks: [
      {
        id: "visual",
        kind: "visual",
        clips: [clip],
      },
      {
        id: "speech",
        kind: captionKind,
        clips: [
          {
            ...clip,
            id: "proof-speech",
            assetId: "audio:test",
            captions: spoken ? words : [],
            payload: {},
          },
        ],
      },
    ],
  });
  const request = DeliveryRequestSchema.parse({
    version: 1,
    projectId: "demo",
    timeline: true,
    formats: ["landscape"],
    variants: ["captioned"],
    placements: ["test"],
    loudness: {
      targetLufs: -16,
      toleranceLu: 2,
      maxTruePeakDb: -1,
      audioRequired: false,
    },
    declaredClaims: [
      {
        id: "claim:proof",
        text: statement,
        sceneId: "proof",
      },
    ],
    claimsReview: {
      reviewedBy: "Synthetic test declaration",
      reviewedAt: "2026-10-11T00:00:00Z",
      evidence: "Unit fixture, no human approval manufactured",
      storyHash: "a".repeat(64),
      claims: [
        {
          id: "claim:proof",
          sourceUrl: "https://example.invalid/source",
          supported: true,
          note: "Supplied evidence",
        },
      ],
    },
  });
  const snapshot = {
    identities: [
      {
        storyHash: "a".repeat(64),
      },
    ],
  } as unknown as DeliverySnapshot;
  const review = () => {
    const findings: Finding[] = [];
    reviewClaims(root, request, snapshot, findings);
    return findings.filter((f) => f.severity === "error");
  };
  const edit = (change: (document: any) => void) => {
    const document = JSON.parse(readFileSync(journal, "utf8"));
    change(document);
    writeFileSync(journal, JSON.stringify(document));
  };
  return {
    root,
    project,
    journal,
    request,
    snapshot,
    review,
    edit,
  };
}
test("active IR visual and spoken claim cannot borrow intact obsolete canonical text", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.review(), []);
  f.edit((doc) => {
    doc.timeline.tracks[0].clips[0].payload.scene.headline = "Unsupported";
    doc.timeline.tracks[0].clips[0].payload.scene.text = "Unsupported";
    doc.timeline.tracks[1].clips[0].captions = [];
  });
  assert.ok(f.review().some((e) => e.message.includes("active timeline")));
});
test("visible-only proof copy remains usable without invented spoken timestamps", (t) => {
  const f = fixture(t, false);
  assert.deepEqual(f.review(), []);
  f.edit((doc) => (doc.timeline.tracks[0].clips[0].payload.scene.headline = "Different actual proof"));
  assert.ok(f.review().length);
});
for (const kind of ["voiceover", "captions", "presenter"])
  test(`${kind} retained words must preserve Russian negation even if visual proof remains`, (t) => {
    const f = fixture(t, true, kind);
    assert.deepEqual(f.review(), []);
    f.edit((doc) => doc.timeline.tracks[1].clips[0].captions.splice(1, 1));
    assert.ok(f.review().some((e) => e.message.includes("retained timeline words")));
  });
test("trimming spoken source cannot substantiate dropped or partly cut claim words", (t) => {
  const f = fixture(t);
  f.edit((doc) => (doc.timeline.tracks[1].clips[0].source.start = r(8)));
  assert.ok(f.review().some((e) => e.message.includes("retained timeline words")));
});
test("words from an adjacent unrelated interval do not substantiate this owning scene", (t) => {
  const f = fixture(t);
  f.edit((doc) => (doc.timeline.tracks[1].clips[0].start = r(30)));
  assert.ok(f.review().some((e) => e.message.includes("retained timeline words")));
});
test("missing owning scene cannot use obsolete canonical claim copy", (t) => {
  const f = fixture(t);
  f.edit((doc) => (doc.timeline.tracks[0].clips = []));
  assert.ok(f.review().some((e) => e.message.includes("no owning active")));
});
test("legacy non-timeline claim review retains supplied sidecar compatibility", (t) => {
  const f = fixture(t);
  f.request.timeline = false;
  assert.deepEqual(f.review(), []);
  mkdirSync(path.join(f.project, "voiceover"));
  writeFileSync(
    path.join(f.project, "voiceover/proof.words.json"),
    JSON.stringify({
      words: [
        {
          text: "Unsupported",
        },
      ],
    }),
  );
  assert.ok(f.review().some((e) => e.message.includes("aligned captions")));
});
test("parallel localized caption track cannot scramble authentic source-word evidence", (t) => {
  const f = fixture(t);
  f.edit((doc) => {
    const localized = structuredClone(doc.timeline.tracks[1]);
    localized.id = "localized";
    localized.kind = "captions";
    localized.clips[0].captions = localized.clips[0].captions.map((w: any, i: number) => ({
      ...w,
      text: ["This", "is", "qualified."][i],
    }));
    doc.timeline.tracks.push(localized);
  });
  assert.deepEqual(f.review(), []);
});

test("active template source URLs cannot substitute for missing visible claim text", (t) => {
  const f = fixture(t, false);
  f.edit((doc) => {
    const scene = doc.timeline.tracks[0].clips[0].payload.scene;
    scene.headline = "Other proof";
    scene.template = { id: "scene.image-proof", version: 1, props: { headline: "Other proof", imageUrl: statement } };
  });
  assert.ok(f.review().some((e) => e.message.includes("active timeline")));
});
