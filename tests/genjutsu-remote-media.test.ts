import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { acquireRemoteMedia } from "../src/lib/assets/remote-media";
import { prepareModel } from "../src/lib/model-preparation/prepare";
import { preparationAdmission, validatePreparation } from "../src/lib/model-preparation/approval";
import { resolveImportedReferences } from "../src/lib/assets/provider-references";
import { executeFalOperation } from "../src/lib/jobs/execution";
import { executeFalNonMedia } from "../src/lib/jobs/nonmedia";
import { OperationStore } from "../src/lib/jobs/store";
import { genjutsuFixture, approveFixture } from "./helpers/genjutsu-preparation";
import { remoteIo } from "./helpers/remote-media";

test("three Genjutsu modes bind reviewed remote originals without transcoding or video upload", async (t) => {
  const f = genjutsuFixture(t),
    silent = path.join(f.rootDir, "silent.mp4");
  assert.equal(spawnSync("ffmpeg", ["-v", "error", "-i", f.video, "-an", "-c:v", "copy", silent]).status, 0);
  const url = "https://cdn.example.com/original.mp4",
    io = remoteIo(readFileSync(silent));
  const data = await acquireRemoteMedia(
    { projectId: "demo", rootDir: f.rootDir, id: "remote-one", url, kind: "video" },
    io,
  );
  for (const mode of ["object-swap", "motion-transfer", "restyle"] as const) {
    const spec = {
      ...f.spec(mode),
      sourceAssetId: data.asset.id,
      remoteSource: data.binding,
      segment: { startSec: 0, durationSec: data.asset.media.durationSec! },
    };
    const prepared = prepareModel("demo", spec, f.rootDir);
    assert.equal(prepared.request.input.video_url, url);
    assert.equal(prepared.receipt.preparedSource.sha256, data.asset.hash);
    assert.match(prepared.request.input.prompt, /@Video1/);
    const resolved = resolveImportedReferences(prepared.request, "demo", f.rootDir).request;
    approveFixture(prepared, f.rootDir);
    assert.equal(
      preparationAdmission(
        "demo",
        { id: spec.id, sha256: prepared.sha256 },
        prepared.request.endpoint,
        resolved.input,
        f.rootDir,
      ).ready,
      true,
    );
    assert.equal(
      validatePreparation("demo", { id: spec.id, sha256: prepared.sha256 }, f.rootDir).plan.input.video_url,
      url,
    );
    for (const bad of [
      { segment: { startSec: 1, durationSec: 4 } },
      { segment: { startSec: 0, durationSec: 4, crop: { x: 0, y: 0, width: 960, height: 540 } } },
    ])
      assert.throws(
        () => prepareModel("demo", { ...spec, ...bad, id: `bad-${mode}` }, f.rootDir),
        /entire verified original/,
      );
  }
});

test("remote source cannot silently strip audio and stale receipt fails before a paid reservation", async (t) => {
  const f = genjutsuFixture(t),
    url = "https://cdn.example.com/original.mp4";
  const data = await acquireRemoteMedia(
    { projectId: "demo", rootDir: f.rootDir, id: "remote-one", url },
    remoteIo(readFileSync(f.video)),
  );
  const spec = {
    ...f.spec(),
    remoteSource: data.binding,
    sourceAssetId: data.asset.id,
    segment: { startSec: 0, durationSec: data.asset.media.durationSec! },
  };
  assert.throws(() => prepareModel("demo", spec, f.rootDir), /audio changes/);
  const prepared = prepareModel("demo", { ...spec, audioPolicy: "preserve-source" }, f.rootDir);
  assert.equal(prepared.request.input.video_url, url);
  const previous = process.cwd();
  process.chdir(f.rootDir);
  t.after(() => process.chdir(previous));
  let submits = 0;
  const options = {
    projectId: "demo",
    providerId: "higgsfield" as const,
    endpoint: "example/video/edit",
    model: "example/video/edit",
    input: { video_url: url },
    mediaKind: "video" as const,
    output: path.join(f.project, "result.mp4"),
    maxCostUsd: 1,
    remoteMedia: [data.binding],
    remoteMediaIo: remoteIo("changed"),
    provider: {
      idempotentSubmit: true,
      submit: async () => {
        submits++;
        return { requestId: "job-1" };
      },
      inspect: async () => ({ state: "queued" as const }),
    },
  };
  await assert.rejects(executeFalOperation(options), /bytes changed/);
  assert.equal(submits, 0);
  assert.equal(existsSync(new OperationStore("demo").file), false);
});

