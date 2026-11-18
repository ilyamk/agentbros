import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCatalogEntry, resetCatalogCache, writeCatalog } from "../src/lib/models/fal-catalog";
import {
  legacyRequestEndpoint,
  projectReferences,
  runFalDoctor,
  scriptTableEndpoints,
  staticReferences,
} from "../src/lib/models/fal-doctor";
import { allModelIds } from "../src/lib/apis/fal-models";
import { FAL_MUSIC_MODELS } from "../src/lib/providers/fal-music";
import { LEGACY_ENDPOINTS } from "../src/lib/models/registry";
import type { FalCatalogEntry } from "../src/types/fal-catalog";

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), `fal-doctor-${prefix}-`));
const TODAY = "2026-11-15";
const synthetic = (endpoint: string, extra: Partial<FalCatalogEntry> = {}): FalCatalogEntry => ({
  ...buildCatalogEntry(
    { endpoint_id: endpoint, metadata: { category: "text-to-video", display_name: endpoint, status: "active" } },
    { today: TODAY, verifiedPins: {} },
  ),
  ...extra,
});

/** A catalogue where one legacy alias is gone, one retiring with a replacement, one deprecated, one active. */
function catalog(): string {
  const dir = tmp("catalog");
  writeCatalog(
    [
      synthetic("fal-ai/kling-video/v2.5-turbo/pro/text-to-video", { status: "gone" }),
      synthetic("fal-ai/minimax/hailuo-02/pro/text-to-video", {
        retiresAt: "2026-12-31",
        replacement: "fal-ai/minimax/hailuo-03/pro/text-to-video",
      }),
      synthetic("bytedance/seedance-2.0/fast/text-to-video", { status: "deprecated" }),
      synthetic("bytedance/seedance-2.5/text-to-video"),
      synthetic("fal-ai/my-retired/model", { status: "gone" }),
    ],
    dir,
    { syncedAt: TODAY },
  );
  resetCatalogCache();
  return dir;
}

test("static sources: every endpoint string in the video and lip-sync tables is covered", () => {
  const video = readFileSync("scripts/generate-video.ts", "utf8");
  const lipsync = readFileSync("scripts/generate-lipsync.ts", "utf8");
  const videoIds = scriptTableEndpoints(video, "generate-video");
  const lipsyncIds = scriptTableEndpoints(lipsync, "generate-lipsync");
  assert.ok(videoIds.length >= 8);
  assert.deepEqual(lipsyncIds.sort(), ["fal-ai/latentsync", "fal-ai/sync-lipsync"]);
  // Any quoted endpoint-shaped string in the table area must be found by the parser.
  const quoted = new Set([...video.matchAll(/"((?:fal-ai|bytedance)\/[a-z0-9._/-]+)"/g)].map((match) => match[1]!));
  for (const id of quoted) assert.ok(videoIds.includes(id), `${id} missing from the generate-video parse`);
  const refs = staticReferences();
  const endpoints = new Set(refs.map((ref) => ref.endpoint));
  for (const id of [
    ...allModelIds(),
    ...Object.keys(FAL_MUSIC_MODELS),
    ...Object.values(LEGACY_ENDPOINTS).flatMap((ops) => Object.values(ops)),
  ])
    assert.ok(endpoints.has(id!), id);
});

test("legacy family requests resolve to their snapshot endpoint", () => {
  assert.equal(
    legacyRequestEndpoint({ family: "kling-v3", variant: "pro", operation: "image-to-video", input: {} }),
    "fal-ai/kling-video/v3/pro/image-to-video",
  );
  assert.equal(
    legacyRequestEndpoint({
      family: "seedance-2.5",
      variant: "default",
      operation: "text-to-video",
      region: "us",
      input: {},
    }),
    "bytedance/seedance-2.5/us/text-to-video",
  );
  assert.equal(
    legacyRequestEndpoint({
      family: "flux-2",
      variant: "dev",
      operation: "text-to-image",
      transport: "stream",
      input: {},
    }),
    "fal-ai/flux-2/stream",
  );
  assert.equal(
    legacyRequestEndpoint({ family: "kling-v3", operation: "image-to-video", input: {} }),
    undefined,
    "ambiguous without a variant",
  );
});

