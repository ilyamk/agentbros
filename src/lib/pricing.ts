import { platformPricingSourceUrl } from "../types/pricing-evidence";
import { estimateFalUnitPrice } from "./models/fal-docs-pricing";
import { higgsfieldPricingFor, higgsfieldPriceRecordFor, type HiggsfieldPricingContext } from "./models/hf-pricing";
import { createHiggsfieldPricingEvidence } from "./models/pricing-evidence";
import { publicTariff } from "./models/public-tariffs";
import { findModel } from "./models/registry";
import { falPriceFor } from "./models/fal-pricing";
import type { PricingDefinition, PricingQuote, TokenUsage } from "../types/models";
export type { PricingQuote } from "../types/models";

/**
 * Single source of truth for external-API pricing used by the pipeline.
 *
 * Legacy aliases retain their historical list-rate snapshot; source/asOf are explicit.
 * Undisclosed prices remain unknown and cannot produce a bounded quote.
 * Modern endpoint prices are operation-specific, never borrowed from siblings.
 *
 * When a provider DOES return a real cost in the API response (e.g. some
 * fal.ai endpoints set `costUsd`), prefer the actual value over the estimate.
 *
 * Add new models here when wiring them in; never inline pricing in scripts.
 */

export type ModelKey =
  // Image
  | "fal:flux-schnell"
  | "fal:flux-dev"
  | "fal:flux-pro"
  | "fal:flux-pro-ultra"
  | "fal:gpt-image-1"
  | "fal:gpt-image-2"
  // Video
  | "fal:kling-2.5-turbo"
  | "fal:seedance-1-pro"
  | "fal:seedance-2-fast"
  | "fal:hailuo-02-pro"
  // Lipsync (opt-in)
  | "fal:sync-lipsync"
  | "fal:latentsync"
  // Image utilities
  | "fal:birefnet-bgremoval"
  | "fal:aura-sr-upscale"
  // Music (fal queue)
  | "fal:elevenlabs-music"
  | "fal:lyria2"
  | "fal:minimax-music-v2.6"
  | "fal:minimax-music-3"
  | "fal:stable-audio-3-small-music"
  // ElevenLabs
  | "elevenlabs:tts-v2"
  | "elevenlabs:tts-v3"
  | "elevenlabs:music"
  | "elevenlabs:scribe-v2"
  | "elevenlabs:scribe-v3"
  | "elevenlabs:forced-alignment"
  // Stock & free
  | "pexels:stock"
  | "pixabay:stock"
  | "unsplash:stock"
  | "freesound:sfx"
  | "lottiefiles:lottie"
  | "pollinations:image";

export type Tier = "fast" | "balanced" | "quality";

export interface PricingEntry {
  /** Display name */
  label: string;
  /** Whether the provider publishes a real public unit price */
  disclosed: boolean;
  /** USD per unit (zero explicitly means free); null means unknown */
  usdPerUnit: number | null;
  /** What the unit measures: "image", "second", "minute", "1k_chars", "request" */
  unit: "image" | "second" | "minute" | "1k_chars" | "request";
  /** Optional notes — e.g. "list price; actual fal.media surcharge unknown" */
  notes?: string;
  /** Maps to one of fast / balanced / quality tiers — informational */
  tierBand?: Tier[];
  /** Where this rate was read, when it was reverified after the legacy snapshot */
  source?: string;
  asOf?: string;
}

const FAL_PRICING_API = "https://api.fal.ai/v1/models/pricing";
const falMusic = (
  endpoint: string,
  label: string,
  usdPerUnit: number,
  unit: PricingEntry["unit"],
  notes: string,
): PricingEntry => ({
  label,
  disclosed: true,
  usdPerUnit,
  unit,
  notes,
  source: `${FAL_PRICING_API}?endpoint_id=${endpoint}`,
  asOf: "2026-11-11",
});

