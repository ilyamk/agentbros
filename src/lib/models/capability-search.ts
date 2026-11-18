import {
  PROVIDER_IDS,
  providerOf,
  type FalCatalogEntry,
  type FalFindQuery,
  type ModelCapability,
  type ProviderId,
} from "../../types/fal-catalog";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  capabilityField,
  capabilityProfile,
  type CapabilityProfile,
} from "./capabilities";
import { loadProviderCatalog } from "./fal-catalog";
import { findFalEndpointResult } from "./fal-find";
import { modelChoicePrice, type ModelPriceParameters } from "./model-choice-price";

type Catalogs = Partial<Record<ProviderId, ReadonlyMap<string, FalCatalogEntry>>>;
const catalogsFor = (catalogs?: Catalogs): Record<ProviderId, ReadonlyMap<string, FalCatalogEntry>> => ({
  fal: catalogs?.fal ?? loadProviderCatalog("fal"),
  higgsfield: catalogs?.higgsfield ?? loadProviderCatalog("higgsfield"),
});

export type CapabilityVocabularyRow = {
  id: ModelCapability;
  description: string;
  models: Record<ProviderId, number>;
  /** Schema fields that prove it, most common first. */
  fields: string[];
};
/** The vocabulary with active-model counts per provider, computed from the tracked catalogues. */
export function capabilityVocabulary(catalogs?: Catalogs): CapabilityVocabularyRow[] {
  const all = catalogsFor(catalogs);
  return CAPABILITY_IDS.map((id) => {
    const models = { fal: 0, higgsfield: 0 } as Record<ProviderId, number>;
    const fields = new Map<string, number>();
    for (const provider of PROVIDER_IDS)
      for (const entry of all[provider].values()) {
        if (entry.status !== "active") continue;
        const field = capabilityField(entry, id);
        if (!field) continue;
        models[provider] += 1;
        fields.set(field.name, (fields.get(field.name) ?? 0) + 1);
      }
    return {
      id,
      description: CAPABILITIES[id].description,
      models,
      fields: [...fields]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 6)
        .map(([name]) => name),
    };
  });
}

/** Full profile of one endpoint at each provider that indexes it (or only `provider`). */
export function endpointProfiles(
  endpoint: string,
  scenario: ModelPriceParameters,
  options: { provider?: ProviderId; catalogs?: Catalogs } = {},
): CapabilityProfile[] {
  const all = catalogsFor(options.catalogs);
  return PROVIDER_IDS.filter((provider) => !options.provider || options.provider === provider).flatMap((provider) => {
    const entry = all[provider].get(endpoint);
    return entry ? [capabilityProfile(entry, scenario)] : [];
  });
}

export type CapabilitySearchRow = {
  provider: ProviderId;
  endpoint: string;
  category: string;
  tier: string;
  score: number;
  matched: { capability: string; field: string }[];
  price: { status: CapabilityProfile["price"]["status"]; usd: number | null; kind: string; label: string };
  limits: Pick<CapabilityProfile["limits"], "durationSec" | "aspects" | "resolutions" | "maxReferenceImages">;
  capabilities: ModelCapability[];
  warnings: string[];
};
/** A compact table over the same finder as fal:find, with each row's profile limits and scenario price. */
export function searchCapabilities(
  query: FalFindQuery,
  scenario: ModelPriceParameters,
  options: { catalogs?: Catalogs } = {},
) {
  const all = catalogsFor(options.catalogs);
  const catalog = new Map(
    PROVIDER_IDS.flatMap((provider) =>
      [...all[provider].values()].map((entry) => [`${provider}:${entry.endpoint}`, entry] as const),
    ),
  );
  // The finder prices with its own duration/resolution/aspect; the scenario adds audio and input lengths.
  const result = findFalEndpointResult(
    { provider: "any", ...query },
    {
      catalog,
      price: (entry, parameters) =>
        modelChoicePrice(entry, {
          ...scenario,
          ...Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined)),
        }),
    },
  );
  const rows: CapabilitySearchRow[] = result.candidates
    .filter((candidate) => !candidate.rejectedBecause)
    .map((candidate) => {
      const entry = catalog.get(`${candidate.provider}:${candidate.endpoint}`)!;
      const profile = capabilityProfile(entry, scenario, { price: () => candidate.price });
      return {
        provider: providerOf(entry),
        endpoint: entry.endpoint,
        category: entry.category,
        tier: entry.tier,
        score: Math.round(candidate.score * 100) / 100,
        matched: candidate.matchedCapabilities ?? [],
        price: {
          status: profile.price.status,
          usd: profile.price.usd,
          kind: profile.price.kind,
          label: profile.price.label,
        },
        limits: {
          durationSec: profile.limits.durationSec,
          aspects: profile.limits.aspects,
          resolutions: profile.limits.resolutions,
          maxReferenceImages: profile.limits.maxReferenceImages,
        },
        capabilities: profile.capabilities,
        warnings: candidate.warnings,
      };
    });
  const rejected = result.candidates.filter((candidate) => candidate.rejectedBecause);
  return {
    match: result.match,
    rows,
    ...(result.message ? { message: result.message } : {}),
    ...(rejected.length
      ? {
          rejected: rejected.map(({ provider, endpoint, rejectedBecause }) => ({
            provider,
            endpoint,
            rejectedBecause,
          })),
        }
      : {}),
  };
}
