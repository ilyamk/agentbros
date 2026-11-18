import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TimelineEditStore } from "../../src/lib/timeline-ir/store";
export const rational = (num: number, den = 1) => ({ num, den });
export const groupClip = (id: string, start: number, span = 30) => ({
  id,
  assetId: "scene:" + id,
  start: rational(start),
  source: { start: rational(7), end: rational(7 + span), timebase: rational(30) },
  rate: rational(1),
  transition: { kind: "cut" as const },
  captions: [{ id: "word", text: "Source caption", start: rational(7), end: rational(12) }],
  payload: { scene: { headline: id }, original: true },
});
export function groupFixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-group-"))),
    project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
  store.initialize({
    version: 1,
    projectId: "demo",
    timebase: rational(30),
    tracks: [
      { id: "visual", kind: "visual", clips: [groupClip("a", 30), groupClip("b", 60), groupClip("blocker", 150)] },
      { id: "overlay", kind: "visual", clips: [groupClip("overlay-a", 15)] },
      ...(["voiceover", "presenter", "music", "sfx", "captions"] as const).map((kind) => ({
        id: kind,
        kind,
        clips: [groupClip(kind, 0, 240)],
      })),
    ],
  });
  return { root, project, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
export const groupRequest = (delta = rational(30)) => ({
  expectedRevision: 0,
  members: [
    { trackId: "visual", clipId: "a" },
    { trackId: "visual", clipId: "b" },
  ],
  delta,
});
