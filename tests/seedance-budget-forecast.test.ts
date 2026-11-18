import { USER_GRANT } from "./helpers/ceiling-grant";
import fixtures from "./fixtures/provider-contracts/fal-valid.json";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FalOperationRequestSchema, type FalOperationRequest } from "../src/types/generation";
import { buildFalOperation } from "../src/lib/providers/fal-operations";
import { resolveImportedReferences } from "../src/lib/assets/provider-references";
import { generationInputHash, type JobProvider } from "../src/lib/jobs/runner";
import { prepareSeedanceForecast, forecastReferenceHash } from "../src/lib/jobs/seedance-forecast";
import { executeFalOperation, type ExecutionOptions } from "../src/lib/jobs/execution";
import { OperationStore } from "../src/lib/jobs/store";
import { quote } from "../src/lib/pricing";
import { importAsset } from "../src/lib/assets/registry";
import { prepareModernAssetDispatch } from "../src/lib/providers/modern-asset";
import { AssetSpecSchema } from "../src/types/pipeline";

const previous = process.cwd(),
  cli = path.resolve("node_modules/tsx/dist/cli.mjs"),
  script = path.resolve("scripts/generate-model.ts");
const root = mkdtempSync(path.join(tmpdir(), "seedance-forecast-"));
process.chdir(root);
test.after(() => {
  process.chdir(previous);
  rmSync(root, { recursive: true, force: true });
});
const networkMarker = path.join(root, "network-attempt"),
  guard = path.join(root, "deny.cjs");
