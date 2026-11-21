import type { FalUnitSemantics } from "./fal-unit-semantics";
import type { PricingEvidenceV1 } from "./pricing-evidence";
import type { FalOperationRequest } from "./generation";
export type ModelRequestRouting = Readonly<
  Required<Pick<FalOperationRequest, "family" | "variant" | "operation" | "region" | "transport">>
>;
export type ModelOperation =
  | "text-to-image"
  | "image-edit"
  | "outpaint"
  | "text-to-video"
  | "image-to-video"
  | "reference-to-video"
  | "video-edit"
  | "video-reference"
  | "motion-control"
  | "draft-complete"
  | "training"
  | "style-workflow"
  | "create-voice";
export type FixedQuantity =
  "generated-second" | "input-video-second" | "output" | "request" | "input-kilo-characters" | "input-audio-minute";
export type TokenUsage = {
  textInput: number;
  imageInput: number;
  imageOutput: number;
  textOutput?: number;
  cachedTextInput?: number;
  cachedImageInput?: number;
  thinkingOutput?: number;
};
export type PricingDefinition = (
  | { kind: "unknown"; reason: string }
  | { kind: "free" }
  /**
   * quantity: generated-second = explicit output duration; input-video-second = measured input video duration; output = outputs requested (default 1);
   * request = one per call; input-kilo-characters = ceil(sent chars / 1000); input-audio-minute = input audio sec / 60.
   * Absent: legacy `units` (images, seconds or requests as the caller counts them).
   */
  | { kind: "fixed"; usdPerUnit: number; quantity?: FixedQuantity }
  | {
      kind: "range";
      lowUsdPerUnit: number;
      expectedUsdPerUnit: number;
      highUsdPerUnit: number;
      audioRates?: { off: number; on: number; voice: number };
    }
  | { kind: "tokens"; ratesPerMillion: TokenUsage; forecastMargin: number }
  | { kind: "megapixels"; firstUsd: number; extraUsd: number; inputExtraUsd: number }
  | { kind: "fal-derived"; usdPerUnit: number; fps?: number }
  | {
      kind: "video-tokens";
      usdPerThousand: number;
      videoReferenceMultiplier: number;
      forecastMargin: number;
      resolutionRates?: Partial<Record<"480p" | "720p" | "1080p" | "4k", number>>;
      acceptsVideoReferences?: boolean;
    }
) & {
  falUnit?: FalUnitSemantics;
  /** The endpoint takes no resolution input, so a page tariff naming a single resolution is that endpoint's own. */
  resolutionFixed?: boolean;
};
export type ModelDescriptor = {
  id: string;
  family:
    | "gpt-image-2.6"
    | "gpt-image-2.5"
    | "nano-banana-2.1"
    | "flux-2"
    | "kling-3"
    | "kling-o3"
    | "seedance-2.5"
    | "kling-voice";
  /** Exact modern request fields, independent from legacy discovery labels. */
  requestRouting: ModelRequestRouting;
  operation: ModelOperation;
  transport: "queue" | "stream" | "session" | "training";
  region: "global" | "us" | "singapore" | "unknown";
  source: string;
  asOf: string;
  pricing: PricingDefinition;
  verification: { discovery: boolean; schema: boolean; localAdapter: boolean; live: boolean };
  /** Provenance of the actual bundled per-operation schema snapshot. */
  capabilities: Record<string, unknown>;
};
export type PricingQuote = {
  model: string;
  lowUsd: number | null;
  expectedUsd: number | null;
  highUsd: number | null;
  currency: "USD";
  source: string;
  asOf: string;
  confidence: "published-rate" | "conservative-bound" | "unknown";
  bounded: boolean;
  basis: PricingDefinition["kind"];
  notes?: string;
  pricingEvidence?: PricingEvidenceV1;
  approximate?: boolean;
  /** The model page's per-unit rate differs from the API's; planning used the higher one (planning-only pricing). */
  priceDrift?: PagePriceDrift;
};
/** Known page/API price drift for one request: both per-unit rates and the one planning used (the higher). */
export type PagePriceDrift = { pageUsdPerUnit: number; apiUsdPerUnit: number; used: number };
