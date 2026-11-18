import { USER_GRANT } from "./helpers/ceiling-grant";
import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, unlinkSync } from "node:fs";
import { prepareModel, genjutsuPrompt } from "../src/lib/model-preparation/prepare";
import {
  preparationAdmission,
  validatePreparation,
  approvePreparation,
  writePreparationRights,
} from "../src/lib/model-preparation/approval";
import { ModelPreparationSpecSchema } from "../src/types/model-preparation";
import { preparationFile, preparationProject } from "../src/lib/model-preparation/storage";
import {
  recordPreparationResult,
  reviewPreparationResult,
  preparationDeliveryReview,
  preparationResultBoard,
  preparationLineageReview,
} from "../src/lib/model-preparation/results";
import { captureBespokeIdentity } from "../src/lib/delivery/bespoke";
import { reviewRights, type Finding } from "../src/lib/delivery/reviews";
import { DeliveryRequestSchema } from "../src/types/delivery";
import { buildFalOperation } from "../src/lib/providers/fal-operations";
import { genjutsuEndpoint, preparationProfile } from "../src/lib/model-preparation/profiles";
import { hashFile, importAsset, readAssetRegistry } from "../src/lib/assets/registry";
import { executeFalOperation } from "../src/lib/jobs/execution";
import { OperationStore } from "../src/lib/jobs/store";
import type { JobProvider } from "../src/lib/jobs/runner";
import { generationInputHash } from "../src/lib/jobs/runner";
import { parseFalTask } from "../src/lib/models/fal-task-map";
import { findFalEndpointResult } from "../src/lib/models/fal-find";
import { modifiersOf, matchPlaybooks } from "../src/lib/playbooks/match";
import { genjutsuFixture, approveFixture } from "./helpers/genjutsu-preparation";

for (const mode of ["object-swap", "motion-transfer", "restyle"] as const)
  test(`prepared ${mode}: measures source, pins refs, builds markers and requires approval`, (t) => {
    const f = genjutsuFixture(t, mode === "motion-transfer"),
      originalHash = hashFile(f.video),
      data = prepareModel("demo", f.spec(mode), f.rootDir);
    assert.equal(data.receipt.endpoint, genjutsuEndpoint(mode));
    assert.equal(data.receipt.source.sha256, originalHash);
    assert.equal(data.receipt.preparedSource.durationSec, 4);
    assert.equal(data.receipt.preparedSource.hasAudio, false);
    assert.equal(data.receipt.references[0]!.media.sha256, f.reference.hash);
    assert.match(data.request.input.prompt, /@Video1/);
    assert.match(data.request.input.prompt, /@Image1/);
    assert.equal(hashFile(f.video), originalHash);
    const binding = { id: data.receipt.id, sha256: data.sha256 },
      validated = validatePreparation("demo", binding, f.rootDir);
    assert.equal(
      preparationAdmission("demo", binding, data.receipt.endpoint, validated.plan.input, f.rootDir).ready,
      false,
    );
    approveFixture(data, f.rootDir);
    assert.equal(
      preparationAdmission("demo", binding, data.receipt.endpoint, validated.plan.input, f.rootDir).ready,
      true,
    );
    assert.equal(prepareModel("demo", f.spec(mode), f.rootDir).reused, true);
    assert.throws(() => prepareModel("demo", { ...f.spec(mode), resolution: "1080p" }, f.rootDir), /immutable/);
  });

