import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import type { TestContext } from "node:test";
import { TimelineIRSchema } from "../src/types/timeline";
import { ProjectConfigSchema } from "../src/types/video";
import { ChapterManifestSchema } from "../src/types/longform";
import { selectionHash } from "../src/lib/longform/plans";
import { hashFile } from "../src/lib/assets/registry";
import { inspectShortsSeriesSource } from "../src/lib/workflows/shorts-series";
export const r = (num: number) => ({ num, den: 1 });
export function shortsFixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "shorts-series-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "public/projects/source");
  mkdirSync(path.join(directory, "pipeline"), { recursive: true });
  const video = path.join(directory, "original.mp4"),
    audio = path.join(directory, "speech-marker.wav");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=160x90:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x90:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=160x90:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=c=yellow:s=160x90:r=30:d=1",
    "-filter_complex",
    "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    video,
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1100:duration=1",
    "-filter_complex",
    "[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1[a]",
    "-map",
    "[a]",
    "-c:a",
    "pcm_s16le",
    audio,
  ]);
  const project = ProjectConfigSchema.parse({
    name: "Synthetic supplied source",
    productName: "Technical test fixture",
    formats: ["landscape"],
    colors: { accent: "#FFE600", background: "#FFFFFF", text: "#111111" },
    musicVolume: 0,
    scenes: [
      {
        id: "source",
        text: "Synthetic caption labels, not a transcribed human recording",
        headline: "",
        visualType: "video",
        imageUrl: "projects/source/original.mp4",
        durationInFrames: 120,
      },
    ],
  });
  const words = [
    { id: "hook", text: "Пример", start: r(0), end: r(20) },
    { id: "this", text: "Это", start: r(30), end: r(38) },
    { id: "not", text: "не", start: r(38), end: r(45) },
    { id: "guarantee", text: "гарантия", start: r(45), end: r(60) },
    { id: "condition", text: "Зависит от условий", start: r(60), end: r(90) },
    { id: "end", text: "Проверьте источник", start: r(90), end: r(120) },
  ];
  const clip = {
    start: r(0),
    source: { start: r(0), end: r(120), timebase: r(30) },
    rate: r(1),
    transition: { kind: "cut" as const },
    captions: [],
  };
  const timeline = TimelineIRSchema.parse({
    version: 1,
    projectId: "source",
    timebase: r(30),
    tracks: [
      {
        id: "visual",
        kind: "visual",
        clips: [{ ...clip, id: "v", assetId: "projects/source/original.mp4" }],
      },
      {
        id: "speech",
        kind: "voiceover",
        clips: [
          {
            ...clip,
            id: "a",
            assetId: "projects/source/speech-marker.wav",
            captions: words,
          },
        ],
      },
    ],
  });
  const chapters = ChapterManifestSchema.parse({
    version: 1,
    revision: 1,
    chapters: [
      {
        id: "hook",
        title: "Supplied fixture hook",
        revision: 1,
        start: r(0),
        end: r(30),
      },
      {
        id: "caveat",
        title: "Supplied Russian caveat",
        revision: 1,
        start: r(30),
        end: r(90),
      },
      {
        id: "end",
        title: "Supplied fixture conclusion",
        revision: 1,
        start: r(90),
        end: r(120),
      },
    ],
    protectedSpans: [
      {
        id: "negation",
        start: r(30),
        end: r(60),
        reason: "negation",
        requires: ["condition"],
        note: "Retain supplied negation and caveat together",
      },
      {
        id: "condition",
        start: r(60),
        end: r(90),
        reason: "caveat",
        note: "Supplied condition controls the claim",
      },
    ],
  });
  writeFileSync(path.join(directory, "project.json"), JSON.stringify(project));
  writeFileSync(
    path.join(directory, "pipeline/timeline-edit.json"),
    JSON.stringify({ version: 1, revision: 3, timeline, undo: [], redo: [] }),
  );
  writeFileSync(path.join(directory, "pipeline/chapters.json"), JSON.stringify(chapters));
  writeFileSync(
    path.join(directory, "pipeline/brand.json"),
    JSON.stringify({
      version: 1,
      name: "Synthetic local brand",
      voice: "source-controlled",
    }),
  );
  const inspected = inspectShortsSeriesSource("source", "pipeline/chapters.json", { rootDir: root });
  const episodes = [
    ["hook", 0, 30],
    ["caveat", 30, 90],
    ["conclusion", 60, 120],
  ] as const;
  const request = {
    version: 1,
    seriesId: "technical-series",
    source: inspected.source,
    episodes: episodes.map(([id, start, end]) => {
      const ranges = [{ start: r(start), end: r(end) }];
      return {
        selection: {
          version: 1,
          id,
          purpose: `Supplied ${id} selection`,
          ranges,
          approval: {
            approvedBy: "synthetic-test-declaration-not-production-review",
            approvedAt: "2026-10-11T00:00:00Z",
            selectionHash: selectionHash(ranges),
          },
        },
        approvedSourceHash: inspected.approvalSourceHash,
        formats: ["vertical", "square"],
      };
    }),
  };
  return {
    root,
    directory,
    project,
    timeline,
    chapters,
    request,
    video,
    audio,
  };
}

