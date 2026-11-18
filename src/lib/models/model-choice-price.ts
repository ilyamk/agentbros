import { platformPricingSourceUrl } from "../../types/pricing-evidence";
import { estimateFalUnitPrice, loadFalUnitSemantics } from "./fal-docs-pricing";
import type { FalCatalogEntry, ModelChoicePrice } from "../../types/fal-catalog";
import { providerOf } from "../../types/fal-catalog";
import type { HiggsfieldPriceRecord } from "../../types/higgsfield";
import { quote } from "../pricing";
import { findModel } from "./registry";
import type { ModelReferenceSetting } from "../../types/model-slots";
import { falPriceFor } from "./fal-pricing";
import { higgsfieldPricingFor, higgsfieldScenarioPricingFor, loadHiggsfieldPrices } from "./hf-pricing";

export type ModelPriceParameters = ModelReferenceSetting;
/** Planning dimensions, not a generation forecast or a claim about provider output pixels. */
export function planningVideoDimensions(
  resolution?: string,
  aspect?: string,
): { width: number; height: number } | undefined {
  const sizes: Record<string, Record<string, [number, number]>> = {
    "480p": {
      "16:9": [854, 480],
      "9:16": [480, 854],
      "1:1": [480, 480],
      "4:3": [640, 480],
      "3:4": [480, 640],
      "21:9": [1120, 480],
    },
    "720p": {
      "16:9": [1280, 720],
      "9:16": [720, 1280],
      "1:1": [720, 720],
      "4:3": [960, 720],
      "3:4": [720, 960],
      "21:9": [1680, 720],
    },
    "1080p": {
      "16:9": [1920, 1080],
      "9:16": [1080, 1920],
      "1:1": [1080, 1080],
      "4:3": [1440, 1080],
      "3:4": [1080, 1440],
      "21:9": [2520, 1080],
    },
  };
  const size = resolution && aspect ? sizes[resolution]?.[aspect] : undefined;
  return size ? { width: size[0], height: size[1] } : undefined;
}
function roundPlanning(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0 || usd * 10000 > Number.MAX_SAFE_INTEGER)
    throw new RangeError("Planning price exceeds numeric precision");
  return Math.ceil(usd * 10000 - 1e-9) / 10000;
}
export function planningChoicePrice(price: ModelChoicePrice): boolean {
  return exactChoicePrice(price) || ((price.kind === "approximate" || price.kind === "typical") && price.usd !== null);
}
function audioPriceInput(entry: FalCatalogEntry, parameters: ModelPriceParameters): Record<string, unknown> {
  if (parameters.generateAudio === undefined) return {};
  return Object.fromEntries(
    entry.inputs
      .filter((field) => field.name === "generate_audio" || field.name === "sound")
      .map((field) => [
        field.name,
        field.name === "sound" ? (parameters.generateAudio ? "on" : "off") : parameters.generateAudio,
      ]),
  );
}
export function modelPriceInput(entry: FalCatalogEntry, parameters: ModelPriceParameters): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      entry.inputs.filter((field) => field.default !== undefined).map((field) => [field.name, field.default]),
    ),
    ...audioPriceInput(entry, parameters),
    ...(parameters.durationSec !== undefined ? { duration: parameters.durationSec } : {}),
    ...(parameters.resolution ? { resolution: parameters.resolution } : {}),
    ...(parameters.aspect ? { aspect_ratio: parameters.aspect } : {}),
    ...(parameters.images !== undefined ? { num_images: parameters.images } : {}),
  };
}
/** Discovery prices are planning evidence. Floors never become request totals. */
export function modelChoicePrice(
  entry: FalCatalogEntry,
  parameters: ModelPriceParameters = {},
  options: { now?: Date; hfPrices?: ReadonlyMap<string, HiggsfieldPriceRecord> } = {},
): ModelChoicePrice {
  const unknown: ModelChoicePrice = {
    kind: "unknown",
    label: "Unknown price; needs --max-cost-usd",
    usd: null,
    unitPrice: null,
    unit: null,
    asOf: null,
    evidenceKind: "none",
    basis: null,
  };
  if (providerOf(entry) === "fal") {
    const semantics = loadFalUnitSemantics();
    const price = falPriceFor(entry.endpoint, undefined, semantics);
    const input = modelPriceInput(entry, parameters);
    const model = findModel(entry.endpoint);
    let definition = model?.pricing ?? price?.pricing;
    if (definition?.kind === "unknown" && price?.pricing.kind === "megapixels") definition = price.pricing;
    const audio =
      parameters.generateAudio ??
      input.generate_audio ??
      (input.sound === "on" ? true : input.sound === "off" ? false : undefined);
    const registrySelected =
      model && definition === model.pricing && model.source !== platformPricingSourceUrl(entry.endpoint);
    const source =
      registrySelected && price?.origin !== "public-tariff"
        ? `src/lib/models/registry.ts (${model.source})`
        : (price?.source ?? "tracked registry");
    const common = {
      asOf: registrySelected && price?.origin !== "public-tariff" ? model.asOf : (price?.observedAsOf ?? null),
      evidenceKind:
        registrySelected && price?.origin !== "public-tariff" ? "reviewed-registry" : (price?.origin ?? "none"),
    };
    const planned = (usd: number, formula: string, approximate = false): ModelChoicePrice => ({
      ...common,
      kind: approximate ? "approximate" : "exact",
      usd: roundPlanning(usd),
      label: `$${roundPlanning(usd)}; ${formula}; ${source}`,
      unitPrice: price?.record?.unitPrice ?? null,
      unit: price?.unit ?? null,
      basis: definition?.kind ?? "unknown",
    });
    if (definition?.falUnit) {
      const rate =
        definition.kind === "fixed" || definition.kind === "fal-derived"
          ? definition.usdPerUnit
          : definition.kind === "megapixels"
            ? definition.firstUsd
            : undefined;
      if (rate === undefined) return { ...unknown, ...common };
      const dimensions =
        parameters.megapixels !== undefined && definition.falUnit.meaning === "output-megapixel"
          ? { width: parameters.megapixels * 1e6, height: 1 }
          : planningVideoDimensions(parameters.resolution, parameters.aspect);
      const result = estimateFalUnitPrice(
        definition.falUnit,
        rate,
        {
          ...parameters,
          ...dimensions,
          voiceControl: input.voice_control === true,
          samples: Number(input.num_samples ?? 1),
          images: parameters.images ?? Number(input.num_images ?? input.num_outputs ?? 1),
          ...(typeof input.resolution === "string" ? { resolution: input.resolution } : {}),
          ...(typeof audio === "boolean" ? { generateAudio: audio } : {}),
          ...(definition.resolutionFixed ? { resolutionFixed: true } : {}),
        },
        definition.kind === "fal-derived" ? definition.fps : undefined,
        options.now,
      );
      const evidence = {
        asOf: definition.falUnit.evidence.observedAsOf,
        evidenceKind: "platform-pricing-api" as const,
      };
      if ("reason" in result) return { ...unknown, ...evidence, label: `Unknown price; ${result.reason}` };
      return {
        ...planned(result.usd, result.formula, result.approximate),
        ...evidence,
        label: `$${roundPlanning(result.usd)}; ${result.formula}`,
        basis:
          definition.falUnit.roundUp ||
          definition.falUnit.perSample ||
          definition.falUnit.clips ||
          definition.falUnit.baseSeconds !== undefined ||
          definition.falUnit.validUntil ||
          definition.falUnit.tiers?.some((tier) => tier.validUntil)
            ? "request"
            : definition.falUnit.meaning,
      };
    }
    // An ambiguous page adds nothing: legacy discovery conversions stay available, as before pages were read.
    if (
      definition?.kind === "unknown" &&
      price?.origin === "platform-pricing-api" &&
      semantics.has(entry.endpoint) &&
      semantics.get(entry.endpoint)!.meaning !== "ambiguous"
    )
      return { ...unknown, ...common, label: `Unknown price; ${definition.reason}` };
    // These conversions are discovery-only: do not broaden generation admission's unit contracts.
    const unit = price?.record?.unit.trim().toLowerCase();
    const rate = price?.record?.unitPrice;
    if (definition?.kind === "unknown" && rate && rate > 0) {
      if (
        ["1k characters", "1000 characters"].includes(unit ?? "") &&
        ["text-to-speech", "speech-to-speech"].includes(entry.category) &&
        parameters.inputCharacters !== undefined
      )
        return planned(
          Math.max(1, Math.ceil(parameters.inputCharacters / 1000)) * rate,
          `ceil(${parameters.inputCharacters} characters / 1000), minimum 1 × $${rate}`,
        );
      if (
        ["seconds", "second", "minutes", "minute"].includes(unit ?? "") &&
        ["audio-to-audio", "speech-to-speech", "speech-to-text", "audio-to-text", "audio-to-video"].includes(
          entry.category,
        ) &&
        entry.inputs.some((field) => field.media === "audio") &&
        parameters.inputAudioSec !== undefined
      ) {
        const divisor = unit!.startsWith("minute") ? 60 : 1;
        return planned(
          (parameters.inputAudioSec / divisor) * rate,
          `${parameters.inputAudioSec} input audio seconds / ${divisor} × $${rate}`,
        );
      }
    }
    if (
      definition?.kind === "unknown" &&
      price?.pricing.kind === "fixed" &&
      price.pricing.quantity === "generated-second" &&
      entry.category === "image-to-video" &&
      !entry.inputs.some((field) => field.media === "video" || field.media === "audio") &&
      entry.inputs.some((field) => field.name === "duration") &&
      parameters.durationSec !== undefined
    ) {
      const usd = roundPlanning(parameters.durationSec * price.pricing.usdPerUnit);
      return {
        kind: "approximate",
        usd,
        label: `$${usd}; ${parameters.durationSec} generated seconds × $${price.pricing.usdPerUnit}; API base rate only, audio variants untracked; ${price.source}`,
        unitPrice: price.pricing.usdPerUnit,
        unit: price.unit,
        asOf: price.observedAsOf,
        evidenceKind: price.origin,
        basis: "generated-second",
      };
    }
    if (definition?.kind === "video-tokens") {
      const dimensions = planningVideoDimensions(parameters.resolution, parameters.aspect);
      const rate = definition.resolutionRates
        ? definition.resolutionRates[parameters.resolution as "480p" | "720p" | "1080p"]
        : parameters.resolution === "480p" || parameters.resolution === "720p"
          ? definition.usdPerThousand
          : undefined;
      if (!dimensions || !rate || !parameters.durationSec)
        return {
          ...unknown,
          ...common,
          label: `Unknown price; needs supported resolution, aspect and output seconds; ${source}`,
        };
      const referenceSeconds = parameters.inputVideoDurationSec ?? 0;
      if (definition.acceptsVideoReferences === false && referenceSeconds > 0)
        return { ...unknown, ...common, label: "Unknown price; this endpoint does not accept video references" };
      const discount = referenceSeconds > 0 ? definition.videoReferenceMultiplier : 1;
      const tokens = (dimensions.width * dimensions.height * (parameters.durationSec + referenceSeconds) * 24) / 1024;
      const expected = (tokens / 1000) * rate * discount;
      // Use the tracked tariff's existing local upper margin for the planning budget filter.
      return planned(
        expected * (1 + definition.forecastMargin),
        `${dimensions.width} × ${dimensions.height} × (${parameters.durationSec} + ${referenceSeconds} reference s) × 24 / 1024 = ${tokens} tokens; / 1000 × $${rate} × ${discount}; expected $${roundPlanning(expected)}, +${definition.forecastMargin * 100}% local margin`,
        true,
      );
    }
    if (definition?.kind === "megapixels" && parameters.megapixels !== undefined) {
      // Preserve both tracked MP rounding interpretations; budget against the upper estimate.
      const count = parameters.images ?? 1;
      const inputCost = Math.ceil(parameters.inputMegapixels ?? 0) * definition.inputExtraUsd;
      const amount =
        (definition.firstUsd + Math.max(0, Math.ceil(parameters.megapixels) - 1) * definition.extraUsd + inputCost) *
        count;
      return planned(
        amount,
        `($${definition.firstUsd} first MP + max(0, ceil(${parameters.megapixels} MP) - 1) × $${definition.extraUsd} + ceil(${parameters.inputMegapixels ?? 0} input MP) × $${definition.inputExtraUsd}) × ${count} images; decimal MP upper estimate`,
        true,
      );
    }
    const result = quote({
      model: entry.endpoint,
      durationSec: parameters.durationSec,
      inputAudioSec: parameters.inputAudioSec,
      inputVideoDurationSec: parameters.inputVideoDurationSec,
      inputCharacters: parameters.inputCharacters,
      ...(typeof audio === "boolean" ? { generateAudio: audio } : {}),
      ...(definition?.kind === "fixed" && definition.quantity === "output"
        ? { units: parameters.images ?? Number(input.num_images ?? input.num_outputs ?? input.batch_size ?? 1) }
        : {}),
      ...(["480p", "720p", "1080p"].includes(parameters.resolution ?? "")
        ? { resolution: parameters.resolution as "480p" | "720p" | "1080p" }
        : {}),
    });
    if (!result.bounded || result.highUsd === null)
      return { ...unknown, ...common, label: `Unknown price; ${result.notes ?? "needs quote"}; ${source}` };
    const formula =
      definition?.kind === "fixed"
        ? definition.quantity === "input-kilo-characters"
          ? `max(1, ceil(${parameters.inputCharacters} characters / 1000)) × $${definition.usdPerUnit}`
          : definition.quantity === "input-audio-minute"
            ? `${parameters.inputAudioSec} input audio seconds / 60 × $${definition.usdPerUnit}`
            : definition.quantity === "input-video-second"
              ? `${parameters.inputVideoDurationSec} input video seconds × $${definition.usdPerUnit}`
              : definition.quantity === "generated-second"
                ? `${parameters.durationSec} generated seconds × $${definition.usdPerUnit}`
                : `${definition.quantity === "output" ? (parameters.images ?? Number(input.num_images ?? input.num_outputs ?? 1)) : 1} ${definition.quantity ?? "request"} × $${definition.usdPerUnit}`
        : `${result.basis} upper request estimate`;
    const resultPrice = planned(result.highUsd, formula, result.highUsd !== result.lowUsd);
    return {
      ...resultPrice,
      unitPrice: definition?.kind === "fixed" ? definition.usdPerUnit : null,
      basis: definition?.kind === "fixed" ? (definition.quantity ?? "request") : result.basis,
    };
  }
  const record = (options.hfPrices ?? loadHiggsfieldPrices()).get(entry.endpoint);
  if (!record) return unknown;
  const input = modelPriceInput(entry, parameters);
  const explicit = {
    ...audioPriceInput(entry, parameters),
    ...(parameters.durationSec !== undefined ? { duration: parameters.durationSec } : {}),
    ...(parameters.resolution ? { resolution: parameters.resolution } : {}),
    ...(parameters.aspect ? { aspect_ratio: parameters.aspect } : {}),
    ...(parameters.images !== undefined ? { num_images: parameters.images } : {}),
  };
  const defaults = Object.fromEntries(
    entry.inputs.filter((field) => field.default !== undefined).map((field) => [field.name, field.default]),
  );
  // Planning discovery only: a stored scenario estimate matches when its full sample input is reproduced exactly.
  // Planning only: a stated source length stands in for a measured clip, so per-source-second tiers can price it.
  const videoField =
    parameters.inputVideoDurationSec !== undefined && parameters.inputVideoDurationSec > 0
      ? (entry.inputs.find((field) => field.media === "video") ??
        (entry.inputs.length ? undefined : { name: "video_url", array: false }))
      : undefined;
  const plannedSource = "planning:source-video";
  const sourced = videoField
    ? { ...explicit, [videoField.name]: videoField.array ? [plannedSource] : plannedSource }
    : explicit;
  const media = videoField ? { [plannedSource]: { durationSec: parameters.inputVideoDurationSec } } : undefined;
  const result =
    higgsfieldScenarioPricingFor(record, entry, parameters, options.now) ??
    higgsfieldPricingFor(record, sourced, { defaults, now: options.now, ...(media ? { media } : {}) });
  if (result.pricing.kind === "fixed") {
    return {
      kind: result.tier?.approximate ? "approximate" : result.tier ? "tiered" : "exact",
      label: `$${Number(result.pricing.usdPerUnit.toFixed(6))} (${result.tier ? "tiered" : "exact"} request estimate); ${result.tier ? `tracked $${result.tier.usdPerUnit}/${result.tier.basis} × requested quantity, rounding ${result.tier.rounding ?? "none"}, discounts and margin per record` : "matching tracked request estimate"}; ${result.source}`,
      usd: result.pricing.usdPerUnit,
      unitPrice: result.tier
        ? result.pricing.usdPerUnit /
          (result.tier.basis === "output-second"
            ? Number(input.duration)
            : result.tier.basis === "image"
              ? Number(input.num_images ?? 1)
              : 1)
        : result.pricing.usdPerUnit,
      unit: result.tier?.basis ?? "request",
      asOf: record.observedAsOf,
      evidenceKind: result.tier ? "higgsfield-description" : "higgsfield-estimate",
      basis:
        result.tier && (result.tier.rounding || result.tier.capSeconds !== undefined || result.tier.extras?.length)
          ? "request"
          : result.tier?.basis === "output-second"
            ? "generated-second"
            : (result.tier?.basis ?? "request"),
    };
  }
  if (record.list)
    return {
      kind: "floor",
      label: `from $${record.list.amount} (floor)`,
      usd: null,
      unitPrice: record.list.amount,
      unit: record.list.unit,
      asOf: record.observedAsOf,
      evidenceKind: "higgsfield-list",
      basis: null,
    };
  return { ...unknown, asOf: record.observedAsOf, evidenceKind: "higgsfield-estimate" };
}
export function exactChoicePrice(price: ModelChoicePrice): boolean {
  return (price.kind === "exact" || price.kind === "tiered") && price.usd !== null;
}
