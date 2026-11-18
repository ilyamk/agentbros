import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { reviewRights } from "../src/lib/delivery/reviews";
import { DeliveryRequestSchema } from "../src/types/delivery";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { hashFile, importAsset } from "../src/lib/assets/registry";
import type { Scene } from "../src/types/video";
const r = (num: number) => ({
  num,
  den: 1,
});
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "active-media-identity-"));
  t.after(() =>
    rmSync(root, {
      recursive: true,
      force: true,
    }),
  );
  const project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), {
    recursive: true,
  });
  mkdirSync(path.join(project, "assets"), {
    recursive: true,
  });
  const media = (name: string, color: string) => {
    const file = path.join(project, "assets", name);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=32x32:r=30:d=0.1`,
      "-frames:v",
      "1",
      file,
    ]);
    return `projects/demo/assets/${name}`;
  };
  const canonical = media("canonical.png", "red"),
    active = media("active.png", "blue"),
    replacement = media("replacement.png", "green");
  const config = {
    name: "Active sources",
    productName: "Active sources",
    formats: ["landscape"],
    musicVolume: 0,
    colors: {},
    scenes: [
      {
        id: "legacy",
        text: "",
        headline: "Legacy",
        visualType: "photo",
        imageUrl: canonical,
        durationInFrames: 30,
      },
    ],
  };
  const configFile = path.join(project, "project.json");
  writeFileSync(configFile, JSON.stringify(config));
  const scene: Scene = {
    id: "edited",
    text: "",
    headline: "Active",
    visualType: "photo",
    imageUrl: active,
    durationInFrames: 30,
  };
  const journal = path.join(project, "pipeline/timeline-edit.json");
  const initialize = (scenes: Scene[]) =>
    new TimelineEditStore(journal).initialize({
      version: 1,
      projectId: "demo",
      timebase: r(30),
      tracks: [
        {
          id: "visual",
          kind: "visual",
          clips: scenes.map((scene, i) => ({
            id: scene.id,
            assetId: `scene:${scene.id}`,
            start: r(i * 30),
            source: {
              start: r(0),
              end: r(30),
              timebase: r(30),
            },
            rate: r(1),
            transition: {
              kind: "cut",
            },
            captions: [],
            payload: {
              scene,
            },
          })),
        },
      ],
    });
  const capture = () =>
    captureRenderIdentity("demo", "landscape", {
      rootDir: root,
      timeline: true,
    });
  return {
    root,
    project,
    config,
    configFile,
    scene,
    journal,
    initialize,
    capture,
    active,
    canonical,
    replacement,
  };
}
test("active IR scene bytes change source snapshot and rights map after a legitimate timeline edit", (t) => {
  const f = fixture(t);
  f.initialize([f.scene]);
  const before = f.capture();
  const active = before.sources.find((s) => s.path === `public/${f.active}`);
  assert.equal(active?.role, "asset");
  assert.ok(!before.sources.some((s) => s.path === `public/${f.canonical}`));
  copyFileSync(path.join(f.root, "public", f.replacement), path.join(f.root, "public", f.active));
  const after = f.capture();
  assert.notEqual(after.sourceSnapshotHash, before.sourceSnapshotHash);
  assert.equal(after.propsHash, before.propsHash, "same props, changed media bytes");
  assert.equal(
    after.sources.find((s) => s.path === active!.path)?.sha256,
    hashFile(path.join(f.root, "public", f.active)),
  );
  const request = DeliveryRequestSchema.parse({
    version: 1,
    projectId: "demo",
    formats: ["landscape"],
    variants: ["captioned"],
    placements: ["YouTube"],
    loudness: {
      targetLufs: -16,
      toleranceLu: 2,
      maxTruePeakDb: -1,
      audioRequired: false,
    },
  });
  const findings: Parameters<typeof reviewRights>[3] = [];
  const records = reviewRights(f.root, request, [after], findings);
  assert.equal(records.length, 1);
  assert.equal(records[0].sha256, after.sources.find((s) => s.path === active!.path)?.sha256);
  assert.equal(records[0].path, active!.path);
  assert.ok(findings.some((f) => f.code === "RIGHTS_UNCONFIRMED" && f.path === active!.path));
});
test("obsolete canonical media bytes do not affect active timeline identity", (t) => {
  const f = fixture(t);
  f.initialize([f.scene]);
  const before = f.capture();
  copyFileSync(path.join(f.root, "public", f.replacement), path.join(f.root, "public", f.canonical));
  const after = f.capture();
  assert.equal(after.sourceSnapshotHash, before.sourceSnapshotHash);
  assert.ok(!after.sources.some((s) => s.path === `public/${f.canonical}`));
});
test("active template fallback and left panel image/video/avatar sources are captured", (t) => {
  const f = fixture(t);
  const video = path.join(f.project, "assets/archival.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=32x32:r=30:d=1",
    "-c:v",
    "libx264",
    video,
  ]);
  const scenes: Scene[] = [
    {
      ...f.scene,
      id: "template",
      imageUrl: undefined,
      template: {
        id: "scene.image-proof",
        version: 1,
        props: {
          headline: "Proof",
          imageUrl: f.active,
        },
      },
    },
    {
      ...f.scene,
      id: "screenshot",
      imageUrl: undefined,
      visualType: "title",
      leftPanel: {
        kind: "screenshot",
        imageUrl: f.replacement,
        entrance: "fade",
        kenBurns: true,
      },
    },
    {
      ...f.scene,
      id: "archival",
      imageUrl: undefined,
      visualType: "title",
      leftPanel: {
        kind: "archival",
        videoUrl: "projects/demo/assets/archival.mp4",
        entrance: "fade",
        startFrom: 0,
      },
    },
    {
      ...f.scene,
      id: "avatar",
      imageUrl: undefined,
      visualType: "title",
      leftPanel: {
        kind: "tweet",
        entrance: "fade",
        verified: false,
        darkMode: false,
        author: "Author",
        handle: "creator",
        text: "A prose URL https://example.invalid does not denote media",
        avatarUrl: f.active,
      },
    },
  ];
  f.initialize(scenes);
  const identity = f.capture();
  for (const source of [f.active, f.replacement, "projects/demo/assets/archival.mp4"])
    assert.ok(
      identity.sources.some((s) => s.path === `public/${source}` && s.role === "asset"),
      source,
    );
});
test("canonical scene image overrides unused template reference in active payload", (t) => {
  const f = fixture(t);
  f.initialize([
    {
      ...f.scene,
      template: {
        id: "scene.image-proof",
        version: 1,
        props: {
          headline: "Proof",
          imageUrl: "projects/demo/assets/missing-unused.png",
        },
      },
    },
  ]);
  assert.ok(f.capture().sources.some((s) => s.path === `public/${f.active}`));
});
test("direct registered timeline assets remain captured and obsolete presenter path is ignored", (t) => {
  const f = fixture(t);
  const video = path.join(f.project, "assets/presenter.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=32x32:r=30:d=1",
    "-c:v",
    "libx264",
    video,
  ]);
  const imported = importAsset({
    projectId: "demo",
    sourceFile: video,
    rootDir: f.root,
    provenance: {
      origin: "manual",
      tool: "offline test",
    },
  });
  writeFileSync(
    f.configFile,
    JSON.stringify({
      ...f.config,
      talkingHead: {
        enabled: true,
        presenterVideo: "projects/demo/missing-legacy-presenter.mp4",
      },
    }),
  );
  new TimelineEditStore(f.journal).initialize({
    version: 1,
    projectId: "demo",
    timebase: r(30),
    tracks: [
      {
        id: "presenter",
        kind: "presenter",
        clips: [
          {
            id: "actual",
            assetId: imported.asset.id,
            start: r(0),
            source: {
              start: r(0),
              end: r(30),
              timebase: r(30),
            },
            rate: r(1),
            transition: {
              kind: "cut",
            },
            captions: [],
          },
        ],
      },
    ],
  });
  const identity = f.capture();
  assert.ok(identity.sources.some((s) => s.path === `public/${imported.asset.files.original}`));
  assert.ok(!identity.sources.some((s) => s.path.includes("missing-legacy-presenter")));
  assert.ok(!identity.sources.some((s) => s.path === `public/${f.canonical}`));
});
test("inherited workflow claims stay bound to authored source/story identity", (t) => {
  const f = fixture(t);
  f.initialize([f.scene]);
  const file = path.join(f.project, "pipeline/workflow-claims.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      claims: [
        {
          id: "source-claim",
          text: "Original qualified statement",
        },
      ],
    }),
  );
  const before = f.capture();
  assert.ok(before.sources.some((s) => s.path.endsWith("workflow-claims.json") && s.role === "creative"));
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      claims: [
        {
          id: "source-claim",
          text: "Changed statement",
        },
      ],
    }),
  );
  const after = f.capture();
  assert.notEqual(after.storyHash, before.storyHash);
  assert.notEqual(after.sourceSnapshotHash, before.sourceSnapshotHash);
});
