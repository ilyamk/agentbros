import path from "node:path";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hashFile } from "../src/lib/assets/registry";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
export function recordingFixture(root: string) {
  mkdirSync(root, {
    recursive: true,
  });
  const source = path.join(root, "original.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30:duration=3",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=if(lt(t\\,1)\\,0.2*sin(2*PI*440*t)\\,if(lt(t\\,2)\\,0.2*sin(2*PI*660*t)\\,0.2*sin(2*PI*880*t))):s=48000:d=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    source,
  ]);
  return {
    version: 1,
    workflow: "recording-edit",
    projectId: "recut",
    name: "Русский монтаж",
    profile: "recording-only",
    formats: ["landscape"],
    source: {
      file: source,
      sha256: hashFile(source),
      version: "take-1",
      fps: {
        num: 30,
        den: 1,
      },
    },
    transcript: {
      version: "reviewed-v1",
      language: "ru",
      words: [
        {
          id: "w1",
          text: "Это",
          startFrame: 0,
          endFrame: 7,
        },
        {
          id: "w2",
          text: "не",
          startFrame: 7,
          endFrame: 12,
        },
        {
          id: "w3",
          text: "гарантия.",
          startFrame: 12,
          endFrame: 25,
        },
        {
          id: "w4",
          text: "Повтор.",
          startFrame: 33,
          endFrame: 50,
        },
        {
          id: "w5",
          text: "Если",
          startFrame: 60,
          endFrame: 68,
        },
        {
          id: "w6",
          text: "проверено.",
          startFrame: 68,
          endFrame: 85,
        },
      ],
    },
    keepSpans: [
      {
        id: "first",
        startFrame: 0,
        endFrame: 30,
        reason: "Сохраняем отрицание полностью",
      },
      {
        id: "last",
        startFrame: 60,
        endFrame: 90,
        reason: "Сохраняем условие полностью",
      },
    ],
    cuts: [
      {
        startFrame: 30,
        endFrame: 60,
        reason: "Одобренное удаление повтора",
      },
    ],
    protectedSpans: [
      {
        startFrame: 0,
        endFrame: 25,
        kind: "negation",
        reason: "Не означает гарантию",
      },
      {
        startFrame: 60,
        endFrame: 85,
        kind: "caveat",
        reason: "Обязательное условие",
      },
    ],
    revision: 1,
  };
}
export async function reviewedRequest(root: string) {
  const request = recordingFixture(root);
  const plan = await runRecordingEditWorkflow(request, {
    action: "plan",
    rootDir: root,
  });
  return {
    ...request,
    review: {
      reviewer: "offline-test-declaration",
      reviewedAt: "2026-10-11T00:00:00Z",
      meaningPreserved: true,
      approvedEditHash: plan.metadata.editHash,
    },
  };
}
