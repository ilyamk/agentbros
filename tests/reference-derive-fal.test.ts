import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readAssetRegistry } from "../src/lib/assets/registry";
import { OperationStore } from "../src/lib/jobs/store";
import type { JobProvider } from "../src/lib/jobs/runner";
import { findCatalogEntry, resetCatalogCache } from "../src/lib/models/fal-catalog";
import {
  FAL_DEFAULT_ENDPOINTS,
  advanceDerivative,
  falRequest,
  pendingDerivative,
  planDerivative,
  planDerivativeSpend,
  runDerivative,
  showDerivative,
} from "../src/lib/references/derive";
import { DerivativeReceiptSchema, type DerivationStep } from "../src/types/references";
import { writeBudgetBrief } from "./helpers/ceiling-grant";
import { falNetworkAttempts } from "./helpers/fal-no-network";
import { derivativeFixture, hasFfmpeg } from "./helpers/reference-derive";

const media = { skip: hasFfmpeg ? false : "needs ffmpeg and ffprobe" } as const;
const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const SCHEMA = "94936c3ade9dc5010618fe1cd64f0c7dc17e0d3a02ab87587f777d63b8b90c0f"; // fal-ai/deepfilternet3

/** Only deepfilternet3's recorded schema is cached; every other endpoint reports SCHEMA_NOT_CACHED. Offline. */
function schemaCache(t: import("node:test").TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "refs-fal-schemas-"));
  copyFileSync(path.resolve("tests/fixtures/fal-catalog/schemas", `${SCHEMA}.json`), path.join(dir, `${SCHEMA}.json`));
  const previous = process.env.AGENTBROS_FAL_SCHEMA_CACHE;
  process.env.AGENTBROS_FAL_SCHEMA_CACHE = dir;
  resetCatalogCache();
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTBROS_FAL_SCHEMA_CACHE;
    else process.env.AGENTBROS_FAL_SCHEMA_CACHE = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

/** The fixture project with a brief budget, entered as the working directory (the durable store resolves from it). */
async function inProject(t: import("node:test").TestContext) {
  schemaCache(t);
  const f = derivativeFixture(t);
  writeBudgetBrief(f.project);
  const previous = process.cwd();
  process.chdir(f.rootDir);
  t.after(() => process.chdir(previous));
  // An upstream local derivative turns the clip's track into an audio asset; the fal step leads the next one.
  const audio = await runDerivative("demo", f.spec("speech", [{ op: "audio-trim", startSec: 0, durationSec: 2 }]));
  const clean = f.spec(
    "speech-clean",
    [
      { op: "audio-clean", engine: "fal" },
      { op: "loudness", lufs: -16 },
    ],
    {
      derivativeId: "speech",
    },
  );
  return { ...f, audio, clean };
}

function transport(states: Array<"queued" | "running" | "completed">) {
  const calls = { submits: 0, inspects: 0, downloads: [] as string[] };
  const url = "https://v3.fal.media/files/synthetic/clean.wav";
  const result = {
    audio_file: { url, content_type: "audio/wav", file_name: "clean.wav" },
    timings: { preprocess: 0.1, inference: 0.2, postprocess: 0.1 },
  };
  const provider: JobProvider = {
    submit: async () => ({ requestId: `request-${++calls.submits}` }),
    inspect: async () => {
      const state = states[Math.min(calls.inspects++, states.length - 1)]!;
      return state === "completed" ? { state, result } : { state };
    },
  };
  return { provider, calls, url };
}

