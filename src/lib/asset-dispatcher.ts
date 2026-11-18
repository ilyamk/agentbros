/**
 * Asset dispatcher — shared logic for resolving, fetching and tracking
 * individual assets from an asset-plan.
 *
 * Called by:
 *   scripts/asset-fetch.ts     — single-asset CLI wrapper
 *   scripts/asset-fetch-all.ts — batch CLI wrapper
 *
 * Contract: returns a plain object (never calls process.exit) so that
 * wrapper scripts can handle output formatting and exit themselves.
 */

import {
  existsSync,
  copyFileSync,
  realpathSync,
  statSync,
  openSync,
  closeSync,
  unlinkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { CliErrorObject, emitProgress, relativisePath } from "./cli/index.js";
import { AssetPlanSchema } from "../types/pipeline.js";
import type { AssetPlan, AssetSpec } from "../types/pipeline.js";
import { prepareModernAssetDispatch } from "./providers/modern-asset";
import { runSfxGeneration, type SfxGenerationOptions } from "./providers/fal-sfx";
import { assetsPlanPath, projectDir } from "./pipeline/paths.js";
import { ResourceService } from "./resources/service";
import { StockFormatSchema, type StockProviderId } from "./resources/stock";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatchResult {
  ok: boolean;
  outputs: string[];
  metadata: Record<string, unknown>;
  error?: string;
  errorCode?: string;
  elapsedMs: number;
}

export interface DispatchOptions {
  projectId: string;
  assetId: string;
  force?: boolean;
  /** Max extra attempts on failure (total attempts = 1 + retry). */
  retry?: number;
}

// ---------------------------------------------------------------------------
// Asset-plan IO
// ---------------------------------------------------------------------------

function readAssetPlan(planPath: string): AssetPlan {
  const raw: unknown = JSON.parse(readFileSync(planPath, "utf-8"));
  const result = AssetPlanSchema.safeParse(raw);
  if (!result.success) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `asset-plan.json failed schema validation: ${result.error.message}`,
    });
  }
  return result.data;
}

