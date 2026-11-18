import { USER_GRANT, writeBudgetBrief } from "./helpers/ceiling-grant";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeFalNonMedia } from "../src/lib/jobs/nonmedia";
import { validateSafeTensors, trustedArtifactUrl, downloadModelArtifact } from "../src/lib/jobs/model-artifacts";
import {
  deriveSeedanceCompletion,
  falCallerIdentity,
  recordSeedanceDraftIntent,
} from "../src/lib/jobs/seedance-drafts";
import { OperationStore } from "../src/lib/jobs/store";
import { runGenerationStep } from "../src/lib/jobs/runner";
import { buildFalOperation, validateFalOperationResult } from "../src/lib/providers/fal-operations";
const tensors = () => {
  const header = Buffer.from(JSON.stringify({ weight: { dtype: "F32", shape: [1], data_offsets: [0, 4] } }));
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([size, header, Buffer.alloc(4)]);
};
const fixture = async (fn: () => Promise<void>) => {
  const old = process.cwd();
  const root = mkdtempSync(path.join(tmpdir(), "nonmedia-"));
  process.chdir(root);
  mkdirSync("public/projects/demo", { recursive: true });
  writeFileSync("public/projects/demo/project.json", "{}");
  writeBudgetBrief("public/projects/demo");
  try {
    await fn();
  } finally {
    process.chdir(old);
    rmSync(root, { recursive: true, force: true });
  }
};
const voiceEndpoint = "fal-ai/kling-video/create-voice";
const trainingEndpoint = "fal-ai/flux-2-trainer";
const options = {
  projectId: "demo",
  endpoint: voiceEndpoint,
  model: voiceEndpoint,
  input: { video_url: "https://fal.media/input.mp4" },
  output: "voice.json",
  kind: "voice" as const,
  maxCostUsd: 0.5,
  operationId: "voice:1",
  validateResult: (result: Record<string, unknown>) => validateFalOperationResult(voiceEndpoint, result),
};
test("voice ID validated, durably published, and returned on resume without a submit", () =>
  fixture(async () => {
    let submits = 0;
    const provider = {
      submit: async () => ({ requestId: `voice-${++submits}` }),
      inspect: async () => ({ state: "completed" as const, result: { voice_id: "voice_123" } }),
    };
    const result = await executeFalNonMedia({ ...options, provider });
    assert.equal(result.metadata.state, "published");
    assert.equal(result.metadata.voiceId, "voice_123");
    assert.equal(submits, 1);
    const manifest = JSON.parse(readFileSync(result.outputs[0]!, "utf8"));
    assert.equal(manifest.provenance.providerRequestId, "voice-1");
    assert.equal(manifest.voiceId, "voice_123");
    const repeat = await executeFalNonMedia({ ...options, provider });
    assert.deepEqual(repeat.outputs, result.outputs);
    assert.equal(submits, 1);
    assert.equal(new OperationStore("demo").summary().reservedUsd, 0.007);
    writeFileSync(result.outputs[0]!, "tampered");
    await assert.rejects(() => executeFalNonMedia({ ...options, provider }), /changed/);
    assert.equal(submits, 1);
  }));
test("invalid voice result retains paid reservation and yields no outputs", () =>
  fixture(async () => {
    const result = await executeFalNonMedia({
      ...options,
      provider: {
        submit: async () => ({ requestId: "r" }),
        inspect: async () => ({ state: "completed" as const, result: { voice_id: "" } }),
      },
    });
    assert.equal(result.metadata.state, "failed");
    assert.deepEqual(result.outputs, []);
    assert.equal(new OperationStore("demo").summary().reservedUsd, 0.007);
  }));
