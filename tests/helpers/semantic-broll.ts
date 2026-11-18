import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { importAsset } from "../../src/lib/assets/registry";
import { SourceIndexSchema, IngestOptionsSchema } from "../../src/types/source-index";
import { importTranscript } from "../../src/lib/ingest";
import { digest } from "../../src/lib/jobs/model-artifacts";
import { TimelineEditStore } from "../../src/lib/timeline-ir/store";
import { planBroll } from "../../src/lib/ingest/broll";
export function brollFixture(rate = "30") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "semantic-broll-"))),
    project = path.join(root, "public/projects/pilot");
  mkdirSync(path.join(project, "pipeline"), {
    recursive: true,
  });
  writeFileSync(
    path.join(project, "project.json"),
    JSON.stringify({
      name: "B-roll pilot",
      productName: "Pilot",
      colors: {},
      formats: ["square"],
      musicVolume: 0,
      voiceoverEnabled: false,
      scenes: [
        {
          id: "base",
          text: "Do not promise a guarantee",
          visualType: "title",
          durationInFrames: 90,
          transitionToNext: "cut",
        },
      ],
    }),
  );
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  const blue = path.join(root, "blue.mp4"),
    red = path.join(root, "red.mp4"),
    speech = path.join(root, "speech.wav");
  ff([
    "-f",
    "lavfi",
    "-i",
    `color=c=blue:s=160x120:r=${rate}:d=1.001`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000:duration=1.001",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    blue,
  ]);
  ff(["-f", "lavfi", "-i", "color=c=red:s=160x120:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", red]);
  ff(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-c:a", "pcm_s16le", speech]);
  const rights = {
    licence: "Synthetic local fixture only",
    checkedAsOf: "2026-10-11T00:00:00Z",
    commercialAllowed: true,
    attributionRequired: false,
  };
  const register = (sourceFile: string) =>
    importAsset({
      rootDir: root,
      projectId: "pilot",
      sourceFile,
      provenance: {
        origin: "manual",
      },
      rights,
    }).asset;
  const cutaway = register(blue),
    base = register(red),
    audio = register(speech);
  const options = IngestOptionsSchema.parse({
    protectedSpans: [
      {
        startSec: 0,
        endSec: 0.6,
        reason: "Preserve complete negative statement",
      },
    ],
  });
  const transcript = {
      segments: [
        {
          text: "Do not claim a guarantee.",
          startSec: 0,
          endSec: 0.5,
        },
      ],
    },
    transcriptBytes = JSON.stringify(transcript),
    transcriptHash = digest(transcriptBytes);
  const key = digest(
    JSON.stringify({
      version: 1,
      sourceHash: cutaway.hash,
      options,
      transcriptHash,
    }),
  );
  const dir = path.join(project, "pipeline/source-index", key);
  mkdirSync(dir, {
    recursive: true,
  });
  writeFileSync(path.join(dir, "transcript.json"), transcriptBytes);
  const fps = cutaway.media.frameRate!.split("/").map(Number);
  const index = SourceIndexSchema.parse({
    schemaVersion: 1,
    projectId: "pilot",
    assetId: cutaway.id,
    sourceHash: cutaway.hash,
    cacheKey: key,
    createdAt: "fixture",
    source: {
      path: cutaway.files.original,
      kind: "video",
      durationSec: cutaway.media.durationSec,
      fps: {
        num: fps[0],
        den: fps[1],
      },
      variableFrameRate: false,
      timestamps: [0],
    },
    options,
    thumbnails: [],
    scenes: [],
    segments: importTranscript(transcript, "fixture supplied original", transcriptHash, cutaway.media.durationSec!),
    transcript: {
      hash: transcriptHash,
      source: "fixture supplied original",
      path: `projects/pilot/pipeline/source-index/${key}/transcript.json`,
    },
    ocr: {
      available: false,
      executed: false,
    },
  });
  const indexFile = `pipeline/source-index/${key}/index.json`;
  writeFileSync(path.join(project, indexFile), JSON.stringify(index));
  const r = (num: number) => ({
    num,
    den: 1,
  });
  const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
  store.initialize({
    version: 1,
    projectId: "pilot",
    timebase: r(30),
    tracks: [
      {
        id: "base",
        kind: "visual",
        clips: [
          {
            id: "original-base",
            assetId: base.id,
            start: r(0),
            source: {
              start: r(0),
              end: r(90),
              timebase: r(30),
            },
            captions: [],
          },
        ],
      },
      {
        id: "speech",
        kind: "voiceover",
        clips: [
          {
            id: "negative-statement",
            assetId: audio.id,
            start: r(0),
            source: {
              start: r(0),
              end: r(144000),
              timebase: r(48000),
            },
            captions: [
              {
                id: "word-not",
                text: "not",
                start: r(48000),
                end: r(96000),
              },
            ],
          },
        ],
      },
    ],
  });
  const request = {
    version: 1 as const,
    projectId: "pilot",
    indexFile,
    retrieval: {
      method: "lexical" as const,
      query: "guarantee",
    },
    segmentId: "transcript-0",
    contextSec: 0,
    trackId: "cutaway",
    clipId: "blue-proof",
    outputStart: r(30),
    expectedRevision: 0,
  };
  const review = (plan: ReturnType<typeof planBroll>) => ({
    planHash: plan.planHash,
    assetHash: plan.assetHash,
    reviewedBy: "synthetic-test-only",
    evidence: "Fixture declaration, not real creative approval",
  });
  return {
    root,
    project,
    request,
    index,
    indexFile,
    cutaway,
    store,
    review,
    cleanup: () =>
      rmSync(root, {
        recursive: true,
        force: true,
      }),
  };
}