writeFileSync(
  guard,
  `const deny=()=>{require('node:fs').writeFileSync(${JSON.stringify(networkMarker)},'attempt');throw Error('Network forbidden');};globalThis.fetch=deny;for(const id of ['node:http','node:https']){const m=require(id);m.get=deny;m.request=deny;}require('node:net').Socket.prototype.connect=deny;`,
);
let id = 0;
function request(region: "global" | "us" = "global", reference = false): FalOperationRequest {
  const url = "https://example.test/original.mp4";
  return {
    family: "seedance-2.5",
    region,
    operation: reference ? "reference-to-video" : "text-to-video",
    input: {
      prompt: "Local forecast",
      duration: "10",
      resolution: "720p",
      ...(reference ? { video_urls: [url] } : {}),
    },
    context: { media: reference ? { [url]: { durationSec: 8 } } : {} },
  };
}
function forecast(value: FalOperationRequest, projectId?: string): FalOperationRequest {
  const original = FalOperationRequestSchema.parse(value),
    resolved = resolveImportedReferences(original, projectId).request,
    plan = buildFalOperation(resolved);
  const refs = Array.isArray(original.input.video_urls) ? original.input.video_urls : [];
  original.context = {
    ...original.context,
    allowTranslatedSpeech: original.context?.allowTranslatedSpeech ?? false,
    media: original.context?.media ?? {},
    videoForecast: {
      version: 1,
      endpoint: plan.endpoint,
      schemaSha256: plan.schemaSha256,
      inputSha256: generationInputHash(plan.input),
      output: {
        kind: "planning-assumption",
        source: "Supplied planned output dimensions; not inferred",
        width: 1280,
        height: 720,
        durationSec: Number.isFinite(Number(plan.input.duration)) ? Number(plan.input.duration) : 10,
        resolution: plan.input.resolution as "720p",
      },
      videoReferences: refs.map((url, index) => ({
        referenceSha256: forecastReferenceHash(String(url)),
        source: "Original media duration evidence",
        durationSec: resolved.context!.media[String((plan.input.video_urls as string[])[index])].durationSec!,
      })),
    },
  };
  return original;
}
function prepare(value: FalOperationRequest, projectId?: string) {
  const resolved = resolveImportedReferences(value, projectId).request,
    plan = buildFalOperation(resolved);
  return { resolved, plan, prepared: prepareSeedanceForecast(value, resolved, plan) };
}
function run(value: FalOperationRequest, bound?: number, projectId?: string) {
  const file = path.join(root, `request-${++id}.json`);
  writeFileSync(file, JSON.stringify(value));
  const args = [
    "--require",
    guard,
    cli,
    script,
    "--request",
    file,
    "--output",
    path.join(root, `output-${id}.mp4`),
    "--dry-run",
  ];
  if (bound !== undefined) args.push("--max-cost-usd", String(bound));
  if (projectId) args.push("--project", projectId);
  const child = spawnSync(process.execPath, args, {
    cwd: root,
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(child.error, undefined);
  assert.equal(existsSync(networkMarker), false);
  assert.equal(child.stdout.trim().split("\n").length, 1, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(child.status, result.ok ? 0 : 1, child.stderr);
  return result;
}
function project(name: string) {
  const directory = path.resolve("public/projects", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "project.json"), "{}");
  return directory;
}

test("actual CLI global/US fixed forecasts and complete video references use exact arithmetic/evidence", () => {
  for (const [region, reference, expected] of [
    ["global", false, 4.6224],
    ["us", false, 5.5469],
    ["global", true, 4.9922],
    ["us", true, 5.9907],
  ] as const) {
    const value = forecast(request(region, reference)),
      result = run(value);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.quote.expectedUsd, expected);
    assert.equal(result.metadata.quote.providerEnforced, false);
    assert.equal(result.metadata.quote.forecastEvidence.forecast.output.kind, "planning-assumption");
    assert.equal(result.metadata.quote.forecastEvidence.sha256, prepare(value).prepared.evidence!.sha256);
    assert.equal(run(value, result.metadata.quote.highUsd).ok, true);
    const below = run(value, expected / 2);
    assert.equal(below.ok, false);
    assert.equal(below.error, "VALIDATION");
  }
});
test("CLI rejects stale endpoint/schema/input, inconsistent output/source and missing/changed reference evidence", () => {
  const value = forecast(request("us", true));
  const mutations: Array<(r: FalOperationRequest) => void> = [
    (r) => {
      r.context!.videoForecast!.endpoint = "bytedance/seedance-2.5/reference-to-video";
    },
    (r) => {
      r.context!.videoForecast!.schemaSha256 = "0".repeat(64);
    },
    (r) => {
      r.context!.videoForecast!.inputSha256 = "0".repeat(64);
    },
    (r) => {
      r.context!.videoForecast!.output.durationSec = 9;
    },
    (r) => {
      r.context!.videoForecast!.output.resolution = "480p";
    },
    (r) => {
      r.context!.videoForecast!.output.width = 0;
    },
    (r) => {
      r.context!.videoForecast!.output.width = 16385;
    },
    (r) => {
      r.context!.videoForecast!.output.height = 1.5;
    },
    (r) => {
      r.context!.videoForecast!.output.width = Infinity;
    },
    (r) => {
      r.context!.videoForecast!.output.source = "";
    },
    (r) => {
      r.context!.videoForecast!.videoReferences = [];
    },
    (r) => {
      r.context!.videoForecast!.videoReferences[0].referenceSha256 = "0".repeat(64);
    },
    (r) => {
      r.context!.videoForecast!.videoReferences[0].durationSec = 9;
    },
    (r) => {
      r.context!.media = {};
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(value);
    mutate(changed);
    const result = run(changed);
    assert.equal(result.ok, false);
    assert.equal(result.error, "VALIDATION");
  }
});
test("no forecast, auto/default duration, editing/draft/completion and unknown tariff remain unknown/manual-bound", () => {
  const auto = request();
  auto.input.duration = "auto";
  const missing = request();
  delete missing.input.duration;
  const editing = request("us", true);
  editing.input.task = "editing";
  const draft = request();
  draft.input.draft = true;
  const unpriced = request();
  unpriced.input.resolution = "1080p";
  for (const value of [
    request(),
    forecast(auto),
    forecast(missing),
    forecast(editing),
    forecast(draft),
    forecast(unpriced),
  ]) {
    const result = run(value);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.quote, null);
    assert.equal(result.metadata.executable, false);
    const manual = run(value, 7);
    assert.equal(manual.ok, true);
    assert.equal(manual.metadata.quote.confidence, "user-bound");
  }
  const complete = FalOperationRequestSchema.parse(
    fixtures.find((row) => row.endpoint === "bytedance/seedance-2.5/draft/complete")!.request,
  );
  complete.input.resolution = "1080p";
  const supplied = forecast(complete);
  assert.equal(prepare(supplied).prepared.quoteInput, undefined);
});
test("actual imported original reference resolves exact provider hash and dispatcher preserves full context", () => {
  const directory = project("imported"),
    source = path.join(directory, "original.mp4");
  const made = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x320:r=24:d=2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-threads",
      "1",
      source,
    ],
    { timeout: 10000 },
  );
  assert.equal(made.status, 0);
  const imported = importAsset({ projectId: "imported", sourceFile: source, provenance: { origin: "manual" } });
  const value = request("us", true);
  value.input.video_urls = [`asset://${imported.asset.id.replace(":", "/")}`];
  value.context = { media: {} };
  const discovery = run(value, undefined, "imported");
  assert.equal(discovery.ok, true);
  const pinned = forecast(value, "imported"),
    { plan, prepared } = prepare(pinned, "imported");
  assert.equal(discovery.metadata.inputHash, generationInputHash(plan.input));
  assert.equal(discovery.metadata.plan.endpoint, plan.endpoint);
  assert.equal(discovery.metadata.plan.schemaSha256, plan.schemaSha256);
  pinned.context!.videoForecast!.inputSha256 = discovery.metadata.inputHash;
  pinned.context!.videoForecast!.endpoint = discovery.metadata.plan.endpoint;
  pinned.context!.videoForecast!.schemaSha256 = discovery.metadata.plan.schemaSha256;
  assert.equal(prepared.quoteInput!.inputVideoDurationSec, imported.asset.media.durationSec);
  assert.notEqual(generationInputHash(pinned.input), generationInputHash(plan.input));
  const result = run(pinned, undefined, "imported");
  assert.equal(result.ok, true);
  assert.equal(result.metadata.quote.expectedUsd, 3.9938);
  const asset = AssetSpecSchema.parse({
    id: "forecasted",
    source: "fal-model",
    kind: "ai-video",
    status: "pending",
    targetPath: "assets/output.mp4",
    metadata: { operationRequest: pinned },
  });
  const args = prepareModernAssetDispatch(asset, "imported", path.join(directory, asset.targetPath));
  const saved = JSON.parse(readFileSync(args[args.indexOf("--request") + 1], "utf8"));
  assert.deepEqual(saved.context.videoForecast, pinned.context!.videoForecast);
  const stale = structuredClone(pinned);
  stale.context!.videoForecast!.inputSha256 = generationInputHash(stale.input);
  const staleCli = run(stale, undefined, "imported");
  assert.equal(staleCli.ok, false);
  assert.equal(staleCli.error, "VALIDATION");
  assert.throws(
    () =>
      prepareModernAssetDispatch(
        { ...asset, metadata: { operationRequest: stale } },
        "imported",
        path.join(directory, asset.targetPath),
      ),
    /pin mismatch/,
  );
  writeFileSync(path.join(root, "public", imported.asset.files.original), "corrupt");
  assert.throws(() => prepare(pinned, "imported"), /checksum/);
});
test("immutable forecast quote survives absent-forecast resume and refuses changed evidence before provider", async () => {
  const directory = project("resumed"),
    value = forecast(request()),
    { plan, prepared } = prepare(value);
  const store = new OperationStore("resumed");
  store.configure({ ceilingUsd: 20, maxJobUsd: 15, repairReserveFraction: 0 }, USER_GRANT);
  let submits = 0,
    inspects = 0;
  const provider: JobProvider = {
    submit: async () => {
      submits++;
      return { requestId: "original" };
    },
    inspect: async () => {
      inspects++;
      return { state: "running" };
    },
  };
  const options: ExecutionOptions = {
    projectId: "resumed",
    operationId: "forecasted",
    model: plan.endpoint,
    endpoint: plan.endpoint,
    input: plan.input,
    output: path.join(directory, "out.mp4"),
    mediaKind: "video",
    provider,
    quoteInput: prepared.quoteInput,
    forecastEvidence: prepared.evidence,
    maxCostUsd: 7,
  };
  await executeFalOperation(options);
  const frozen = store.snapshot().jobs.forecasted;
  await executeFalOperation({ ...options, forecastEvidence: undefined, quoteInput: undefined });
  assert.deepEqual(store.snapshot().jobs.forecasted.quote, frozen.quote);
  assert.equal(store.summary().reservedUsd, frozen.reservedMicros / 1e6);
  const changed = structuredClone(value);
  changed.context!.videoForecast!.output.width = 640;
  const changedPrepared = prepare(changed).prepared;
  await assert.rejects(
    executeFalOperation({
      ...options,
      forecastEvidence: changedPrepared.evidence,
      quoteInput: changedPrepared.quoteInput,
    }),
    /Forecast digest differs/,
  );
  const corrupt = structuredClone(prepared.evidence!);
  corrupt.sha256 = "0".repeat(64);
  await assert.rejects(executeFalOperation({ ...options, forecastEvidence: corrupt }), /digest mismatch/);
  await assert.rejects(executeFalOperation({ ...options, input: { prompt: "changed" } }), /different inputs/);
  await assert.rejects(
    executeFalOperation({ ...options, quoteInput: { ...options.quoteInput, width: 640 } }),
    /Quote quantities differ/,
  );
  assert.deepEqual({ submits, inspects }, { submits: 1, inspects: 2 });
});
test("old manual quotes load and resume without forecast; optional new evidence cannot retrofit commitment", async () => {
  const directory = project("legacy"),
    value = forecast(request()),
    { plan, prepared } = prepare(value);
  const store = new OperationStore("legacy");
  store.configure({ ceilingUsd: 20, maxJobUsd: 15, repairReserveFraction: 0 }, USER_GRANT);
  let submissions = 0;
  const provider: JobProvider = {
    submit: async () => {
      submissions++;
      return { requestId: "old" };
    },
    inspect: async () => ({ state: "running" }),
  };
  const options: ExecutionOptions = {
    projectId: "legacy",
    operationId: "old",
    model: plan.endpoint,
    endpoint: plan.endpoint,
    input: plan.input,
    output: path.join(directory, "out.mp4"),
    mediaKind: "video",
    provider,
    maxCostUsd: 7,
  };
  await executeFalOperation(options);
  const stored = store.snapshot().jobs.old;
  assert.equal(stored.quote.forecastEvidence, undefined);
  await executeFalOperation(options);
  await assert.rejects(
    executeFalOperation({ ...options, forecastEvidence: prepared.evidence, quoteInput: prepared.quoteInput }),
    /Forecast digest differs/,
  );
  assert.deepEqual(store.snapshot().jobs.old.quote, stored.quote);
  assert.equal(submissions, 1);
});

