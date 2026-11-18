import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import { timelineCaptionWords } from "../src/lib/captions/profiles";
import { buildCaptionPages, pageText } from "../src/lib/captions/pages";
import { timingFixture } from "./workflow-recording-timing-fixtures";

test("recording-edit writes each word's speaker onto its caption, so an unpunctuated speaker change starts a new page", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "recording-caption-speaker-"));
  try {
    const { request } = timingFixture(root, "vfr", 6);
    const speakers: Record<string, string> = {
      first: "interviewer",
      negation: "guest",
      claim: "guest",
      removed: "guest",
      condition: "guest",
      tail: "guest",
    };
    const withSpeakers = {
      ...request,
      transcript: {
        ...request.transcript,
        words: request.transcript.words.map((w: { id: string }) => ({ ...w, speaker: speakers[w.id] })),
      },
    };
    const plain = await runRecordingEditWorkflow(request, { action: "plan", rootDir: root });
    const plan = await runRecordingEditWorkflow(withSpeakers, { action: "plan", rootDir: root });
    assert.notEqual(
      plan.metadata.editHash,
      plain.metadata.editHash,
      "speakers change the captions, so review must cover them",
    );
    await runRecordingEditWorkflow(
      {
        ...withSpeakers,
        review: {
          reviewer: "offline-test-declaration",
          reviewedAt: "2026-11-13T00:00:00Z",
          meaningPreserved: true,
          approvedEditHash: plan.metadata.editHash,
        },
      },
      { action: "create", rootDir: root },
    );
    const ir = new TimelineEditStore(
      path.join(root, "public/projects", request.projectId, "pipeline/timeline-edit.json"),
    ).read().timeline;
    const captions = ir.tracks.find((track) => track.kind === "captions")!.clips.flatMap((clip) => clip.captions);
    assert.ok(captions.length > 0);
    for (const caption of captions) assert.equal((caption as { speaker?: string }).speaker, speakers[caption.id]);
    const compiled = compileTimelineIR(ir).tracks.find((track) => track.kind === "captions")!.clips[0];
    const pages = buildCaptionPages(timelineCaptionWords(compiled.captions, ir.timebase));
    assert.deepEqual(pageText(pages[0]), ["Это"]);
    assert.match(pageText(pages[1]).join(" "), /^не/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
