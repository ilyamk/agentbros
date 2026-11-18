import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { TimelineEditStore } from "../../src/lib/timeline-ir/store";
export const r = (num: number) => ({ num, den: 1 });
export function chapterFixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-chapters-"))),
    project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  const scene = { id: "hook", text: "", headline: "Lesson", visualType: "title", durationInFrames: 90 };
  writeFileSync(
    path.join(project, "project.json"),
    JSON.stringify({
      name: "Lesson",
      productName: "Lesson",
      formats: ["landscape", "vertical", "square"],
      colors: {},
      musicVolume: 0,
      scenes: [scene],
    }),
  );
  const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
  const doc = store.initialize({
    version: 1,
    projectId: "demo",
    timebase: r(30),
    tracks: [
      {
        id: "visual",
        kind: "visual",
        clips: [
          {
            id: "hook",
            assetId: "scene:hook",
            start: r(0),
            source: { start: r(0), end: r(90), timebase: r(30) },
            rate: r(1),
            transition: { kind: "cut" },
            captions: [],
            payload: { scene },
          },
        ],
      },
    ],
  });
  const manifest = {
    version: 1,
    revision: 1,
    chapters: [
      { id: "first", title: "First <script>unsafe</script>", revision: 1, start: r(0), end: r(30) },
      { id: "second", title: "Second", revision: 1, start: r(30), end: r(90) },
    ],
    protectedSpans: [],
  };
  const manifestFile = path.join(project, "pipeline/chapters.json");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const request = {
    expectedRevision: doc.revision,
    timelineHash: createHash("sha256").update(JSON.stringify(doc.timeline)).digest("hex"),
    manifestSha256: null,
    format: "landscape" as const,
  };
  return { root, project, store, manifest, manifestFile, request };
}
