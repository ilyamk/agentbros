import { writeBudgetBrief } from "./helpers/ceiling-grant";
import "./helpers/fal-no-network";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importAsset } from "../src/lib/assets/registry";
import {
  approvePack,
  NO_PACK_WARNING,
  packResultBoard,
  preparePack,
  readPackOutputs,
  referencePackGate,
  reviewPackResult,
} from "../src/lib/references/packs";
import { executeFalOperation } from "../src/lib/jobs/execution";
import type { JobProvider } from "../src/lib/jobs/runner";
import { prepareModernAssetDispatch } from "../src/lib/providers/modern-asset";
import { AssetSpecSchema } from "../src/types/pipeline";
import { digest } from "../src/lib/jobs/model-artifacts";

/** RFC 0003 WP6 (AC14): generate:model verifies a bound pack, warns or refuses reference inputs without one. Offline. */

const REPO = process.cwd();
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const media = { skip: hasFfmpeg ? false : "needs ffmpeg and ffprobe" } as const;
const SEEDANCE = "bytedance/seedance-2.5/reference-to-video";

function ffmpeg(...args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
const png = (file: string, colour: string, size: string) =>
  ffmpeg("-f", "lavfi", "-i", `color=c=${colour}:s=${size}`, "-frames:v", "1", "-pix_fmt", "rgb24", file);

function fixture(t: TestContext) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "reference-pack-generation-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const project = path.join(rootDir, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const src = path.join(rootDir, "src");
  mkdirSync(src);
  const add = (name: string, colour: string, size: string) => {
    png(path.join(src, name), colour, size);
    return importAsset({
      rootDir,
      projectId: "demo",
      sourceFile: path.join(src, name),
      provenance: { origin: "provider", tool: "offline-fixture", referenceAssetIds: [] },
    }).asset;
  };
  const face = add("face.png", "0x336699", "512x512");
  const plate = add("plate.png", "0x996633", "640x480");
  const spec = (id: string) => ({
    schemaVersion: 1,
    id,
    shotId: "s01",
    endpoint: SEEDANCE,
    profileFamily: "seedance-2.5",
    attachments: [
      {
        requirementKey: "hero-identity",
        source: { assetId: face.id },
        slot: "images",
        order: 1,
        roleSentence: "the face and hair of Mara",
      },
      {
        requirementKey: "market-plate",
        source: { assetId: plate.id },
        slot: "images",
        order: 2,
        roleSentence: "the market at dusk, take only the place and light",
      },
    ],
    prompt: { action: "Mara walks through the market as the lamps come on." },
    params: {},
    audioPolicy: "native",
  });
  const prepare = (id: string) => preparePack("demo", spec(id), rootDir);
  const approve = (pack: ReturnType<typeof prepare>) =>
    approvePack(
      "demo",
      pack.spec.id,
      "Yes, use these two.",
      {
        packSha256: pack.packSha256,
        reviewer: "fixture reviewer",
        evidence: "Inspected board.html and every attachment at full size.",
        markersVerified: true,
        promptReviewed: true,
        attachments: pack.receipt.attachments.map((a) => ({
          sha256: a.media.sha256,
          requirementKey: a.requirementKey,
          suitable: true,
          evidence: "Shows what its role sentence asks for.",
        })),
      },
      rootDir,
    );
  return { rootDir, project, prepare, approve, face, spec };
}
type Fixture = ReturnType<typeof fixture>;

function code(fn: () => unknown, expected: string, pattern?: RegExp) {
  let caught: (Error & { code?: string }) | undefined;
  try {
    fn();
  } catch (error) {
    caught = error as Error & { code?: string };
  }
  assert.ok(caught, `expected ${expected}`);
  assert.equal(caught.code, expected, caught.message);
  if (pattern) assert.match(caught.message, pattern);
}
const requestOf = (pack: { directory: string }) =>
  JSON.parse(readFileSync(path.join(pack.directory, "request.json"), "utf8")) as {
    provider: "fal";
    endpoint: string;
    input: Record<string, unknown>;
    context: { referencePack: { id: string; sha256: string } };
  };
