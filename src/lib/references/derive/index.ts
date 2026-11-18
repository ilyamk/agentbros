/**
 * Reference derivatives (RFC 0003 §6.4): plan, run and show one immutable derivative. Local ffmpeg and matte steps
 * (WP5); a leading fal step through the durable paid job path, or a leading Blender pass (WP5b).
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { CliErrorObject, ensureFfmpeg, ensureFfprobe } from "../../cli";
import { hashFile, importAsset, readAssetRegistry } from "../../assets/registry";
import { inspectAsset } from "../../assets/inspect";
import { immutableWrite } from "../../jobs/model-artifacts";
import { projectMediaFile } from "../../model-preparation/storage";
import { probeVideo } from "../../vision/media";
import type { AssetRecord } from "../../../types/assets";
import {
  DerivativeReceiptSchema,
  DerivativeSpecSchema,
  type DerivationStep,
  type DerivativeMediaPin,
  type DerivativeReceipt,
  type DerivativeSpec,
} from "../../../types/references";
import { derivativeBoard } from "./board";
import { runReferenceSensors, sensorEvidence } from "../sensors";
import { SEQUENCE_DIR, resolveBlendScene, runBlenderPass } from "./blender";
import { conformFalArgs, isFalStep, planFalStep, runFalStep, type FalCallOptions, type FalStepPlan } from "./fal";
import {
  LOUDNORM,
  compileStep,
  contactSheetCount,
  nextState,
  outputExtension,
  stepEngine,
  type MediaState,
  type PlannedStep,
} from "./ops";
import {
  PENDING_FILE,
  derivativeDigest,
  derivativeDirectory,
  derivativeProject,
  readDerivative,
  readDerivativePending,
  readDerivativeSpec,
  receiptLink,
  sha256Text,
  type DerivativePendingFile,
} from "./storage";

export { readDerivative, derivativeDirectory, receiptLink } from "./storage";
export { compileStep, nextState, stepEngine, type MediaState, type PlannedStep, type StepStatus } from "./ops";
export {
  FAL_DEFAULT_ENDPOINTS,
  falEndpointFor,
  falOperationId,
  falRequest,
  type FalCallOptions,
  type FalStepPlan,
} from "./fal";
export { PASSES_SCRIPT, resolveBlendScene } from "./blender";

const FFMPEG_TIMEOUT_MS = 600_000;

/** Runs ffmpeg with literal arguments; `-n` never overwrites. Returns stderr (for loudnorm's JSON summary). */
export function runDeriveFfmpeg(args: string[], level: "error" | "info" = "error"): string {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-v", level, "-n", ...args], {
    encoding: "utf8",
    timeout: FFMPEG_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffmpeg failed: ${result.error?.message ?? result.stderr.slice(-700)}`,
    });
  return result.stderr;
}
/** The first line of `ffmpeg -version`: the receipt's engine version, since outputs are reproducible per build. */
export function ffmpegVersion(): string {
  const result = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 30_000 });
  const line = result.stdout?.split("\n")[0]?.trim();
  if (result.status !== 0 || !line)
    throw new CliErrorObject({ code: "FFMPEG_MISSING", message: "ffmpeg -version failed." });
  return line;
}

/** Integrated loudness and true peak of a file's first audio stream (loudnorm analysis, nothing written). */
export function measureLoudness(file: string, lufs: number): { integratedLufs: number; truePeakDb: number } {
  const stderr = runDeriveFfmpeg(
    [
      "-protocol_whitelist",
      "file",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-af",
      `loudnorm=I=${lufs}:TP=${LOUDNORM.truePeakDb}:LRA=${LOUDNORM.lra}:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    "info",
  );
  const start = stderr.lastIndexOf("{"),
    end = stderr.lastIndexOf("}");
  let parsed: Record<string, string> = {};
  try {
    parsed = JSON.parse(stderr.slice(start, end + 1));
  } catch {
    throw new CliErrorObject({ code: "FFMPEG_FAILED", message: "loudnorm printed no measurement." });
  }
  const integratedLufs = Number(parsed.input_i),
    truePeakDb = Number(parsed.input_tp);
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDb))
    throw new CliErrorObject({ code: "FFMPEG_FAILED", message: "loudnorm measured silence or an invalid value." });
  return { integratedLufs, truePeakDb };
}

