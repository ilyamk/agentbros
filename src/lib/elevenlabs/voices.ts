import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  VoiceManagementRequestSchema,
  VoiceSelectionRequestSchema,
  type VoiceManagementRequest,
} from "../../types/elevenlabs";
import { inspectAsset } from "../assets/inspect";
import { analyzeAudio } from "../audio/analysis";
import { requireUserWords } from "../cli/user-words";
import { importAsset } from "../assets/registry";
import { immutableWrite, digest } from "../jobs/model-artifacts";
import { runGenerationStep, generationInputHash, type JobProvider } from "../jobs/runner";
import { canonicalInputIdentity } from "../jobs/identity";
import { ElevenLabsClient, remoteId, appendFile } from "./client";
import { projectOutput, regularInput, logicalJson, verifyVoiceRef } from "./files";
import {
  configuredStore,
  retainedStudioQuote,
  operationQuote,
  paidStudioResponse,
  studioOperationIdentity,
  type StudioExecution,
} from "./operations";

export async function discoverVoices(options: {
  action: "search" | "shared" | "inspect";
  query?: string;
  voiceId?: string;
  limit?: number;
  client?: ElevenLabsClient;
}) {
  const client = options.client ?? new ElevenLabsClient();
  const count = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.limit ?? 20);
  if (options.action === "inspect") {
    if (!options.voiceId) throw Error("Voice inspection needs voiceId");
    const data = await client.json(`/v1/voices/${remoteId(options.voiceId)}`);
    return {
      provider: "elevenlabs",
      voice: data,
      note: "Remote metadata is not human selection or verification evidence.",
    };
  }
  const params = new URLSearchParams({ page_size: String(count) });
  if (options.query) params.set("search", z.string().max(500).parse(options.query));
  return {
    provider: "elevenlabs",
    scope: options.action === "shared" ? "shared-library" : "account",
    ...(await client.json(`${options.action === "shared" ? "/v1/shared-voices" : "/v2/voices"}?${params}`)),
  };
}

export function voiceReadiness(data: Record<string, any>, model?: string) {
  if (model) {
    const state = data.fine_tuning?.state?.[model];
    const verification = data.voice_verification;
    if (state === "failed") return "failed";
    if (state !== "fine_tuned") return "training";
    // Absence of verification metadata is not proof that verification succeeded.
    return verification?.is_verified === true || verification?.requires_verification === false
      ? "ready"
      : "needs-verification";
  }
  const verification = data.voice_verification ?? data;
  return (verification.requires_verification === false || verification.is_verified === true) &&
    !data.library_voice_match
    ? "ready"
    : "needs-verification";
}

async function managementBody(request: VoiceManagementRequest, inputs: { file: string }[]) {
  if (request.task === "design")
    return {
      voice_description: request.description,
      text: request.previewText,
      model_id: request.model ?? "eleven_multilingual_ttv_v2",
    };
  if (request.task === "create-designed")
    return {
      voice_name: request.name,
      generated_voice_id: request.generatedVoiceId,
      ...(request.description ? { voice_description: request.description } : {}),
    };
  if (request.task === "clone-professional") return { name: request.name, language: request.language };
  if (request.task === "train") return { model_id: request.model };
  const form = new FormData();
  if (request.name) form.set("name", request.name);
  if (
    (request.task === "clone-instant" || request.task === "add-samples") &&
    request.removeBackgroundNoise !== undefined
  )
    form.set("remove_background_noise", String(request.removeBackgroundNoise));
  if (request.task === "dictionary") await appendFile(form, "file", inputs[0]!.file);
  else for (const input of inputs) await appendFile(form, "files", input.file);
  return form;
}

