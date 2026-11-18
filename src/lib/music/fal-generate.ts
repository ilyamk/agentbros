/** `generate:music --provider fal`: one durable fal job per take, resumed by re-running the same arguments. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, emitProgress, relativisePath, requireFile, requireProject } from "../cli";
import { logCost } from "../cli/cost-log";
import type { CompositionPlan } from "../elevenlabs-music";
import { executeFalOperation } from "../jobs/execution";
import type { JobProvider } from "../jobs/runner";
import { digest, immutableWrite } from "../jobs/model-artifacts";
import { generationInputHash } from "../jobs/runner";
import { OperationStore } from "../jobs/store";
import { pipelineDir } from "../pipeline/paths";
import { PRICING } from "../pricing";
import { buildFalMusicOperation, FalMusicError } from "../providers/fal-music";

export type FalMusicRun = {
  endpoint: string;
  prompt?: string;
  compositionPlanPath?: string;
  durationSec?: number;
  instrumental?: boolean;
  seed?: number;
  negativePrompt?: string;
  output: string;
  projectId?: string;
  assetId?: string;
  operationId?: string;
  maxCostUsd?: number;
  dryRun?: boolean;
  force?: boolean;
  provider?: JobProvider;
  fetch?: typeof fetch;
  pollMs?: number;
  timeoutMs?: number;
};

function probeDuration(file: string): number | null {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
    { encoding: "utf8" },
  );
  const value = Number.parseFloat(result.stdout?.trim() ?? "");
  return result.status === 0 && Number.isFinite(value) ? value : null;
}

function transcode(from: string, to: string): void {
  const args = [
    "-v",
    "error",
    "-y",
    "-i",
    from,
    ...(to.endsWith(".mp3") ? ["-codec:a", "libmp3lame", "-b:a", "320k"] : []),
    to,
  ];
  const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (result.error)
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffmpeg is needed to convert the provider container. Install with: brew install ffmpeg",
    });
  if (result.status !== 0)
    throw new CliErrorObject({ code: "FFMPEG_FAILED", message: `ffmpeg could not convert ${from}: ${result.stderr}` });
}

export async function runFalMusic(run: FalMusicRun): Promise<{ outputs: string[]; metadata: Record<string, unknown> }> {
  let compositionPlan: CompositionPlan | undefined;
  if (run.compositionPlanPath) {
    requireFile(run.compositionPlanPath);
    const raw: unknown = JSON.parse(readFileSync(run.compositionPlanPath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as CompositionPlan).sections)) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--composition-plan must be a JSON object with a sections array.",
      });
    }
    compositionPlan = raw as CompositionPlan;
  }
  let operation: ReturnType<typeof buildFalMusicOperation>;
  try {
    operation = buildFalMusicOperation(run.endpoint, {
      prompt: run.prompt,
      compositionPlan,
      durationSec: run.durationSec,
      instrumental: run.instrumental,
      seed: run.seed,
      negativePrompt: run.negativePrompt,
    });
  } catch (error) {
    if (error instanceof FalMusicError) throw new CliErrorObject({ code: "INVALID_INPUT", message: error.message });
    throw error;
  }
  const target = path.resolve(run.output);
  const extension = path.extname(target).slice(1).toLowerCase();
  if (extension !== "mp3" && extension !== "wav")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--output must end in .mp3 or .wav." });
  // The provider's own container is kept beside the requested file, so bytes always match their extension.
  const providerOutput =
    extension === operation.container ? target : target.replace(/\.[^.]+$/, `.${operation.container}`);
  const inputHash = generationInputHash(operation.input);
  const operationId =
    run.operationId ?? `fal:${digest(`${operation.endpoint}:${inputHash}:${providerOutput}`).slice(0, 40)}`;
  const execution = {
    projectId: run.projectId,
    endpoint: operation.endpoint,
    model: operation.model,
    input: operation.input,
    output: providerOutput,
    mediaKind: "audio" as const,
    stage: "audio",
    assetId: run.assetId,
    operationId,
    maxCostUsd: run.maxCostUsd,
    force: run.force,
    quoteInput: { units: operation.units },
    provider: run.provider,
    fetch: run.fetch,
    validateResult: (result: Record<string, unknown>) => {
      const audio = result.audio as { url?: unknown } | undefined;
      if (!audio || typeof audio.url !== "string")
        throw new CliErrorObject({ code: "VALIDATION", message: "fal music result has no audio.url." });
    },
  };
  const summary = {
    endpoint: operation.endpoint,
    model: operation.model,
    units: operation.units,
    unit: PRICING[operation.model].unit,
    durationControl: operation.definition.duration,
    providerOutput: relativisePath(providerOutput),
  };
  if (run.dryRun) {
    const dry = await executeFalOperation({ ...execution, dryRun: true });
    return { outputs: [], metadata: { ...dry.metadata, ...summary } };
  }
  if (!run.projectId)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Paid generation requires --project for durable budget tracking.",
    });
  requireProject(run.projectId);
  const store = new OperationStore(run.projectId);
  const already = existsSync(store.file) ? store.snapshot().jobs[operationId] : undefined;
  if (!already && providerOutput !== target && existsSync(target) && !run.force) {
    throw new CliErrorObject({ code: "FILE_EXISTS", message: `Output exists: ${target}. Pass --force to overwrite.` });
  }
  if (!already && !(await executeFalOperation({ ...execution, dryRun: true })).metadata.quote) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Unknown price requires an explicit --max-cost-usd planning bound.",
    });
  }
  const requestFile = path.join(
    pipelineDir(run.projectId),
    "model-requests",
    `${digest(operationId)}-${inputHash}.json`,
  );
  immutableWrite(
    requestFile,
    JSON.stringify({
      provider: "fal.ai",
      endpoint: operation.endpoint,
      model: operation.model,
      operationId,
      input: operation.input,
    }),
  );

  const deadline = Date.now() + (run.timeoutMs ?? 15 * 60_000);
  let result = await executeFalOperation(execution);
  while (
    result.metadata.state === "queued" ||
    result.metadata.state === "running" ||
    result.metadata.state === "reserved"
  ) {
    if (Date.now() > deadline)
      throw new CliErrorObject({
        code: "TIMEOUT",
        message: `fal job ${String(result.metadata.providerRequestId)} still ${String(result.metadata.state)}. Re-run the same command to resume; it will not resubmit.`,
      });
    emitProgress(`fal ${operation.endpoint}: ${String(result.metadata.state)}`);
    await new Promise((resolve) => setTimeout(resolve, run.pollMs ?? 5000));
    result = await executeFalOperation(execution);
  }
  if (result.metadata.state !== "published") {
    throw new CliErrorObject({
      code: result.metadata.state === "unknown" ? "NETWORK" : "VALIDATION",
      message: `fal music job ended ${String(result.metadata.state)}: ${String(result.metadata.error ?? "")}. Next: ${String(result.metadata.nextAction)} with the same arguments.`,
    });
  }
  if (providerOutput !== target && (!existsSync(target) || run.force || already?.state !== "published"))
    transcode(providerOutput, target);
  const measuredDurationSec = probeDuration(target);
  if (already?.state !== "published") {
    // The operation store is budget authority; the ledger feeds cost-report.
    logCost({
      projectId: run.projectId,
      stage: "audio",
      scriptId: "generate-music.ts",
      assetId: run.assetId,
      service: "fal.ai",
      provider: "fal",
      operationId,
      model: operation.model,
      units: operation.units,
      unitName: PRICING[operation.model].unit,
      notes: `endpoint=${operation.endpoint} operationId=${operationId}`,
    });
  }
  return {
    outputs: [relativisePath(target)],
    metadata: { ...result.metadata, ...summary, requestFile: relativisePath(requestFile), measuredDurationSec },
  };
}
