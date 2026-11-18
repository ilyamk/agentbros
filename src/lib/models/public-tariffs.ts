import type { PricingDefinition } from "../../types/models";

/** Public list tariffs only: not account prices, invoices or live operation acceptance. */
export type PublicTariff = {
  pricing: PricingDefinition;
  evidence: {
    source: string;
    observedAsOf: string;
    kind: "public-model-page";
    unit: string;
    conditions: string;
    acceptance: "not-run";
  };
};
const tariffs: Record<string, PublicTariff> = {};
function register(
  endpoint: string,
  pricing: PricingDefinition,
  unit: string,
  conditions: string,
  observedAsOf = "2026-10-11",
): void {
  tariffs[endpoint] = {
    pricing,
    evidence: {
      source: `https://fal.ai/models/${endpoint}`,
      observedAsOf,
      kind: "public-model-page",
      unit,
      conditions,
      acceptance: "not-run",
    },
  };
}
const gpt: PricingDefinition = {
  kind: "tokens",
  ratesPerMillion: {
    textInput: 5,
    cachedTextInput: 1.25,
    textOutput: 10,
    imageInput: 8,
    cachedImageInput: 2,
    imageOutput: 30,
  },
  forecastMargin: 0.2,
};
// Each endpoint's own public page was read; this list is not a sibling fallback.
for (const endpoint of [
  "openai/gpt-image-2.5/flare/text-to-image",
  "openai/gpt-image-2.5/flare/edit",
  "openai/gpt-image-2.5/sunburst/edit",
]) {
  register(
    endpoint,
    gpt,
    "USD per million tokens",
    "Requires disjoint token forecasts. Quality and image counts change usage, not fixed image fees. No independently published thinking-token rate; positive unknown categories remain unknown. Planning margin 20% is a local assumption.",
  );
}
for (const endpoint of [
  "openai/gpt-image-2.6/flare/text-to-image",
  "openai/gpt-image-2.6/flare/edit",
  "openai/gpt-image-2.6/sunburst/edit",
]) {
  register(
    endpoint,
    gpt,
    "USD per million tokens",
    "Disjoint text/image token forecasts required. Quality significantly affects cost; default high. Rounded up to $0.0001. Planning margin 20% is a local assumption; no public fixed per-image fee.",
    "2026-11-15",
  );
}
register(
  "google/nano-banana-2.1/edit",
  {
    kind: "tokens",
    ratesPerMillion: {
      textInput: 1.764,
      imageInput: 1.764,
      textOutput: 8.823,
      thinkingOutput: 8.823,
      imageOutput: 35.294,
    },
    forecastMargin: 0.2,
  },
  "USD per million tokens",
  "Actual token usage; no separate resolution/search/thinking surcharges. No cached-token rate published. Forecast margin 20% is a local assumption.",
);
for (const [endpoint, off, on, voice] of [
  ["fal-ai/kling-video/v3/pro/text-to-video", 0.112, 0.168, 0.196],
  ["fal-ai/kling-video/v3/standard/text-to-video", 0.084, 0.126, 0.154],
  ["fal-ai/kling-video/v3/standard/image-to-video", 0.084, 0.126, 0.154],
] as const) {
  register(
    endpoint,
    {
      kind: "range",
      lowUsdPerUnit: off,
      expectedUsdPerUnit: on,
      highUsdPerUnit: voice,
      audioRates: { off, on, voice },
    },
    "USD per generated second",
    "Audio off/on and voice-control-with-audio select distinct rates. Missing audio choice preserves full published range; voice control requires audio.",
  );
}
for (const [endpoint, rate, highResolutionRate, reference] of [
  ["bytedance/seedance-2.5/text-to-video", 0.0214, undefined, false],
  ["bytedance/seedance-2.5/image-to-video", 0.0214, undefined, false],
  ["bytedance/seedance-2.5/us/text-to-video", 0.02568, 0.02808, false],
  ["bytedance/seedance-2.5/us/image-to-video", 0.02568, 0.02808, false],
  ["bytedance/seedance-2.5/us/reference-to-video", 0.02568, 0.02808, true],
] as const) {
  register(
    endpoint,
    {
      kind: "video-tokens",
      usdPerThousand: rate,
      videoReferenceMultiplier: reference ? 0.6 : 1,
      forecastMargin: 0.05,
      acceptsVideoReferences: reference,
      resolutionRates: {
        "480p": rate,
        "720p": rate,
        ...(highResolutionRate === undefined ? {} : { "1080p": highResolutionRate }),
      },
    },
    "USD per thousand video tokens",
    "Tokens = output width × height × billed seconds × 24 / 1024. Reference operation bills input plus output video seconds and applies ×0.6 with video input; other modes use output only. Global 1080p prose conflicts with page mode constraints and remains unknown. Forecast margin 5% is local, not a provider guarantee.",
  );
}
// These six exact public pages were independently reviewed on 2026-10-12.
for (const [endpoint, rate] of [
  ["fal-ai/kling-video/v3/turbo/pro/text-to-video", 0.14],
  ["fal-ai/kling-video/v3/turbo/pro/image-to-video", 0.14],
  ["fal-ai/kling-video/v3/turbo/standard/text-to-video", 0.112],
  ["fal-ai/kling-video/v3/turbo/standard/image-to-video", 0.112],
  ["fal-ai/kling-video/o3/pro/video-to-video/reference", 0.168],
] as const) {
  register(
    endpoint,
    { kind: "fixed", usdPerUnit: rate, quantity: "generated-second" },
    "USD per generated second",
    "Requires explicit positive validated output duration. No independently published audio/voice surcharge or additional input-video fee. Missing/nullable output duration remains unknown; no input-duration inference. Public list estimate, not a provider-enforced billing cap.",
    "2026-10-12",
  );
}
register(
  "fal-ai/kling-video/create-voice",
  { kind: "fixed", usdPerUnit: 0.007 },
  "USD per generation",
  "One voice creation generation; source audio length is not the billing quantity. Public list estimate, not account pricing or actual invoice.",
  "2026-10-12",
);
export function publicTariff(endpoint: string): PublicTariff | undefined {
  // Callers cannot mutate the process-global price snapshot through discovery.
  const tariff = tariffs[endpoint];
  return tariff ? structuredClone(tariff) : undefined;
}