/** Re-read under a writer lock so parallel assets cannot clobber each other. */
function patchAssetPlan(planPath: string, id: string, patch: Partial<AssetSpec>): void {
  const lock = `${planPath}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: "Asset plan is locked by another writer; retry after it finishes.",
    });
  }
  const tmp = `${planPath}.${randomUUID()}.tmp`;
  try {
    const current = readAssetPlan(planPath),
      index = current.assets.findIndex((asset) => asset.id === id);
    if (index < 0) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Asset was removed while dispatching." });
    const asset = current.assets[index]!;
    current.assets[index] = {
      ...asset,
      ...patch,
      ...(patch.metadata ? { metadata: { ...(asset.metadata ?? {}), ...patch.metadata } } : {}),
    };
    writeFileSync(tmp, JSON.stringify(current, null, 2), "utf8");
    renameSync(tmp, planPath);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
    closeSync(fd);
    unlinkSync(lock);
  }
}

export function isPendingDispatch(result: Pick<DispatchResult, "ok" | "outputs" | "metadata">): boolean {
  return (
    result.ok &&
    ([
      "planned",
      "reserved",
      "submitting",
      "queued",
      "running",
      "unknown",
      "result-ready",
      "downloading",
      "validated",
      "awaiting-import",
    ].includes(String(result.metadata.state)) ||
      result.metadata.pending === true)
  );
}
/** Test seam for the in-process ElevenLabs SFX route: a fake job provider and download fetch. */
export type SfxDispatchProvider = Pick<SfxGenerationOptions, "provider" | "fetch">;
export type DispatchDependencies = {
  dispatch?: (projectId: string, asset: AssetSpec, targetAbs: string, force: boolean) => Promise<DispatchResult>;
  sfx?: SfxDispatchProvider;
  /** Test seam for stock routes: a ResourceService with a fake fetch and project root. */
  stock?: ResourceService;
};

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

interface SpawnResult {
  ok: boolean;
  json?: Record<string, unknown>;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn a child process synchronously. Children inherit the current environment
 * (env vars from --env-file are already present in process.env).
 *
 * Wave R2 scripts (generate-image, generate-video, generate-music) emit a
 * single JSON line on stdout. Older fetch-* scripts emit free text — callers
 * are expected to use exit code and find downloaded files themselves.
 */
function spawnScript(cmd: string, args: string[]): SpawnResult {
  emitProgress(`Spawning: ${cmd} ${args.join(" ")}`);

  const result = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: process.env,
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? 1;

  // Try to parse the last non-empty line as JSON (Wave R2 output convention)
  let json: Record<string, unknown> | undefined;
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (lastLine?.startsWith("{")) {
    try {
      json = JSON.parse(lastLine) as Record<string, unknown>;
    } catch {
      // stdout wasn't JSON — caller handles via exitCode
    }
  }

  return { ok: exitCode === 0, json, stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Directory diff helpers for legacy fetch-* scripts
// ---------------------------------------------------------------------------

/** Snapshot all files in a directory, returning a Set of absolute paths. */
function snapshotDir(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).map((f) => path.join(dir, f)));
}

/** Return files that appeared in `after` but were not in `before`. */
function newFiles(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((f) => !before.has(f));
}

// ---------------------------------------------------------------------------
// Absolute target path
// ---------------------------------------------------------------------------

function resolveTargetPath(projectId: string, asset: AssetSpec): string {
  const root = path.resolve(projectDir(projectId));
  const target = path.resolve(root, asset.targetPath),
    relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Asset target escapes project or points to project directory.",
    });
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realRelative = path.relative(realpathSync(root), realpathSync(ancestor));
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Asset target symlink escapes project." });
  return target;
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

/**
 * Fetch or generate one asset from the plan, updating its status in-place.
 * The plan file is written back atomically after each status change.
 */
export async function dispatchAsset(
  opts: DispatchOptions,
  dependencies: DispatchDependencies = {},
): Promise<DispatchResult> {
  const startedAt = Date.now();
  const planPath = assetsPlanPath(opts.projectId);

  // ── 1. Load plan ──────────────────────────────────────────────────────────

  if (!existsSync(planPath)) {
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `asset-plan.json not found for project "${opts.projectId}". Run the asset-plan stage first.`,
    });
  }

  const plan = readAssetPlan(planPath);

  // ── 2. Find asset ─────────────────────────────────────────────────────────

  const asset = plan.assets.find((a) => a.id === opts.assetId);
  if (!asset) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Asset "${opts.assetId}" not found in asset-plan.json.`,
    });
  }

  // ── 3. Already-done guard ─────────────────────────────────────────────────

  const targetAbs = resolveTargetPath(opts.projectId, asset);

  if (!opts.force && asset.status === "done" && existsSync(targetAbs)) {
    return {
      ok: true,
      outputs: [relativisePath(targetAbs)],
      metadata: { skipped: "already-done" },
      elapsedMs: Date.now() - startedAt,
    };
  }

  // ── 4. Flip to running ────────────────────────────────────────────────────

  patchAssetPlan(planPath, asset.id, { status: "running", errorMessage: undefined });

  // ── 5. Dispatch ───────────────────────────────────────────────────────────

  let result: DispatchResult;

  try {
    result = dependencies.dispatch
      ? await dependencies.dispatch(opts.projectId, asset, targetAbs, !!opts.force)
      : await doDispatch(opts.projectId, asset, targetAbs, !!opts.force, dependencies.sfx, dependencies.stock);
  } catch (err: unknown) {
    const message = err instanceof CliErrorObject ? err.message : err instanceof Error ? err.message : String(err);
    const code = err instanceof CliErrorObject ? err.code : "INTERNAL";

    // Update plan: failed
    const prevAttempts =
      typeof asset.metadata?.["dispatchAttempts"] === "number" ? (asset.metadata["dispatchAttempts"] as number) : 0;
    patchAssetPlan(planPath, asset.id, {
      status: "failed",
      errorMessage: message,
      metadata: { ...(asset.metadata ?? {}), dispatchAttempts: prevAttempts + 1 },
    });

    return {
      ok: false,
      outputs: [],
      metadata: { dispatchAttempts: prevAttempts + 1 },
      error: message,
      errorCode: code,
      elapsedMs: Date.now() - startedAt,
    };
  }

  // ── 6. Write final status ─────────────────────────────────────────────────

  if (result.ok) {
    // Manual-drop assets (screenshot, talking-head-clip, archival) return ok:true
    // but the binary hasn't been fetched — keep them as "pending" so the
    // orchestrator can surface the manual-drop requirement to the user.
    if (result.metadata["dryRun"] === true) {
      // A no-spend plan wrote nothing: the asset still needs generation.
      result.outputs = [];
      patchAssetPlan(planPath, asset.id, { status: "pending", errorMessage: undefined });
    } else if (result.metadata["requiresManualDrop"]) {
      const expectedPath =
        typeof result.metadata["expectedPath"] === "string"
          ? (result.metadata["expectedPath"] as string)
          : asset.targetPath;
      patchAssetPlan(planPath, asset.id, {
        status: "pending",
        errorMessage: `Manual file required at: ${expectedPath}`,
      });
    } else if (isPendingDispatch(result)) {
      result.outputs = [];
      result.metadata = { ...result.metadata, pending: true, resume: true };
      patchAssetPlan(planPath, asset.id, { status: "running", errorMessage: undefined, metadata: result.metadata });
    } else if (
      !result.metadata.inline &&
      !result.metadata.skippedReason &&
      (!existsSync(targetAbs) || !statSync(targetAbs).isFile() || statSync(targetAbs).size === 0)
    ) {
      result = {
        ok: false,
        outputs: [],
        metadata: result.metadata,
        error: "Asset operation reported success without a non-empty target file.",
        errorCode: "FILE_NOT_FOUND",
        elapsedMs: result.elapsedMs,
      };
      patchAssetPlan(planPath, asset.id, { status: "failed", errorMessage: result.error, metadata: result.metadata });
    } else {
      patchAssetPlan(planPath, asset.id, {
        status: "done",
        metadata: result.metadata,
        errorMessage: undefined,
      });
    }
  } else {
    const prevAttempts =
      typeof asset.metadata?.["dispatchAttempts"] === "number" ? (asset.metadata["dispatchAttempts"] as number) : 0;
    patchAssetPlan(planPath, asset.id, {
      status: "failed",
      errorMessage: result.error,
      metadata: { ...(asset.metadata ?? {}), dispatchAttempts: prevAttempts + 1 },
    });
  }

  return { ...result, elapsedMs: Date.now() - startedAt };
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

