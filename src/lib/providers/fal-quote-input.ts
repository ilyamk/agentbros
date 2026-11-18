import { resolveProviderSnapshot } from "../models/fal-catalog";
import { higgsfieldPriceFor } from "../models/hf-pricing";
import type { FalOperationContext, FalOperationPlan } from "../../types/generation";
import type { QuoteInput } from "../pricing";
import { resolveFalSnapshotForPlan } from "./fal-operations";
import { resolveSchema } from "./json-schema-validate";
import { findCatalogEntry } from "../models/fal-catalog";
import { findModel } from "../models/registry";
import { falPriceFor } from "../models/fal-pricing";
import { CliErrorObject } from "../cli";

const numeric = (value: unknown): number | undefined => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

/** Resolve provider duration aliases and the per-sample billing default from the pinned endpoint schema. */
export function resolveFalQuantities(
  endpoint: string,
  input: Record<string, unknown>,
): { durationSec?: number; sampleCount: number | null } {
  let durationFields: string[] = [];
  let sampleField: { default?: unknown } | undefined = findCatalogEntry(endpoint)?.inputs.find(
    (field) => field.name === "num_samples",
  );
  try {
    const snapshot = resolveFalSnapshotForPlan({ endpoint });
    const properties = resolveSchema(snapshot.input, snapshot.schemas).properties;
    durationFields = ["duration", "duration_seconds", "seconds"].filter(
      (key) => properties && Object.hasOwn(properties, key),
    );
    const field = properties?.num_samples;
    if (field) sampleField = resolveSchema(field, snapshot.schemas);
  } catch {
    /* Explicit quantities still work without a cached schema; absent sample defaults remain unknown. */
  }
  const durationSec = (durationFields.length ? durationFields : ["duration", "duration_seconds", "seconds"])
    .map((key) => input[key])
    .map(numeric)
    .find((value) => value !== undefined);
  const sampleValue = input.num_samples === undefined ? sampleField?.default : input.num_samples;
  const count = numeric(sampleValue);
  const sampleCount =
    input.num_samples === undefined && !sampleField
      ? 1
      : count !== undefined && Number.isSafeInteger(count)
        ? count
        : null;
  return { durationSec, sampleCount };
}

/** Derive billable quantities from provider bytes, measured context and pinned sample defaults. */
export function quoteInputForPlan(
  plan: Omit<FalOperationPlan, "provider"> & { provider: "fal" | "higgsfield" },
  input: Record<string, unknown>,
  context?: FalOperationContext,
): Omit<QuoteInput, "model"> {
  if (plan.provider === "higgsfield") {
    const properties = resolveProviderSnapshot("higgsfield", plan.endpoint)?.input.properties ?? {};
    const defaults = Object.fromEntries(
      Object.entries(properties)
        .filter(([, field]) => field.default !== undefined)
        .map(([key, field]) => [key, field.default]),
    );
    return {
      provider: "higgsfield",
      providerInput: input,
      providerContext: { defaults, media: context?.media, videoInput: plan.category === "video-to-video" },
    };
  }
  const quantities: Omit<QuoteInput, "model"> = {};
  const count = [input.num_images, input.num_outputs, input.num_generations, input.n]
    .map(numeric)
    .find((value) => value !== undefined);
  const { durationSec: duration, sampleCount } = resolveFalQuantities(plan.endpoint, input);
  // Output tariffs default to one in quote(). Leave variable-duration quantities
  // unset until measured, so generated-second tariffs cannot acquire a default second.
  if (plan.family === "seedance-2.5") quantities.units = 1;
  else if (plan.family !== "catalog" && plan.outputKinds?.includes("video")) quantities.units = duration ?? null;
  else if (count !== undefined) quantities.units = count;
  else if (duration === undefined && !plan.outputKinds?.some((kind) => kind === "video" || kind === "audio"))
    quantities.units = 1;
  if (duration !== undefined) quantities.durationSec = duration;
  if (sampleCount === null) quantities.units = null;
  else if (sampleCount !== 1) quantities.multiplier = sampleCount;
  if (
    plan.endpoint === "fal-ai/elevenlabs/speech-to-text/scribe-v2" &&
    Array.isArray(input.keyterms) &&
    input.keyterms.length
  )
    quantities.multiplier = (quantities.multiplier ?? 1) * 1.3;
  const text = [input.text, input.prompt, input.input, input.script].filter(
    (value): value is string => typeof value === "string",
  );
  if (text.length) quantities.inputCharacters = text.reduce((sum, value) => sum + value.length, 0);
  const audioDuration =
    typeof input.audio_url === "string" ? context?.media?.[input.audio_url]?.durationSec : undefined;
  if (audioDuration !== undefined && Number.isFinite(audioDuration) && audioDuration > 0)
    quantities.inputAudioSec = audioDuration;
  const size = input.image_size;
  if (size && typeof size === "object" && !Array.isArray(size)) {
    const { width, height } = size as Record<string, unknown>;
    if (typeof width === "number") quantities.width = width;
    if (typeof height === "number") quantities.height = height;
  }
  if (typeof input.resolution === "string") quantities.resolution = input.resolution as QuoteInput["resolution"];
  if (typeof input.generate_audio === "boolean") quantities.generateAudio = input.generate_audio;
  return quantities;
}

/** Provider unit quantities depend on tariff semantics, independently of quote evidence. */
export function providerUnitQuantity(
  plan: Omit<FalOperationPlan, "provider"> & { provider: "fal" | "higgsfield" },
  input: Record<string, unknown>,
  context?: FalOperationContext,
): number {
  const quantities = quoteInputForPlan(plan, input, context);
  const pricing =
    plan.provider === "higgsfield"
      ? higgsfieldPriceFor(plan.endpoint, input, quantities.providerContext)?.pricing
      : (findModel(plan.endpoint)?.pricing ?? falPriceFor(plan.endpoint)?.pricing);
  let units: number | null | undefined;
  if (quantities.units === null) units = null;
  else if (pricing?.kind === "fixed") {
    switch (pricing.quantity) {
      case "request":
        units = 1;
        break;
      case "output":
        units = quantities.units ?? 1;
        break;
      case "generated-second":
        units = quantities.durationSec;
        break;
      case "input-audio-minute":
        units = quantities.inputAudioSec === undefined ? undefined : quantities.inputAudioSec / 60;
        break;
      case "input-kilo-characters":
        units =
          quantities.inputCharacters === undefined
            ? undefined
            : Math.max(1, Math.ceil(quantities.inputCharacters / 1000));
        break;
      default:
        units = quantities.units ?? quantities.durationSec;
    }
  } else if (pricing?.kind === "range") units = quantities.units ?? quantities.durationSec;
  else if (pricing?.kind === "megapixels" && quantities.width && quantities.height)
    units = Math.ceil((quantities.width * quantities.height) / 1e6) * (quantities.units ?? 1);
  const quantity = units == null ? undefined : units * (quantities.multiplier ?? 1);
  if (quantity === undefined || !Number.isFinite(quantity) || quantity <= 0)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Cannot derive provider unit quantity for ${plan.endpoint}; inspect its unit semantics and request quantities.`,
    });
  return quantity;
}