test("explicit segment/crop is measured without upscaling; source stays immutable", (t) => {
  const f = genjutsuFixture(t),
    data = prepareModel(
      "demo",
      { ...f.spec(), segment: { startSec: 2, durationSec: 4, crop: { x: 0, y: 0, width: 800, height: 520 } } },
      f.rootDir,
    );
  assert.equal(data.receipt.preparedSource.width, 800);
  assert.equal(data.receipt.preparedSource.height, 520);
  assert.equal(data.receipt.source.durationSec, 6);
  assert.throws(
    () =>
      prepareModel(
        "demo",
        { ...f.spec("object-swap", "too-long"), segment: { startSec: 3, durationSec: 4 } },
        f.rootDir,
      ),
    /extends beyond/,
  );
  assert.throws(
    () =>
      prepareModel(
        "demo",
        {
          ...f.spec("object-swap", "odd-crop"),
          segment: { startSec: 1, durationSec: 4, crop: { x: 1, y: 0, width: 800, height: 520 } },
        },
        f.rootDir,
      ),
    /even/,
  );
  assert.throws(
    () =>
      prepareModel(
        "demo",
        {
          ...f.spec("object-swap", "tiny"),
          segment: { startSec: 1, durationSec: 4, crop: { x: 0, y: 0, width: 320, height: 240 } },
        },
        f.rootDir,
      ),
    /409,600/,
  );
});

test("restyle can omit character refs; unrelated fields and incomplete prerequisites fail", (t) => {
  const f = genjutsuFixture(t),
    data = prepareModel("demo", { ...f.spec("restyle"), references: [] }, f.rootDir);
  assert.equal(data.receipt.references.length, 0);
  assert.doesNotMatch(data.request.input.prompt, /@Image/);
  assert.throws(() => ModelPreparationSpecSchema.parse({ ...f.spec(), references: [] }), /image references/);
  assert.throws(
    () => ModelPreparationSpecSchema.parse({ ...f.spec(), presetId: f.spec("restyle").presetId }),
    /Only restyle/,
  );
  assert.throws(() => ModelPreparationSpecSchema.parse({ ...f.spec(), mask: {} }), /Unrecognized key/);
  assert.equal(preparationProfile("object-swap").markers.preferred, true);
  assert.doesNotMatch(genjutsuPrompt({ ...f.spec(), useMarkers: false }), /@Video|@Image/);
});

test("display-space crops normalise anamorphic source geometry before cropping", (t) => {
  const f = genjutsuFixture(t),
    sourceFile = path.join(f.rootDir, "anamorphic.mp4");
  const child = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=720x576:r=10:d=4",
      "-vf",
      "setsar=16/15",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      sourceFile,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const source = importAsset({
    projectId: "demo",
    rootDir: f.rootDir,
    sourceFile,
    provenance: { origin: "manual", tool: "anamorphic-fixture" },
  }).asset;
  const data = prepareModel(
    "demo",
    {
      ...f.spec(),
      sourceAssetId: source.id,
      segment: { startSec: 0, durationSec: 4, crop: { x: 0, y: 0, width: 768, height: 576 } },
    },
    f.rootDir,
  );
  assert.equal(data.receipt.source.width, 768);
  assert.equal(data.receipt.preparedSource.width, 768);
  assert.equal(data.receipt.preparedSource.height, 576);
});

test("marker guards reject dangling references without inventing provider fields", () => {
  for (const mode of ["object-swap", "motion-transfer"] as const) {
    const request = {
      provider: "higgsfield" as const,
      endpoint: genjutsuEndpoint(mode),
      input: {
        video_url: "https://example.com/source.mp4",
        image_urls: ["https://example.com/face.png"],
        prompt: "@Video1 @Image1",
      },
    };
    assert.doesNotThrow(() => buildFalOperation(request));
    for (const token of ["@Video2", "@Image0", "@Image2", "@Image 2", "@ImageX", "@Video", "@Image1abc"])
      assert.throws(
        () => buildFalOperation({ ...request, input: { ...request.input, prompt: token } }),
        /has no attached/,
      );
  }
});