async function doDispatch(
  projectId: string,
  asset: AssetSpec,
  targetAbs: string,
  force: boolean,
  sfx: SfxDispatchProvider = {},
  stock?: ResourceService,
): Promise<DispatchResult> {
  const { kind, source } = asset;

  // ── Inline / no-fetch kinds ───────────────────────────────────────────────

  if (kind === "inline" || source === "inline") {
    return {
      ok: true,
      outputs: [],
      metadata: { inline: true },
      elapsedMs: 0,
    };
  }

  // ── Manual-drop kinds ─────────────────────────────────────────────────────

  if ((kind === "screenshot" || kind === "talking-head-clip") && source === "manual") {
    // Do not fail — surface to orchestrator for user action.
    // Status is NOT updated to done: we keep it pending so the orchestrator
    // knows to prompt the user.
    return {
      ok: true,
      outputs: [],
      metadata: { requiresManualDrop: true, expectedPath: relativisePath(targetAbs) },
      elapsedMs: 0,
    };
  }

  // ── sketch / tweet — inline data ──────────────────────────────────────────
  // These render from inline data (the early `source === "inline"` guard above
  // already handled that case). For manual source treat as a drop; for any
  // other source the combination is unsupported.

  if (kind === "sketch" || kind === "tweet") {
    if (source === "manual") {
      return {
        ok: true,
        outputs: [],
        metadata: { requiresManualDrop: true, expectedPath: relativisePath(targetAbs) },
        elapsedMs: 0,
      };
    }
    return unsupported(kind, source);
  }

  // ── archival ──────────────────────────────────────────────────────────────

  if (kind === "archival") {
    return {
      ok: true,
      outputs: [],
      metadata: { requiresManualDrop: true, expectedPath: relativisePath(targetAbs) },
      elapsedMs: 0,
    };
  }

  // ── voiceover ─────────────────────────────────────────────────────────────
  // Voice-producer stage owns voiceover generation; skip gracefully.

  if (kind === "voiceover") {
    return {
      ok: true,
      outputs: [],
      metadata: { skippedReason: "voiceover is managed by the voice-producer stage" },
      elapsedMs: 0,
    };
  }

  // ── Ensure parent directory exists before download ────────────────────────

  mkdirSync(path.dirname(targetAbs), { recursive: true });

  if (source === "fal-model") {
    // All modern kinds (including audio, 3D, upscale and cutout) share exact endpoint routing.
    try {
      const args = prepareModernAssetDispatch(asset, projectId!, targetAbs, force);
      return interpretJsonResult(spawnScript("npx", ["tsx", ...args]), targetAbs);
    } catch (error) {
      return {
        ok: false,
        outputs: [],
        metadata: {},
        error: error instanceof Error ? error.message : String(error),
        errorCode: error instanceof CliErrorObject ? error.code : "INVALID_INPUT",
        elapsedMs: 0,
      };
    }
  }

  // ── Stock photo / video — Unsplash, Pexels, Pixabay (ResourceService) ────

  if (
    (kind === "stock-photo" || kind === "stock-video") &&
    (source === "pexels" || source === "pixabay" || source === "unsplash")
  ) {
    return dispatchStock(projectId, asset, targetAbs, kind, source, stock);
  }

  // ── AI image — fal FLUX ───────────────────────────────────────────────────

  if (kind === "ai-image" && source === "fal-flux") {
    const modelOverride =
      typeof asset.metadata?.["model"] === "string" ? (asset.metadata["model"] as string) : undefined;
    const model = validateFluxModel(modelOverride) ?? "flux-schnell";

    return dispatchGenerateImage(asset, targetAbs, model, force, projectId);
  }

  // ── AI image / meme — fal gpt-image-2 ────────────────────────────────────
  // gpt-image-2 is the only supported gpt-image model; metadata.model is ignored.

  if ((kind === "ai-image" || kind === "meme") && source === "fal-gpt-image") {
    return dispatchGenerateImage(asset, targetAbs, "gpt-image-2", force, projectId);
  }

  // ── AI video — Kling ──────────────────────────────────────────────────────

  if (kind === "ai-video" && source === "fal-kling") {
    return dispatchGenerateVideo(asset, targetAbs, "kling-2.5-turbo", force, projectId);
  }

  // ── AI video — ByteDance Seedance (v1 pro / v2 fast) ──────────────────────
  // Default model is seedance-2-fast; override via metadata.model = "seedance-1-pro".

  if (kind === "ai-video" && source === "fal-bytedance") {
    const override = asset.metadata?.["model"];
    const model = override === "seedance-1-pro" || override === "seedance-2-fast" ? override : "seedance-2-fast";
    return dispatchGenerateVideo(asset, targetAbs, model, force, projectId);
  }

  // ── AI video — Minimax / Hailuo ───────────────────────────────────────────

  if (kind === "ai-video" && source === "fal-minimax") {
    return dispatchGenerateVideo(asset, targetAbs, "hailuo-02-pro", force, projectId);
  }

  // ── SFX — Freesound ───────────────────────────────────────────────────────

  if (kind === "sfx" && source === "freesound") {
    return dispatchSfx(asset, targetAbs);
  }

  // ── SFX — ElevenLabs (fal elevenlabs/sound-effects/v3, the sfx:generate path) ──

  if (kind === "sfx" && source === "elevenlabs-sfx") {
    return dispatchElevenLabsSfx(projectId, asset, targetAbs, sfx);
  }

  // ── Music — ElevenLabs ───────────────────────────────────────────────────

  if (kind === "music" && source === "elevenlabs-music") {
    return dispatchGenerateMusic(asset, targetAbs, force, projectId);
  }

  // ── Lottie ────────────────────────────────────────────────────────────────

  if (kind === "lottie" && source === "lottiefiles") {
    return dispatchLottie(asset, targetAbs);
  }

  // ── Unsupported combination ───────────────────────────────────────────────

  return unsupported(kind, source);
}