type Measured = { state: MediaState; mime: string };
function measure(file: string): Measured {
  if (file.endsWith(".json"))
    return { mime: "application/json", state: { kind: "json", hasAudio: false, hasAlpha: false } };
  const inspected = inspectAsset(file);
  const video = inspected.kind === "video" ? probeVideo(file) : undefined;
  return {
    mime: inspected.mime,
    state: {
      kind: inspected.kind,
      ...(video
        ? { width: video.width, height: video.height, fps: video.fps, frameCount: video.frameCount }
        : { width: inspected.media.width, height: inspected.media.height }),
      ...(inspected.kind !== "image" ? { durationSec: video?.durationSec ?? inspected.media.durationSec } : {}),
      hasAudio: inspected.media.hasAudio,
      hasAlpha: inspected.media.hasAlpha === true,
    },
  };
}
function pinOf(
  assetId: string,
  sha256: string,
  original: string,
  bytes: number,
  measured: Measured,
): DerivativeMediaPin {
  const { state } = measured;
  return {
    assetId,
    sha256,
    original,
    bytes,
    ...(state.width && state.height ? { width: state.width, height: state.height } : {}),
    contentType: measured.mime,
    ...(state.durationSec ? { durationSec: state.durationSec } : {}),
    ...(state.kind === "video" && state.fps ? { fps: state.fps } : {}),
    ...(state.kind === "video" && state.frameCount ? { frameCount: state.frameCount } : {}),
    hasAudio: state.hasAudio,
  };
}

type ResolvedInput = { asset: AssetRecord; file: string; pin: DerivativeMediaPin; state: MediaState };
/** An imported asset, or a previous derivative's output; the bytes must still match the registry hash. */
export function resolveDerivativeInput(
  projectId: string,
  spec: DerivativeSpec,
  rootDir = process.cwd(),
): ResolvedInput {
  let assetId: string;
  if ("derivativeId" in spec.input) {
    if (spec.input.derivativeId === spec.id)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "A derivative cannot take its own output as input." });
    const upstream = readDerivative(projectId, spec.input.derivativeId, rootDir);
    assetId = upstream.receipt.output.assetId;
  } else assetId = spec.input.assetId;
  const asset = readAssetRegistry(projectId, rootDir).assets.find((row) => row.id === assetId);
  if (!asset)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Asset ${assetId} is not in the project registry; import it with pnpm import:asset first.`,
    });
  if (!["image", "video", "audio"].includes(asset.kind))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Asset ${assetId} is ${asset.kind}, not media.` });
  const file = projectMediaFile(projectId, asset.files.original, rootDir);
  if (statSync(file).size !== asset.files.bytes || hashFile(file) !== asset.hash)
    throw new CliErrorObject({ code: "VALIDATION", message: `Imported original ${assetId} changed on disk.` });
  const measured = measure(file);
  if ((measured.state.kind as string) !== asset.kind)
    throw new CliErrorObject({ code: "VALIDATION", message: "Measured media kind differs from the asset record." });
  return {
    asset,
    file,
    state: measured.state,
    pin: pinOf(asset.id, asset.hash, asset.files.original, asset.files.bytes, measured),
  };
}

export type DerivativePlan = {
  id: string;
  specSha256: string;
  /**
   * none: never run; same: this spec already ran (run returns it); incomplete: this spec started; pending: its fal
   * step awaits the provider (re-run the same command); conflict: the id holds another spec.
   */
  existing: "none" | "same" | "incomplete" | "pending" | "conflict";
  input: DerivativeMediaPin;
  steps: PlannedStep[];
  output: MediaState;
  runnable: boolean;
  /** may-spend: a fal step; run needs the user's --confirm-spend and, for an unknown price, --max-cost-usd. */
  spend: "none" | "may-spend";
};

