/** Durable project-local SFX and foley takes, shared by `sfx:generate` and the asset dispatcher. Reinvoke identical options to resume. */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { assertPathWithin, CliErrorObject, requireProject } from "../cli";
import { inspectAsset } from "../assets/inspect";
import { importAsset } from "../assets/registry";
import { executeFalOperation, type ExecutionOptions } from "../jobs/execution";
import { generationInputHash } from "../jobs/runner";
import { digest, immutableWrite } from "../jobs/model-artifacts";
import {
  buildFalOperation,
  FalOperationError,
  requireExecutableFalOperation,
  resolveFalSnapshotForPlan,
  validateFalOperationResult,
} from "./fal-operations";
import { FAL_SFX_ENDPOINTS } from "./fal-guards/sound";
import { quoteInputForPlan } from "./fal-quote-input";
import { findCatalogEntry, readCachedApiModel } from "../models/fal-catalog";
import { openApiRoutes } from "./fal-openapi";
import type { FalOperationContext } from "../../types/generation";

export type SfxGenerationOptions = Pick<
  ExecutionOptions,
  "output" | "operationId" | "maxCostUsd" | "dryRun" | "provider" | "fetch"
> & {
  projectId: string;
  endpoint: string;
  prompt?: string;
  video?: string;
  durationSec?: number;
};

export async function runSfxGeneration(options: SfxGenerationOptions) {
  requireProject(options.projectId);
  assertPathWithin(path.resolve("public/projects", options.projectId), path.resolve(options.output));
  const route = FAL_SFX_ENDPOINTS[options.endpoint as keyof typeof FAL_SFX_ENDPOINTS];
  const entry = findCatalogEntry(options.endpoint);
  if (!route || !entry || !["verified", "live"].includes(entry.tier) || entry.status !== "active" || entry.retiresAt)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--endpoint must name an active verified SFX/foley endpoint; music uses generate:music.",
    });
  if (route.video !== !!options.video || (!route.video && !options.prompt?.trim()))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Text SFX needs --prompt; foley needs --video and optionally --prompt.",
    });
  if (options.durationSec !== undefined && (!Number.isFinite(options.durationSec) || options.durationSec <= 0))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--duration must be positive and finite." });
  const input: Record<string, unknown> = {};
  if (options.prompt !== undefined) input[route.promptField] = options.prompt;
  if (options.durationSec !== undefined) input[route.durationField] = options.durationSec;
  const extension = path.extname(options.output).slice(1).toLowerCase();
  if (options.endpoint === "elevenlabs/sound-effects/v3") {
    if (extension !== "mp3")
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "ElevenLabs SFX output must use .mp3." });
    input.output_format = "mp3_44100_128";
  } else if (route.video) {
    if (extension !== "wav")
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Foley output must use .wav." });
  } else {
    if (!["mp3", "wav", "flac", "ogg", "opus", "m4a", "aac"].includes(extension))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Unsupported Stable Audio SFX output extension." });
    input.output_format = extension;
  }
  const context: FalOperationContext = { media: {} };
  if (options.video) {
    const bytes = statSync(options.video).size;
    if (bytes > 8 * 1024 * 1024)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Foley inline video exceeds 8 MB; use generate:model with an uploaded URL for larger media.",
      });
    const inspected = inspectAsset(options.video);
    if (inspected.kind !== "video")
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--video must contain a video stream." });
    const url = `data:${inspected.mime};base64,${readFileSync(options.video).toString("base64")}`;
    input.video_url = url;
    input.num_samples = 1;
    input.preserve_speech = false;
    input.upload_audio_format = "wav";
    context.media![url] = {
      bytes,
      durationSec: inspected.media.durationSec,
      width: inspected.media.width,
      height: inspected.media.height,
    };
  }
  let plan;
  try {
    plan = buildFalOperation({ endpoint: options.endpoint, input, context });
    if (!options.dryRun) requireExecutableFalOperation(plan);
  } catch (error) {
    if (error instanceof FalOperationError) throw new CliErrorObject({ code: "INVALID_INPUT", message: error.message });
    throw error;
  }
  const snapshot = resolveFalSnapshotForPlan(plan);
  const apiModel = entry.schema ? readCachedApiModel(entry.schema.sha256) : undefined;
  const queuePath = apiModel ? openApiRoutes(apiModel)?.submitPath.replace(/^\//, "") : undefined;
  const inputSha256 = generationInputHash(plan.input);
  const operationId =
    options.operationId ??
    `fal:${digest(`${plan.endpoint}:${inputSha256}:${path.resolve(options.output)}`).slice(0, 40)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(operationId))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid operation ID." });
  const requestFile = path.resolve(
    "public/projects",
    options.projectId,
    "pipeline/model-requests",
    `${digest(operationId)}.json`,
  );
  const record = `${path.resolve(options.output)}.take.json`;
  assertPathWithin(path.resolve("public/projects", options.projectId), record);
  if (existsSync(record)) {
    const saved = JSON.parse(readFileSync(record, "utf8"));
    if (saved.endpoint !== plan.endpoint || saved.inputSha256 !== inputSha256 || saved.operationId !== operationId)
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: "Take record belongs to different inputs or operation.",
      });
  }
  if (!options.dryRun) {
    assertPathWithin(path.resolve("public/projects", options.projectId), requestFile);
    immutableWrite(
      requestFile,
      `${JSON.stringify({ endpoint: plan.endpoint, input: plan.input, context }, null, 2)}\n`,
    );
  }
  const referenceAssetIds =
    options.video && !options.dryRun
      ? [
          importAsset({ projectId: options.projectId, sourceFile: options.video, provenance: { origin: "manual" } })
            .asset.id,
        ]
      : [];
  const result = await executeFalOperation({
    ...options,
    operationId,
    input: plan.input,
    mediaKind: "audio",
    model: plan.endpoint,
    queuePath,
    referenceAssetIds,
    resultSchema: { schema: snapshot.output, components: snapshot.schemas },
    quoteInput: quoteInputForPlan(plan, plan.input, context),
    validateResult: (data) => {
      validateFalOperationResult(plan.endpoint, data);
    },
  });
  const take = {
    status: result.metadata.state === "published" ? "published" : "needs-generation",
    origin: "provider",
    endpoint: plan.endpoint,
    operationId: result.metadata.operationId,
    inputSha256,
    prompt: options.prompt ?? null,
    request: path.relative(process.cwd(), requestFile),
    assetIds: result.metadata.assetIds ?? [],
    src: result.outputs[0] ?? null,
  };
  const outputs = [...result.outputs];
  if (take.status === "published") {
    immutableWrite(record, `${JSON.stringify(take, null, 2)}\n`);
    outputs.push(path.relative(process.cwd(), record));
  }
  return {
    outputs,
    metadata: { ...result.metadata, take, plan, queuePath, quoteInput: quoteInputForPlan(plan, plan.input, context) },
  };
}