// ---------------------------------------------------------------------------
// Per-backend helpers
// ---------------------------------------------------------------------------

function unsupported(kind: string, source: string): DispatchResult {
  return {
    ok: false,
    outputs: [],
    metadata: {},
    error: `Unsupported kind+source combination: ${kind}+${source}`,
    errorCode: "INVALID_INPUT",
    elapsedMs: 0,
  };
}

function validateFluxModel(raw: string | undefined): string | undefined {
  const allowed = ["flux-schnell", "flux-dev", "flux-pro", "flux-pro-ultra"];
  if (raw !== undefined && allowed.includes(raw)) return raw;
  return undefined;
}

// ---------------------------------------------------------------------------
// generate-image dispatcher
// ---------------------------------------------------------------------------

function dispatchGenerateImage(
  asset: AssetSpec,
  targetAbs: string,
  model: string,
  force: boolean,
  projectId?: string,
): DispatchResult {
  if (!asset.prompt) {
    return {
      ok: false,
      outputs: [],
      metadata: {},
      error: `Asset "${asset.id}" (kind: ${asset.kind}) requires a prompt.`,
      errorCode: "INVALID_INPUT",
      elapsedMs: 0,
    };
  }

  const args: string[] = [
    "scripts/generate-image.ts",
    "--prompt",
    asset.prompt,
    "--output",
    targetAbs,
    "--model",
    model,
  ];

  if (typeof asset.metadata?.["size"] === "string") {
    args.push("--size", asset.metadata["size"] as string);
  }
  if (typeof asset.metadata?.["quality"] === "string") {
    args.push("--quality", asset.metadata["quality"] as string);
  }
  if (typeof asset.metadata?.["format"] === "string") {
    args.push("--format", asset.metadata["format"] as string);
  }

  // Reference image routing — gpt-image-2 supports multi-image edit; FLUX
  // img2img takes a single reference. If 2+ refs are present and the chosen
  // model is gpt-image-2 we pass them as --reference-images; otherwise fall
  // back to --reference-image with the first URL.
  const refs = asset.referenceImageUrls ?? [];
  if (refs.length >= 2 && model === "gpt-image-2") {
    args.push("--reference-images", refs.join(","));
  } else if (refs[0]) {
    args.push("--reference-image", refs[0]);
  }

  if (typeof asset.metadata?.["maskUrl"] === "string") {
    args.push("--mask-url", asset.metadata["maskUrl"] as string);
  }

  if (force) args.push("--force");

  if (projectId) {
    args.push("--project", projectId, "--asset-id", asset.id, "--stage", "assets");
    appendPaidIdentity(args, asset, projectId);
  }

  const res = spawnScript("npx", ["tsx", ...args]);
  return interpretJsonResult(res, targetAbs);
}

