import { jsonRequest } from "./http";
import { ACTORS } from "./providers";
import { MediaFetchError } from "./errors";
import { MEDIA_FETCH_TARIFF_SOURCE } from "../pricing";
export async function inspectPricing(): Promise<unknown[]> {
  return Promise.all(
    Object.entries(ACTORS).map(async ([provider, actor]) => {
      const raw = (await jsonRequest(`https://api.apify.com/v2/acts/${actor}`)) as {
        data?: { pricingInfos?: Record<string, unknown>[] };
      };
      const now = Date.now(),
        active = raw.data?.pricingInfos
          ?.filter((x) => Date.parse(String(x.startedAt)) <= now)
          .sort((a, b) => Date.parse(String(b.startedAt)) - Date.parse(String(a.startedAt)))[0];
      if (!active)
        throw new MediaFetchError(
          "UNKNOWN_PRICE",
          "Actor has no current public pricing metadata.",
          "Use an explicit authorised positive cost bound.",
        );
      const perEvent = active.pricingPerEvent as
        { actorChargeEvents?: Record<string, { eventPriceUsd?: number }> } | undefined;
      const events = perEvent?.actorChargeEvents;
      return {
        provider,
        actor,
        source: `https://api.apify.com/v2/acts/${actor}`,
        asOf: new Date().toISOString(),
        startedAt: active.startedAt,
        pricingModel: active.pricingModel,
        memoryMiB: 1024,
        actorStartUsd: events?.["apify-actor-start"]?.eventPriceUsd,
        resultUsd: events?.["apify-default-dataset-item"]?.eventPriceUsd,
        platformUsageExtra: active.isPPEPlatformUsagePaidByUser !== false,
        proxyUsageExtra: provider === "apify-wilcode",
        sourceRegistry: MEDIA_FETCH_TARIFF_SOURCE,
        notes:
          "Startup plus result events are not the full bill. Compute, proxy and storage may apply. User bounds are not provider billing caps.",
      };
    }),
  );
}