function wav(file: string) {
  const made = spawnSync("ffmpeg", [
    ...["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=2:sample_rate=48000"],
    ...["-c:a", "pcm_s16le", file],
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  return readFileSync(file);
}

test("every default fal endpoint is catalogued and receives the step's media in its own field", () => {
  const video = {
    kind: "video",
    width: 64,
    height: 64,
    fps: 10,
    frameCount: 30,
    hasAudio: false,
    hasAlpha: false,
  } as const;
  const still = { kind: "image", width: 64, height: 64, hasAudio: false, hasAlpha: false } as const;
  const audio = { kind: "audio", durationSec: 2, hasAudio: true, hasAlpha: false } as const;
  const asset = { hash: "a".repeat(64) } as Parameters<typeof falRequest>[2];
  const ref = `asset://sha256/${"a".repeat(64)}`;
  const cases: Array<[DerivationStep, typeof video | typeof still | typeof audio, string, Record<string, unknown>]> = [
    [
      { op: "depth-video", engine: "fal" },
      video,
      FAL_DEFAULT_ENDPOINTS["depth-video"],
      { video_url: ref, colormap: "grayscale" },
    ],
    [{ op: "pose-video", engine: "fal" }, video, FAL_DEFAULT_ENDPOINTS["pose-video"], { video_url: ref }],
    [
      { op: "mask-video", engine: "fal", prompt: "the red mug" },
      video,
      FAL_DEFAULT_ENDPOINTS["mask-video"].video,
      { video_url: ref, prompt: "the red mug" },
    ],
    [
      { op: "mask-video", engine: "fal", prompt: "the red mug" },
      still,
      FAL_DEFAULT_ENDPOINTS["mask-video"].image,
      { image_url: ref, mask_only: true, prompt: "the red mug" },
    ],
    [
      { op: "audio-clean", engine: "fal" },
      audio,
      FAL_DEFAULT_ENDPOINTS["audio-clean"],
      { audio_url: ref, audio_format: "wav" },
    ],
  ];
  for (const [step, state, endpoint, input] of cases) {
    assert.ok(findCatalogEntry(endpoint), `${endpoint} is catalogued`);
    const request = falRequest(step as Parameters<typeof falRequest>[0], state, asset);
    assert.equal(request.endpoint, endpoint);
    assert.deepEqual(request.input, input);
  }
  // An explicit endpoint overrides the default but must be catalogued and return the step's media.
  assert.equal(
    falRequest({ op: "depth-video", engine: "fal", endpoint: "fal-ai/dwpose/video" }, video, asset).endpoint,
    "fal-ai/dwpose/video",
  );
  assert.throws(
    () => falRequest({ op: "depth-video", engine: "fal", endpoint: "fal-ai/not-a-model" }, video, asset),
    /not in the tracked fal catalogue/,
  );
  assert.throws(
    () => falRequest({ op: "depth-video", engine: "fal", endpoint: "fal-ai/deepfilternet3" }, video, asset),
    /returns audio, not video/,
  );
});

test("fal steps lead the chain, take their media kind and need a prompt for a mask", media, (t) => {
  const f = derivativeFixture(t);
  const steps: Array<[DerivationStep[], RegExp]> = [
    [
      [
        { op: "trim", startSec: 0, durationSec: 1 },
        { op: "depth-video", engine: "fal" },
      ],
      /Step 2 \(depth-video\).*first step/,
    ],
    [[{ op: "audio-clean", engine: "fal" }], /Step 1 \(audio-clean\): takes audio, not video/],
    [[{ op: "mask-video", engine: "fal" }], /needs a prompt/],
  ];
  for (const [chain, message] of steps)
    assert.throws(() => planDerivative("demo", f.spec("bad", chain), f.rootDir), message);
});

test("plan builds the generation request and reports an unknown price; writes nothing", media, async (t) => {
  const f = await inProject(t);
  const plan = await planDerivativeSpend("demo", f.clean);
  assert.equal(plan.spend, "may-spend");
  assert.deepEqual(
    plan.steps.map((step) => [step.op, step.engine, step.status]),
    [
      ["audio-clean", "fal", "paid"],
      ["loudness", "ffmpeg", "ready"],
    ],
  );
  assert.ok(plan.fal);
  assert.equal(plan.fal.endpoint, "fal-ai/deepfilternet3");
  assert.deepEqual(plan.fal.request, {
    endpoint: "fal-ai/deepfilternet3",
    input: { audio_url: `asset://sha256/${f.audio.receipt.output.sha256}`, audio_format: "wav" },
  });
  assert.equal(plan.fal.operationId, "refs-derive.speech-clean.step-01");
  assert.equal(plan.fal.schema, "cached");
  assert.equal(plan.fal.pricing, "unknown");
  assert.equal(plan.fal.executable, false);
  assert.equal(plan.fal.job, null);
  assert.match(plan.fal.nextAction ?? "", /--max-cost-usd/);
  assert.match(
    plan.fal.generateModel,
    /generate:model --request \S+\/request\.json .*--operation-id refs-derive\.speech-clean\.step-01 --asset-id refs-derive:refs-derive\.speech-clean\.step-01 --stage references --dry-run$/,
  );
  // A bound makes it admissible on paper; still nothing is written or reserved.
  const bounded = await planDerivativeSpend("demo", f.clean, process.cwd(), { maxCostUsd: 0.05 });
  assert.equal(bounded.fal?.executable, true);
  assert.ok(!existsSync(path.join(f.project, "pipeline/reference-derivatives/speech-clean")));
  assert.ok(!existsSync(path.join(f.project, "pipeline/operations.json")));
  // An endpoint whose schema is not cached plans with the sync command instead of failing.
  const depth = await planDerivativeSpend("demo", f.spec("depth", [{ op: "depth-video", engine: "fal" }]));
  assert.equal(depth.fal?.schema, "not-cached");
  assert.equal(depth.fal?.nextAction, "pnpm fal:sync --schemas fal-ai/depth-anything-video");
  assert.deepEqual(falNetworkAttempts, []);
});

test(
  "run refuses without --confirm-spend and without a bound for an unknown price, before any write",
  media,
  async (t) => {
    const f = await inProject(t);
    const { provider, calls } = transport(["completed"]);
    await assert.rejects(
      advanceDerivative("demo", f.clean, process.cwd(), { provider, maxCostUsd: 0.05 }),
      /--confirm-spend/,
    );
    await assert.rejects(
      advanceDerivative("demo", f.clean, process.cwd(), { provider, confirmSpend: true }),
      /unknown prices are not free.*--max-cost-usd/,
    );
    assert.equal(calls.submits, 0);
    assert.ok(!existsSync(path.join(f.project, "pipeline/reference-derivatives/speech-clean")));
    assert.ok(!existsSync(path.join(f.project, "pipeline/operations.json")));
  },
);

test(
  "queued fal job: pending.json, no receipt, no import; the same command resumes and seals the receipt",
  media,
  async (t) => {
    const f = await inProject(t);
    const directory = path.join(f.project, "pipeline/reference-derivatives/speech-clean");
    const before = readAssetRegistry("demo").assets.length;
    const options = { confirmSpend: true, maxCostUsd: 0.05 };
    const queued = transport(["queued"]);
    const first = await advanceDerivative("demo", f.clean, process.cwd(), { ...options, provider: queued.provider });
    assert.equal(first.status, "pending");
    assert.equal(first.status === "pending" && first.operationId, "refs-derive.speech-clean.step-01");
    assert.equal(queued.calls.submits, 1);
    const pending = JSON.parse(readFileSync(path.join(directory, "pending.json"), "utf8"));
    assert.equal(pending.operationId, "refs-derive.speech-clean.step-01");
    assert.equal(pending.endpoint, "fal-ai/deepfilternet3");
    assert.match(pending.requestSha256, /^[a-f0-9]{64}$/);
    assert.ok(existsSync(path.join(directory, "spec.json")));
    assert.ok(existsSync(path.join(directory, "request.json")));
    assert.ok(!existsSync(path.join(directory, "receipt.json")));
    assert.equal(readAssetRegistry("demo").assets.length, before, "nothing is imported while the job is pending");
    assert.equal((await planDerivativeSpend("demo", f.clean)).existing, "pending");
    assert.equal(pendingDerivative("demo", "speech-clean")?.pending.operationId, pending.operationId);
    assert.equal((await planDerivativeSpend("demo", f.clean)).fal?.job, "queued");
    assert.throws(() => showDerivative("demo", "speech-clean"), /no receipt/);
    await assert.rejects(
      runDerivative("demo", f.clean, process.cwd(), { ...options, provider: queued.provider }),
      /waits for fal operation/,
    );
    // AC9: the stored request plans through the generate:model CLI against the same durable job, offline.
    const plan = (await planDerivativeSpend("demo", f.clean)).fal!;
    const args = plan.generateModel.replace(/^pnpm generate:model /, "").split(" ");
    const cli = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/generate-model.ts"), ...args], {
      cwd: f.rootDir,
      encoding: "utf8",
      env: { ...process.env, FAL_KEY: "" },
    });
    const line = JSON.parse(cli.stdout.trim().split("\n").at(-1)!);
    assert.equal(line.ok, true, cli.stdout + cli.stderr);
    assert.equal(line.metadata.dryRun, true);
    assert.equal(line.metadata.operationId, "refs-derive.speech-clean.step-01");
    assert.equal(queued.calls.submits, 1);
    // A changed spec under the same id stays immutable while pending.
    await assert.rejects(
      advanceDerivative("demo", { ...f.clean, purpose: "changed" }, process.cwd(), options),
      /different spec/,
    );

    const done = transport(["completed"]);
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
      done.calls.downloads.push(String(input));
      return String(input) === done.url
        ? new Response(new Uint8Array(wav(path.join(f.rootDir, "clean.wav"))))
        : new Response("missing", { status: 404 });
    }) as typeof fetch;
    const ready = await advanceDerivative("demo", f.clean, process.cwd(), {
      ...options,
      provider: done.provider,
      fetch: fetcher,
    });
    assert.equal(ready.status, "ready");
    if (ready.status !== "ready") return;
    assert.equal(done.calls.submits, 0, "the resume polls the original request, never resubmits");
    assert.equal(queued.calls.submits, 1);
    assert.deepEqual(done.calls.downloads, [done.url]);
    const receipt = DerivativeReceiptSchema.parse(
      JSON.parse(readFileSync(path.join(directory, "receipt.json"), "utf8")),
    );
    assert.deepEqual(receipt.engine, {
      kind: "fal",
      version: "fal-ai/deepfilternet3",
      operationId: "refs-derive.speech-clean.step-01",
    });
    assert.equal(receipt.costUsd, null);
    assert.ok(
      receipt.warnings.some((warning) => /pnpm budget --project demo --operation-id refs-derive/.test(warning)),
    );
    assert.equal(receipt.output.contentType, "audio/wav");
    assert.ok(!existsSync(path.join(directory, "pending.json")));
    const assets = readAssetRegistry("demo").assets;
    const provider = assets.find((asset) => asset.provenance.origin === "provider");
    assert.equal(provider?.provenance.generationJobId, "refs-derive.speech-clean.step-01");
    const derived = assets.find((asset) => asset.id === receipt.output.assetId)!;
    assert.equal(derived.provenance.origin, "derivative");
    assert.equal(derived.provenance.derivative?.id, "speech-clean");
    assert.equal(derived.provenance.generationJobId, "refs-derive.speech-clean.step-01");
    assert.deepEqual(derived.provenance.referenceAssetIds, [f.audio.receipt.output.assetId, provider!.id]);
    const job = new OperationStore("demo").snapshot().jobs["refs-derive.speech-clean.step-01"]!;
    assert.equal(job.state, "published");
    assert.equal(job.endpoint, "fal-ai/deepfilternet3");
    // Re-running returns the stored receipt without touching the provider.
    const again = await advanceDerivative("demo", f.clean, process.cwd(), { ...options, provider: done.provider });
    assert.equal(again.status === "ready" && again.reused, true);
    assert.equal(done.calls.submits, 0);
    assert.deepEqual(falNetworkAttempts, []);
  },
);