// ---------------------------------------------------------------------------
// generate-video dispatcher
// ---------------------------------------------------------------------------

function dispatchGenerateVideo(
  asset: AssetSpec,
  targetAbs: string,
  model: string,
  force: boolean,
  projectId?: string,
): DispatchResult {
  if (!asset.prompt) {
    return {
      ok: false,
      outputs: [],
      metadata: {},
      error: `Asset "${asset.id}" (kind: ${asset.kind}) requires a prompt.`,
      errorCode: "INVALID_INPUT",
      elapsedMs: 0,
    };
  }

  const args: string[] = [
    "scripts/generate-video.ts",
    "--prompt",
    asset.prompt,
    "--output",
    targetAbs,
    "--model",
    model,
  ];

  // Duration: number ("auto" goes via string)
  const durMeta = asset.metadata?.["duration"];
  if (typeof durMeta === "number") {
    args.push("--duration", String(durMeta));
  } else if (durMeta === "auto") {
    args.push("--duration", "auto");
  }

  if (typeof asset.metadata?.["aspect"] === "string") {
    args.push("--aspect", asset.metadata["aspect"] as string);
  }
  if (typeof asset.metadata?.["resolution"] === "string") {
    args.push("--resolution", asset.metadata["resolution"] as string);
  }
  if (asset.metadata?.["generateAudio"] === false) {
    args.push("--no-generate-audio");
  } else if (asset.metadata?.["generateAudio"] === true) {
    args.push("--generate-audio");
  }
  if (typeof asset.metadata?.["seed"] === "number") {
    args.push("--seed", String(asset.metadata["seed"]));
  }

  // Reference image routing — if 2+ URLs are present and the model supports r2v
  // (seedance-2-fast), pass them as --reference-images. Otherwise fall back to
  // single-image i2v with the first URL.
  const refImages = asset.referenceImageUrls ?? [];
  const supportsR2v = model === "seedance-2-fast";
  if (refImages.length >= 2 && supportsR2v) {
    args.push("--reference-images", refImages.join(","));
  } else if (refImages[0]) {
    args.push("--reference-image", refImages[0]);
  }

  // Reference videos / audios from metadata (Seedance 2 fast r2v only).
  // Accept either string[] or comma-separated string.
  const refVideos = normaliseUrlList(asset.metadata?.["referenceVideoUrls"]);
  const refAudios = normaliseUrlList(asset.metadata?.["referenceAudioUrls"]);
  if (refVideos.length > 0 && supportsR2v) {
    args.push("--reference-videos", refVideos.join(","));
  }
  if (refAudios.length > 0 && supportsR2v) {
    args.push("--reference-audios", refAudios.join(","));
  }

  if (typeof asset.metadata?.["endImageUrl"] === "string") {
    args.push("--end-image-url", asset.metadata["endImageUrl"] as string);
  }

  if (force) args.push("--force");

  if (projectId) {
    args.push("--project", projectId, "--asset-id", asset.id, "--stage", "assets");
    appendPaidIdentity(args, asset, projectId);
  }

  const res = spawnScript("npx", ["tsx", ...args]);
  return interpretJsonResult(res, targetAbs);
}