const gate = (f: Fixture, raw: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  referencePackGate({
    projectId: "demo",
    raw,
    provider: ((raw.provider as string | undefined) ?? "fal") as "fal",
    endpoint: raw.endpoint as string,
    input: raw.input as Record<string, unknown>,
    resuming: false,
    dryRun: true,
    rootDir: f.rootDir,
    env: {},
    ...over,
  });

function generateModel(f: Fixture, request: unknown, env: Record<string, string> = {}) {
  const file = path.join(f.rootDir, `request-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(request));
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(REPO, "node_modules/tsx/dist/loader.mjs"),
      "--import",
      path.join(REPO, "tests/helpers/fal-no-network.ts"),
      path.join(REPO, "scripts/generate-model.ts"),
      "--request",
      file,
      "--project",
      "demo",
      "--output",
      "public/projects/demo/assets/videos/shot.mp4",
      "--dry-run",
      // A planning bound, so approval is the only difference between an executable and a blocked dry run.
      "--max-cost-usd",
      "5",
    ],
    {
      cwd: f.rootDir,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        ...(process.env.AGENTBROS_MEMORY_ROOT ? { AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT } : {}),
        ...env,
      },
    },
  );
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `${run.stdout}\n${run.stderr}`);
  return { status: run.status, envelope: JSON.parse(lines[0]!), stderr: run.stderr };
}

test("a bound pack: approval, tampered input, wrong hash and a foreign request form", media, (t) => {
  const f = fixture(t);
  const pack = f.prepare("stills");
  const request = requestOf(pack);
  // Unapproved: a dry run is not executable; execution is refused.
  const unapproved = gate(f, request);
  assert.equal(unapproved.executable, false);
  assert.deepEqual(unapproved.reasons, ["pack not approved"]);
  assert.deepEqual(unapproved.referencePack, { id: "stills", sha256: pack.packSha256, status: "prepared" });
  code(() => gate(f, request, { dryRun: false }), "STAGE_INCOMPLETE", /not approved/);
  f.approve(pack);
  const approved = gate(f, request, { dryRun: false });
  assert.equal(approved.executable, true);
  assert.equal(approved.referencePack?.status, "approved");
  assert.deepEqual(approved.warnings, []);
  // Parsed defaults (as the asset dispatcher writes them) are the same request.
  const withDefaults = { ...request, context: { ...request.context, media: {}, allowTranslatedSpeech: false } };
  assert.equal(gate(f, withDefaults).executable, true);
  // Tampered input, an extra context field, another endpoint, the wrong hash, no project.
  const tampered = { ...request, input: { ...request.input, prompt: "Something else entirely." } };
  code(() => gate(f, tampered), "VALIDATION", /differs from the pack's request\.json/);
  code(
    () => gate(f, { ...request, context: { ...request.context, callerId: "x" } }),
    "VALIDATION",
    /differs from the pack's request\.json/,
  );
  code(
    () => gate(f, { ...request, context: { referencePack: { id: "stills", sha256: "a".repeat(64) } } }),
    "VALIDATION",
    /binds sha256/,
  );
  code(() => gate(f, request, { projectId: undefined }), "INVALID_INPUT");
  code(
    () =>
      gate(f, {
        family: "seedance-2.5",
        operation: "reference-to-video",
        input: request.input,
        context: request.context,
      }),
    "VALIDATION",
    /endpoint-form/,
  );
  code(
    () => gate(f, { ...request, context: { referencePack: { id: "absent", sha256: pack.packSha256 } } }),
    "STAGE_INCOMPLETE",
  );
});

test("no pack on a profiled endpoint: warn, enforce, off; resumes, Genjutsu and unprofiled endpoints", media, (t) => {
  const f = fixture(t);
  const input = { prompt: "Mara walks.", image_urls: [`asset://sha256/${f.face.hash}`] };
  const raw = { provider: "fal", endpoint: SEEDANCE, input };
  const warned = gate(f, raw);
  assert.equal(warned.executable, true);
  assert.equal(warned.warnings.length, 1);
  assert.ok(warned.warnings[0]!.startsWith(NO_PACK_WARNING));
  assert.match(warned.warnings[0]!, /seedance-2\.5: \/image_urls/);
  code(() => gate(f, raw, { env: { AGENTBROS_REFERENCE_PACKS: "enforce" } }), "VALIDATION", /refs:pack/);
  assert.deepEqual(gate(f, raw, { env: { AGENTBROS_REFERENCE_PACKS: "off" } }).warnings, []);
  code(() => gate(f, raw, { env: { AGENTBROS_REFERENCE_PACKS: "strict" } }), "INVALID_INPUT");
  // A resumed durable job keeps its identity; empty reference fields are not references.
  assert.deepEqual(gate(f, raw, { resuming: true, env: { AGENTBROS_REFERENCE_PACKS: "enforce" } }).warnings, []);
  assert.deepEqual(gate(f, { ...raw, input: { prompt: "Mara walks.", image_urls: [] } }).warnings, []);
  // An endpoint without a profile is not checked.
  const plain = {
    endpoint: "fal-ai/flux/schnell",
    input: { prompt: "A cup", image_urls: ["https://fal.media/a.png"] },
  };
  assert.deepEqual(gate(f, plain, { env: { AGENTBROS_REFERENCE_PACKS: "enforce" } }).warnings, []);
  // Genjutsu requests with a model preparation keep their own gate (until WP9).
  const genjutsu = {
    provider: "higgsfield",
    endpoint: "higgsfield/genjutsu/object-swap/v1.0",
    input: { video_url: "https://example.com/v.mp4", image_urls: ["https://example.com/a.png"] },
    context: { modelPreparation: { id: "swap", sha256: "b".repeat(64) } },
  };
  const exempt = gate(f, genjutsu, { provider: "higgsfield", env: { AGENTBROS_REFERENCE_PACKS: "enforce" } });
  assert.deepEqual(exempt.warnings, []);
  // Element pointers expand over arrays.
  const kling = {
    endpoint: "fal-ai/kling-video/o3/standard/reference-to-video",
    input: { prompt: "x", elements: [{ frontal_image_url: "https://fal.media/a.png" }] },
  };
  assert.match(gate(f, kling).warnings[0]!, /\/elements\/\{n\}\/frontal_image_url/);
});

test("generate:model --dry-run: pack metadata, unapproved, tampered, enforce and off", media, (t) => {
  const f = fixture(t);
  const pack = f.prepare("stills");
  const request = requestOf(pack);
  const unapproved = generateModel(f, request);
  assert.equal(unapproved.envelope.ok, true, JSON.stringify(unapproved.envelope));
  assert.equal(unapproved.envelope.metadata.executable, false);
  assert.deepEqual(unapproved.envelope.metadata.notExecutableReasons, ["pack not approved"]);
  assert.equal(unapproved.envelope.metadata.referencePack.status, "prepared");
  f.approve(pack);
  const approved = generateModel(f, request);
  assert.equal(approved.envelope.ok, true, JSON.stringify(approved.envelope));
  assert.deepEqual(approved.envelope.metadata.referencePack, {
    id: "stills",
    sha256: pack.packSha256,
    status: "approved",
  });
  assert.equal(approved.envelope.metadata.notExecutableReasons, undefined);
  assert.equal(approved.envelope.metadata.executable, true, JSON.stringify(approved.envelope.metadata));
  assert.equal(approved.envelope.metadata.warnings, undefined);
  const tampered = generateModel(f, { ...request, input: { ...request.input, seed: 7 } });
  assert.equal(tampered.envelope.ok, false);
  assert.equal(tampered.envelope.error, "VALIDATION");
  const loose = { provider: "fal", endpoint: SEEDANCE, input: request.input };
  const warned = generateModel(f, loose);
  assert.equal(warned.envelope.ok, true, JSON.stringify(warned.envelope));
  assert.match(warned.envelope.metadata.warnings.join(" "), /without a reference pack/);
  assert.match(warned.stderr, /without a reference pack/);
  const enforced = generateModel(f, loose, { AGENTBROS_REFERENCE_PACKS: "enforce" });
  assert.equal(enforced.envelope.error, "VALIDATION");
  assert.notEqual(enforced.status, 0);
  const off = generateModel(f, loose, { AGENTBROS_REFERENCE_PACKS: "off" });
  assert.equal(off.envelope.ok, true);
  assert.equal(off.envelope.metadata.warnings, undefined);
});

test("native speech keeps the script pin, reports review requirements and refuses a silent pass", media, (t) => {
  const f = fixture(t);
  const line = {
    lineId: "wait-here",
    speakerId: "mara",
    language: "en",
    text: "Wait here.",
    startSec: 0,
    endSec: 2,
  };
  const script = path.join(f.project, "pipeline/script.json");
  const approved = {
    narratorVoice: "drew",
    voiceoverEnabled: false,
    language: "en",
    beats: [],
    dialogue: [{ lineId: line.lineId, speakerId: line.speakerId, language: "en", text: line.text, sceneId: "s01" }],
  };
  writeFileSync(script, JSON.stringify(approved));
  const pack = preparePack("demo", { ...f.spec("native-line"), nativeSpeech: [line] }, f.rootDir);
  assert.equal(pack.spec.scriptSha256, digest(readFileSync(script)));
  f.approve(pack);
  const request = requestOf(pack);
  assert.equal(request.input.generate_audio, true);
  assert.match(String(request.input.prompt), /mara speaks in en: "Wait here\."/);
  const plan = generateModel(f, request);
  assert.equal(plan.envelope.ok, true, JSON.stringify(plan.envelope));
  assert.deepEqual(plan.envelope.metadata.speech, {
    audioPolicy: "native",
    lineIds: [line.lineId],
    reviewRequired: true,
  });
  writeFileSync(script, JSON.stringify({ ...approved, dialogue: [] }));
  code(() => gate(f, request), "VALIDATION", /script changed/);
  writeFileSync(script, JSON.stringify(approved));

  const silent = path.join(f.project, "silent.mp4");
  ffmpeg("-f", "lavfi", "-i", "color=gray:s=160x120:r=30:d=2", "-c:v", "libx264", silent);
  const board = packResultBoard("demo", pack.spec.id, silent, f.rootDir);
  const review = {
    schemaVersion: 1,
    packSha256: pack.packSha256,
    outputSha256: board.outputSha256,
    reviewer: "fixture reviewer",
    evidence: "Compared the complete line with the result.",
    identity: "pass",
    wardrobe: "not-applicable",
    otherSubjects: "not-applicable",
    preserved: "pass",
    motion: "pass",
    naturalness: "pass",
    promptFit: "pass",
    temporalConsistency: "pass",
    audio: "pass",
    verdict: "pass",
  };
  const speech = {
    lineId: line.lineId,
    words: "pass",
    speaker: "pass",
    sync: "pass",
    evidence: "Viewed the speaking interval.",
  };
  const submit = (input: unknown) =>
    reviewPackResult("demo", pack.spec.id, input, f.rootDir, { allowForeignResult: true });
  code(() => submit(review), "VALIDATION", /every bound speech line/);
  code(() => submit({ ...review, speech: [speech, speech] }), "VALIDATION", /every bound speech line/);
  for (const dimension of ["words", "speaker"])
    code(() => submit({ ...review, speech: [{ ...speech, [dimension]: "fail" }] }), "VALIDATION", /failed dimension/);
  code(() => submit({ ...review, speech: [speech] }), "VALIDATION", /must contain audible media/);
});

test("a performed audio-driven line needs a passing lip-sync check before result acceptance", media, (t) => {
  const f = fixture(t);
  const previousCache = process.env.AGENTBROS_FAL_SCHEMA_CACHE;
  process.env.AGENTBROS_FAL_SCHEMA_CACHE = path.resolve(import.meta.dirname, "fixtures/fal-catalog/schemas");
  t.after(() => {
    if (previousCache === undefined) delete process.env.AGENTBROS_FAL_SCHEMA_CACHE;
    else process.env.AGENTBROS_FAL_SCHEMA_CACHE = previousCache;
  });
  const line = { lineId: "demo-line", speakerId: "mara", language: "en", text: "Wait.", startSec: 0, endSec: 1 };
  const audio = path.join(f.project, "line.mp3");
  ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=1", audio);
  const hash = digest(readFileSync(audio));
  const words = path.join(f.project, "line.words.json");
  writeFileSync(
    words,
    JSON.stringify({
      sourceSha256: hash,
      words: [{ lineId: line.lineId, speaker: line.speakerId, text: "Wait.", start: 0.1, end: 0.6 }],
    }),
  );
  const receipt = `${audio}.take.json`;
  writeFileSync(
    receipt,
    JSON.stringify({
      sha256: hash,
      alignmentSha256: digest(readFileSync(words)),
      output: "line.mp3",
      request: {
        language: "en",
        lineId: line.lineId,
        speaker: line.speakerId,
        approvedText: line.text,
        voiceRef: { provider: "elevenlabs", voiceId: "demo_voice", model: "eleven_v4", language: "en" },
      },
    }),
  );
  const asset = importAsset({
    rootDir: f.rootDir,
    projectId: "demo",
    sourceFile: audio,
    provenance: { origin: "provider", tool: "speech fixture" },
  }).asset;
  const pack = preparePack(
    "demo",
    {
      schemaVersion: 1,
      id: "lip-sync-line",
      shotId: "s01",
      endpoint: "fal-ai/bytedance/omnihuman/v1.5",
      profileFamily: "omnihuman-1.5-speech",
      audioPolicy: "replace-in-edit",
      prompt: { action: "Mara raises her eyes." },
      attachments: [
        {
          requirementKey: "portrait",
          source: { assetId: f.face.id },
          slot: "portrait",
          order: 1,
          roleSentence: "Mara's portrait",
        },
        {
          requirementKey: "speech",
          source: { assetId: asset.id },
          slot: "speech",
          order: 1,
          roleSentence: "Mara's line",
          speech: {
            kind: "performed-lines",
            use: "drive",
            sha256: hash,
            receipt,
            receiptSha256: digest(readFileSync(receipt)),
            lines: [line],
          },
        },
      ],
    },
    f.rootDir,
  );
  assert.match(String(pack.request.input.audio_url), new RegExp(hash));
  const video = path.join(f.project, "lip-sync.mp4");
  ffmpeg("-f", "lavfi", "-i", "color=gray:s=160x120:r=30:d=1", "-c:v", "libx264", video);
  const board = packResultBoard("demo", pack.spec.id, video, f.rootDir);
  const review = {
    schemaVersion: 1,
    packSha256: pack.packSha256,
    outputSha256: board.outputSha256,
    reviewer: "fixture reviewer",
    evidence: "Compared the complete line with the result and approved take.",
    identity: "pass",
    wardrobe: "not-applicable",
    otherSubjects: "not-applicable",
    preserved: "pass",
    motion: "pass",
    naturalness: "pass",
    promptFit: "pass",
    temporalConsistency: "pass",
    audio: "replace-in-edit",
    verdict: "pass",
  };
  const speech = {
    lineId: line.lineId,
    words: "pass",
    speaker: "pass",
    evidence: "Reviewed the take against the result.",
  };
  const submit = (sync: string) =>
    reviewPackResult("demo", pack.spec.id, { ...review, speech: [{ ...speech, sync }] }, f.rootDir, {
      allowForeignResult: true,
    });
  code(() => submit("not-applicable"), "VALIDATION", /passing lip-sync review/);
  assert.equal(submit("pass").review.verdict, "pass");

  const sourceVideo = importAsset({
    rootDir: f.rootDir,
    projectId: "demo",
    sourceFile: video,
    provenance: { origin: "provider", tool: "picture fixture" },
  }).asset;
  const synced = preparePack(
    "demo",
    {
      ...pack.spec,
      id: "sync-v3-line",
      endpoint: "fal-ai/sync-lipsync/v3",
      profileFamily: "sync-v3-speech",
      attachments: [
        {
          requirementKey: "picture",
          source: { assetId: sourceVideo.id },
          slot: "video",
          order: 1,
          roleSentence: "Mara",
        },
        pack.spec.attachments[1]!,
      ],
    },
    f.rootDir,
  );
  assert.equal(synced.request.input.prompt, undefined);
  assert.match(synced.receipt.compiledPrompt, /mara speaks in en: "Wait\."/);
  assert.equal(packResultBoard("demo", synced.spec.id, video, f.rootDir).outputSha256, board.outputSha256);
});

test("a published pack output is recorded; review-result refuses a foreign result unless allowed", media, async (t) => {
  const f = fixture(t);
  const pack = f.prepare("stills");
  f.approve(pack);
  const binding = { id: "stills", sha256: pack.packSha256 };
  const previous = process.cwd();
  process.chdir(f.rootDir);
  t.after(() => process.chdir(previous));
  writeBudgetBrief(f.project);
  png(path.join(f.rootDir, "result.png"), "0x22aa44", "320x240");
  const bytes = readFileSync(path.join(f.rootDir, "result.png"));
  const url = "https://v3.fal.media/files/synthetic/result.png";
  let submits = 0;
  const provider: JobProvider = {
    submit: async () => ({ requestId: `request-${++submits}` }),
    inspect: async () => ({ state: "completed", result: { images: [{ url, content_type: "image/png" }] } }),
  };
  const options = {
    projectId: "demo",
    endpoint: "fixture/pack",
    model: "fixture/pack",
    input: { prompt: "pack" },
    output: "public/projects/demo/assets/images/shot.png",
    mediaKind: "image" as const,
    maxCostUsd: 0.5,
    operationId: "pack:1",
    referencePack: binding,
    provider,
    fetch: (async () => new Response(new Uint8Array(bytes))) as typeof fetch,
  };
  const published = await executeFalOperation(options);
  assert.equal(published.metadata.state, "published", JSON.stringify(published.metadata));
  const outputs = readPackOutputs("demo", "stills", f.rootDir)!;
  assert.equal(outputs.packSha256, pack.packSha256);
  assert.equal(outputs.outputs.length, 1);
  assert.equal(outputs.outputs[0]!.operationId, "pack:1");
  assert.equal(outputs.outputs[0]!.path, "public/projects/demo/assets/images/shot.png");
  // Resume: no second submit, no duplicate row; another binding is refused.
  await executeFalOperation(options);
  assert.equal(submits, 1);
  assert.equal(readPackOutputs("demo", "stills", f.rootDir)!.outputs.length, 1);
  await assert.rejects(
    executeFalOperation({ ...options, referencePack: { id: "other", sha256: "c".repeat(64) } }),
    /Reference pack binding differs/,
  );

  const review = (outputSha256: string) => ({
    schemaVersion: 1,
    packSha256: pack.packSha256,
    outputSha256,
    reviewer: "fixture reviewer",
    evidence: "Looked at the whole result next to the attachments.",
    identity: "pass",
    wardrobe: "not-applicable",
    preserved: "pass",
    otherSubjects: "not-applicable",
    motion: "not-applicable",
    naturalness: "pass",
    promptFit: "pass",
    temporalConsistency: "pass",
    audio: "pass",
    verdict: "pass",
  });
  const own = packResultBoard("demo", "stills", options.output, f.rootDir);
  assert.equal(own.producedByPack, true);
  assert.deepEqual(own.warnings, []);
  assert.equal(reviewPackResult("demo", "stills", review(own.outputSha256), f.rootDir).producedByPack, true);
  // A result the pack did not produce: the board warns, the review refuses without the flag.
  mkdirSync(path.join(f.rootDir, "out/demo"), { recursive: true });
  const stray = path.join(f.rootDir, "out/demo/other.png");
  png(stray, "0xaa2244", "320x240");
  const foreign = packResultBoard("demo", "stills", stray, f.rootDir);
  assert.equal(foreign.producedByPack, false);
  assert.match(foreign.warnings.join(" "), /not in pack stills's outputs\.json/);
  code(
    () => reviewPackResult("demo", "stills", review(foreign.outputSha256), f.rootDir),
    "VALIDATION",
    /outputs\.json/,
  );
  const allowed = reviewPackResult("demo", "stills", review(foreign.outputSha256), f.rootDir, {
    allowForeignResult: true,
  });
  assert.equal(allowed.producedByPack, false);
  assert.ok(existsSync(allowed.file));
});

test("asset plan: metadata.referencePack must be the request's binding; the dispatcher runs the gate", media, (t) => {
  const f = fixture(t);
  const pack = f.prepare("stills");
  const request = requestOf(pack);
  const previous = process.cwd();
  process.chdir(f.rootDir);
  t.after(() => process.chdir(previous));
  const asset = (metadata: Record<string, unknown>) =>
    AssetSpecSchema.parse({
      id: "shot",
      kind: "ai-video",
      source: "fal-model",
      targetPath: "assets/videos/shot.mp4",
      status: "pending",
      metadata: { operationRequest: request, ...metadata },
    });
  const target = path.resolve("public/projects/demo/assets/videos/shot.mp4");
  code(
    () =>
      prepareModernAssetDispatch(asset({ referencePack: { id: "other", sha256: pack.packSha256 } }), "demo", target),
    "VALIDATION",
    /differs from operationRequest\.context\.referencePack/,
  );
  // Unapproved pack: refused before a request file is written or a job is spawned.
  code(
    () => prepareModernAssetDispatch(asset({ referencePack: request.context.referencePack }), "demo", target),
    "STAGE_INCOMPLETE",
  );
  f.approve(pack);
  const args = prepareModernAssetDispatch(asset({ referencePack: request.context.referencePack }), "demo", target);
  assert.equal(args[0], "scripts/generate-model.ts");
});
