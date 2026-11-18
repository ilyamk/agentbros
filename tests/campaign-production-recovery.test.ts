import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { RenderReceiptSchema } from "../src/types/delivery";
import { OperationStore } from "../src/lib/jobs/store";
import { importAsset } from "../src/lib/assets/registry";
import { ProjectConfigSchema } from "../src/types/video";
import { initCampaign, archiveCampaign, reviseCampaign } from "../src/lib/campaigns/production/store";
import { campaignInputIdentity, executeCampaignTask } from "../src/lib/campaigns/production/execute";
import { approveCampaignPackage, reviewPackage } from "../src/lib/campaigns/production/review";
import { runCampaignQueue } from "../src/lib/campaigns/production/queue";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { publishRenderReceipt } from "../src/lib/delivery/render-receipt";
import { jsonFile, productionDirectory, digest, pinFile, immutableJson } from "../src/lib/campaigns/production/files";
import { USER_GRANT } from "./helpers/ceiling-grant";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "campaign-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "public/projects/item");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "project.json"),
    JSON.stringify(
      ProjectConfigSchema.parse({
        name: "Recovery fixture",
        productName: "Synthetic",
        colors: {},
        musicVolume: 0,
        voiceoverEnabled: false,
        formats: ["vertical"],
        scenes: [{ id: "hook", text: "", headline: "", visualType: "title", durationInFrames: 90 }],
      }),
    ),
  );
  const plan = initCampaign(
    {
      version: 1,
      id: "batch",
      revision: 1,
      scenario: "ad-experiments",
      brief: "Explicit recovery fixture; no model or creative acceptance is asserted",
      members: [{ id: "item", projectId: "item", language: "en", adapter: { kind: "existing", projectId: "item" } }],
    },
    root,
  );
  return { root, directory, plan };
}
test(
  "identical video bytes with a refreshed renderer receipt retain separate QA evidence",
  { timeout: 60000 },
  async (t) => {
    const f = fixture(t),
      { pack } = reviewPackage(f.root, f.plan, "creative-plan");
    await approveCampaignPackage(f.root, f.plan, pack, pack.packageHash, "Synthetic contract fixture only", "fixture");
    const clip = path.join(f.root, "fixture.mp4"),
      output = path.join(f.root, "out/item/vertical-clean.mp4");
    mkdirSync(path.dirname(output), { recursive: true });
    const encoded = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=1080x1920:r=30:d=3",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        clip,
      ],
      { encoding: "utf8" },
    );
    assert.equal(encoded.status, 0, encoded.stderr);
    const executor: typeof executeCampaignTask = async (task, context) => {
      if (task.kind === "render") {
        const identity = captureRenderIdentity("item", "vertical", { rootDir: f.root, captions: "off" });
        copyFileSync(clip, output);
        const receipt = publishRenderReceipt(output, identity, identity, f.root);
        return { outputs: [output, receipt], metadata: { explicitFFmpegFixture: true, remotionExecution: false } };
      }
      return executeCampaignTask(task, context);
    };
    const first = await runCampaignQueue(f.root, f.plan, executor, { identity: campaignInputIdentity });
    assert.deepEqual(
      first.tasks.filter((task) => task.state === "failed"),
      [],
    );
    unlinkSync(`${output}.receipt.json`);
    const second = await runCampaignQueue(f.root, f.plan, executor, { identity: campaignInputIdentity });
    assert.deepEqual(
      second.tasks.filter((task) => task.state === "failed"),
      [],
    );
    assert.equal(readdirSync(path.join(f.directory, "pipeline/campaign-qa")).length, 2);
  },
);
test("archival retires historical runtime waits before owner retention ends", async (t) => {
  const f = fixture(t),
    file = path.join(f.root, ".cache/campaign-production/runtime.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      limits: { generation: 1, process: 1, render: 1, qa: 1 },
      records: {
        [`batch.${f.plan.planHash}.material-old`]: {
          state: "waiting",
          pid: process.pid,
          token: "fixture",
          resource: "generation",
          resourceKey: "fal",
          operationId: "never-created",
        },
      },
    }),
  );
  await archiveCampaign(f.root, "batch", "Fixture retention ended after all durable operations were reconciled");
  assert.deepEqual((jsonFile(file) as { records: unknown }).records, {});
  rmSync(path.dirname(path.dirname(productionDirectory(f.root, "batch"))), { recursive: true });
  const plan = initCampaign(
    {
      version: 1,
      id: "other",
      revision: 1,
      scenario: "ad-experiments",
      brief: "Unrelated queue fixture",
      members: [
        {
          id: "next",
          projectId: "next",
          language: "en",
          adapter: {
            kind: "template",
            project: ProjectConfigSchema.parse({
              name: "Fixture",
              productName: "Fixture",
              colors: {},
              scenes: [{ id: "hook", text: "", visualType: "title" }],
            }),
          },
        },
      ],
    },
    f.root,
  );
  const run = await runCampaignQueue(
    f.root,
    plan,
    async (task) => {
      const output = path.join(f.root, `${task.id}.json`);
      writeFileSync(output, "{}");
      return { outputs: [output] };
    },
    { maxTasks: 1 },
  );
  assert.equal(run.attempted, 1);
});