export async function executeVoiceManagement(raw: unknown, execution: StudioExecution = {}) {
  const request = VoiceManagementRequestSchema.parse(raw),
    root = path.resolve(execution.rootDir ?? process.cwd());
  const target = projectOutput(root, request.projectId, request.output);
  if (path.extname(target.file) !== ".json") throw Error("Voice lifecycle output must be a JSON manifest");
  const scope = execution.scopeRoot ?? root;
  const inputs = [...(request.samples ?? []), ...(request.dictionary ? [request.dictionary] : [])].map((file) =>
    regularInput(root, file, scope, 64 * 1024 * 1024),
  );
  const sampleReview = request.samples?.map((_, index) => {
    const input = inputs[index]!;
    const measured = inspectAsset(input.file);
    if (measured.kind !== "audio" || !measured.media.hasAudio) throw Error("Voice samples must contain audio only");
    const checked = analyzeAudio(input.file);
    return {
      sha256: input.sha256,
      durationSec: checked.durationSec,
      sampleRate: measured.media.sampleRate,
      channels: measured.media.channels,
      truePeakDb: checked.truePeakDb,
      silenceSec: checked.silence.reduce((total, interval) => total + interval.endSec - interval.startSec, 0),
      ...(checked.truePeakDb !== null && checked.truePeakDb >= -0.1 ? { clippingRisk: true } : {}),
    };
  });
  const advisory = sampleReview
    ? {
        samples: sampleReview,
        totalSec: sampleReview.reduce((sum, sample) => sum + sample.durationSec, 0),
        targetSec: request.task === "clone-instant" ? [60, 120] : [1800, 10800],
        reviewByEar: ["one speaker", "consistent register", "no music, room noise or reverb"],
      }
    : undefined;
  const prior = request.sourceManifest ? regularInput(root, request.sourceManifest, scope, 4 * 1024 * 1024) : undefined;
  const priorData = prior
    ? z
        .object({ voiceId: z.string(), model: z.string().optional(), task: z.string() })
        .passthrough()
        .parse(JSON.parse(readFileSync(prior.file, "utf8")))
    : undefined;
  if (
    request.task === "refresh" &&
    (!priorData ||
      priorData.voiceId !== request.voiceId ||
      (["clone-professional", "train", "add-samples", "adopt"].includes(priorData.task) && !request.model) ||
      (priorData.model && priorData.model !== request.model))
  )
    throw Error("Readiness refresh must match the original voice and its exact training model");
  const endpoint = {
    design: "/v1/text-to-voice/design",
    "create-designed": "/v1/text-to-voice",
    "clone-instant": "/v1/voices/add",
    "clone-professional": "/v1/voices/pvc",
    "add-samples": `/v1/voices/pvc/${request.voiceId}/samples`,
    train: `/v1/voices/pvc/${request.voiceId}/train`,
    dictionary: "/v1/pronunciation-dictionaries/add-from-file",
    refresh: `/v1/voices/${request.voiceId}`,
    adopt: `/v1/voices/${request.voiceId}`,
  }[request.task];
  const logical = logicalJson({
    ...request,
    operationId: undefined,
    maxCostUsd: undefined,
    output: target.relative,
    samples: inputs.map((input) => ({ sha256: input.sha256, bytes: input.bytes })),
    dictionary: request.dictionary ? inputs[0]?.sha256 : undefined,
    sourceManifest: prior?.sha256,
  });
  const identity = { endpoint, request: logical };
  const inputHash = generationInputHash(identity);
  const saved = existsSync(target.file) ? JSON.parse(readFileSync(target.file, "utf8")) : undefined;
  const savedMatches =
    saved &&
    (saved.canonicalInput
      ? saved.canonicalInput.version === 2 && saved.canonicalInput.sha256 === canonicalInputIdentity(identity).sha256
      : saved.inputHash === inputHash);
  const selectedId =
    request.operationId ?? (savedMatches && typeof saved.operationId === "string" ? saved.operationId : undefined);
  const metadataOnly = request.task === "refresh" || request.task === "adopt";
  const operationId = metadataOnly
    ? (selectedId ?? `el:voice:${inputHash.slice(0, 40)}`)
    : studioOperationIdentity(request.projectId, root, execution.store, {
        input: request.task === "train" ? identity : { ...identity, destination: target.relative },
        idInput: identity,
        operationId: selectedId,
        endpoint,
        provider: "elevenlabs",
        assetId: target.relative,
        id: (hash) => `el:voice:${hash.slice(0, 40)}`,
      }).operationId;
  if (saved) {
    if (!savedMatches || saved.operationId !== operationId) throw Error("Voice manifest belongs to different inputs");
    return { outputs: [target.file], metadata: { state: "published", voice: saved, replay: true } };
  }
  const model = `elevenlabs:voice-${request.task}`;
  const reservation = metadataOnly
    ? null
    : (retainedStudioQuote(request.projectId, root, operationId, execution.store) ??
      operationQuote(model, request.maxCostUsd));
  if (execution.dryRun !== false)
    return {
      outputs: [],
      metadata: {
        state: "planned",
        endpoint,
        operationId,
        quote: reservation,
        executable: metadataOnly || reservation !== null,
        ...(advisory ? { sampleReview: advisory } : {}),
        request: logical,
        liveVerified: false,
        humanAction:
          request.task.startsWith("clone") || request.task === "train"
            ? "Supply genuine rights/consent and complete provider verification; agents cannot perform it"
            : request.task === "design"
              ? "Listen to and select a preview before permanent creation"
              : null,
      },
    };
  const client = new ElevenLabsClient(execution);
  if (metadataOnly) {
    const data = await client.json(endpoint);
    if (remoteId(data.voice_id) !== request.voiceId) throw Error("Voice metadata does not match the requested voice");
    const professional = data.category === "professional" || Boolean(data.fine_tuning?.state);
    if (request.task === "adopt" && !professional) throw Error("Adoption is for a privately shared professional clone");
    const manifest = {
      version: 1,
      provider: "elevenlabs",
      task: request.task,
      operationId,
      inputHash,
      canonicalInput: canonicalInputIdentity(identity),
      voiceId: request.voiceId,
      ...(request.model ? { model: request.model } : {}),
      readiness: voiceReadiness(data, professional ? request.model : undefined),
      ...(prior ? { sourceManifestSha256: prior.sha256 } : {}),
      rights: request.rights ?? priorData?.rights ?? null,
      ...(request.language ? { language: request.language } : {}),
      liveVerified: false,
    };
    immutableWrite(target.file, `${JSON.stringify(manifest, null, 2)}\n`);
    return { outputs: [target.file], metadata: { state: "published", voice: manifest } };
  }
  const store = configuredStore(request.projectId, root, execution.store);
  const recheck = () => {
    for (const input of inputs)
      if (regularInput(root, input.file, scope, 64 * 1024 * 1024).sha256 !== input.sha256)
        throw Error("Voice input changed");
  };
  const body = async () => {
    recheck();
    return managementBody(request, inputs);
  };
  if (request.task === "train") {
    const previous = store.snapshot().jobs[operationId];
    const bound = previous?.quote ?? reservation;
    if (!bound) throw Error("Training requires an authorised positive maxCostUsd");
    const provider: JobProvider = {
      submit: async () => {
        await client.mutation(endpoint, await body());
        return { requestId: request.voiceId! };
      },
      inspect: async (_endpoint, voiceId) => {
        const data = await client.json(`/v1/voices/${remoteId(voiceId)}`),
          readiness = voiceReadiness(data, request.model);
        if (readiness === "failed")
          return { state: "failed", message: "Professional voice training failed; no refund assumed" };
        return readiness === "ready"
          ? { state: "completed", result: { voiceId, readiness, model: request.model } }
          : { state: "running" };
      },
    };
    const job = await runGenerationStep({
      store,
      input: identity,
      operation: {
        operationId,
        provider: "elevenlabs",
        endpoint,
        assetId: target.relative,
        stage: "voice",
        quote: bound,
      },
      provider,
      publish: async (result) => {
        const manifest = {
          version: 1,
          provider: "elevenlabs",
          task: request.task,
          inputHash,
          canonicalInput: canonicalInputIdentity(identity),
          operationId,
          ...result,
          rights: request.rights,
          liveVerified: false,
        };
        immutableWrite(target.file, `${JSON.stringify(manifest, null, 2)}\n`);
        return { outputs: [target.file], hashes: [digest(readFileSync(target.file))] };
      },
    });
    return {
      outputs: job.state === "published" ? [target.file] : [],
      metadata: {
        state: job.state,
        operationId,
        providerRequestId: job.providerRequestId,
        nextAction: job.state === "unknown" ? "reconcile-existing-voice" : "resume-same-operation",
        budget: store.summary(),
      },
    };
  }
  const { response } = await paidStudioResponse({
    projectId: request.projectId,
    root,
    task: `voice-${request.task}`,
    endpoint,
    identity,
    output: target.relative,
    model,
    bound: request.maxCostUsd,
    operationId,
    execution,
    maxResponseBytes: 64 * 1024 * 1024,
    perform: async () => client.post(endpoint, await body()),
  });
  const rawData: unknown = await response.json();
  const data =
    request.task === "add-samples"
      ? { samples: z.array(z.object({ sample_id: z.string().min(1) }).passthrough()).parse(rawData) }
      : z.record(z.string(), z.any()).parse(rawData);
  recheck();
  const directory = mkdtempSync(path.join(tmpdir(), "el-voice-"));
  try {
    const previews: { generatedVoiceId: string; src: string; sha256: string }[] = [];
    if (request.task === "design") {
      const rows = z
        .array(
          z
            .object({ generated_voice_id: z.string().min(1), audio_base_64: z.string().min(1).max(30_000_000) })
            .passthrough(),
        )
        .min(1)
        .max(10)
        .parse(data.previews);
      for (const [index, preview] of rows.entries()) {
        const file = path.join(directory, `${index}.mp3`),
          bytes = Buffer.from(preview.audio_base_64, "base64");
        writeFileSync(file, bytes);
        if (inspectAsset(file).kind !== "audio") throw Error("Voice design preview is not valid audio");
        const imported = importAsset({
          projectId: request.projectId,
          rootDir: root,
          sourceFile: file,
          provenance: { origin: "provider", tool: "elevenlabs:voice-design", generationJobId: operationId },
        });
        previews.push({
          generatedVoiceId: remoteId(preview.generated_voice_id),
          src: imported.asset.files.original,
          sha256: digest(bytes),
        });
      }
    }
    const voiceId =
      request.task === "add-samples" ? request.voiceId : data.voice_id ? remoteId(data.voice_id) : undefined;
    if (["create-designed", "clone-instant", "clone-professional", "add-samples"].includes(request.task) && !voiceId)
      throw Error("Provider did not return the expected voice ID");
    if (request.task === "dictionary") {
      remoteId(data.id);
      remoteId(data.version_id);
    }
    const readiness =
      request.task === "create-designed"
        ? "ready"
        : request.task === "clone-instant"
          ? voiceReadiness(data)
          : request.task === "design"
            ? "awaiting-selection"
            : request.task === "dictionary"
              ? "ready"
              : "needs-verification";
    const manifest = {
      version: 1,
      provider: "elevenlabs",
      task: request.task,
      operationId,
      inputHash,
      canonicalInput: canonicalInputIdentity(identity),
      ...(voiceId ? { voiceId } : {}),
      readiness,
      ...(previews.length ? { previews } : {}),
      ...(request.task === "dictionary" ? { dictionaryId: data.id, versionId: data.version_id } : {}),
      sourceHashes: inputs.map((input) => input.sha256),
      ...(advisory ? { sampleReview: advisory } : {}),
      ...(request.rights ? { rights: request.rights } : {}),
      liveVerified: false,
      providerVerificationRequired: readiness === "needs-verification",
    };
    immutableWrite(target.file, `${JSON.stringify(manifest, null, 2)}\n`);
    return { outputs: [target.file], metadata: { state: "published", voice: manifest, budget: store.summary() } };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function recordVoiceSelection(raw: unknown, answer: string | undefined, root = process.cwd()) {
  const request = VoiceSelectionRequestSchema.parse(raw);
  const choice = requireUserWords(answer, "--answer");
  const { voiceRef, projectId } = request;
  if (voiceRef.selection) throw Error("Calibrate from the voice and its readiness manifest");
  verifyVoiceRef(root, voiceRef, root, voiceRef.model.includes("_sts_") ? "voice-change" : "tts");
  const { file } = projectOutput(root, projectId, request.output);
  const takes = request.takes.map((take) => {
    const receiptFile = projectOutput(root, projectId, take.receipt).file;
    const checked = regularInput(root, receiptFile, root, 4 * 1024 * 1024);
    if (checked.sha256 !== take.sha256) throw Error("Calibration take receipt changed");
    const data = JSON.parse(readFileSync(checked.file, "utf8"));
    if (
      data.provider !== "elevenlabs" ||
      data.voiceId !== voiceRef.voiceId ||
      data.request?.model !== voiceRef.model ||
      data.request?.language !== voiceRef.language ||
      data.request?.voiceRef?.manifestSha256 !== voiceRef.manifestSha256
    )
      throw Error("Calibration take belongs to another voice, model, language or manifest");
    const audio = projectOutput(root, projectId, path.join("public/projects", projectId, data.output)).file;
    if (checked.file !== `${audio}.take.json` || regularInput(root, audio, root).sha256 !== data.sha256)
      throw Error("Calibration audio changed");
    return { use: take.use, receiptSha256: checked.sha256, audioSha256: data.sha256 };
  });
  if (new Set(takes.map((take) => take.receiptSha256)).size !== takes.length)
    throw Error("Calibration cases must be separate takes");
  const selection = {
    version: 1,
    status: "approved",
    voiceId: voiceRef.voiceId,
    model: voiceRef.model,
    language: voiceRef.language,
    manifestSha256: voiceRef.manifestSha256,
    takes,
    answer: choice,
  };
  immutableWrite(file, `${JSON.stringify(selection, null, 2)}\n`);
  return { outputs: [file], metadata: { selection, selectionSha256: digest(readFileSync(file)) } };
}
