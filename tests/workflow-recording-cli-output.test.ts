import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { timingFixture } from "./workflow-recording-timing-fixtures";

test("video:workflow recording-edit keeps its one stdout line small: boundaries and word mappings become counts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "recording-cli-output-"));
  try {
    const { request } = timingFixture(root, "vfr", 20);
    const plan = await runRecordingEditWorkflow(request, { action: "plan", rootDir: root });
    const reviewed = {
      ...request,
      review: {
        reviewer: "offline-test-declaration",
        reviewedAt: "2026-11-13T00:00:00Z",
        meaningPreserved: true,
        approvedEditHash: plan.metadata.editHash,
      },
    };
    const file = path.join(root, "request.json");
    writeFileSync(file, JSON.stringify(reviewed));
    for (const action of ["plan", "create"]) {
      const run = spawnSync(
        path.resolve("node_modules/.bin/tsx"),
        [
          path.resolve("scripts/video-workflow.ts"),
          "--scenario",
          "recording-edit",
          "--action",
          action,
          "--request",
          file,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
        },
      );
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const line = run.stdout.trim();
      assert.equal(line.split("\n").length, 1);
      const result = JSON.parse(line);
      assert.equal(result.metadata.sourceTiming.boundaries, undefined);
      assert.equal(
        result.metadata.sourceTiming.boundaryCount,
        (plan.metadata.sourceTiming as { boundaries: unknown[] }).boundaries.length,
      );
      assert.ok(
        result.metadata.mapping.every(
          (span: { words?: unknown; wordCount: number }) =>
            span.words === undefined && Number.isInteger(span.wordCount),
        ),
      );
      assert.ok(line.length < JSON.stringify(plan.metadata).length / 2, `${line.length} bytes`);
      assert.equal(result.metadata.editHash, plan.metadata.editHash);
    }
    assert.ok(existsSync(path.join(root, "public/projects/recut-vfr/pipeline/recording-edit.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