function existingState(directory: string, specSha256: string): DerivativePlan["existing"] {
  const stored = readDerivativeSpec(directory);
  if (!stored) return "none";
  if (derivativeDigest(stored) !== specSha256) return "conflict";
  if (existsSync(path.join(directory, "receipt.json"))) return "same";
  return existsSync(path.join(directory, PENDING_FILE)) ? "pending" : "incomplete";
}

/** Dry run: resolve and verify the input, walk the kind state machine and report each step's engine; writes nothing. */
export function planDerivative(projectId: string, input: unknown, rootDir = process.cwd()): DerivativePlan {
  const spec = DerivativeSpecSchema.parse(input);
  const directory = derivativeDirectory(projectId, spec.id, rootDir);
  const specSha256 = derivativeDigest(spec);
  const resolved = resolveDerivativeInput(projectId, spec, rootDir);
  let state = resolved.state;
  const steps = spec.steps.map((step, index): PlannedStep => {
    const before = state;
    state = nextState(index, step, state);
    return { index, op: step.op, ...stepEngine(step), inputKind: before.kind, outputKind: state.kind };
  });
  for (const step of spec.steps)
    if (step.op === "blender-pass") resolveBlendScene(derivativeProject(projectId, rootDir), step.scene);
  const engines = [...new Set(steps.map((step) => step.engine).filter((engine) => engine !== "ffmpeg"))];
  if (engines.length > 1)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `One derivative records one engine; this spec uses ${engines.join(" and ")}. Split it into chained derivatives (input.derivativeId).`,
    });
  return {
    id: spec.id,
    specSha256,
    existing: existingState(directory, specSha256),
    input: resolved.pin,
    steps,
    output: state,
    runnable: steps.every((step) => step.status !== "not-implemented"),
    spend: steps.some((step) => step.status === "paid") ? "may-spend" : "none",
  };
}

/** planDerivative plus, for a fal step, the validated generation request and its offline quote and admission preview. */
export async function planDerivativeSpend(
  projectId: string,
  input: unknown,
  rootDir = process.cwd(),
  options: Pick<FalCallOptions, "maxCostUsd"> = {},
): Promise<DerivativePlan & { fal?: FalStepPlan }> {
  const plan = planDerivative(projectId, input, rootDir);
  const spec = DerivativeSpecSchema.parse(input);
  const first = spec.steps[0]!;
  if (!isFalStep(first) || plan.steps[0]!.status !== "paid") return plan;
  const resolved = resolveDerivativeInput(projectId, spec, rootDir);
  return {
    ...plan,
    fal: await planFalStep(projectId, spec.id, 0, first, resolved.state, resolved.asset, rootDir, options),
  };
}

export type DerivativeRunResult = {
  status: "ready";
  receipt: DerivativeReceipt;
  sha256: string;
  directory: string;
  asset: AssetRecord;
  reused: boolean;
};
/** A fal step that is reserved, queued, running or unknown: pending.json is written and no receipt exists. */
export type DerivativePending = {
  status: "pending";
  id: string;
  operationId: string;
  endpoint: string;
  /** The durable job state (reserved, submitting, queued, running, unknown). */
  state: string;
  directory: string;
  pending: DerivativePendingFile;
  nextAction: string;
};
export type DerivativeRunOptions = FalCallOptions & { blenderExecutable?: string };

/** The ONNX matte engine, or ASSET_MISSING naming the command that fetches its weights. */
export async function assertCutoutEngine(): Promise<void> {
  const matte = await import("../../matte");
  const { selectEngine } = await import("../../matte/engine");
  const choice = selectEngine("onnx", "subject", await matte.engineFacts({ probeVision: false }));
  if (!choice.ok)
    throw new CliErrorObject({
      code: "ASSET_MISSING",
      message: `cutout needs the local matte weights: ${choice.message}`,
      details: { fix: choice.fix },
    });
}

async function runCutout(input: string, output: string): Promise<{ modelSha256: string; runtime: string }> {
  const { runMatte } = await import("../../matte");
  const result = await runMatte({
    input,
    output,
    kind: "subject",
    engine: "onnx",
    quality: "balanced",
    maxFrames: 1,
    temporal: "none",
    strength: 0,
    refine: false,
    prores: false,
    force: false,
  });
  return { modelSha256: result.receipt.engine.sha256, runtime: result.receipt.engine.runtime };
}