test("doctor: statuses, replacement and merged sources, harness plus a temporary project", () => {
  const catalogDir = catalog();
  const project = tmp("project");
  const operations = path.join(project, "operations.json");
  const assetPlan = path.join(project, "asset-plan.json");
  writeFileSync(
    operations,
    JSON.stringify({
      version: 1,
      projectId: "demo",
      revision: 1,
      jobs: {
        "op-1": { provider: "fal", endpoint: "fal-ai/my-retired/model", state: "succeeded" },
        "op-2": { provider: "elevenlabs", endpoint: "fal-ai/not-fal-provider", state: "succeeded" },
      },
    }),
  );
  writeFileSync(
    assetPlan,
    JSON.stringify({
      assets: [
        {
          id: "hero",
          source: "fal-model",
          metadata: { operationRequest: { endpoint: "bytedance/seedance-2.5/text-to-video", input: {} } },
        },
        {
          id: "b-roll",
          source: "fal-model",
          metadata: {
            operationRequest: { family: "kling-v3", variant: "pro", operation: "image-to-video", input: {} },
          },
        },
        {
          id: "odd",
          source: "fal-model",
          metadata: { operationRequest: { family: "kling-v3", operation: "image-to-video", input: {} } },
        },
        { id: "stock", source: "pexels" },
      ],
    }),
  );
  const scanned = projectReferences({ operations, assetPlan, label: "demo" });
  assert.deepEqual(scanned.refs.map((ref) => ref.endpoint).sort(), [
    "bytedance/seedance-2.5/text-to-video",
    "fal-ai/kling-video/v3/pro/image-to-video",
    "fal-ai/my-retired/model",
  ]);
  assert.deepEqual(scanned.unresolved, ["demo asset-plan.json odd"]);

  const report = runFalDoctor({ catalogDir, project: { operations, assetPlan, label: "demo" } });
  const find = (id: string) => report.findings.find((finding) => finding.endpoint === id)!;
  assert.equal(find("fal-ai/kling-video/v2.5-turbo/pro/text-to-video").status, "gone");
  assert.deepEqual(find("fal-ai/kling-video/v2.5-turbo/pro/text-to-video").where, [
    "scripts/generate-video.ts",
    "src/lib/models/registry.ts LEGACY_ENDPOINTS kling-2.5-turbo",
  ]);
  assert.deepEqual(find("fal-ai/minimax/hailuo-02/pro/text-to-video"), {
    endpoint: "fal-ai/minimax/hailuo-02/pro/text-to-video",
    where: ["scripts/generate-video.ts", "src/lib/models/registry.ts LEGACY_ENDPOINTS hailuo-02-pro"],
    status: "retiring",
    retiresAt: "2026-12-31",
    replacement: "fal-ai/minimax/hailuo-03/pro/text-to-video",
  });
  assert.equal(find("bytedance/seedance-2.0/fast/text-to-video").status, "deprecated");
  assert.equal(find("bytedance/seedance-2.5/text-to-video").status, "active");
  assert.equal(find("fal-ai/my-retired/model").status, "gone");
  assert.deepEqual(find("fal-ai/my-retired/model").where, ["demo operations.json op-1"]);
  assert.equal(find("fal-ai/kling-video/v3/pro/image-to-video").status, "not-in-catalog");
  assert.equal(
    report.findings.some((finding) => finding.endpoint === "fal-ai/not-fal-provider"),
    false,
  );
  assert.deepEqual(
    report.findings.slice(0, 2).map((finding) => finding.status),
    ["gone", "gone"],
    "problems first",
  );
  assert.equal(report.counts.gone, 2);
  assert.equal(report.catalogEntries, 5);
  assert.deepEqual(report.unresolved, ["demo asset-plan.json odd"]);

  const projectOnly = runFalDoctor({
    catalogDir,
    includeStatic: false,
    project: { operations, assetPlan, label: "demo" },
  });
  assert.equal(projectOnly.findings.length, 3);
  resetCatalogCache();
});
