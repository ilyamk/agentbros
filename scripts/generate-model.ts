import { verifyRemoteMedia } from "../src/lib/assets/remote-media";
/** Schema-validated modern fal operation. No arbitrary endpoint passthrough. */
import { estimateHiggsfield } from "../src/lib/models/hf-pricing";
import { createHiggsfieldClient } from "../src/lib/providers/higgsfield/client";
import { prepareHiggsfieldInput } from "../src/lib/providers/higgsfield/uploads";
import { HiggsfieldUploadCache } from "../src/lib/providers/higgsfield/upload-cache";
import { generationRequestBody } from "../src/lib/jobs/request-body";
import { prepareSeedanceForecast } from "../src/lib/jobs/seedance-forecast";
import { resolveImportedReferences } from "../src/lib/assets/provider-references";
import { resolveOperationIdentity } from "../src/lib/jobs/identity";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { executeFalNonMedia } from "../src/lib/jobs/nonmedia";
import {
  falCallerIdentity,
  deriveSeedanceCompletion,
  recordSeedanceDraftIntent,
} from "../src/lib/jobs/seedance-drafts";
import { digest } from "../src/lib/jobs/model-artifacts";
import { generationInputHash } from "../src/lib/jobs/runner";
import { parseArgs, runScript, CliErrorObject, emitProgress, requireEnv, requireProject } from "../src/lib/cli";
import {
  buildFalOperation,
  requireExecutableFalOperation,
  validateFalOperationResult,
  FalOperationError,
  resolveFalSnapshotForPlan,
  listFalOperationAdapters,
} from "../src/lib/providers/fal-operations";
import { FalEndpointRequestSchema, FalOperationRequestSchema, type FalAnyRequest } from "../src/types/generation";
import { executeFalOperation, PAID_CLI_SPECS } from "../src/lib/jobs/execution";
import { quoteInputForPlan } from "../src/lib/providers/fal-quote-input";
import { primaryKind } from "../src/lib/providers/fal-results";
import { findCatalogEntry, readCachedApiModel } from "../src/lib/models/fal-catalog";
import { openApiRoutes } from "../src/lib/providers/fal-openapi";
import { executeFalHttpStream } from "../src/lib/providers/stream/service";
import { genjutsuMode } from "../src/lib/model-preparation/profiles";
import { readOutputMotion } from "../src/lib/sensors/motion-expect";
import { preparationAdmission } from "../src/lib/model-preparation/approval";
import { jobSubmitted, referencePackGate, type ReferencePackGate } from "../src/lib/references/packs/admission";
runScript(async () => {
  const args = parseArgs([
    ...PAID_CLI_SPECS,
    {
      name: "request",
      required: true,
      description:
        "JSON FalEndpointRequest or FalOperationRequest file (exact provider input and routing/context). A context.referencePack request must be refs:pack --action request's request.json for an approved pack. Reference inputs on a profiled endpoint without a pack: AGENTBROS_REFERENCE_PACKS=warn (default) | enforce (refuse) | off",
    },
    { name: "scope-root", description: "Trusted MCP workspace boundary for nested local references" },
    {
      name: "output",
      required: true,
      description:
        "Output file, resolved from the current directory, not from --project: run from the repository root and pass public/projects/<id>/assets/...; the operation ID derives from the resolved path, so resume with the same path from the same directory (or --operation-id). Text/JSON use it only as stable manifest identity",
    },
    { name: "project", description: "Project for durable jobs/budgets" },
    { name: "stage", description: "Pipeline stage" },
    { name: "asset-id", description: "Asset-plan ID" },
    { name: "force", type: "boolean", description: "Overwrite target output" },
    {
      name: "allow-unvalidated",
      type: "boolean",
      description: "Explicitly permit Higgsfield catalogue requests without a documented schema",
    },
    {
      name: "provider-estimate",
      type: "boolean",
      description:
        "Validate a schema-less Higgsfield request with the free estimate API before execution; dry-run remains offline",
    },
    { name: "token-forecast", description: "Optional JSON TokenUsage forecast for pricing" },
  ] as const);
  // "-" (or /dev/stdin) reads descriptor 0: on Linux a spawned child's stdin is a socket, which open("/dev/stdin") refuses (ENXIO).
  const raw = JSON.parse(
    readFileSync(args.request === "-" || args.request === "/dev/stdin" ? 0 : args.request!, "utf8"),
  );
  let request: FalAnyRequest =
    raw && typeof raw === "object" && "endpoint" in raw
      ? FalEndpointRequestSchema.parse(raw)
      : FalOperationRequestSchema.parse(raw);
  // Draft lineage and bounded streams retain their existing tracked-request contracts.
  if ("endpoint" in request && request.provider !== "higgsfield") {
    const endpointRequest = request;
    const adapter = listFalOperationAdapters().find(
      (item) =>
        item.endpoint === endpointRequest.endpoint &&
        (!endpointRequest.transport || item.transport === endpointRequest.transport) &&
        (!endpointRequest.region || item.region === endpointRequest.region),
    );
    if (adapter && (adapter.family === "seedance-2.5" || adapter.transport === "stream")) {
      request = FalOperationRequestSchema.parse({
        family: adapter.family,
        variant: adapter.variant,
        operation: adapter.operation,
        transport: adapter.transport,
        region: adapter.region,
        input: request.input,
        context: request.context,
      });
    }
  }
  const originalRequest = structuredClone(request);
  const references = resolveImportedReferences(request, args.project, process.cwd(), undefined, args["scope-root"]);
  request = references.request;
  let callerIdentity: string | undefined;
  if (
    "family" in request &&
    request.family === "seedance-2.5" &&
    (request.input.draft === true || request.operation === "complete")
  ) {
    callerIdentity = args["dry-run"] ? request.context?.callerId : falCallerIdentity(requireEnv("FAL_KEY"));
    if (request.operation === "complete") {
      if (!args.project || !callerIdentity)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message:
            "Completion needs --project and verified original account. Offline dry-run may supply the stored credential fingerprint as context.callerId.",
        });
      requireProject(args.project);
      request = FalOperationRequestSchema.parse(deriveSeedanceCompletion(args.project, request, callerIdentity));
    }
  }
  let plan: ReturnType<typeof buildFalOperation>;
  let packGate: ReferencePackGate = { warnings: [], executable: true, reasons: [] };
  let higgsfieldEstimateBody: string | undefined;
  let higgsfieldPricingInput: Record<string, unknown> | undefined;
  try {
    plan = buildFalOperation(request, { allowUnvalidated: args["allow-unvalidated"] });
    const { existing } = resolveOperationIdentity({
      input: plan.input,
      projectId: args.project,
      operationId: args["operation-id"],
      endpoint: plan.endpoint,
      provider: plan.provider === "higgsfield" ? "higgsfield" : "fal.ai",
      assetId: args["asset-id"] ?? path.resolve(args.output!),
      id: (hash) => `${plan.provider}:${digest(`${plan.endpoint}:${hash}:${path.resolve(args.output!)}`).slice(0, 40)}`,
    });
    const resumingHiggsfield = existing?.provider === "higgsfield" && existing.endpoint === plan.endpoint;
    if (
      !args["dry-run"] &&
      genjutsuMode(plan.endpoint, plan.provider) &&
      (!resumingHiggsfield || request.context?.modelPreparation)
    ) {
      const admission = preparationAdmission(
        args.project,
        request.context?.modelPreparation,
        plan.endpoint,
        plan.input,
      );
      if (!admission.ready)
        throw new CliErrorObject({ code: "STAGE_INCOMPLETE", message: admission.blockers.join(" ") });
    }
    // RFC 0003 D8: a bound reference pack is verified; reference inputs without one warn or are refused.
    packGate = referencePackGate({
      projectId: args.project,
      raw,
      provider: plan.provider,
      endpoint: plan.endpoint,
      input: originalRequest.input,
      // Only a job that may have reached the provider resumes past the gate; a reserved one is admitted again.
      resuming: jobSubmitted(existing),
      dryRun: args["dry-run"] === true,
    });
    for (const warning of packGate.warnings) emitProgress(warning);
    if (!args["dry-run"] && resumingHiggsfield && !plan.verification.schema && args["provider-estimate"])
      plan = buildFalOperation(request, { allowUnvalidated: true });
    if (!args["dry-run"] && !resumingHiggsfield && plan.provider === "higgsfield" && args["provider-estimate"]) {
      if (!args.project)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: "Paid generation requires --project for durable budget tracking and the Higgsfield upload cache.",
        });
      requireProject(args.project);
      if (request.context?.remoteMedia?.length) await verifyRemoteMedia(args.project, request.context.remoteMedia);
      const credentials = requireEnv("HIGGSFIELD_API_KEY");
      higgsfieldPricingInput = await prepareHiggsfieldInput(plan.input, {
        client: createHiggsfieldClient({ credentials }),
        cache: new HiggsfieldUploadCache(args.project),
        uploads: [],
        persistUpload: () => {},
        onReferencePrepared: (source, url) => {
          if (request.context?.media?.[source]) request.context.media[url] = request.context.media[source];
        },
      });
      higgsfieldEstimateBody = generationRequestBody(higgsfieldPricingInput);
      await estimateHiggsfield(plan.endpoint, higgsfieldPricingInput, (url, init) => fetch(url, init), {
        apiKey: credentials,
        maxRetries: 0,
      });
      if (!plan.verification.schema) {
        plan = buildFalOperation(request, { allowUnvalidated: true });
        plan.warnings.push("Schema-less request validated by the provider estimate API for this execution.");
      }
    }
    if (!args["dry-run"]) requireExecutableFalOperation(plan);
  } catch (error) {
    if (error instanceof FalOperationError)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: error.message,
        details: {
          providerCode: error.code,
          ...(error.code === "SCHEMA_NOT_CACHED" && "endpoint" in request
            ? {
                nextAction:
                  request.provider === "higgsfield"
                    ? "Refresh the Higgsfield catalogue/schema snapshot."
                    : `pnpm fal:sync --schemas ${request.endpoint}`,
              }
            : {}),
        },
      });
    throw error;
  }
  const inputHash = generationInputHash(plan.input);
  const withPack = <T extends { metadata: Record<string, unknown> }>(result: T): T => ({
    ...result,
    metadata: {
      ...result.metadata,
      ...(packGate.referencePack ? { referencePack: packGate.referencePack } : {}),
      ...(packGate.speech ? { speech: packGate.speech } : {}),
      ...(packGate.warnings.length
        ? { warnings: [...((result.metadata.warnings as string[] | undefined) ?? []), ...packGate.warnings] }
        : {}),
      ...(packGate.executable ? {} : { executable: false, notExecutableReasons: packGate.reasons }),
    },
  });
  const videoForecast =
    "family" in originalRequest && "family" in request ? prepareSeedanceForecast(originalRequest, request, plan) : {};
  if ("endpoint" in request && request.context?.videoForecast)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Seedance video forecast: only Seedance 2.5 operations support this forecast.",
    });
  const snapshot = resolveFalSnapshotForPlan(plan);
  const entry = plan.provider === "fal" ? findCatalogEntry(plan.endpoint) : undefined;
  const apiModel = entry?.schema ? readCachedApiModel(entry.schema.sha256) : undefined;
  const queuePath = apiModel ? openApiRoutes(apiModel)?.submitPath.replace(/^\//, "") : undefined;
  const mediaKind = primaryKind(plan.outputKinds ?? []);
  if (!mediaKind)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Operation has no supported output kinds." });
  const quoteInput = quoteInputForPlan(plan, plan.input, request.context);
  if (higgsfieldPricingInput) quoteInput.providerInput = higgsfieldPricingInput;
  const routing = {
    category: plan.category,
    tier: plan.tier,
    outputKinds: plan.outputKinds,
    mediaKind,
    queuePath: queuePath ?? null,
    retiresAt: plan.retiresAt ?? null,
    replacement: plan.replacement ?? null,
    quoteInput,
  };
  if (plan.transport === "realtime") {
    const message =
      "Realtime requires generate:realtime with RealtimeSessionRequest, session/revision identity, whole-session quote and explicit bounds.";
    if (!args["dry-run"]) throw new CliErrorObject({ code: "INVALID_INPUT", message });
    return withPack({
      outputs: [],
      metadata: { dryRun: true, executable: false, inputHash, ...routing, plan, nextAction: message },
    });
  }
  if (plan.transport === "stream") {
    if ("endpoint" in request)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Stream execution requires a tracked bounded stream adapter.",
      });
    const result = await executeFalHttpStream({
      request,
      output: args.output!,
      projectId: args.project,
      operationId: args["operation-id"],
      maxCostUsd: args["max-cost-usd"],
      dryRun: args["dry-run"] === true,
      force: args.force,
      stage: args.stage,
      assetId: args["asset-id"],
      referenceAssetIds: references.referenceAssetIds,
    });
    return withPack({
      ...result,
      metadata: { ...result.metadata, ...(args["dry-run"] ? { inputHash, ...routing } : {}), plan },
    });
  }
  // Only these pinned schemas bind element voice IDs to the published v3
  // audio/voice tariff. Do not infer pricing conditions for sibling operations.
  const voiceTariffEndpoint = [
    "fal-ai/kling-video/v3/pro/image-to-video",
    "fal-ai/kling-video/v3/standard/image-to-video",
  ].includes(plan.endpoint);
  const voiceControl =
    voiceTariffEndpoint &&
    Array.isArray(plan.input.elements) &&
    plan.input.elements.some((element: unknown) => {
      if (!element || typeof element !== "object") return false;
      const voiceId = (element as Record<string, unknown>).voice_id;
      return typeof voiceId === "string" && voiceId.trim().length > 0;
    });
  if (voiceControl && plan.input.generate_audio === false)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "Kling element voice control requires generated audio; set generate_audio:true or remove the voice binding.",
    });
  const tokenForecast = args["token-forecast"] ? JSON.parse(readFileSync(args["token-forecast"], "utf8")) : undefined;
  Object.assign(
    quoteInput,
    voiceTariffEndpoint ? { voiceControl } : {},
    tokenForecast ? { tokens: tokenForecast } : {},
    videoForecast.quoteInput,
  );
  const { operationId } = resolveOperationIdentity({
    input: plan.input,
    projectId: args.project,
    operationId: args["operation-id"],
    endpoint: plan.endpoint,
    provider: plan.provider === "higgsfield" ? "higgsfield" : "fal.ai",
    assetId: args["asset-id"] ?? path.resolve(args.output!),
    id: (hash) => `${plan.provider}:${digest(`${plan.endpoint}:${hash}:${path.resolve(args.output!)}`).slice(0, 40)}`,
  });
  if (!args["dry-run"] && plan.family === "seedance-2.5" && plan.input.draft === true) {
    if (!args.project || !callerIdentity)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Draft needs durable --project and account identity.",
      });
    requireProject(args.project);
    recordSeedanceDraftIntent(args.project, operationId, plan, callerIdentity);
  }
  if (plan.category === "training" || plan.transport === "training" || plan.family === "kling-voice") {
    const result = await executeFalNonMedia({
      providerId: plan.provider,
      projectId: args.project,
      endpoint: plan.endpoint,
      model: plan.endpoint,
      input: plan.input,
      output: args.output!,
      kind: plan.family === "kling-voice" ? "voice" : "training",
      remoteMedia: request.context?.remoteMedia,
      referenceAssetIds: references.referenceAssetIds,
      ...(plan.family === "catalog"
        ? { resultSchema: { schema: snapshot.output, components: snapshot.schemas }, queuePath }
        : {}),
      operationId,
      maxCostUsd: args["max-cost-usd"],
      dryRun: args["dry-run"],
      stage: args.stage,
      assetId: args["asset-id"],
      quoteInput: { ...quoteInput, units: 1 },
      validateResult: (data) => validateFalOperationResult(plan.endpoint, data, plan.provider),
    });
    return withPack({
      ...result,
      metadata: {
        ...result.metadata,
        ...(args["dry-run"] ? { inputHash, ...routing } : {}),
        executable: plan.executable && result.metadata.executable !== false,
        plan,
      },
    });
  }
  const result = await executeFalOperation({
    providerId: plan.provider,
    projectId: args.project,
    endpoint: plan.endpoint,
    model: plan.endpoint,
    input: plan.input,
    output: args.output!,
    mediaKind,
    resultSchema: { schema: snapshot.output, components: snapshot.schemas },
    queuePath,
    referenceAssetIds: references.referenceAssetIds,
    remoteMedia: request.context?.remoteMedia,
    operationId,
    maxCostUsd: args["max-cost-usd"],
    dryRun: args["dry-run"],
    force: args.force,
    stage: args.stage,
    assetId: args["asset-id"],
    forecastEvidence: videoForecast.evidence,
    modelPreparation: request.context?.modelPreparation,
    referencePack: packGate.referencePack
      ? { id: packGate.referencePack.id, sha256: packGate.referencePack.sha256 }
      : undefined,
    referencePackGated: true,
    quoteInput,
    higgsfieldEstimateBody,
    validateResult: (result) => {
      validateFalOperationResult(plan.endpoint, result, plan.provider);
      if (
        plan.family === "seedance-2.5" &&
        plan.input.draft === true &&
        (typeof result.draft_id !== "string" || !result.draft_id)
      )
        throw new CliErrorObject({ code: "VALIDATION", message: "Draft response has no completion ID." });
    },
  });
  // A published video gets a free local motion reading, and a verdict against context.expect. The asset is paid for and
  // kept either way, so a failed expectation changes nextAction, never ok.
  const motion =
    mediaKind === "video" && !args["dry-run"] && result.outputs.length
      ? readOutputMotion(result.outputs, request.context?.expect)
      : undefined;
  if (motion?.acceptance?.passed === false) emitProgress(`Motion: ${motion.acceptance.findings.join(" ")}`);
  return withPack({
    ...result,
    metadata: {
      ...result.metadata,
      ...(args["dry-run"] ? { inputHash, ...routing } : {}),
      ...(videoForecast.evidence ? { videoForecast } : {}),
      ...(motion ? { motion: motion.motion } : {}),
      ...(motion?.acceptance ? { acceptance: motion.acceptance } : {}),
      ...(motion?.acceptance?.passed === false
        ? { nextAction: "review-motion", nextActions: ["review-motion", result.metadata.nextAction].filter(Boolean) }
        : {}),
      ...(!plan.executable && !plan.verification.schema
        ? {
            nextAction:
              "Schema unavailable: use --provider-estimate during authorised execution or --allow-unvalidated, plus a price or positive --max-cost-usd planning bound.",
          }
        : {}),
      executable:
        plan.executable &&
        plan.transport === "queue" &&
        plan.family !== "kling-voice" &&
        result.metadata.executable !== false,
      plan,
    },
  });
});