const stepFile = (work: string, index: number, kind: MediaState["kind"]) =>
  path.join(work, `step-${String(index + 1).padStart(2, "0")}.${outputExtension(kind)}`);

/**
 * Run a derivative to completion. The same id and spec return the stored receipt (reused); another spec under the
 * id fails with FILE_EXISTS. A fal step that has not published yet fails with STAGE_INCOMPLETE naming its
 * operation; use advanceDerivative to receive the pending state instead.
 */
export async function runDerivative(
  projectId: string,
  input: unknown,
  rootDir = process.cwd(),
  options: DerivativeRunOptions = {},
): Promise<DerivativeRunResult> {
  const result = await advanceDerivative(projectId, input, rootDir, options);
  if (result.status === "pending")
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `Derivative ${result.id} waits for fal operation ${result.operationId} (${result.state}).`,
      details: { operationId: result.operationId, nextAction: result.nextAction },
    });
  return result;
}

/**
 * One resumable step of a derivative. Local steps run to completion. A leading fal step goes through the durable
 * job runner: without `confirmSpend`, or with an unknown price and no `maxCostUsd`, it refuses before any write;
 * while the job is not published it writes pending.json and returns `pending` (no receipt, no derivative import);
 * re-running the same spec resumes the same operation. The output is imported with provenance origin
 * "derivative"; receipt.json is the commit marker.
 */