function appendPaidIdentity(args: string[], asset: AssetSpec, projectId: string): void {
  const operationId =
    typeof asset.metadata?.operationId === "string"
      ? asset.metadata.operationId
      : `asset:${createHash("sha256")
          .update(`${projectId}:${asset.id}:${String(asset.metadata?.generationRevision ?? 0)}`)
          .digest("hex")}`;
  args.push("--operation-id", operationId);
  if (typeof asset.metadata?.maxCostUsd === "number" && asset.metadata.maxCostUsd >= 0)
    args.push("--max-cost-usd", String(asset.metadata.maxCostUsd));
}

// ---------------------------------------------------------------------------
// ElevenLabs SFX dispatcher (in-process sfx:generate route)
// ---------------------------------------------------------------------------

export const ELEVENLABS_SFX_ENDPOINT = "elevenlabs/sound-effects/v3";

/**
 * Same path as `sfx:generate --endpoint elevenlabs/sound-effects/v3`: durable job,
 * budget admission and price checks in executeFalOperation, resumable by operation ID.
 * `metadata.dryRun: true` or AGENTBROS_NO_SPEND=1 plans offline without reservation or submit.
 */
async function dispatchElevenLabsSfx(
  projectId: string,
  asset: AssetSpec,
  targetAbs: string,
  provider: SfxDispatchProvider,
): Promise<DispatchResult> {
  const prompt = asset.prompt ?? asset.query;
  if (!prompt) {
    return {
      ok: false,
      outputs: [],
      metadata: {},
      error: `Asset "${asset.id}" (kind: sfx) requires a prompt.`,
      errorCode: "INVALID_INPUT",
      elapsedMs: 0,
    };
  }
  const identity: string[] = [];
  appendPaidIdentity(identity, asset, projectId);
  const operationId = identity[identity.indexOf("--operation-id") + 1]!;
  const maxCostUsd =
    typeof asset.metadata?.maxCostUsd === "number" && asset.metadata.maxCostUsd > 0
      ? asset.metadata.maxCostUsd
      : undefined;
  const duration = asset.metadata?.["duration"];
  const dryRun = asset.metadata?.["dryRun"] === true || process.env.AGENTBROS_NO_SPEND === "1";
  const result = await runSfxGeneration({
    projectId,
    endpoint: ELEVENLABS_SFX_ENDPOINT,
    prompt,
    durationSec: typeof duration === "number" ? duration : undefined,
    output: targetAbs,
    operationId,
    maxCostUsd,
    dryRun,
    ...provider,
  });
  return {
    ok: true,
    outputs: result.outputs,
    metadata: { ...result.metadata, ...(dryRun ? { dryRun: true } : {}) },
    elapsedMs: 0,
  };
}

function normaliseUrlList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// ---------------------------------------------------------------------------
// generate-music dispatcher
// ---------------------------------------------------------------------------

