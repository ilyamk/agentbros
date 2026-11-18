import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperationStore } from "../src/lib/jobs/store";
import { USER_GRANT } from "./helpers/ceiling-grant";

const repo = path.resolve(import.meta.dirname, "..");
function report(cwd: string, project: string) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.join(repo, "scripts/cost-report.ts"),
      "--project",
      project,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        AGENTBROS_NO_DOTENV: "1",
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 1, child.stdout);
  return JSON.parse(lines[0]!) as { ok: boolean; metadata: Record<string, unknown> };
}

test("cost:report names a published fal job without a receipt as reserved and unreconciled, never as a charge", (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "cost-report-pending-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const directory = path.join(cwd, "public/projects/pending/pipeline");
  mkdirSync(directory, { recursive: true });
  mkdirSync(path.join(cwd, "public/projects/empty/pipeline"), { recursive: true });
  const store = new OperationStore("pending", { directory });
  store.configure({ ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0.15, maxPaidAttemptsPerAsset: 2 }, USER_GRANT);
  const id = "fal:keyframe";
  store.reserveOperation({
    operationId: id,
    provider: "fal.ai",
    endpoint: "fal-ai/flux/schnell",
    inputHash: "hash-keyframe",
    assetId: "keyframe",
    repair: false,
    quote: {
      currency: "USD",
      lowUsd: 0.2,
      expectedUsd: 0.2,
      highUsd: 0.2,
      bounded: true,
      source: "offline quote",
      asOf: "2026-11-17",
      confidence: "published-rate",
    },
  });
  store.transitionJob(id, "submitting");
  store.transitionJob(id, "queued", { providerRequestId: "request-1" });
  store.transitionJob(id, "result-ready", { result: { images: [] } });
  store.transitionJob(id, "downloading");
  store.transitionJob(id, "validated");
  store.transitionJob(id, "published");
  assert.equal(store.snapshot().jobs[id]!.receipt, undefined);

  const { ok, metadata } = report(cwd, "pending");
  assert.equal(ok, true);
  // The ledger holds no row, so nothing is invented as a charge.
  assert.equal(metadata.totalUsd, 0);
  assert.equal(metadata.reservedUnreconciledUsd, 0.2);
  assert.deepEqual(metadata.pendingReconciliation, [
    { operationId: id, endpoint: "fal-ai/flux/schnell", reservedUsd: 0.2 },
  ]);
  const markdown = readFileSync(path.join(directory, "cost-report.md"), "utf8");
  assert.match(markdown, /\$0\.2 reserved/);
  assert.doesNotMatch(markdown, /No paid API calls recorded/);
  assert.ok(markdown.includes(`pnpm budget --project pending --operation-id ${id} --receipt <receipt.json>`), markdown);

  const empty = report(cwd, "empty").metadata;
  assert.equal(empty.reservedUnreconciledUsd, 0);
  assert.deepEqual(empty.pendingReconciliation, []);
});