test("all passed video entries are counted and unmatched/extra evidence is rejected without dimension inference", () => {
  const value = request("us", true);
  const url = (value.input.video_urls as string[])[0];
  value.input.video_urls = [url, url];
  const pinned = forecast(value),
    prepared = prepare(pinned).prepared;
  assert.equal(prepared.quoteInput!.inputVideoDurationSec, 16);
  assert.equal(prepared.quoteInput!.width, 1280);
  assert.equal(quote({ model: pinned.context!.videoForecast!.endpoint, ...prepared.quoteInput }).expectedUsd, 8.6532);
  const extra = structuredClone(pinned);
  extra.context!.videoForecast!.videoReferences.push(extra.context!.videoForecast!.videoReferences[0]);
  assert.throws(() => prepare(extra), /complete passed reference-video evidence/);
  const badSchema = structuredClone(pinned);
  badSchema.context!.videoForecast!.videoReferences[0].durationSec = Number.MAX_SAFE_INTEGER;
  assert.equal(FalOperationRequestSchema.safeParse(badSchema).success, false);
});

test("internally valid stored evidence bound to another request rejects absent-forecast resume before provider", async () => {
  const directory = project("cross-bound"),
    value = forecast(request()),
    { plan, prepared } = prepare(value);
  const store = new OperationStore("cross-bound");
  store.configure({ ceilingUsd: 20, maxJobUsd: 15, repairReserveFraction: 0 }, USER_GRANT);
  let submits = 0,
    inspects = 0;
  const provider: JobProvider = {
    submit: async () => {
      submits++;
      return { requestId: "original" };
    },
    inspect: async () => {
      inspects++;
      return { state: "running" };
    },
  };
  const options: ExecutionOptions = {
    projectId: "cross-bound",
    operationId: "bound",
    model: plan.endpoint,
    endpoint: plan.endpoint,
    input: plan.input,
    output: path.join(directory, "out.mp4"),
    mediaKind: "video",
    provider,
    quoteInput: prepared.quoteInput,
    forecastEvidence: prepared.evidence,
  };
  await executeFalOperation(options);
  const original = store.snapshot(),
    liability = store.summary().reservedUsd;
  for (const field of ["endpoint", "inputSha256"] as const) {
    const corrupt = structuredClone(original);
    const evidence = corrupt.jobs.bound.quote.forecastEvidence!;
    evidence.forecast[field] = field === "endpoint" ? "bytedance/seedance-2.5/us/text-to-video" : "0".repeat(64);
    evidence.sha256 = generationInputHash(evidence.forecast);
    writeFileSync(store.file, JSON.stringify(corrupt));
    const before = store.snapshot();
    await assert.rejects(
      executeFalOperation({ ...options, forecastEvidence: undefined, quoteInput: undefined }),
      /Stored forecast endpoint\/provider-input pins differ/,
    );
    assert.deepEqual(store.snapshot(), before);
    assert.equal(store.summary().reservedUsd, liability);
    assert.deepEqual({ submits, inspects }, { submits: 1, inspects: 1 });
  }
});
