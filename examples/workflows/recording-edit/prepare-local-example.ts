/** Synthetic offline example only. Produces no approvals and contacts no services. */
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hashFile } from "../../../src/lib/assets/registry";
import { runRecordingEditWorkflow } from "../../../src/lib/workflows/recording-edit";
async function main() {
  const directory = path.resolve(process.argv[2] ?? ".cache/recording-edit-example");
  mkdirSync(directory, {
    recursive: true,
  });
  const file = path.join(directory, "supplied-synthetic-recording.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=3",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    "-n",
    file,
  ]);
  const request = {
    version: 1,
    workflow: "recording-edit",
    projectId: "recording-example",
    name: "Synthetic Russian recut example",
    profile: "recording-only",
    formats: ["landscape"],
    source: {
      file,
      sha256: hashFile(file),
      version: "synthetic-fixture-v1",
      fps: {
        num: 30,
        den: 1,
      },
    },
    transcript: {
      version: "synthetic-timing-declaration-v1",
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
        reason: "Retain complete negation",
      },
      {
        id: "last",
        startFrame: 60,
        endFrame: 90,
        reason: "Retain complete caveat",
      },
    ],
    cuts: [
      {
        startFrame: 30,
        endFrame: 60,
        reason: "Remove declared repeat",
      },
    ],
    protectedSpans: [
      {
        startFrame: 0,
        endFrame: 25,
        kind: "negation",
        reason: "Not a guarantee",
      },
      {
        startFrame: 60,
        endFrame: 85,
        kind: "caveat",
        reason: "Keep qualification",
      },
    ],
    revision: 1,
  };
  const plan = await runRecordingEditWorkflow(request, {
    action: "plan",
  });
  writeFileSync(path.join(directory, "request.json"), JSON.stringify(request, null, 2));
  writeFileSync(path.join(directory, "plan.json"), JSON.stringify(plan, null, 2));
  process.stdout.write(
    JSON.stringify({
      requestFile: path.join(directory, "request.json"),
      reviewHash: plan.metadata.editHash,
      note: "Synthetic tone, not actual speech. Review is not generated; supply your own declaration.",
    }) + "\n",
  );
}
void main();