test("training artifact download failure resumes original job and stores hashes/provenance", () =>
  fixture(async () => {
    let submits = 0;
    let failed = false;
    const binary = tensors();
    const result = {
      diffusers_lora_file: { url: "https://fal.media/lora.safetensors", file_size: binary.length },
      config_file: { url: "https://fal.media/config.json" },
    };
    const provider = {
      submit: async () => ({ requestId: `train-${++submits}` }),
      inspect: async () => ({ state: "completed" as const, result }),
    };
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).endsWith("config.json") && !failed) {
        failed = true;
        return new Response("fail", { status: 503 });
      }
      return String(url).endsWith("config.json")
        ? new Response('{"rank":16}', { headers: { "content-type": "application/json" } })
        : new Response(new Uint8Array(binary), { headers: { "content-type": "application/octet-stream" } });
    }) as typeof fetch;
    const opts = {
      ...options,
      endpoint: trainingEndpoint,
      model: trainingEndpoint,
      kind: "training" as const,
      input: { image_data_url: "https://fal.media/dataset.zip" },
      operationId: "train:1",
      provider,
      fetch: fetcher,
      validateResult: (data: Record<string, unknown>) => validateFalOperationResult(trainingEndpoint, data),
    };
    const first = await executeFalNonMedia(opts);
    assert.equal(first.metadata.state, "failed");
    assert.deepEqual(first.outputs, []);
    const resumed = await executeFalNonMedia(opts);
    assert.equal(resumed.metadata.state, "published");
    assert.equal(submits, 1);
    const manifest = JSON.parse(readFileSync(resumed.outputs[0]!, "utf8"));
    assert.equal(manifest.artifacts.length, 2);
    assert.equal(manifest.provenance.billing, "unreconciled");
    assert.equal(manifest.artifacts[0].bytes, binary.length);
    writeFileSync(manifest.artifacts[0].path, "corrupt");
    await assert.rejects(() => executeFalNonMedia(opts), /artifact.*changed/);
    assert.equal(submits, 1);
  }));
test("unknown training prices refuse unbounded execution and dry run stays offline", () =>
  fixture(async () => {
    let submitted = false;
    const provider = {
      submit: async () => {
        submitted = true;
        throw new Error("must not run");
      },
      inspect: async () => ({ state: "queued" as const }),
    };
    await assert.rejects(
      () =>
        executeFalNonMedia({
          ...options,
          endpoint: trainingEndpoint,
          model: trainingEndpoint,
          kind: "training",
          maxCostUsd: undefined,
          provider,
        }),
      /Unknown price/,
    );
    const result = await executeFalNonMedia({
      ...options,
      endpoint: trainingEndpoint,
      model: trainingEndpoint,
      kind: "training",
      maxCostUsd: undefined,
      dryRun: true,
      provider,
    });
    assert.equal(result.metadata.executable, false);
    assert.equal(submitted, false);
  }));
test("queued and ambiguous voice operations expose no completed ID/output", () =>
  fixture(async () => {
    const queued = await executeFalNonMedia({
      ...options,
      provider: { submit: async () => ({ requestId: "q" }), inspect: async () => ({ state: "queued" as const }) },
    });
    assert.equal(queued.metadata.state, "queued");
    assert.deepEqual(queued.outputs, []);
    assert.equal(queued.metadata.voiceId, undefined);
    const unknown = await executeFalNonMedia({
      ...options,
      operationId: "unknown:1",
      assetId: "unknown",
      provider: {
        submit: async () => {
          throw new Error("lost acknowledgement");
        },
        inspect: async () => {
          throw new Error("no id");
        },
      },
    });
    assert.equal(unknown.metadata.state, "unknown");
    assert.deepEqual(unknown.outputs, []);
  }));