test("a fal step alone still yields a derivative asset distinct from the provider original", media, async (t) => {
  const f = await inProject(t);
  const only = f.spec("speech-clean-only", [{ op: "audio-clean", engine: "fal" }], { derivativeId: "speech" });
  const options = { confirmSpend: true, maxCostUsd: 0.05 };
  const done = transport(["completed"]);
  const fetcher = (async (input: Parameters<typeof fetch>[0]) =>
    String(input) === done.url
      ? new Response(new Uint8Array(wav(path.join(f.rootDir, "only.wav"))))
      : new Response("missing", { status: 404 })) as typeof fetch;
  const ready = await advanceDerivative("demo", only, process.cwd(), {
    ...options,
    provider: done.provider,
    fetch: fetcher,
  });
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  const assets = readAssetRegistry("demo").assets;
  const provider = assets.find(
    (asset) =>
      asset.provenance.generationJobId === "refs-derive.speech-clean-only.step-01" &&
      asset.provenance.origin === "provider",
  )!;
  assert.ok(provider);
  assert.notEqual(ready.asset.id, provider.id);
  assert.equal(ready.asset.provenance.origin, "derivative");
  assert.equal(ready.asset.provenance.derivative?.id, "speech-clean-only");
  assert.ok(!ready.receipt.warnings.some((warning) => /Identical output bytes/.test(warning)));
  assert.equal(ready.receipt.engine.operationId, "refs-derive.speech-clean-only.step-01");
});