test("a revised campaign reuses its own published material without another submission", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "campaign-material-reuse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "public/projects/item");
  mkdirSync(directory, { recursive: true });
  const project = ProjectConfigSchema.parse({
    name: "Reuse fixture",
    productName: "Fixture",
    colors: {},
    musicVolume: 0,
    scenes: [{ id: "hook", text: "", visualType: "title" }],
  });
  writeFileSync(path.join(directory, "project.json"), JSON.stringify(project));
  const output = path.join(directory, "product.png"),
    requestFile = path.join(root, "request.json");
  assert.equal(
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=48x32", "-frames:v", "1", output]).status,
    0,
  );
  writeFileSync(
    requestFile,
    JSON.stringify({
      provider: "fal",
      endpoint: "fixture/image",
      input: { prompt: "Explicitly fake historical generation" },
    }),
  );
  const source = {
      kind: "generate" as const,
      useCase: "fixture-unavailable-live-model",
      request: pinFile(root, requestFile),
      output: path.relative(root, output),
      reason: "Reuse the exact synthetic historical result",
    },
    operationId = `campaign.batch.product.${digest(source).slice(0, 16)}`;
  const store = new OperationStore("item", { directory: path.join(directory, "pipeline") });
  store.configure({ ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
  store.reserveOperation({
    operationId,
    provider: "fal.ai",
    endpoint: "fixture/image",
    inputHash: "fixture",
    assetId: output,
    quote: {
      currency: "USD",
      lowUsd: 0.1,
      expectedUsd: 0.1,
      highUsd: 0.1,
      bounded: true,
      source: "fixture",
      asOf: "2026-11-16",
      confidence: "published-rate",
    },
  });
  store.transitionJob(operationId, "submitting");
  store.transitionJob(operationId, "queued", { providerRequestId: "synthetic-no-network" });
  store.transitionJob(operationId, "result-ready", {
    result: { published: { outputs: [path.relative(root, output)], hashes: [pinFile(root, output).sha256] } },
  });
  store.transitionJob(operationId, "downloading");
  store.transitionJob(operationId, "validated");
  store.transitionJob(operationId, "published");
  const request = {
    version: 1 as const,
    id: "batch",
    revision: 1,
    scenario: "ad-experiments" as const,
    capUsd: 1,
    brief: "Synthetic historical operation; zero live requests",
    materials: [{ id: "product", owner: "item", source }],
    members: [
      {
        id: "item",
        projectId: "item",
        language: "en",
        quotaUsd: 1,
        materials: ["product"],
        adapter: { kind: "existing" as const, projectId: "item" },
      },
    ],
  };
  const first = initCampaign(request, root);
  await runCampaignQueue(
    root,
    first,
    async (task) => {
      if (task.kind !== "material") return { outputs: [], blocked: true };
      const imported = importAsset({
        projectId: "item",
        rootDir: root,
        sourceFile: output,
        provenance: {
          origin: "provider",
          tool: "generate:model",
          model: "fixture/image",
          generationJobId: operationId,
        },
        nonMedia: true,
      });
      const file = path.join(productionDirectory(root, "batch"), "materials", first.planHash, "product.json");
      immutableJson(file, {
        ownerProjectId: "item",
        assetId: imported.asset.id,
        original: imported.asset.files.original,
        sha256: imported.asset.hash,
        sourceHash: digest(source),
        operationId,
      });
      return {
        outputs: [file, path.join(root, "public", imported.asset.files.original)],
        metadata: { fakeHistoricalProducer: true },
      };
    },
    { maxTasks: 1 },
  );
  const second = reviseCampaign(
      { ...request, revision: 2, brief: "Another creative revision with the same original" },
      root,
    ),
    { pack } = reviewPackage(root, second, "creative-plan");
  await approveCampaignPackage(root, second, pack, pack.packageHash, "Fixture-only reuse plan", "fixture");
  const result = await runCampaignQueue(root, second, executeCampaignTask, {
    maxTasks: 1,
    identity: campaignInputIdentity,
  });
  assert.equal(result.tasks[0].state, "complete");
  assert.equal(store.snapshot().jobs[operationId].paidAttempts, 1, "Only the simulated historical attempt remains");
});

test("an exact full render is adopted into a new task without another renderer process", async (t) => {
  const f = fixture(t),
    { pack } = reviewPackage(f.root, f.plan, "creative-plan");
  await approveCampaignPackage(f.root, f.plan, pack, pack.packageHash, "Synthetic reuse protocol only", "fixture");
  const output = path.join(f.root, "out/item/vertical-clean.mp4");
  mkdirSync(path.dirname(output), { recursive: true });
  assert.equal(
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=1080x1920:r=30:d=3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      output,
    ]).status,
    0,
  );
  const identity = captureRenderIdentity("item", "vertical", { rootDir: f.root, captions: "off" });
  publishRenderReceipt(output, identity, identity, f.root);
  const task = f.plan.tasks.find((task) => task.kind === "render")!;
  const result = await executeCampaignTask(task, {
    root: f.root,
    plan: f.plan,
    inputHash: "0".repeat(64),
    paid: false,
  });
  assert.equal(result.metadata?.reusedExactRender, true);
  assert.deepEqual(result.outputs, [output, `${output}.receipt.json`]);
  const manual = RenderReceiptSchema.parse({
    ...(jsonFile(`${output}.receipt.json`) as object),
    evidence: "human-declared",
    reviewedBy: "fixture",
    note: "Manual declaration only",
  });
  writeFileSync(`${output}.receipt.json`, JSON.stringify(manual));
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (() => {
    throw new Error("Fixture renderer was requested; manual evidence was not reused");
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => executeCampaignTask(task, { root: f.root, plan: f.plan, inputHash: "0".repeat(64), paid: false }),
      /Fixture renderer was requested/,
    );
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});

test("cached scheduling still refuses a dependency changed during a worker", async (t) => {
  const f = fixture(t);
  let renderAttempts = 0;
  const result = await runCampaignQueue(f.root, f.plan, async (task) => {
    const file = path.join(f.root, `${task.id}.txt`);
    writeFileSync(file, task.id);
    if (task.kind === "anchors")
      writeFileSync(path.join(f.root, "prepare-item.txt"), "Changed while the worker was active");
    if (task.kind === "render") renderAttempts++;
    return { outputs: [file] };
  });
  assert.equal(renderAttempts, 0);
  assert.ok(result.tasks.some((task) => task.id === "anchors-item" && task.state === "dependency"));
});