test("safetensors rejects pickle, tensor overlaps, invalid dtypes and trailing bytes", () => {
  validateSafeTensors(tensors());
  assert.throws(() => validateSafeTensors(Buffer.from("pickle executable")));
  assert.throws(() => validateSafeTensors(Buffer.concat([tensors(), Buffer.from([0])])), /payload/);
  const header = Buffer.from(
    JSON.stringify({
      a: { dtype: "F32", shape: [1], data_offsets: [0, 4] },
      b: { dtype: "F32", shape: [1], data_offsets: [0, 4] },
    }),
  );
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(header.length));
  assert.throws(() => validateSafeTensors(Buffer.concat([size, header, Buffer.alloc(4)])), /overlap/);
});
test("artifact downloads reject unsafe URL, HTML content type, wrong config type", async () => {
  for (const url of [
    "http://fal.media/x",
    "https://evil.invalid/x",
    "https://user:pass@fal.media/x",
    "https://localhost/x",
  ])
    assert.throws(() => trustedArtifactUrl(url));
  await assert.rejects(
    () =>
      downloadModelArtifact(
        "https://fal.media/x",
        "config",
        (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof fetch,
      ),
    /content type/,
  );
  await assert.rejects(
    () =>
      downloadModelArtifact(
        "https://fal.media/x",
        "config",
        (async () => new Response("[]", { headers: { "content-type": "application/json" } })) as typeof fetch,
      ),
    /config/,
  );
});
test("draft completion derives original account/timing and uses provider result despite failed preview", () =>
  fixture(async () => {
    const store = new OperationStore("demo");
    store.configure({ ceilingUsd: 10, maxJobUsd: 10 }, USER_GRANT);
    const caller = falCallerIdentity("offline-fixture");
    const plan = buildFalOperation({
      family: "seedance-2.5",
      variant: "default",
      operation: "text-to-video",
      input: { prompt: "test", draft: true },
    });
    recordSeedanceDraftIntent("demo", "draft:1", plan, caller);
    const operation = {
      operationId: "draft:1",
      provider: "fal.ai",
      endpoint: plan.endpoint,
      assetId: "preview",
      quote: {
        lowUsd: 0,
        expectedUsd: 0.5,
        highUsd: 0.5,
        currency: "USD" as const,
        bounded: true as const,
        source: "explicit fixture",
        asOf: new Date().toISOString(),
        confidence: "user-bound" as const,
      },
    };
    await runGenerationStep({
      store,
      operation,
      input: plan.input,
      provider: {
        submit: async () => ({ requestId: "draft-request" }),
        inspect: async () => ({
          state: "completed" as const,
          result: { draft_id: "draft-id", seed: 1, video: { url: "https://fal.media/preview.mp4" } },
        }),
      },
      publish: async () => {
        throw new Error("offline preview download fails");
      },
    });
    const request = {
      family: "seedance-2.5" as const,
      operation: "complete",
      variant: "draft",
      input: { draft_id: "draft-id" },
      context: { callerId: "forged", draft: { id: "wrong", callerId: "wrong", createdAt: "2099-01-01T00:00:00.000Z" } },
    };
    const derived = deriveSeedanceCompletion("demo", request, caller);
    assert.equal(derived.context?.callerId, caller);
    assert.equal(derived.context?.draft?.id, "draft-id");
    assert.equal(buildFalOperation(derived).endpoint, "bytedance/seedance-2.5/draft/complete");
    assert.throws(
      () => deriveSeedanceCompletion("demo", request, falCallerIdentity("other-account")),
      /account mismatch/,
    );
    assert.throws(() => deriveSeedanceCompletion("demo", { ...request, region: "us" }, caller), /region mismatch/);
    assert.throws(() => deriveSeedanceCompletion("demo", request, caller, "2099-01-01T00:00:00.000Z"), /expired/);
    assert.throws(
      () => deriveSeedanceCompletion("demo", { ...request, input: { draft_id: "unknown" } }, caller),
      /verified/,
    );
    assert.throws(
      () => recordSeedanceDraftIntent("demo", "draft:1", plan, falCallerIdentity("other-account")),
      /conflict/,
    );
    assert.equal(store.summary().reservedUsd, 0.5);
    const completion = buildFalOperation(derived);
    await runGenerationStep({
      store,
      operation: { ...operation, operationId: "complete:1", endpoint: completion.endpoint, assetId: "completed-video" },
      input: completion.input,
      provider: {
        submit: async () => ({ requestId: "completion-request" }),
        inspect: async () => ({ state: "queued" as const }),
      },
    });
    assert.equal(store.summary().reservedUsd, 1, "draft and completion each retain a separate paid commitment");
  }));