test("changed prompt, review board or original invalidates exact input approval", (t) => {
  const f = genjutsuFixture(t),
    data = prepareModel("demo", f.spec(), f.rootDir);
  approveFixture(data, f.rootDir);
  const binding = { id: data.receipt.id, sha256: data.sha256 },
    { plan } = validatePreparation("demo", binding, f.rootDir);
  assert.equal(
    preparationAdmission("demo", binding, plan.endpoint, { ...plan.input, prompt: "changed" }, f.rootDir).ready,
    false,
  );
  const registryFile = path.join(f.project, "pipeline/asset-registry.json"),
    registryBytes = readFileSync(registryFile),
    registry = JSON.parse(registryBytes.toString());
  registry.assets.find((asset: { id: string }) => asset.id === data.receipt.preparedSource.assetId).media.durationSec =
    8;
  writeFileSync(registryFile, JSON.stringify(registry));
  assert.throws(() => validatePreparation("demo", binding, f.rootDir), /measurements/);
  writeFileSync(registryFile, registryBytes);
  const provenanceMutation = JSON.parse(registryBytes.toString());
  provenanceMutation.assets.find(
    (asset: { id: string }) => asset.id === data.receipt.preparedSource.assetId,
  ).provenance.referenceAssetIds = [];
  writeFileSync(registryFile, JSON.stringify(provenanceMutation));
  assert.throws(() => validatePreparation("demo", binding, f.rootDir), /upstream input provenance/);
  writeFileSync(registryFile, registryBytes);
  const board = preparationFile("demo", binding.id, "board.html", f.rootDir),
    original = readFileSync(board);
  writeFileSync(board, "changed");
  assert.throws(() => validatePreparation("demo", binding, f.rootDir), /board changed/);
  writeFileSync(board, original);
  const image = path.join(f.rootDir, "public", f.reference.files.original);
  writeFileSync(image, "changed");
  assert.equal(preparationAdmission("demo", binding, plan.endpoint, plan.input, f.rootDir).ready, false);
});

test("visual review must match ordered exact references, and source audio cannot be silently cleared", (t) => {
  const f = genjutsuFixture(t),
    data = prepareModel("demo", { ...f.spec(), audioPolicy: "preserve-source" }, f.rootDir);
  assert.equal(data.receipt.preparedSource.hasAudio, true);
  assert.throws(() => approveFixture(data, f.rootDir), /audio rights/);
  writePreparationRights(
    "demo",
    data.receipt.id,
    {
      status: "licensed",
      userStatement: "Fixture licence",
      evidence: "Synthetic video and audio",
      processingAllowed: true,
      commercialAllowed: true,
      placements: ["tiktok"],
      audioRights: "licensed",
      usage: { advertising: false, endorsement: false, standaloneResale: false },
    },
    f.rootDir,
  );
  assert.throws(
    () =>
      approvePreparation(
        "demo",
        data.receipt.id,
        "Fixture approval",
        {
          preparationSha256: data.sha256,
          reviewer: "fixture",
          evidence: "fixture",
          sourceMotionReadable: true,
          targetUnambiguous: true,
          references: [],
        },
        f.rootDir,
      ),
    /different preparation inputs/,
  );
});

test("fresh execution and dry-run enforce preparation before any network or job reservation", async (t) => {
  const f = genjutsuFixture(t),
    cwd = process.cwd();
  process.chdir(f.rootDir);
  t.after(() => process.chdir(cwd));
  let called = false;
  const options = {
    providerId: "higgsfield" as const,
    projectId: "demo",
    endpoint: genjutsuEndpoint("object-swap"),
    model: genjutsuEndpoint("object-swap"),
    input: { video_url: "https://example.com/source.mp4", image_urls: ["https://example.com/face.png"] },
    output: "public/projects/demo/assets/result.mp4",
    mediaKind: "video" as const,
    maxCostUsd: 1,
    fetch: async () => {
      called = true;
      throw new Error("Network forbidden");
    },
  };
  const dry = await executeFalOperation({ ...options, dryRun: true });
  assert.equal(dry.metadata.executable, false);
  await assert.rejects(executeFalOperation(options), /approved model:prepare/);
  assert.equal(called, false);
  assert.equal(existsSync(new OperationStore("demo").file), false);
});