export const PRICING: Record<ModelKey, PricingEntry> = {
  // ── Images ──────────────────────────────────────────────────────────────
  "fal:flux-schnell": {
    label: "FLUX.1 schnell",
    disclosed: true,
    usdPerUnit: 0.003,
    unit: "image",
    tierBand: ["fast"],
  },
  "fal:flux-dev": {
    label: "FLUX.1 dev",
    disclosed: true,
    usdPerUnit: 0.025,
    unit: "image",
    tierBand: ["balanced"],
  },
  "fal:flux-pro": {
    label: "FLUX.1 pro",
    disclosed: true,
    usdPerUnit: 0.05,
    unit: "image",
    tierBand: ["quality"],
  },
  "fal:flux-pro-ultra": {
    label: "FLUX.1 pro ultra",
    disclosed: true,
    usdPerUnit: 0.06,
    unit: "image",
    tierBand: ["quality"],
  },
  "fal:gpt-image-1": {
    label: "OpenAI gpt-image-1 (via fal)",
    disclosed: true,
    usdPerUnit: 0.04,
    unit: "image",
    tierBand: ["balanced"],
  },
  "fal:gpt-image-2": {
    label: "OpenAI gpt-image-2 (via fal)",
    disclosed: false,
    // No verified public price snapshot; never treat an old heuristic as billing.
    usdPerUnit: null,
    unit: "image",
    notes: "Pricing not publicly disclosed; estimate only.",
    tierBand: ["quality"],
  },

  // ── Video ───────────────────────────────────────────────────────────────
  "fal:kling-2.5-turbo": {
    label: "Kling 2.5 Turbo Pro",
    disclosed: true,
    usdPerUnit: 0.07,
    unit: "second",
    tierBand: ["quality"],
  },
  "fal:seedance-1-pro": {
    label: "ByteDance Seedance 1 Pro",
    disclosed: false,
    usdPerUnit: null,
    unit: "second",
    notes: "Estimate only; fal.ai does not publish unit price.",
    tierBand: ["balanced"],
  },
  "fal:seedance-2-fast": {
    label: "ByteDance Seedance 2.0 Fast",
    disclosed: true,
    usdPerUnit: 0.2419,
    unit: "second",
    notes:
      "Pricing per second of OUTPUT video at 720p. Native audio generation does not change unit price. Endpoint slug: `bytedance/seedance-2.0/fast/...` (NO fal-ai/ prefix).",
    tierBand: ["balanced", "quality"],
  },
  "fal:hailuo-02-pro": {
    label: "MiniMax Hailuo 02 Pro",
    disclosed: true,
    usdPerUnit: 0.08,
    unit: "second",
    tierBand: ["quality"],
  },

  // ── Lipsync (opt-in only) ───────────────────────────────────────────────
  "fal:sync-lipsync": {
    label: "Sync Labs Lipsync",
    disclosed: true,
    usdPerUnit: 0.05,
    unit: "second",
    notes: "Per second of OUTPUT video.",
  },
  "fal:latentsync": {
    label: "ByteDance LatentSync",
    disclosed: false,
    usdPerUnit: null,
    unit: "second",
    notes: "Estimate only.",
  },

  // ── Image utilities ─────────────────────────────────────────────────────
  "fal:birefnet-bgremoval": {
    label: "BiRefNet background removal",
    disclosed: true,
    usdPerUnit: 0.005,
    unit: "image",
  },
  "fal:aura-sr-upscale": {
    label: "AuraSR 4× upscale",
    disclosed: true,
    usdPerUnit: 0.01,
    unit: "image",
  },

  // ── Music via fal (pricing API list rates, not invoices) ───────────────
  "fal:elevenlabs-music": falMusic(
    "fal-ai/elevenlabs/music",
    "ElevenLabs Music (via fal)",
    0.6,
    "minute",
    "fal lists USD 0.60 per minute; proration is not published, so quotes round the requested length up to whole minutes.",
  ),
  "fal:lyria2": falMusic(
    "fal-ai/lyria2",
    "Google Lyria 2 (via fal)",
    0.1,
    "request",
    "fal lists USD 0.10 per 30 seconds; the endpoint has no length input and returns one 30 s clip.",
  ),
  "fal:minimax-music-v2.6": falMusic(
    "fal-ai/minimax-music/v2.6",
    "MiniMax Music 2.6 (via fal)",
    0.15,
    "request",
    "fal lists USD 0.15 per audio; the model decides the length.",
  ),
  "fal:minimax-music-3": falMusic(
    "minimax/music-3",
    "MiniMax Music 3 (via fal)",
    0.002,
    "second",
    "fal lists USD 0.002 per second; quoted on the requested duration, which is an upper bound on output.",
  ),
  "fal:stable-audio-3-small-music": falMusic(
    "fal-ai/stable-audio-3/small/music/text-to-audio",
    "Stable Audio 3 Small music (via fal)",
    0.0217,
    "request",
    "fal lists USD 0.0217 per audio.",
  ),

  // ── ElevenLabs ──────────────────────────────────────────────────────────
  "elevenlabs:tts-v2": {
    label: "ElevenLabs TTS Multilingual v2",
    disclosed: true,
    // Public ElevenAPI USD list price snapshot 2026-10-11; invoice remains authoritative.
    usdPerUnit: 0.08,
    unit: "1k_chars",
  },
  "elevenlabs:tts-v3": {
    label: "ElevenLabs TTS v3",
    disclosed: true,
    usdPerUnit: 0.08,
    unit: "1k_chars",
    notes: "Public API list rate 2026-10-11, excluding taxes/contract overrides.",
  },
  "elevenlabs:music": {
    label: "ElevenLabs Music",
    disclosed: true,
    // Public list rate $0.15/minute; stored in seconds to preserve legacy callers.
    usdPerUnit: 0.15 / 60,
    unit: "second",
  },
  "elevenlabs:scribe-v2": {
    label: "ElevenLabs Scribe v2 (STT)",
    disclosed: true,
    usdPerUnit: 0.2 / 60,
    unit: "minute",
    notes: "Public API list rate $0.20/hour for batch Scribe v2, excluding taxes; $0.22/hour is the Realtime rate.",
    source: "https://elevenlabs.io/pricing/api",
    asOf: "2026-11-13",
  },
  "elevenlabs:scribe-v3": {
    label: "ElevenLabs Scribe v3 (STT)",
    disclosed: true,
    usdPerUnit: 0.2 / 60,
    unit: "minute",
    notes:
      "Public API list rate $0.20/hour, excluding taxes. Callers add keyterms (+$0.05/hour) and multichannel (per channel) to the billable minutes.",
    source: "https://elevenlabs.io/pricing/api",
    asOf: "2026-11-13",
  },
  "elevenlabs:forced-alignment": {
    label: "ElevenLabs Forced Alignment",
    disclosed: false,
    usdPerUnit: null,
    unit: "request",
    notes: "No verified universal public USD rate; requires an explicit account-specific bound.",
  },

  // ── Stock / free ────────────────────────────────────────────────────────
  "pexels:stock": {
    label: "Pexels stock",
    disclosed: true,
    usdPerUnit: 0,
    unit: "request",
  },
  "pixabay:stock": {
    label: "Pixabay stock",
    disclosed: true,
    usdPerUnit: 0,
    unit: "request",
  },
  "unsplash:stock": {
    label: "Unsplash stock",
    disclosed: true,
    usdPerUnit: 0,
    unit: "request",
  },
  "freesound:sfx": {
    label: "Freesound CC0 SFX",
    disclosed: true,
    usdPerUnit: 0,
    unit: "request",
  },
  "lottiefiles:lottie": {
    label: "LottieFiles",
    disclosed: true,
    usdPerUnit: 0,
    unit: "request",
  },
  "pollinations:image": {
    label: "Pollinations image",
    disclosed: true,
    usdPerUnit: 0,
    unit: "request",
  },
};