function dispatchGenerateMusic(
  asset: AssetSpec,
  targetAbs: string,
  force: boolean,
  projectId?: string,
): DispatchResult {
  if (!asset.prompt) {
    return {
      ok: false,
      outputs: [],
      metadata: {},
      error: `Asset "${asset.id}" (kind: music) requires a prompt.`,
      errorCode: "INVALID_INPUT",
      elapsedMs: 0,
    };
  }

  const duration = typeof asset.metadata?.["duration"] === "number" ? (asset.metadata["duration"] as number) : 30;

  const args: string[] = [
    "scripts/generate-music.ts",
    "--prompt",
    asset.prompt,
    "--output",
    targetAbs,
    "--duration",
    String(duration),
  ];
  if (force) args.push("--force");
  if (projectId) {
    args.push("--project", projectId, "--asset-id", asset.id);
  }

  const res = spawnScript("npx", ["tsx", ...args]);
  return interpretJsonResult(res, targetAbs);
}

// ---------------------------------------------------------------------------
// Stock dispatcher: ranked search, rights-checked acquisition and a receipt
// ---------------------------------------------------------------------------

/**
 * Searches the plan's source (metadata.providers may widen it, "auto" uses every configured source),
 * takes the best candidate that fills metadata.format at metadata.zoom, and acquires it through
 * ResourceService so the asset registry and pipeline/resources receipt carry its licence.
 */
async function dispatchStock(
  projectId: string,
  asset: AssetSpec,
  targetAbs: string,
  kind: "stock-photo" | "stock-video",
  source: StockProviderId,
  injected?: ResourceService,
): Promise<DispatchResult> {
  const query = asset.query ?? asset.prompt;
  if (!query)
    return {
      ok: false,
      outputs: [],
      metadata: {},
      error: `Asset "${asset.id}" requires a query for ${source} search.`,
      errorCode: "INVALID_INPUT",
      elapsedMs: 0,
    };
  const meta = asset.metadata ?? {};
  const format = meta["format"] === undefined ? undefined : StockFormatSchema.parse(meta["format"]);
  const zoom = typeof meta["zoom"] === "number" ? meta["zoom"] : undefined;
  const widen = meta["providers"];
  const providers =
    widen === "auto" ? ("auto" as const) : Array.isArray(widen) ? (widen.map(String) as StockProviderId[]) : [source];
  const service =
    injected ??
    new ResourceService({
      credentials: {
        pexels: process.env.PEXELS_API_KEY,
        pixabay: process.env.PIXABAY_API_KEY,
        unsplash: process.env.UNSPLASH_ACCESS_KEY,
      },
    });
  const found = await service.stock.search(providers, {
    query,
    kind: kind === "stock-photo" ? "image" : "video",
    limit: 15,
    filters: { ...(format ? { format } : {}), ...(zoom ? { zoom } : {}), safe: meta["safe"] === true || undefined },
  });
  const best = found.results.find((item) => !item.blocked);
  if (!best)
    return {
      ok: false,
      outputs: [],
      metadata: { providers: found.providers },
      error: found.results.length
        ? `No ${source} result fills the frame: ${found.results[0]!.blocked}`
        : `No ${source} result for "${query}".`,
      errorCode: "VALIDATION",
      elapsedMs: 0,
    };
  const acquired = await service.acquire(best.candidate, {
    projectId,
    usage: {
      commercial: meta["commercial"] === true,
      advertising: meta["advertising"] === true,
      credit: meta["credit"] === true,
    },
    ...(format ? { target: { format, ...(zoom ? { zoom } : {}) } } : {}),
  });
  mkdirSync(path.dirname(targetAbs), { recursive: true });
  copyFileSync(path.resolve("public", acquired.asset.files.original), targetAbs);
  return {
    ok: true,
    outputs: [relativisePath(targetAbs)],
    metadata: {
      source: best.candidate.provider,
      query,
      resourceId: best.candidate.id,
      assetId: acquired.asset.id,
      receipt: relativisePath(acquired.resourceReceipt),
      score: best.score,
      reasons: best.reasons,
    },
    elapsedMs: 0,
  };
}

// ---------------------------------------------------------------------------
// Freesound dispatcher (legacy free-text script)
// ---------------------------------------------------------------------------

