import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  ElevenLabsAudioRequestSchema,
  SpeechResponseSchema,
  type ElevenLabsAudioRequest,
} from "../../types/elevenlabs";
import { CliErrorObject } from "../cli";
import { inspectAsset } from "../assets/inspect";
import { importAsset } from "../assets/registry";
import { immutableWrite, digest } from "../jobs/model-artifacts";
import { OperationStore } from "../jobs/store";
import { synchronousPaidRequest } from "../jobs/synchronous";
import { generationInputHash } from "../jobs/runner";
import { resolveOperationIdentity, canonicalInputIdentity } from "../jobs/identity";
import type { GenerationJob, PriceQuote } from "../jobs/types";
import { quote } from "../pricing";
import { ElevenLabsClient, appendFile } from "./client";
import { projectOutput, regularInput, verifyVoiceRef, logicalJson } from "./files";
import { characterWords } from "./timings";
import { validateDirectedText } from "./direction";
import { MAX_VOICE_CHANGE_SECONDS, providerLanguage } from "../../types/elevenlabs-profiles";

export type StudioExecution = {
  rootDir?: string;
  scopeRoot?: string;
  dryRun?: boolean;
  store?: OperationStore;
  fetch?: typeof fetch;
  apiKey?: string;
};
export const speechAlignmentPath = (audio: string) => audio.replace(/\.[^./\\]+$/, "") + ".words.json";
export function operationQuote(model: string, maxCostUsd?: number, units?: number): PriceQuote | null {
  const estimate = quote({ model, units });
  if (estimate.bounded && estimate.lowUsd !== null && estimate.expectedUsd !== null && estimate.highUsd !== null) {
    if (maxCostUsd !== undefined && estimate.highUsd > maxCostUsd)
      throw Error("Quote exceeds the explicit operation bound");
    return {
      ...estimate,
      lowUsd: estimate.lowUsd,
      expectedUsd: estimate.expectedUsd,
      highUsd: estimate.highUsd,
      bounded: true,
      confidence: estimate.confidence === "unknown" ? "conservative-bound" : estimate.confidence,
      notes: estimate.notes ? [estimate.notes] : [],
    };
  }
  return maxCostUsd === undefined
    ? null
    : {
        currency: "USD",
        lowUsd: 0,
        expectedUsd: maxCostUsd,
        highUsd: maxCostUsd,
        bounded: true,
        confidence: "user-bound",
        source: "Explicit planning bound, not a provider billing cap",
        asOf: new Date().toISOString().slice(0, 10),
        model,
        providerEnforced: false,
      };
}
function realDestination(file: string): string {
  const suffix: string[] = [];
  let ancestor = path.resolve(file);
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    suffix.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw Error("Cannot resolve private response cache");
    ancestor = parent;
  }
  const resolved = realpathSync(ancestor);
  if (!statSync(resolved).isDirectory())
    throw new CliErrorObject({ code: "VALIDATION", message: "Private response cache needs a directory ancestor" });
  return path.join(resolved, ...suffix);
}
function studioStore(projectId: string, root: string, provided?: OperationStore) {
  const store =
    provided ??
    new OperationStore(projectId, {
      directory: path.join(root, "public/projects", projectId, "pipeline"),
      responseCacheDirectory: path.join(root, ".cache/paid-responses", projectId),
    });
  if (store.projectId !== projectId) throw Error("Operation store belongs to another project");
  const inside = (parent: string, file: string) => {
    const relative = path.relative(parent, file);
    return (
      relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const publicDirectory = path.resolve(root, "public"),
    cache = path.resolve(store.responseCacheDirectory);
  if (inside(publicDirectory, cache) || inside(realDestination(publicDirectory), realDestination(cache)))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Private paid response cache must remain outside workspace public assets before submission",
    });
  return store;
}
export function configuredStore(projectId: string, root: string, provided?: OperationStore) {
  const store = studioStore(projectId, root, provided);
  if (!existsSync(store.file))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Configure the project budget explicitly before executing a new ElevenLabs workflow",
    });
  return store;
}
export function retainedStudioQuote(projectId: string, root: string, operationId: string, provided?: OperationStore) {
  const store = studioStore(projectId, root, provided);
  return existsSync(store.file) ? store.snapshot().jobs[operationId]?.quote : undefined;
}
export function studioOperationIdentity(
  projectId: string,
  root: string,
  provided: OperationStore | undefined,
  options: Omit<Parameters<typeof resolveOperationIdentity>[0], "store" | "projectId">,
) {
  return resolveOperationIdentity({ ...options, store: studioStore(projectId, root, provided) });
}

