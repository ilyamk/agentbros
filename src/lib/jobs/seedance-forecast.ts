import { createHash } from "node:crypto";
import {
  SeedanceVideoForecastSchema,
  VideoForecastEvidenceSchema,
  type VideoForecastEvidence,
  type FalOperationRequest,
  type FalOperationPlan,
} from "../../types/generation";
import { generationInputHash } from "./runner";
import { CliErrorObject } from "../cli";
import type { QuoteInput } from "../pricing";

export const forecastReferenceHash = (reference: string): string =>
  createHash("sha256").update(reference).digest("hex");
export function validateVideoForecastEvidence(value: unknown): VideoForecastEvidence {
  const evidence = VideoForecastEvidenceSchema.parse(value);
  if (generationInputHash(evidence.forecast) !== evidence.sha256)
    throw new CliErrorObject({ code: "VALIDATION", message: "Video forecast evidence digest mismatch." });
  return evidence;
}
/** Validate against the normalized provider bytes, retaining original reference identity by position. */
export function prepareSeedanceForecast(
  original: FalOperationRequest,
  resolved: FalOperationRequest,
  plan: FalOperationPlan,
): { evidence?: VideoForecastEvidence; quoteInput?: Omit<QuoteInput, "model">; reason?: string } {
  if (!resolved.context?.videoForecast) return {};
  const forecast = SeedanceVideoForecastSchema.parse(resolved.context.videoForecast);
  const fail = (message: string): never => {
    throw new CliErrorObject({ code: "VALIDATION", message: `Seedance video forecast: ${message}` });
  };
  if (plan.family !== "seedance-2.5") fail("only Seedance 2.5 operations support this forecast.");
  if (
    forecast.endpoint !== plan.endpoint ||
    forecast.schemaSha256 !== plan.schemaSha256 ||
    forecast.inputSha256 !== generationInputHash(plan.input)
  )
    fail("endpoint/schema/normalized provider-input pin mismatch.");
  const rawVideos = Array.isArray(original.input.video_urls) ? original.input.video_urls : [];
  const videos = Array.isArray(plan.input.video_urls) ? plan.input.video_urls : [];
  if (rawVideos.length !== videos.length || forecast.videoReferences.length !== videos.length)
    fail("complete passed reference-video evidence required.");
  let inputVideoDurationSec = 0;
  for (const [index, reference] of videos.entries()) {
    const pin = forecast.videoReferences[index];
    if (
      typeof rawVideos[index] !== "string" ||
      pin.referenceSha256 !== forecastReferenceHash(rawVideos[index] as string)
    )
      fail("reference identity/order pin mismatch.");
    const actual = resolved.context?.media?.[String(reference)]?.durationSec;
    if (actual === undefined || !Number.isFinite(actual) || actual !== pin.durationSec)
      fail("reference duration evidence is missing or inconsistent with resolved media.");
    inputVideoDurationSec += pin.durationSec;
  }
  if (inputVideoDurationSec > 30.2 + 1e-8) fail("combined reference duration exceeds schema bounds.");
  if (plan.input.resolution !== undefined && forecast.output.resolution !== plan.input.resolution)
    fail("resolution differs from normalized provider input.");
  const duration = plan.input.duration === "auto" ? undefined : Number(plan.input.duration);
  if (Number.isFinite(duration) && forecast.output.durationSec !== duration)
    fail("duration differs from normalized provider input.");
  const evidence: VideoForecastEvidence = {
    kind: "seedance-video-forecast",
    sha256: generationInputHash(forecast),
    forecast,
  };
  if (
    plan.input.draft === true ||
    plan.operation === "complete" ||
    plan.input.task === "editing" ||
    !["text-to-video", "image-to-video", "reference-to-video"].includes(plan.operation)
  )
    return { evidence, reason: "Draft/editing/completion tariffs are not forecast-enabled." };
  if (!Number.isFinite(duration) || plan.input.resolution === undefined)
    return {
      evidence,
      reason: "Explicit fixed duration and resolution required; auto/default choices remain unknown.",
    };
  return {
    evidence,
    quoteInput: {
      units: 1,
      width: forecast.output.width,
      height: forecast.output.height,
      durationSec: duration,
      resolution: forecast.output.resolution,
      inputVideoDurationSec,
    },
    reason: "Output pixels are supplied planning assumptions; estimates do not cap provider billing.",
  };
}