export function addSuppliedEducation(f: ReturnType<typeof shortsFixture>, keepThree = false) {
  const evidenceFile = path.join(f.directory, "pipeline/supplied-lesson.txt");
  const excerpt = "Это не гарантия. Зависит от условий.";
  writeFileSync(evidenceFile, `Synthetic supplied lesson evidence only: ${excerpt}`);
  const sha256 = hashFile(evidenceFile);
  const spans = [
    ["hook", 0, 30],
    ["caveat", 30, 90],
    ["end", 90, 120],
  ] as const;
  const visual = f.timeline.tracks.find((track) => track.kind === "visual")!;
  const original = visual.clips[0];
  visual.clips = spans.map(([id, start, end]) => ({
    ...structuredClone(original),
    id,
    start: r(start),
    source: { ...original.source, start: r(start), end: r(end) },
  }));
  f.project.scenes = spans.map(([id, start, end]) => ({
    ...structuredClone(f.project.scenes[0]),
    id,
    durationInFrames: end - start,
  }));
  writeFileSync(path.join(f.directory, "project.json"), JSON.stringify(f.project));
  writeFileSync(
    path.join(f.directory, "pipeline/timeline-edit.json"),
    JSON.stringify({
      version: 1,
      revision: 4,
      timeline: f.timeline,
      undo: [],
      redo: [],
    }),
  );
  writeFileSync(
    path.join(f.directory, "pipeline/education.json"),
    JSON.stringify({
      request: {
        sources: [{ id: "supplied", sha256 }],
        claims: [{ id: "conditioned", evidence: [{ sourceId: "supplied", excerpt }] }],
        chapters: [
          {
            beats: [{ id: "caveat", spokenText: excerpt, claimIds: ["conditioned"] }],
          },
        ],
      },
      evidenceFiles: [{ id: "supplied", file: "pipeline/supplied-lesson.txt", sha256 }],
    }),
  );
  writeFileSync(
    path.join(f.directory, "pipeline/workflow-render.json"),
    JSON.stringify({
      version: 1,
      workflow: "education",
      projectId: "source",
      timelineRequired: true,
    }),
  );
  const inspected = inspectShortsSeriesSource("source", "pipeline/chapters.json", { rootDir: f.root });
  f.request.source = inspected.source;
  if (!keepThree) f.request.episodes = f.request.episodes.slice(0, 2);
  else {
    f.request.episodes[2].selection.ranges = [{ start: r(90), end: r(120) }];
    f.request.episodes[2].selection.approval.selectionHash = selectionHash(f.request.episodes[2].selection.ranges);
  }
  f.request.episodes.forEach((episode) => (episode.approvedSourceHash = inspected.approvalSourceHash));
  return { evidenceFile, sha256, excerpt };
}