function dispatchSfx(asset: AssetSpec, targetAbs: string): DispatchResult {
  const query = asset.query ?? asset.prompt;
  if (!query) {
    return {
      ok: false,
      outputs: [],
      metadata: {},
      error: `Asset "${asset.id}" requires a query for Freesound search.`,
      errorCode: "INVALID_INPUT",
      elapsedMs: 0,
    };
  }

  const legacyDir = path.resolve(path.join("public", "sfx"));
  const before = snapshotDir(legacyDir);

  const res = spawnScript("npx", [
    "tsx",
    "scripts/fetch-sound-effects.ts",
    "--query",
    query,
    "--commercial",
    "--download",
    "1",
  ]);

  if (!res.ok) {
    return {
      ok: false,
      outputs: [],
      metadata: {},
      error: `fetch-sound-effects failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`,
      errorCode: "INTERNAL",
      elapsedMs: 0,
    };
  }

  const after = snapshotDir(legacyDir);
  const downloaded = newFiles(before, after);

  if (downloaded.length === 0) {
    return {
      ok: false,
      outputs: [],
      metadata: {},
      error: "Freesound download succeeded but no new file found in public/sfx/.",
      errorCode: "INTERNAL",
      elapsedMs: 0,
    };
  }

  const src = downloaded[0]!;
  renameSync(src, targetAbs);

  return {
    ok: true,
    outputs: [relativisePath(targetAbs)],
    metadata: { source: "freesound", query },
    elapsedMs: 0,
  };
}

// ---------------------------------------------------------------------------
// LottieFiles dispatcher (legacy free-text script)
// ---------------------------------------------------------------------------

function dispatchLottie(asset: AssetSpec, targetAbs: string): DispatchResult {
  const query = asset.query ?? asset.prompt;
  if (!query) {
    return {
      ok: false,
      outputs: [],
      metadata: {},
      error: `Asset "${asset.id}" requires a query for LottieFiles search.`,
      errorCode: "INVALID_INPUT",
      elapsedMs: 0,
    };
  }

  const legacyDir = path.resolve(path.join("public", "lottie"));
  const before = snapshotDir(legacyDir);

  const res = spawnScript("npx", ["tsx", "scripts/fetch-lottie.ts", "--query", query, "--download", "1"]);

  if (!res.ok) {
    return {
      ok: false,
      outputs: [],
      metadata: {},
      error: `fetch-lottie failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`,
      errorCode: "INTERNAL",
      elapsedMs: 0,
    };
  }

  const after = snapshotDir(legacyDir);
  const downloaded = newFiles(before, after);

  if (downloaded.length === 0) {
    return {
      ok: false,
      outputs: [],
      metadata: {},
      error: "LottieFiles download succeeded but no new file found in public/lottie/.",
      errorCode: "INTERNAL",
      elapsedMs: 0,
    };
  }

  const src = downloaded[0]!;
  renameSync(src, targetAbs);

  return {
    ok: true,
    outputs: [relativisePath(targetAbs)],
    metadata: { source: "lottiefiles", query },
    elapsedMs: 0,
  };
}

// ---------------------------------------------------------------------------
// Wave R2 result interpreter
// ---------------------------------------------------------------------------

/**
 * Parses the JSON envelope emitted by Wave R2 scripts (generate-image, etc.)
 * and normalises it into a DispatchResult.
 */
export function interpretJsonResult(res: SpawnResult, targetAbs: string): DispatchResult {
  if (res.json) {
    const j = res.json;
    if (j["ok"] === true && res.ok) {
      return {
        ok: true,
        outputs: Array.isArray(j["outputs"]) ? (j["outputs"] as string[]) : [],
        metadata: (j["metadata"] as Record<string, unknown>) ?? {},
        elapsedMs: typeof j["elapsedMs"] === "number" ? (j["elapsedMs"] as number) : 0,
      };
    }
    // ok: false
    return {
      ok: false,
      outputs: [],
      metadata: {},
      error: typeof j["message"] === "string" ? (j["message"] as string) : "Script reported failure",
      errorCode: typeof j["error"] === "string" ? (j["error"] as string) : "INTERNAL",
      elapsedMs: typeof j["elapsedMs"] === "number" ? (j["elapsedMs"] as number) : 0,
    };
  }

  // No JSON parsed — fall back to exit code + stderr
  if (res.ok) {
    return {
      ok: true,
      outputs: [relativisePath(targetAbs)],
      metadata: {},
      elapsedMs: 0,
    };
  }

  return {
    ok: false,
    outputs: [],
    metadata: {},
    error: `Script exited with code ${res.exitCode}. Stderr: ${res.stderr.slice(0, 500)}`,
    errorCode: "INTERNAL",
    elapsedMs: 0,
  };
}