export interface QuoteInput {
  provider?: "fal" | "higgsfield";
  providerInput?: Record<string, unknown>;
  providerContext?: HiggsfieldPricingContext;
  model: string;
  units?: number | null;
  multiplier?: number;
  width?: number;
  height?: number;
  inputMegapixels?: number;
  durationSec?: number;
  inputVideoDurationSec?: number;
  resolution?: "480p" | "720p" | "1080p";
  generateAudio?: boolean;
  voiceControl?: boolean;
  tokens?: TokenUsage;
  /** Characters of the sent text, for endpoints priced per 1000 characters. */
  inputCharacters?: number;
  /** Seconds of input audio (from media metadata), for endpoints priced per minute. */
  inputAudioSec?: number;
}
const LEGACY_AS_OF = "2026-04-30";
function nonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
    throw new RangeError(`${name} must be finite, nonnegative and within numeric precision`);
}
function dimension(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0 || value > 16384))
    throw new RangeError(`${name} must be an integer between 1 and 16384`);
}
/** An estimate is never an invoice; upper bounds are planning assumptions. */
export function quote(input: QuoteInput): PricingQuote {
  let units = input.units === undefined ? (input.durationSec ?? 1) : input.units;
  if (units !== null) nonnegative(units, "units");
  const multiplier = input.multiplier ?? 1;
  nonnegative(multiplier, "multiplier");
  dimension(input.width, "width");
  dimension(input.height, "height");
  for (const [name, value] of Object.entries({
    inputMegapixels: input.inputMegapixels,
    durationSec: input.durationSec,
    inputVideoDurationSec: input.inputVideoDurationSec,
    inputCharacters: input.inputCharacters,
    inputAudioSec: input.inputAudioSec,
  }))
    if (value !== undefined) nonnegative(value, name);
  if (input.tokens) {
    for (const [name, value] of Object.entries(input.tokens)) {
      if (
        ![
          "textInput",
          "imageInput",
          "imageOutput",
          "textOutput",
          "cachedTextInput",
          "cachedImageInput",
          "thinkingOutput",
        ].includes(name)
      )
        throw new RangeError(`Unknown token usage: ${name}`);
      nonnegative(value, name);
    }
    for (const name of ["textInput", "imageInput", "imageOutput"] as const)
      if (input.tokens[name] === undefined) throw new RangeError(`Missing token usage: ${name}`);
  }
  if (input.provider === "higgsfield") {
    if ((input.units !== undefined && input.units !== 1) || (input.multiplier !== undefined && input.multiplier !== 1))
      throw new RangeError("Higgsfield quotes exactly one physical request; quote separate requests independently.");
    const record = higgsfieldPriceRecordFor(input.model, input.providerInput ?? {});
    const price = record && higgsfieldPricingFor(record, input.providerInput ?? {}, input.providerContext);
    const common = {
      model: input.model,
      currency: "USD" as const,
      source: price?.source ?? `https://api.higgsfield.ai/estimate/${input.model}`,
      asOf: price?.observedAsOf ?? new Date().toISOString().slice(0, 10),
    };
    if (!record || !price || price.pricing.kind !== "fixed")
      return {
        ...common,
        lowUsd: null,
        expectedUsd: null,
        highUsd: null,
        confidence: "unknown",
        bounded: false,
        basis: "unknown",
        notes:
          price?.pricing.kind === "unknown"
            ? price.pricing.reason
            : "No Higgsfield price record; a positive authorised bound is required.",
      };
    const evidence = createHiggsfieldPricingEvidence(record, input.providerInput ?? {}, input.providerContext);
    const amount = price.pricing.usdPerUnit;
    return {
      ...common,
      lowUsd: amount,
      expectedUsd: amount,
      highUsd: amount,
      confidence: "published-rate",
      bounded: true,
      basis: "fixed",
      pricingEvidence: evidence,
      notes: price.tier?.approximate
        ? "Approximate Higgsfield price; reservation includes a +25% safety margin. Planning only, not an invoice."
        : "Higgsfield request estimate; planning only, not an invoice.",
    };
  }
  const modern = findModel(input.model);
  const legacy = PRICING[input.model as ModelKey];
  // API fallbacks retain their current record and provenance, including registered operations without a public tariff.
  const platform =
    (!modern && !legacy) || modern?.source === platformPricingSourceUrl(input.model)
      ? falPriceFor(input.model)
      : undefined;
  let definition: PricingDefinition =
    modern?.pricing ??
    platform?.pricing ??
    (!legacy || !legacy.disclosed || legacy.usdPerUnit === null
      ? { kind: "unknown", reason: legacy?.notes ?? "Unknown model price" }
      : legacy.usdPerUnit === 0
        ? { kind: "free" }
        : { kind: "fixed", usdPerUnit: legacy.usdPerUnit });
  const currentAudioRate = [
    "elevenlabs:tts-v2",
    "elevenlabs:tts-v3",
    "elevenlabs:music",
    "elevenlabs:scribe-v2",
  ].includes(input.model);
  const tariffEvidence = publicTariff(input.model)?.evidence;
  const source =
    tariffEvidence?.source ??
    platform?.source ??
    modern?.source ??
    legacy?.source ??
    (currentAudioRate
      ? "https://elevenlabs.io/pricing/api"
      : legacy
        ? "Repository legacy pricing snapshot: src/lib/pricing.ts (not reverified)"
        : "No pricing source");
  const asOf =
    tariffEvidence?.observedAsOf ??
    platform?.observedAsOf ??
    modern?.asOf ??
    legacy?.asOf ??
    (currentAudioRate ? "2026-10-11" : LEGACY_AS_OF);
  const unknown = (notes: string): PricingQuote => ({
    model: input.model,
    lowUsd: null,
    expectedUsd: null,
    highUsd: null,
    currency: "USD",
    source,
    asOf,
    confidence: "unknown",
    bounded: false,
    basis: definition.kind,
    notes,
  });
  if (definition.kind === "unknown") return unknown(definition.reason);
  if (definition.falUnit) {
    if (input.units === null) return unknown("Quantity not yet known; cannot reserve a bounded estimate.");
    const rate =
      definition.kind === "fixed" || definition.kind === "fal-derived"
        ? definition.usdPerUnit
        : definition.kind === "megapixels"
          ? definition.firstUsd
          : undefined;
    if (rate === undefined) return unknown("No API unit rate for model-page semantics");
    const estimate = estimateFalUnitPrice(
      definition.falUnit,
      rate,
      {
        ...input,
        samples: input.units ?? 1,
        images: input.units ?? 1,
        ...(definition.resolutionFixed ? { resolutionFixed: true } : {}),
      },
      definition.kind === "fal-derived" ? definition.fps : undefined,
    );
    if ("reason" in estimate) return unknown(estimate.reason);
    const scaled = estimate.usd * multiplier * 10000;
    if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER)
      throw new RangeError("Quote exceeds numeric precision limit");
    const amount = Math.ceil(scaled - 1e-9) / 10000;
    if (amount <= 0)
      return unknown("Quantity rounds to a zero commitment; an API-derived price is never quoted as free.");
    return {
      model: input.model,
      lowUsd: amount,
      expectedUsd: amount,
      highUsd: amount,
      currency: "USD",
      source: definition.falUnit.evidence.url,
      asOf: definition.falUnit.evidence.observedAsOf,
      confidence: estimate.approximate ? "conservative-bound" : "published-rate",
      bounded: true,
      basis: definition.kind,
      approximate: estimate.approximate,
      notes: estimate.formula,
      ...(estimate.priceDrift ? { priceDrift: estimate.priceDrift } : {}),
    };
  }
  // Quantities the tracked registry never uses; each needs its own measured input, never a default of zero.
  if (definition.kind === "fixed" && definition.quantity && definition.quantity !== "generated-second") {
    switch (definition.quantity) {
      case "input-video-second":
        if (input.inputVideoDurationSec === undefined || input.inputVideoDurationSec <= 0)
          return unknown("Positive measured input video duration required (inputVideoDurationSec).");
        units = input.units === null ? null : input.inputVideoDurationSec;
        break;
      case "output":
        units = input.units === undefined ? 1 : input.units;
        break;
      case "request":
        units = input.units === null ? null : 1;
        break;
      case "input-kilo-characters":
        if (input.inputCharacters === undefined)
          return unknown("Characters of the sent text required (inputCharacters); priced per 1000 characters.");
        units = Math.max(1, Math.ceil(input.inputCharacters / 1000));
        break;
      case "input-audio-minute":
        if (input.inputAudioSec === undefined || input.inputAudioSec <= 0)
          return unknown("Positive input audio duration required (inputAudioSec); priced per minute.");
        units = input.inputAudioSec / 60;
        break;
    }
  }
  if (definition.kind === "fixed" && definition.quantity === "generated-second") {
    if (input.durationSec === undefined || units === null)
      return unknown("Explicit generated output duration required; input duration cannot substitute.");
    if (input.durationSec <= 0 || units <= 0 || multiplier <= 0)
      throw new RangeError("Generated seconds, units and multiplier must be positive.");
    if (units !== input.durationSec)
      throw new RangeError("Generated-second units must match explicit output duration.");
  }
  if (units === null) return unknown("Quantity not yet known; cannot reserve a bounded estimate.");
  let low = 0,
    expected = 0,
    high = 0;
  switch (definition.kind) {
    case "fal-derived":
      return unknown("Derived pricing requires model-page evidence");
    case "free":
      break;
    case "fixed":
      low = expected = high = definition.usdPerUnit * units;
      break;
    case "range": {
      if (
        (definition.audioRates || input.model === "fal-ai/kling-video/v3/pro/image-to-video") &&
        input.generateAudio !== undefined
      ) {
        if (input.voiceControl && !input.generateAudio) throw new RangeError("voice control requires generated audio");
        const rates = definition.audioRates ?? { off: 0.112, on: 0.168, voice: 0.196 };
        low =
          expected =
          high =
            (input.generateAudio ? (input.voiceControl ? rates.voice : rates.on) : rates.off) * units;
      } else {
        low = definition.lowUsdPerUnit * units;
        expected = definition.expectedUsdPerUnit * units;
        high = definition.highUsdPerUnit * units;
      }
      break;
    }
    case "tokens": {
      if (!input.tokens)
        return unknown("Token forecast required; quality/image counts alone do not bound token billing.");
      for (const [key, value] of Object.entries(input.tokens))
        if (value > 0 && definition.ratesPerMillion[key as keyof TokenUsage] === undefined)
          return unknown(`Missing rate for ${key}`);
      expected = Object.entries(input.tokens).reduce(
        (sum, [key, value]) =>
          sum +
          (value * (definition.kind === "tokens" ? (definition.ratesPerMillion[key as keyof TokenUsage] ?? 0) : 0)) /
            1e6,
        0,
      );
      low = expected * (1 - definition.forecastMargin);
      high = expected * (1 + definition.forecastMargin);
      low *= units;
      expected *= units;
      high *= units;
      break;
    }
    case "megapixels": {
      if (!input.width || !input.height) return unknown("Output dimensions required for megapixel pricing.");
      const pixels = input.width * input.height;
      // Published examples use 1024² per MP whereas prose says nearest MP.
      // Keep both interpretations until billing calibration establishes rounding.
      const inputCost = Math.ceil(input.inputMegapixels ?? 0) * definition.inputExtraUsd;
      low =
        (definition.firstUsd + Math.max(0, Math.ceil(pixels / 1048576) - 1) * definition.extraUsd + inputCost) * units;
      high = (definition.firstUsd + Math.max(0, Math.ceil(pixels / 1e6) - 1) * definition.extraUsd + inputCost) * units;
      expected = low;
      break;
    }
    case "video-tokens": {
      if (!input.width || !input.height || input.durationSec === undefined || !input.resolution)
        return unknown("Video output dimensions, resolution and duration required.");
      if (definition.acceptsVideoReferences === false && (input.inputVideoDurationSec ?? 0) > 0)
        return unknown("This operation does not bill video references; use the exact reference operation.");
      if (definition.resolutionRates) {
        const rate = definition.resolutionRates[input.resolution];
        if (rate === undefined) return unknown("No verified tariff for this operation and resolution.");
        definition = { ...definition, usdPerThousand: rate };
      } else if (input.resolution === "1080p") definition = { ...definition, usdPerThousand: 0.0234 };
      const seconds = input.durationSec + (input.inputVideoDurationSec ?? 0);
      const discount = (input.inputVideoDurationSec ?? 0) > 0 ? definition.videoReferenceMultiplier : 1;
      expected = ((((input.width * input.height * seconds * 24) / 1024) * definition.usdPerThousand) / 1000) * discount;
      low = expected * (1 - definition.forecastMargin);
      high = expected * (1 + definition.forecastMargin);
      // durationSec already provides the billed quantity; units counts outputs.
      const count = input.units ?? 1;
      low *= count;
      expected *= count;
      high *= count;
      break;
    }
  }
  const round = (value: number) => {
    const scaled = value * multiplier * 10000;
    if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER)
      throw new RangeError("Quote exceeds numeric precision limit");
    return Math.max(0, Math.ceil(scaled - 1e-9)) / 10000;
  };
  if (definition.kind === "fixed" && definition.quantity === "generated-second" && round(high) <= 0)
    throw new RangeError("Generated-second quote is below numeric precision; cannot produce a zero commitment.");
  if (platform && round(high) <= 0)
    return unknown("Quantity rounds to a zero commitment; an API-derived price is never quoted as free.");
  return {
    model: input.model,
    lowUsd: round(low),
    expectedUsd: round(expected),
    highUsd: round(high),
    currency: "USD",
    source,
    asOf,
    confidence: platform || low === high ? "published-rate" : "conservative-bound",
    bounded: true,
    basis: definition.kind,
    notes: legacy?.notes ?? platform?.notes,
  };
}
export interface EstimateInput {
  model: string;
  units: number | null;
  multiplier?: number;
}
export interface EstimateResult {
  model: string;
  units: number | null;
  estimatedUsd: number | null;
  disclosed: boolean;
  notes?: string;
  quote: PricingQuote;
}
/** Backward-compatible entry point with explicit unknown values. */
export function estimate(input: EstimateInput): EstimateResult {
  const result = quote(input);
  return {
    model: input.model,
    units: input.units,
    estimatedUsd: result.expectedUsd,
    disclosed: result.bounded,
    notes: result.notes,
    quote: result,
  };
}