export async function paidStudioResponse(options: {
  projectId: string;
  root: string;
  task: string;
  endpoint: string;
  identity: Record<string, unknown>;
  output: string;
  model: string;
  bound?: number;
  units?: number;
  operationId?: string;
  execution: StudioExecution;
  perform: () => Promise<Response>;
  maxResponseBytes?: number;
}) {
  const store = configuredStore(options.projectId, options.root, options.execution.store);
  const identity = { ...options.identity, destination: options.output };
  const { operationId, existing: previous } = resolveOperationIdentity({
    input: identity,
    store,
    operationId: options.operationId,
    provider: "elevenlabs",
    endpoint: options.endpoint,
    assetId: options.output,
    id: (hash) => `el:${options.task}:${hash.slice(0, 40)}`,
  });
  const reservation = previous?.quote ?? operationQuote(options.model, options.bound, options.units);
  if (!reservation)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Unknown price requires an explicitly authorised positive maxCostUsd; no POST submitted",
    });
  const response = await synchronousPaidRequest({
    store,
    identity,
    operation: {
      operationId,
      provider: "elevenlabs",
      endpoint: options.endpoint,
      assetId: options.output,
      stage: "audio",
      quote: reservation,
    },
    maxResponseBytes: options.maxResponseBytes ?? 128 * 1024 * 1024,
    perform: options.perform,
  });
  if (!response.ok)
    throw new CliErrorObject({
      code: response.status === 429 ? "RATE_LIMIT" : "VALIDATION",
      message: `ElevenLabs HTTP ${response.status}; saved response retained, no free retry assumed`,
      details: { operationId },
    });
  return { response, operationId };
}

export function speechBody(request: Extract<ElevenLabsAudioRequest, { task: "tts" | "dialogue" }>) {
  const shared = {
    model_id: request.model,
    ...(request.language && request.model !== "eleven_multilingual_v2"
      ? { language_code: providerLanguage(request.language) }
      : {}),
    ...(request.dictionaries ? { pronunciation_dictionary_locators: request.dictionaries } : {}),
    ...(request.effects ? { audio_effects: request.effects } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.textNormalization ? { apply_text_normalization: request.textNormalization } : {}),
    ...(request.previousRequestIds?.length
      ? { previous_request_ids: request.previousRequestIds }
      : request.previousText
        ? { previous_text: request.previousText }
        : {}),
    ...(request.nextRequestIds?.length ? { next_request_ids: request.nextRequestIds } : {}),
  };
  return request.task === "dialogue"
    ? {
        ...shared,
        inputs: request.turns.map((turn) => ({ text: turn.text, voice_id: turn.voiceRef?.voiceId ?? turn.voiceId })),
        ...(request.settings ? { settings: request.settings } : {}),
        ...(request.nextText && !request.nextRequestIds?.length ? { future_text: request.nextText } : {}),
      }
    : {
        ...shared,
        text: request.text,
        ...(request.settings ? { voice_settings: request.settings } : {}),
        ...(request.nextText && !request.nextRequestIds?.length ? { next_text: request.nextText } : {}),
        ...(request.usePvcAsIvc !== undefined ? { use_pvc_as_ivc: request.usePvcAsIvc } : {}),
      };
}

export function speechAlignmentBytes(
  words: {
    text: string;
    startSec: number;
    endSec: number;
    speaker?: string | null;
    sceneId?: string;
    lineId?: string;
  }[],
  sourceSha256: string,
) {
  return `${JSON.stringify({ words: words.map((word) => ({ text: word.text, start: word.startSec, end: word.endSec, ...(word.speaker ? { speaker: word.speaker, sceneId: word.sceneId } : {}), ...(word.lineId ? { lineId: word.lineId } : {}) })), sourceSha256, timingMethod: "derived-from-provider-character-alignment" }, null, 2)}\n`;
}