test("approved operation publishes preparation provenance, resumes once and requires exact-result QA", async (t) => {
  const f = genjutsuFixture(t, true),
    data = prepareModel("demo", f.spec(), f.rootDir);
  approveFixture(data, f.rootDir);
  const binding = { id: data.receipt.id, sha256: data.sha256 },
    validated = validatePreparation("demo", binding, f.rootDir);
  const cwd = process.cwd();
  process.chdir(f.rootDir);
  t.after(() => process.chdir(cwd));
  let submits = 0;
  let polls = 0;
  const provider: JobProvider = {
    submit: async () => {
      submits++;
      return { requestId: "fixture-result" };
    },
    inspect: async () =>
      ++polls === 1
        ? { state: "queued" }
        : { state: "completed", result: { video: { url: "https://cdn.higgsfield.ai/fixture.mp4" } } },
  };
  const generated = path.join(f.rootDir, "generated.mp4");
  const encoded = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      f.video,
      "-t",
      "4",
      "-vf",
      "hflip",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      generated,
    ],
    { encoding: "utf8" },
  );
  assert.equal(encoded.status, 0, encoded.stderr);
  const options = {
    projectId: "demo",
    providerId: "higgsfield" as const,
    endpoint: validated.plan.endpoint,
    model: validated.plan.endpoint,
    input: validated.plan.input,
    modelPreparation: binding,
    output: "public/projects/demo/assets/result.mp4",
    mediaKind: "video" as const,
    maxCostUsd: 1,
    provider,
    fetch: async () => new Response(readFileSync(generated)),
  };
  const queued = await executeFalOperation(options);
  assert.equal(queued.metadata.state, "queued");
  assert.deepEqual(
    new OperationStore("demo").snapshot().jobs[String(queued.metadata.operationId)]!.publication!.modelPreparation,
    binding,
  );
  const { modelPreparation: _binding, ...resume } = options;
  const published = await executeFalOperation(resume);
  assert.equal(published.metadata.state, "published", String(published.metadata.error));
  assert.equal((await executeFalOperation(resume)).metadata.state, "published");
  assert.equal(submits, 1);
  const resultHash = hashFile(options.output),
    asset = readAssetRegistry("demo", f.rootDir).assets.find((row) => row.hash === resultHash)!;
  assert.deepEqual(asset.provenance.modelPreparation, binding);
  assert.deepEqual(
    asset.provenance.referenceAssetIds,
    [f.source.id, data.receipt.preparedSource.assetId, f.reference.id].sort(),
    "Shared execution derives source lineage from approval even when the caller omits reference IDs.",
  );
  const use = { commercial: true, placements: ["tiktok"], usage: {} };
  assert.throws(() => preparationDeliveryReview("demo", binding, resultHash, use, f.rootDir));
  const board = preparationResultBoard("demo", binding.id, options.output, f.rootDir);
  assert.equal(board.frames.length, 3);
  const review = {
    schemaVersion: 1,
    preparationSha256: data.sha256,
    outputSha256: resultHash,
    reviewer: "fixture",
    evidence: "Synthetic fixture only",
    identity: "pass",
    motion: "pass",
    preservedElements: "pass",
    otherSubjects: "pass",
    temporalConsistency: "pass",
    audio: "pass",
    verdict: "pass",
  };
  reviewPreparationResult("demo", binding.id, review, f.rootDir);
  assert.equal(preparationDeliveryReview("demo", binding, resultHash, use, f.rootDir).allowed, true);
  const approvalFile = preparationFile("demo", binding.id, "approval.json", f.rootDir),
    approvalBytes = readFileSync(approvalFile);
  unlinkSync(approvalFile);
  assert.throws(
    () => preparationDeliveryReview("demo", binding, resultHash, use, f.rootDir),
    /Approve the visual review/,
  );
  writeFileSync(approvalFile, approvalBytes);
  const rightsFile = preparationFile("demo", binding.id, "rights.json", f.rootDir),
    rightsBytes = readFileSync(rightsFile),
    rights = JSON.parse(rightsBytes.toString());
  writeFileSync(rightsFile, JSON.stringify({ ...rights, placements: ["tiktok", "youtube"] }));
  assert.throws(
    () => preparationDeliveryReview("demo", binding, resultHash, { ...use, placements: ["youtube"] }, f.rootDir),
    /stale/,
  );
  writeFileSync(rightsFile, rightsBytes);
  assert.throws(
    () => preparationDeliveryReview("demo", binding, resultHash, { ...use, placements: ["youtube"] }, f.rootDir),
    /do not cover/,
  );
  assert.throws(
    () => preparationDeliveryReview("demo", binding, resultHash, { ...use, usage: { advertising: true } }, f.rootDir),
    /do not cover/,
  );
  assert.throws(
    () => reviewPreparationResult("demo", binding.id, { ...review, identity: "fail" }, f.rootDir),
    /failed dimension/,
  );
  writeFileSync(path.join(f.project, "pipeline/build.json"), JSON.stringify({ composition: "RemixFixture" }));
  writeFileSync(
    path.join(f.project, "pipeline/motion-plan.json"),
    JSON.stringify({ fps: 30, shots: [{ startFrame: 0, durationFrames: 120 }] }),
  );
  const identity = captureBespokeIdentity("demo", "landscape", { rootDir: f.rootDir });
  assert.ok(
    identity.sources
      .filter((source) => source.path.includes("/entities/"))
      .every((source) => source.role === "creative"),
  );
  const request = DeliveryRequestSchema.parse({
    version: 1,
    projectId: "demo",
    formats: ["landscape"],
    variants: ["captioned"],
    placements: ["tiktok"],
    commercial: true,
    loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: false },
  });
  const findings: Finding[] = [];
  reviewRights(f.rootDir, request, [identity], findings);
  assert.deepEqual(
    findings.filter((finding) => finding.severity === "error"),
    [],
    JSON.stringify(findings),
  );
  const derivativeFile = path.join(f.project, "derived.mp4");
  const derived = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      generated,
      "-vf",
      "hue=s=0",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      derivativeFile,
    ],
    { encoding: "utf8" },
  );
  assert.equal(derived.status, 0, derived.stderr);
  const derivative = importAsset({
    projectId: "demo",
    rootDir: f.rootDir,
    sourceFile: derivativeFile,
    provenance: { origin: "manual", tool: "fixture-derivative", referenceAssetIds: [asset.id] },
  }).asset;
  assert.equal(preparationLineageReview("demo", derivative.id, use, f.rootDir).length, 1);
  const derivedRegistry = readAssetRegistry("demo", f.rootDir).assets;
  assert.throws(
    () =>
      preparationLineageReview(
        "demo",
        derivative.id,
        use,
        f.rootDir,
        derivedRegistry.map((row) =>
          row.id === derivative.id ? { ...row, provenance: { ...row.provenance, referenceAssetIds: [row.id] } } : row,
        ),
      ),
    /Cyclic/,
  );
  unlinkSync(approvalFile);
  assert.throws(() => preparationLineageReview("demo", derivative.id, use, f.rootDir), /Approve/);
});