test("queued remote jobs preserve bindings and lineage on resume without rereading an expired URL", async (t) => {
  const f = genjutsuFixture(t),
    url = "https://cdn.example.com/original.mp4";
  const data = await acquireRemoteMedia(
    { projectId: "demo", rootDir: f.rootDir, id: "remote-one", url },
    remoteIo(readFileSync(f.video)),
  );
  const previous = process.cwd();
  process.chdir(f.rootDir);
  t.after(() => process.chdir(previous));
  let submits = 0,
    sourceChecks = 0;
  const options = {
    projectId: "demo",
    providerId: "higgsfield" as const,
    endpoint: "example/video/edit",
    model: "example/video/edit",
    input: { video_url: url },
    mediaKind: "video" as const,
    output: path.join(f.project, "result.mp4"),
    maxCostUsd: 1,
    remoteMedia: [data.binding],
    remoteMediaIo: remoteIo(readFileSync(f.video)),
    provider: {
      idempotentSubmit: true,
      submit: async () => {
        submits++;
        return { requestId: "job-1" };
      },
      inspect: async () => ({ state: "queued" as const }),
    },
  };
  const first = await executeFalOperation(options);
  const job = new OperationStore("demo").snapshot().jobs[String(first.metadata.operationId)]!;
  assert.deepEqual(job.publication?.remoteMedia, [data.binding]);
  assert.deepEqual(job.publication?.referenceAssetIds, [data.asset.id]);
  const resumed = await executeFalOperation({
    ...options,
    operationId: String(first.metadata.operationId),
    providerId: undefined,
    remoteMedia: undefined,
    remoteMediaIo: {
      request: async () => {
        sourceChecks++;
        throw Error("URL expired");
      },
    },
  });
  assert.equal(resumed.metadata.state, "queued");
  assert.equal(submits, 1);
  assert.equal(sourceChecks, 0);
  await assert.rejects(
    executeFalOperation({ ...options, remoteMedia: [{ ...data.binding, sha256: "0".repeat(64) }] }),
    /identity changed/,
  );
});

test("Soul ID keeps nested checked image URLs and durable remote lineage through its training transport", async (t) => {
  const f = genjutsuFixture(t),
    url = "https://cdn.example.com/character.png",
    io = remoteIo(readFileSync(f.image), "image/png");
  const data = await acquireRemoteMedia(
    { projectId: "demo", rootDir: f.rootDir, id: "remote-image", url, kind: "image" },
    io,
  );
  const input = { name: "Hero", input_images: [{ type: "image_url", image_url: url }] };
  const previous = process.cwd();
  process.chdir(f.rootDir);
  t.after(() => process.chdir(previous));
  let submits = 0;
  const options = {
    projectId: "demo",
    providerId: "higgsfield" as const,
    endpoint: "v1/custom-references",
    model: "v1/custom-references",
    input,
    kind: "training" as const,
    output: path.join(f.project, "training.json"),
    maxCostUsd: 1,
    quoteInput: { provider: "higgsfield" as const, providerInput: input },
    remoteMedia: [data.binding],
    remoteMediaIo: io,
    provider: {
      idempotentSubmit: false,
      submit: async (_endpoint: string, body: Record<string, unknown>) => {
        submits++;
        assert.deepEqual(body, input);
        return { requestId: "character-1" };
      },
      inspect: async () => ({ state: "queued" as const }),
    },
  };
  const first = await executeFalNonMedia(options);
  const job = new OperationStore("demo").snapshot().jobs[String(first.metadata.operationId)];
  assert.deepEqual(job.publication?.remoteMedia, [data.binding]);
  assert.deepEqual(job.publication?.referenceAssetIds, [data.asset.id]);
  const resumed = await executeFalNonMedia({
    ...options,
    remoteMedia: undefined,
    remoteMediaIo: {
      request: async () => {
        throw Error("Already submitted");
      },
    },
  });
  assert.equal(resumed.metadata.state, "queued");
  assert.equal(submits, 1);
  const ambiguousOptions = {
    ...options,
    output: path.join(f.project, "ambiguous-training.json"),
    provider: {
      ...options.provider,
      submit: async () => {
        throw Error("Lost training submit response");
      },
    },
  };
  const ambiguous = await executeFalNonMedia(ambiguousOptions);
  assert.equal(ambiguous.metadata.state, "unknown");
  const recovered = await executeFalNonMedia({
    ...ambiguousOptions,
    remoteMedia: undefined,
    remoteMediaIo: {
      request: async () => {
        throw Error("Ambiguous non-idempotent submission cannot be retried");
      },
    },
  });
  assert.equal(recovered.metadata.state, "unknown");
});