/** Pre-defined tier → model picks. Keep aligned with `.claude/agents/asset-planner.md`. */
export const TIER_MODEL_PICKS: Record<
  Tier,
  {
    image: ModelKey;
    imageEdit?: ModelKey;
    videoT2v: ModelKey;
    videoI2v: ModelKey;
    bgRemoval: ModelKey;
  }
> = {
  fast: {
    image: "fal:flux-schnell",
    imageEdit: "fal:gpt-image-1",
    videoT2v: "fal:seedance-2-fast",
    videoI2v: "fal:seedance-2-fast",
    bgRemoval: "fal:birefnet-bgremoval",
  },
  balanced: {
    image: "fal:flux-dev",
    imageEdit: "fal:gpt-image-2",
    videoT2v: "fal:seedance-2-fast",
    videoI2v: "fal:seedance-2-fast",
    bgRemoval: "fal:birefnet-bgremoval",
  },
  quality: {
    image: "fal:gpt-image-2",
    imageEdit: "fal:gpt-image-2",
    videoT2v: "fal:kling-2.5-turbo",
    videoI2v: "fal:kling-2.5-turbo",
    bgRemoval: "fal:birefnet-bgremoval",
  },
};

/** Downloader tariffs are inspected from these primary sources; no inferred free operation. */
export const MEDIA_FETCH_TARIFF_SOURCE = {
  rapidapi: "https://rapidapi.com/coder2077/api/instagram-downloader-download-instagram-videos-stories1",
  easyapi: "https://api.apify.com/v2/acts/easyapi~all-in-one-media-downloader",
  wilcode: "https://api.apify.com/v2/acts/wilcode~all-social-media-video-downloader",
} as const;