test("historical unbound durable Genjutsu jobs keep their original resume identity", async (t) => {
  const f = genjutsuFixture(t),
    cwd = process.cwd();
  process.chdir(f.rootDir);
  t.after(() => process.chdir(cwd));
  const endpoint = genjutsuEndpoint("object-swap"),
    input = { video_url: "https://example.com/historical.mp4", image_urls: ["https://example.com/historical.png"] },
    output = path.join(f.project, "assets/historical.mp4");
  const store = new OperationStore("demo");
  store.configure({ ceilingUsd: 2, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
  store.reserveOperation({
    operationId: "legacy-fixture",
    provider: "higgsfield",
    endpoint,
    inputHash: generationInputHash(input),
    assetId: output,
    stage: "assets",
    repair: false,
    quote: {
      currency: "USD",
      lowUsd: 0,
      expectedUsd: 1,
      highUsd: 1,
      bounded: true,
      source: "Historical authorised fixture bound",
      asOf: "2026-11-15",
      confidence: "user-bound",
    },
    publication: { output, model: endpoint, kind: "video", referenceAssetIds: [] },
  });
  const provider: JobProvider = {
    submit: async () => ({ requestId: "legacy-result" }),
    inspect: async () => ({ state: "completed", result: { video: { url: "https://cdn.higgsfield.ai/legacy.mp4" } } }),
  };
  const result = await executeFalOperation({
    projectId: "demo",
    providerId: "higgsfield",
    endpoint,
    model: endpoint,
    input,
    output,
    mediaKind: "video",
    operationId: "legacy-fixture",
    provider,
    fetch: async () => new Response(readFileSync(f.video)),
  });
  assert.equal(result.metadata.state, "published", String(result.metadata.error));
  assert.equal(store.snapshot().jobs["legacy-fixture"]!.publication!.modelPreparation, undefined);
});

test("discovery separates three intents and remix sources do not imply style replication", () => {
  for (const phrase of [
    "replace only one person in an existing video, preserve the background",
    "заменить человека в видео, сохранить фон",
  ]) {
    const task = parseFalTask(phrase);
    assert.ok(task.concepts.includes("character-in-video"));
    assert.ok(!task.concepts.includes("background-replace"));
    const candidate = findFalEndpointResult({ provider: "higgsfield", task: phrase }).candidates[0]!;
    assert.equal(candidate.endpoint, genjutsuEndpoint("object-swap"));
    assert.equal(candidate.preparation?.mode, "object-swap");
  }
  for (const [phrase, mode] of [
    ["transfer motion and rebuild scene", "motion-transfer"],
    ["restyle a video", "restyle"],
  ] as const)
    assert.equal(
      findFalEndpointResult({ provider: "higgsfield", task: phrase }).candidates[0]!.endpoint,
      genjutsuEndpoint(mode),
    );
  assert.ok(parseFalTask("replace the background in this video").concepts.includes("background-replace"));
  assert.deepEqual(modifiersOf("character swap in https://www.tiktok.com/@fixture/video/123 using my reference"), []);
  assert.deepEqual(modifiersOf("genjutsu in the style of this video"), ["reference-style"]);
  assert.deepEqual(modifiersOf("copy exactly with genjutsu"), ["replica"]);
  assert.equal(matchPlaybooks("replace one person in video with genjutsu").candidates[0]!.id, "video-remix");
});

test("study-only is processing permission, never publication; path escapes are rejected", (t) => {
  const f = genjutsuFixture(t),
    data = prepareModel("demo", f.spec(), f.rootDir);
  approveFixture(data, f.rootDir, "study-only");
  const binding = { id: data.receipt.id, sha256: data.sha256 },
    validated = validatePreparation("demo", binding, f.rootDir);
  assert.equal(
    preparationAdmission("demo", binding, validated.plan.endpoint, validated.plan.input, f.rootDir).ready,
    true,
  );
  const output = path.join(f.project, "fixture.mp4");
  writeFileSync(output, readFileSync(f.video));
  recordPreparationResult("demo", binding, "fixture-study", output, f.source.id, f.rootDir);
  const resultHash = hashFile(output);
  reviewPreparationResult(
    "demo",
    binding.id,
    {
      schemaVersion: 1,
      preparationSha256: data.sha256,
      outputSha256: resultHash,
      reviewer: "fixture",
      evidence: "Fixture study",
      identity: "pass",
      motion: "pass",
      preservedElements: "pass",
      otherSubjects: "pass",
      temporalConsistency: "pass",
      audio: "pass",
      verdict: "pass",
    },
    f.rootDir,
  );
  assert.throws(
    () =>
      preparationDeliveryReview(
        "demo",
        binding,
        resultHash,
        { commercial: false, placements: ["tiktok"], usage: {} },
        f.rootDir,
      ),
    /do not cover/,
  );
  assert.throws(() => preparationFile("demo", binding.id, "../escape.json", f.rootDir), /escapes/);
  const outside = path.join(f.rootDir, "outside");
  mkdirSync(outside);
  symlinkSync(outside, path.join(f.project, "pipeline/model-preparations/escape"));
  assert.throws(() => preparationFile("demo", "escape", "receipt.json", f.rootDir), /symlink/);
  unlinkSync(path.join(f.project, "pipeline/model-preparations/escape"));
  assert.equal(preparationProject("demo", f.rootDir), f.project);
});