export function validateKnownStitchingIds(ids: string[], jobs: GenerationJob[], model: string, now = Date.now()) {
  const requested = new Set(ids);
  for (const job of jobs) {
    if (!job.providerRequestId || !requested.has(job.providerRequestId) || job.provider !== "elevenlabs") continue;
    if (job.state !== "published" || job.quote?.model !== model)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Known stitching request must be published by the same model and endpoint type",
      });
    if (now - Date.parse(job.createdAt) > 2 * 60 * 60 * 1000)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Known stitching request is more than two hours old; use approved text context",
      });
  }
}

export async function executeStudioAudio(raw: unknown, execution: StudioExecution = {}) {
  const request = ElevenLabsAudioRequestSchema.parse(raw),
    root = path.resolve(execution.rootDir ?? process.cwd());
  const target = projectOutput(root, request.projectId, request.output);
  const scope = execution.scopeRoot ?? root;
  const speech = request.task === "tts" || request.task === "dialogue";
  const format = request.task === "isolate" ? undefined : request.outputFormat;
  if (format && path.extname(target.file) !== (format.startsWith("wav_") ? ".wav" : ".mp3"))
    throw Error("Audio output extension must match the selected format");
  const turns = request.task === "dialogue" ? request.turns : request.task === "isolate" ? [] : [request];
  for (const turn of turns) {
    if (turn.voiceRef && request.task !== "isolate") verifyVoiceRef(root, turn.voiceRef, scope, request.task);
    if ("approvedText" in turn && turn.approvedText && "text" in turn)
      validateDirectedText(turn.approvedText, turn.text, turn.pronunciations);
  }
  const source = !speech ? regularInput(root, request.source, scope) : undefined;
  const sourceMetadata = source ? inspectAsset(source.file) : undefined;
  if (sourceMetadata && !sourceMetadata.media.hasAudio) throw Error("Transform source has no audio");
  if (request.task === "voice-change" && sourceMetadata!.media.durationSec! > MAX_VOICE_CHANGE_SECONDS)
    throw Error("Voice changer accepts at most five minutes per request");
  const voice =
    request.task === "tts"
      ? (request.voiceRef?.voiceId ?? request.voiceId)
      : request.task === "voice-change"
        ? (request.voiceRef?.voiceId ?? request.voiceId)
        : undefined;
  const endpoint =
    request.task === "tts"
      ? `/v1/text-to-speech/${voice}/with-timestamps`
      : request.task === "dialogue"
        ? "/v1/text-to-dialogue/with-timestamps"
        : request.task === "isolate"
          ? "/v1/audio-isolation"
          : `/v1/voice-changer/${voice}`;
  const logical = logicalJson({
    ...request,
    operationId: undefined,
    maxCostUsd: undefined,
    output: target.relative,
    ...(source ? { source: { sha256: source.sha256, bytes: source.bytes } } : {}),
  });
  const identity = { endpoint, request: logical };
  const takeFile = `${target.file}.take.json`;
  const take = existsSync(takeFile) ? JSON.parse(readFileSync(takeFile, "utf8")) : undefined;
  const takeMatches =
    take &&
    (take.canonicalInput
      ? take.canonicalInput.version === 2 && take.canonicalInput.sha256 === canonicalInputIdentity(identity).sha256
      : take.inputHash === generationInputHash(identity));
  const { operationId, existing } = studioOperationIdentity(request.projectId, root, execution.store, {
    input: { ...identity, destination: target.relative },
    idInput: identity,
    operationId:
      request.operationId ?? (takeMatches && typeof take.operationId === "string" ? take.operationId : undefined),
    provider: "elevenlabs",
    endpoint,
    assetId: target.relative,
    id: (hash) => `el:${request.task}:${hash.slice(0, 40)}`,
  });
  const model =
    request.task === "isolate"
      ? "elevenlabs:isolation"
      : request.task === "tts"
        ? request.model === "eleven_v3"
          ? "elevenlabs:tts-v3"
          : request.model === "eleven_multilingual_v2"
            ? "elevenlabs:tts-v2"
            : `elevenlabs:${request.model}`
        : `elevenlabs:${request.task === "dialogue" ? (request.model === "eleven_v3" ? "dialogue" : "dialogue-v4") : request.model}`;
  const units = speech
    ? (request.task === "tts" ? request.text.length : request.turns.reduce((sum, turn) => sum + turn.text.length, 0)) /
      1000
    : request.task === "voice-change"
      ? sourceMetadata!.media.durationSec! / 60
      : undefined;
  if (take) {
    if (
      !takeMatches ||
      take.operationId !== operationId ||
      !existsSync(target.file) ||
      digest(readFileSync(target.file)) !== take.sha256
    )
      throw Error("Existing take does not match the immutable operation");
    const outputs = [target.file, takeFile];
    let alignmentRecoveryRequired = false;
    if (take.timing?.words) {
      const words = speechAlignmentBytes(take.timing.words, take.sha256);
      if (take.alignmentSha256 !== digest(words)) throw Error("Timing receipt checksum changed");
      const sidecar = speechAlignmentPath(target.file);
      if (existsSync(sidecar) && regularInput(root, sidecar, scope, 64 * 1024 * 1024).sha256 !== take.alignmentSha256)
        throw Error("Existing immutable timing sidecar differs");
      alignmentRecoveryRequired = !existsSync(sidecar);
      if (execution.dryRun === false) immutableWrite(sidecar, words);
      if (existsSync(sidecar)) outputs.push(sidecar);
    }
    return {
      outputs,
      metadata: {
        state: execution.dryRun === false ? "published" : "planned",
        take,
        replay: true,
        alignmentRecoveryRequired,
      },
    };
  }
  if (existsSync(target.file)) {
    const store = studioStore(request.projectId, root, execution.store);
    if (!existsSync(store.file) || store.snapshot().jobs[operationId]?.state !== "published")
      throw new CliErrorObject({ code: "FILE_EXISTS", message: "Choose a new immutable output path" });
  }
  if (!speech && request.provider === "fal") return executeFalTransform(request, source!.file, execution);
  if (speech && (!existing || existing.state === "reserved")) {
    const ids = [...(request.previousRequestIds ?? []), ...(request.nextRequestIds ?? [])];
    if (ids.length) {
      const store = studioStore(request.projectId, root, execution.store);
      if (existsSync(store.file)) validateKnownStitchingIds(ids, Object.values(store.snapshot().jobs), model);
    }
  }
  const reservation =
    retainedStudioQuote(request.projectId, root, operationId, execution.store) ??
    operationQuote(model, request.maxCostUsd, units);
  if (execution.dryRun !== false)
    return {
      outputs: [],
      metadata: {
        state: "planned",
        operationId,
        endpoint,
        quote: reservation,
        executable: reservation !== null,
        request: logical,
        liveVerified: false,
        nextAction: reservation ? "review-budget-and-execute" : "supply-authorised-maxCostUsd",
      },
    };
  const client = new ElevenLabsClient(execution);
  const { response } = await paidStudioResponse({
    projectId: request.projectId,
    root,
    task: request.task,
    endpoint,
    identity,
    output: target.relative,
    model,
    bound: request.maxCostUsd,
    units,
    operationId,
    execution,
    perform: async () => {
      if (source && regularInput(root, source.file, scope).sha256 !== source.sha256)
        throw Error("Source changed before upload");
      const query = new URLSearchParams();
      if (format) query.set("output_format", format);
      if ("enableLogging" in request && request.enableLogging !== undefined)
        query.set("enable_logging", String(request.enableLogging));
      const route = query.size ? `${endpoint}?${query}` : endpoint;
      if (speech) return client.post(route, speechBody(request));
      const form = new FormData();
      await appendFile(form, "audio", source!.file);
      if (request.task === "voice-change") {
        form.set("model_id", request.model);
        if (request.settings) form.set("voice_settings", JSON.stringify(request.settings));
        if (request.removeBackgroundNoise !== undefined)
          form.set("remove_background_noise", String(request.removeBackgroundNoise));
        if (request.seed !== undefined) form.set("seed", String(request.seed));
      }
      return client.post(route, form);
    },
  });
  const rawResponse = speech ? SpeechResponseSchema.parse(await response.json()) : undefined;
  if (rawResponse && !/^[a-zA-Z0-9+/]+={0,2}$/.test(rawResponse.audio_base64))
    throw Error("Invalid provider audio encoding");
  const bytes = rawResponse
    ? Buffer.from(rawResponse.audio_base64, "base64")
    : Buffer.from(await response.arrayBuffer());
  const directory = mkdtempSync(path.join(tmpdir(), "el-audio-"));
  try {
    const temporary = path.join(directory, "take.bin");
    writeFileSync(temporary, bytes);
    const media = inspectAsset(temporary);
    if (media.kind !== "audio" || !media.media.hasAudio || media.media.width !== undefined)
      throw Error("Provider output is not a valid audio-only take");
    if (format && (format.startsWith("wav_") ? media.media.codec !== "pcm_s16le" : media.media.codec !== "mp3"))
      throw Error("Provider output codec differs from the requested format");
    if (source && regularInput(root, source.file, scope).sha256 !== source.sha256)
      throw Error("Source changed during processing");
    let words: ReturnType<typeof characterWords> | undefined, timingIssue: string | undefined;
    let alignmentSource: "original" | "normalised" | undefined;
    if (speech && rawResponse) {
      const alignments = [
        ["original", rawResponse.alignment],
        ["normalised", rawResponse.normalized_alignment],
      ] as const;
      const expectedSpoken =
        request.task === "tts" ? request.expectedSpokenText : request.turns.some((turn) => turn.expectedSpokenText);
      for (const [source, alignment] of expectedSpoken ? [...alignments].reverse() : alignments) {
        if (!alignment) continue;
        try {
          const candidate = characterWords(
            alignment,
            request.task === "tts" ? request.text : request.turns.map((turn) => turn.text).join(""),
            media.media.durationSec!,
            request.task === "dialogue" ? request.turns : undefined,
            rawResponse.voice_segments,
            request.language,
            request.task === "tts" ? request : undefined,
          );
          if (!candidate.length) throw Error("Provider alignment contains no words");
          words = candidate;
          alignmentSource = source;
          timingIssue = undefined;
          break;
        } catch (error) {
          timingIssue = error instanceof Error ? error.message : String(error);
        }
      }
      if (!words) timingIssue ??= "Provider supplied no usable character alignment";
    }
    const parent = source
      ? importAsset({
          rootDir: root,
          projectId: request.projectId,
          sourceFile: source.file,
          provenance: { origin: "manual" },
        })
      : undefined;
    const imported = importAsset({
      rootDir: root,
      projectId: request.projectId,
      sourceFile: temporary,
      provenance: {
        origin: "provider",
        tool: `elevenlabs:${request.task}`,
        referenceAssetIds: parent ? [parent.asset.id] : [],
        billing: { status: "unknown" },
      },
    });
    const wordBytes = words ? speechAlignmentBytes(words, digest(bytes)) : undefined;
    const take = {
      version: 1,
      provider: "elevenlabs",
      task: request.task,
      operationId,
      inputHash: generationInputHash(identity),
      canonicalInput: canonicalInputIdentity(identity),
      sha256: digest(bytes),
      assetId: imported.asset.id,
      src: imported.asset.files.original,
      request: logical,
      model: speech ? request.model : model,
      pricingModel: model,
      ...(response.headers.get("request-id") ? { providerRequestId: response.headers.get("request-id") } : {}),
      ...(response.headers.get("character-cost")
        ? { characterCost: Number(response.headers.get("character-cost")) }
        : {}),
      ...(voice ? { voiceId: voice } : {}),
      ...(request.task === "tts" && request.voiceRef ? { voiceRef: request.voiceRef } : {}),
      liveVerified: false,
      ...(source
        ? {
            source: {
              sha256: source.sha256,
              assetId: parent!.asset.id,
              durationSec: sourceMetadata!.media.durationSec,
            },
            clock: {
              status: "requires-review",
              outputDurationSec: media.media.durationSec,
              durationDeltaSec: media.media.durationSec! - sourceMetadata!.media.durationSec!,
            },
            alignmentRequired: true,
          }
        : { alignmentRequired: !words }),
      ...(words
        ? {
            alignmentSha256: digest(wordBytes!),
            timing: {
              method: "derived-from-provider-character-alignment",
              source: alignmentSource,
              words,
              authored: request.task === "tts" ? request.text : request.task === "dialogue" ? request.turns : null,
            },
          }
        : {}),
      ...(timingIssue && !words ? { timingIssue } : {}),
      output: target.relative,
    };
    immutableWrite(target.file, bytes);
    const outputs = [target.file, takeFile];
    if (words) {
      const alignmentFile = speechAlignmentPath(target.file);
      immutableWrite(alignmentFile, wordBytes!);
      outputs.push(alignmentFile);
    }
    immutableWrite(takeFile, `${JSON.stringify(take, null, 2)}\n`);
    return {
      outputs,
      metadata: {
        state: "published",
        take,
        budget: configuredStore(request.projectId, root, execution.store).summary(),
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function executeFalTransform(
  request: Extract<ElevenLabsAudioRequest, { task: "isolate" | "voice-change" }>,
  source: string,
  execution: StudioExecution,
) {
  if (execution.rootDir && path.resolve(execution.rootDir) !== process.cwd())
    throw Error("Fal execution uses the current workspace root");
  const { buildFalOperation, requireExecutableFalOperation, resolveFalSnapshotForPlan, validateFalOperationResult } =
    await import("../providers/fal-operations");
  const { executeFalOperation } = await import("../jobs/execution");
  const { quoteInputForPlan } = await import("../providers/fal-quote-input");
  const { openApiRoutes } = await import("../providers/fal-openapi");
  const { readCachedApiModel } = await import("../models/fal-catalog");
  const endpoint = request.task === "isolate" ? "fal-ai/elevenlabs/audio-isolation" : "fal-ai/elevenlabs/voice-changer";
  const sourceInfo = regularInput(process.cwd(), source, execution.scopeRoot, 8 * 1024 * 1024);
  if (
    request.task === "voice-change" &&
    request.settings &&
    Object.keys(request.settings).some(
      (key) => !["stability", "similarity_boost", "style", "use_speaker_boost"].includes(key),
    )
  )
    throw Error("The fal voice-changer route does not support these settings");
  const input = {
    audio_url: `data:${inspectAsset(source).mime};base64,${readFileSync(source).toString("base64")}`,
    ...(request.task === "voice-change"
      ? { voice: request.voiceRef?.voiceId ?? request.voiceId, model_id: request.model, ...request.settings }
      : {}),
  };
  const context = { speechLanguage: request.task === "voice-change" ? request.language : undefined };
  const plan = buildFalOperation({ endpoint, input, context });
  requireExecutableFalOperation(plan);
  const snapshot = resolveFalSnapshotForPlan(plan);
  const api = readCachedApiModel(snapshot.sha256);
  const references =
    execution.dryRun === false
      ? [importAsset({ projectId: request.projectId, sourceFile: source, provenance: { origin: "manual" } }).asset.id]
      : [];
  const result = await executeFalOperation({
    projectId: request.projectId,
    endpoint,
    input: plan.input,
    output: request.output,
    model: endpoint,
    mediaKind: "audio",
    dryRun: execution.dryRun !== false,
    operationId: request.operationId,
    maxCostUsd: request.maxCostUsd,
    referenceAssetIds: references,
    queuePath: api ? openApiRoutes(api)?.submitPath.replace(/^\//, "") : undefined,
    resultSchema: { schema: snapshot.output, components: snapshot.schemas },
    quoteInput: quoteInputForPlan(plan, plan.input, context),
    validateResult: (data) => validateFalOperationResult(endpoint, data),
  });
  const derivation = {
    sourceSha256: sourceInfo.sha256,
    referenceAssetIds: references,
    clock: "requires-review",
    alignmentRequired: true,
  };
  if (result.metadata.state === "published")
    immutableWrite(
      `${request.output}.transform.json`,
      `${JSON.stringify({ version: 1, provider: "fal", operationId: result.metadata.operationId, ...derivation }, null, 2)}\n`,
    );
  return { ...result, metadata: { ...result.metadata, state: String(result.metadata.state ?? "planned"), derivation } };
}