export async function advanceDerivative(
  projectId: string,
  input: unknown,
  rootDir = process.cwd(),
  options: DerivativeRunOptions = {},
): Promise<DerivativeRunResult | DerivativePending> {
  const spec = DerivativeSpecSchema.parse(input);
  const directory = derivativeDirectory(projectId, spec.id, rootDir);
  const specSha256 = derivativeDigest(spec);
  const existing = existingState(directory, specSha256);
  if (existing === "conflict")
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: `Derivative ${spec.id} holds a different spec; derivatives are immutable, use a new id.`,
    });
  if (existing === "same") {
    const stored = readDerivative(projectId, spec.id, rootDir);
    const asset = readAssetRegistry(projectId, rootDir).assets.find((row) => row.id === stored.receipt.output.assetId);
    if (!asset) throw new CliErrorObject({ code: "VALIDATION", message: `Output of ${spec.id} is not registered.` });
    return { status: "ready", receipt: stored.receipt, sha256: stored.sha256, directory, asset, reused: true };
  }
  const plan = planDerivative(projectId, spec, rootDir);
  const blocked = plan.steps.find((step) => step.status === "not-implemented");
  if (blocked)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Step ${blocked.index + 1} (${blocked.op}, engine ${blocked.engine}) is ${blocked.status}: ${blocked.reason}.`,
    });
  const first = spec.steps[0]!;
  const fal = isFalStep(first) ? first : undefined;
  let falPlan: FalStepPlan | undefined;
  if (fal) {
    if (!options.confirmSpend)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Step 1 (${fal.op}) is a paid fal job. Show the user the plan (pnpm refs:derive --action plan) and pass --confirm-spend only after their yes.`,
      });
    const resolvedForPlan = resolveDerivativeInput(projectId, spec, rootDir);
    falPlan = await planFalStep(
      projectId,
      spec.id,
      0,
      fal,
      resolvedForPlan.state,
      resolvedForPlan.asset,
      rootDir,
      options,
    );
    if (falPlan.schema === "not-cached")
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `No cached schema for ${falPlan.endpoint}; run ${falPlan.nextAction} first.`,
      });
    if (!falPlan.job && falPlan.pricing === "unknown" && options.maxCostUsd === undefined)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `${falPlan.endpoint} has no bounded price: unknown prices are not free. Pass --max-cost-usd with the bound the user authorised.`,
      });
  }
  ensureFfmpeg();
  ensureFfprobe();
  const hasCutout = spec.steps.some((step) => step.op === "cutout");
  if (hasCutout) await assertCutoutEngine();
  const resolved = resolveDerivativeInput(projectId, spec, rootDir);
  mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, ".deriving.lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw new CliErrorObject({
      code: "TIMEOUT",
      message: `Derivative ${spec.id} is locked by another run; inspect ${lock} before removing it.`,
    });
  }
  const work = path.join(directory, `.work-${randomUUID()}`);
  try {
    mkdirSync(work);
    const measurements: Record<string, number> = {};
    const warnings: string[] = [];
    let current = resolved.file;
    let state = resolved.state;
    let engine: DerivativeReceipt["engine"] | undefined;
    let costUsd: number | null = null;
    const extraReferences: string[] = [];
    let sidecar: string | undefined;
    let start = 0;
    let modelSha256: string | undefined;
    let matteRuntime = "";
    let encodes = 0;
    if (fal && falPlan) {
      // The spec and the exact request are fixed before submission, so a changed spec under this id stays FILE_EXISTS.
      immutableWrite(path.join(directory, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
      immutableWrite(path.join(directory, "request.json"), `${JSON.stringify(falPlan.request, null, 2)}\n`);
      const run = await runFalStep(projectId, falPlan, resolved.asset, resolved.state, fal, rootDir, options);
      if (!run.published) {
        const pending =
          readDerivativePending(directory) ??
          ({
            schemaVersion: 1,
            id: spec.id,
            operationId: falPlan.operationId,
            endpoint: falPlan.endpoint,
            requestSha256: falPlan.requestSha256,
            createdAt: new Date().toISOString(),
          } satisfies DerivativePendingFile);
        immutableWrite(path.join(directory, PENDING_FILE), `${JSON.stringify(pending, null, 2)}\n`);
        if (run.state === "failed")
          throw new CliErrorObject({
            code: "VALIDATION",
            message: `fal operation ${falPlan.operationId} failed: ${run.error ?? "no detail"}. The derivative stays pending; the same command retries publication without a new submit when the provider kept the result.`,
            details: { operationId: falPlan.operationId },
          });
        return {
          status: "pending",
          id: spec.id,
          operationId: falPlan.operationId,
          endpoint: falPlan.endpoint,
          state: run.state,
          directory,
          pending,
          nextAction:
            run.nextAction === "reconcile-provider-request"
              ? `pnpm budget --project ${projectId} (reconcile operation ${falPlan.operationId} before any retry)`
              : `Re-run the same refs:derive run command later to resume operation ${falPlan.operationId}.`,
        };
      }
      const predicted = nextState(0, fal, state);
      const conformed = stepFile(work, 0, predicted.kind);
      runDeriveFfmpeg(conformFalArgs(predicted.kind, predicted, run.output, conformed));
      const measured = measure(conformed);
      if (measured.state.kind !== predicted.kind)
        throw new CliErrorObject({
          code: "FFMPEG_FAILED",
          message: `fal result conformed to ${measured.state.kind}, expected ${predicted.kind}.`,
        });
      if (predicted.frameCount && measured.state.frameCount !== predicted.frameCount)
        warnings.push(
          `The fal result has ${measured.state.frameCount} frames after conforming; the input has ${predicted.frameCount}.`,
        );
      if (predicted.kind === "video") encodes++;
      state = measured.state;
      current = conformed;
      costUsd = run.costUsd;
      if (costUsd === null)
        warnings.push(
          `Billing not reconciled: record the provider receipt with pnpm budget --project ${projectId} --operation-id ${run.operationId} --receipt <receipt.json>.`,
        );
      extraReferences.push(run.providerAssetId);
      engine = { kind: "fal", version: falPlan.endpoint, operationId: run.operationId };
      start = 1;
    } else if (first.op === "blender-pass") {
      const pass = await runBlenderPass(first, state, derivativeProject(projectId, rootDir), work, {
        executable: options.blenderExecutable,
      });
      Object.assign(measurements, pass.measurements);
      warnings.push(...pass.warnings);
      const measured = measure(pass.output);
      state = measured.state;
      current = pass.output;
      sidecar = pass.sidecar;
      // The scene file is the pass's model: its hash pins exactly what was rendered.
      engine = { kind: "blender", version: pass.version, modelSha256: pass.blendSha256 };
      start = 1;
    }
    for (const [index, step] of spec.steps.entries()) {
      if (index < start) continue;
      const predicted = nextState(index, step, state);
      const output = stepFile(work, index, predicted.kind);
      if (step.op === "snap" && predicted.width === state.width && predicted.height === state.height) {
        warnings.push(
          `Step ${index + 1} (snap): ${state.width}x${state.height} is already a multiple of ${step.multipleOf}.`,
        );
        continue;
      }
      if (step.op === "cutout") {
        const result = await runCutout(current, output);
        modelSha256 = result.modelSha256;
        matteRuntime = result.runtime;
      } else {
        if (step.op === "loudness") measurements.loudnessInputLufs = measureLoudness(current, step.lufs).integratedLufs;
        runDeriveFfmpeg(compileStep(index, step, state, current, output));
        if (step.op === "loudness") {
          const after = measureLoudness(output, step.lufs);
          measurements.loudnessTargetLufs = step.lufs;
          measurements.loudnessOutputLufs = after.integratedLufs;
          measurements.loudnessOutputTruePeakDb = after.truePeakDb;
          if (Math.abs(after.integratedLufs - step.lufs) > 1)
            warnings.push(
              `loudness: measured ${after.integratedLufs} LUFS against a ${step.lufs} LUFS target (single-pass loudnorm).`,
            );
        }
        if (step.op === "contact-sheet") measurements.contactSheetFrames = contactSheetCount(state, step.columns);
        if (step.op === "extract-frame" && state.frameCount)
          measurements.extractedFrame =
            step.at === "first"
              ? 0
              : step.at === "last"
                ? state.frameCount - 1
                : Math.min(state.frameCount - 1, Math.floor(step.at * (state.fps ?? 1) + 1e-6));
        if (predicted.kind === "video" && reencodesVideo(step)) encodes++;
      }
      const measured = measure(output);
      if (measured.state.kind !== predicted.kind)
        throw new CliErrorObject({
          code: "FFMPEG_FAILED",
          message: `Step ${index + 1} (${step.op}) produced ${measured.state.kind}, expected ${predicted.kind}.`,
        });
      state = measured.state;
      current = output;
    }
    if (current === resolved.file)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Every step was a no-op; the output equals the input.",
      });
    if (encodes > 1)
      warnings.push(`${encodes} lossy H.264 encodes in this chain; fewer, combined steps keep more detail.`);
    const final = measure(current);
    const hash = hashFile(current);
    const ext = outputExtension(final.state.kind);
    const outputPin = pinOf(
      `sha256:${hash}`,
      hash,
      `projects/${projectId}/assets/imported/${hash}.${ext}`,
      statSync(current).size,
      final,
    );
    if (final.state.width && final.state.height) {
      measurements.width = final.state.width;
      measurements.height = final.state.height;
    }
    if (final.state.durationSec) measurements.durationSec = final.state.durationSec;
    if (final.state.kind === "video" && final.state.frameCount) measurements.frameCount = final.state.frameCount;
    if (final.state.kind === "video" && final.state.fps) measurements.fps = final.state.fps;
    if (spec.role && final.state.kind !== "json") {
      const evidence = sensorEvidence(
        runReferenceSensors({ file: current, role: spec.role, modality: final.state.kind }),
      );
      Object.assign(measurements, evidence.measurements);
      warnings.push(...evidence.warnings);
    }
    const ffmpeg = ffmpegVersion();
    const prior = readAssetRegistry(projectId, rootDir).assets.find((row) => row.id === outputPin.assetId);
    if (prior?.provenance.derivative && prior.provenance.derivative.id !== spec.id)
      warnings.push(
        `Identical output bytes were registered by derivative ${prior.provenance.derivative.id}; the registry keeps that provenance.`,
      );
    else if (prior && !prior.provenance.derivative)
      warnings.push(
        "Identical output bytes were already registered as a non-derivative asset; its provenance is kept.",
      );
    const receipt = DerivativeReceiptSchema.parse({
      schemaVersion: 1,
      id: spec.id,
      specSha256,
      createdAt: new Date().toISOString(),
      input: resolved.pin,
      output: outputPin,
      engine:
        engine && engine.kind !== "fal"
          ? { ...engine, version: `${engine.version}; ${ffmpeg}` }
          : (engine ??
            (hasCutout
              ? { kind: "matte-onnx", version: `${ffmpeg}; ${matteRuntime}`, modelSha256 }
              : { kind: "ffmpeg", version: ffmpeg })),
      costUsd,
      measurements,
      warnings,
    });
    const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
    const imported = importAsset({
      projectId,
      rootDir,
      sourceFile: current,
      nonMedia: final.state.kind === "json",
      provenance: {
        origin: "derivative",
        tool: "refs:derive",
        model: receipt.engine.version,
        referenceAssetIds: [resolved.asset.id, ...extraReferences],
        originalFilename: `${spec.id}.${ext}`,
        ...(receipt.engine.operationId ? { generationJobId: receipt.engine.operationId } : {}),
        derivative: { id: spec.id, specSha256, receipt: receiptLink(spec.id) },
      },
      rights: resolved.asset.rights,
    }).asset;
    if (imported.files.original !== outputPin.original)
      throw new CliErrorObject({ code: "VALIDATION", message: "Imported output path differs from its pin." });
    immutableWrite(path.join(directory, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
    if (sidecar) {
      // The full-depth PNG sequence and pass.json sit beside the receipt: pipeline/reference-derivatives/<id>/sequence/.
      const target = path.join(directory, SEQUENCE_DIR);
      rmSync(target, { recursive: true, force: true });
      renameSync(path.join(sidecar, SEQUENCE_DIR), target);
      renameSync(path.join(sidecar, "pass.json"), path.join(target, "pass.json"));
    }
    immutableWrite(
      path.join(directory, "board.html"),
      derivativeBoard(spec, receipt, directory, path.join(path.resolve(rootDir), "public")),
    );
    immutableWrite(path.join(directory, "receipt.json"), receiptText);
    if (existsSync(path.join(directory, PENDING_FILE))) unlinkSync(path.join(directory, PENDING_FILE));
    return { status: "ready", receipt, sha256: sha256Text(receiptText), directory, asset: imported, reused: false };
  } finally {
    rmSync(work, { recursive: true, force: true });
    closeSync(fd);
    if (existsSync(lock)) unlinkSync(lock);
  }
}

const reencodesVideo = (step: DerivationStep) => !["strip-audio", "loudness"].includes(step.op);

/** A derivative whose fal step awaits the provider: its pending.json, spec and files; undefined otherwise. */
export function pendingDerivative(projectId: string, id: string, rootDir = process.cwd()) {
  const directory = derivativeDirectory(projectId, id, rootDir);
  if (existsSync(path.join(directory, "receipt.json"))) return undefined;
  const pending = readDerivativePending(directory);
  if (!pending) return undefined;
  return {
    pending,
    spec: readDerivativeSpec(directory),
    files: ["spec.json", "request.json", PENDING_FILE].map((name) => path.join(directory, name)),
  };
}

/** The stored receipt, spec and file paths of a derivative, plus a Blender pass's sequence/pass.json. */
export function showDerivative(projectId: string, id: string, rootDir = process.cwd()) {
  const stored = readDerivative(projectId, id, rootDir);
  const sequence = path.join(stored.directory, SEQUENCE_DIR, "pass.json");
  return {
    receipt: stored.receipt,
    spec: stored.spec,
    sha256: stored.sha256,
    files: [
      ...["spec.json", "receipt.json", "board.html"].map((name) => path.join(stored.directory, name)),
      ...(existsSync(sequence) ? [sequence] : []),
    ],
    ...(existsSync(sequence) ? { sequence: JSON.parse(readFileSync(sequence, "utf8")) as unknown } : {}),
  };
}
