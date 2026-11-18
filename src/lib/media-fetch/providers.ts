import type { MediaFetchOptions, MediaProvider, MediaVariant, MediaKind } from "../../types/media-fetch";
import { MediaFetchError } from "./errors";
import { jsonRequest, publicUrl } from "./http";
import { platformFor } from "./catalogue";

export const RAPID_HOST = "instagram-downloader-download-instagram-videos-stories1.p.rapidapi.com";
export const ACTORS = {
  "apify-easyapi": "easyapi~all-in-one-media-downloader",
  "apify-wilcode": "wilcode~all-social-media-video-downloader",
} as const;
export type ProviderJson = (url: string, options?: Parameters<typeof jsonRequest>[1]) => Promise<unknown>;
const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
const array = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const string = (x: unknown) => (typeof x === "string" ? x : undefined);
export function rapidCredits(url: string): number {
  const p = platformFor(url);
  return p === "youtube"
    ? 15
    : p === "instagram" && /\/(stories|highlights)\//.test(new URL(url).pathname)
      ? 5
      : ["rutube", "likee"].includes(p)
        ? 3
        : 2;
}
export function requestInput(
  provider: MediaProvider,
  url: string,
  options: MediaFetchOptions,
): Record<string, unknown> {
  if (provider === "rapidapi")
    return platformFor(url) === "youtube"
      ? {
          url,
          format:
            options.kind === "audio"
              ? "mp3"
              : `${[144, 240, 360, 480, 720, 1080, 1440, 2160].filter((h) => h <= (options.height ?? 2160)).at(-1)}p`,
        }
      : { url };
  if (provider === "apify-easyapi") return { link: url, proxyConfiguration: { useApifyProxy: false } };
  return {
    url,
    proxySettings: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
    ...(platformFor(url) === "youtube" ? { mergeYoutube: { quality: options.height ?? 1080 } } : { mergeAV: true }),
  };
}
export async function submit(
  provider: MediaProvider,
  input: Record<string, unknown>,
  timeoutMs: number,
  call: ProviderJson = jsonRequest,
): Promise<{ runId?: string; result?: unknown }> {
  if (provider === "rapidapi") {
    const youtube = platformFor(String(input.url)) === "youtube";
    const endpoint = `https://${RAPID_HOST}/${youtube ? "youtube/download" : `fetch?url=${encodeURIComponent(String(input.url))}`}`;
    const result = await call(endpoint, {
      method: youtube ? "POST" : "GET",
      headers: {
        "x-rapidapi-key": process.env.RAPIDAPI_KEY!,
        "x-rapidapi-host": RAPID_HOST,
        "content-type": "application/json",
      },
      ...(youtube ? { body: input } : {}),
      timeoutMs,
    });
    if (object(result).ok !== true)
      throw new MediaFetchError(
        "SOURCE_UNAVAILABLE",
        "RapidAPI rejected this source.",
        "Check whether the source is public and supported.",
      );
    return { result };
  }
  const result = object(
    await call(
      `https://api.apify.com/v2/acts/${ACTORS[provider]}/runs?timeout=${Math.ceil(timeoutMs / 1000)}&memory=1024`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.APIFY_TOKEN!}`, "content-type": "application/json" },
        body: input,
        timeoutMs: 60000,
      },
    ),
  );
  const runId = string(object(result.data).id);
  if (!runId || !/^[A-Za-z0-9]+$/.test(runId))
    throw new MediaFetchError(
      "PROVIDER_RESPONSE_INVALID",
      "Apify returned no valid run ID.",
      "Inspect the operation before retrying.",
    );
  return { runId };
}
export async function inspectRun(
  runId: string,
  call: ProviderJson = jsonRequest,
): Promise<{ state: "running" | "completed"; result?: unknown; usageUsd?: number }> {
  if (!/^[A-Za-z0-9]+$/.test(runId)) throw new MediaFetchError("VALIDATION", "Invalid Apify run ID.");
  const headers = { authorization: `Bearer ${process.env.APIFY_TOKEN!}` };
  const run = object(object(await call(`https://api.apify.com/v2/actor-runs/${runId}`, { headers })).data);
  if (["FAILED", "ABORTED", "TIMED-OUT"].includes(String(run.status)))
    throw new MediaFetchError(
      "PROVIDER_RUN_FAILED",
      `Apify run ${run.status}.`,
      "Inspect the run in Apify Console; preserve its billing reservation.",
    );
  if (run.status !== "SUCCEEDED") return { state: "running" };
  const dataset = string(run.defaultDatasetId);
  if (!dataset || !/^[A-Za-z0-9]+$/.test(dataset))
    throw new MediaFetchError("PROVIDER_RESPONSE_INVALID", "Completed run has no valid dataset ID.");
  const rows: unknown[] = [];
  for (let offset = 0; offset < 10000; offset += 100) {
    const page = await call(
      `https://api.apify.com/v2/datasets/${dataset}/items?offset=${offset}&limit=100&clean=true`,
      { headers },
    );
    if (!Array.isArray(page)) throw new MediaFetchError("PROVIDER_RESPONSE_INVALID", "Dataset is not an array.");
    rows.push(...page);
    if (page.length < 100)
      return {
        state: "completed",
        result: rows,
        usageUsd: typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : undefined,
      };
  }
  throw new MediaFetchError("SIZE_LIMIT", "Dataset exceeds 10,000 rows.");
}
export function normalise(
  provider: MediaProvider,
  result: unknown,
  options?: Pick<MediaFetchOptions, "kind">,
): MediaVariant[] {
  const variants: MediaVariant[] = [];
  const add = (raw: unknown, group: string, fallback: MediaKind = "video", associated = false) => {
    const x = object(raw),
      url = string(x.download_url) ?? string(x.url);
    if (!url) return;
    publicUrl(url);
    const type = string(x.type),
      resolution = String(x.resolution ?? x.quality ?? "");
    const kind: MediaKind =
      type === "audio" || /audio only|^audio$/.test(resolution)
        ? "audio"
        : type === "image" || type === "photo"
          ? "image"
          : fallback;
    const match = resolution.match(/(\d+)x(\d+)|([0-9]{3,4})p?/);
    const height = typeof x.height === "number" ? x.height : match ? Number(match[2] ?? match[3]) : undefined;
    variants.push({
      url,
      kind,
      group,
      ...(height ? { height } : {}),
      ...(string(x.extension) ? { extension: String(x.extension) } : {}),
      quality: resolution,
      associated,
      preview: x.preview === true,
    });
  };
  if (provider === "rapidapi") {
    const root = object(result);
    if (root.ok !== true)
      throw new MediaFetchError("SOURCE_UNAVAILABLE", "Provider reported unsuccessful acquisition.");
    const items = root.type === "album" ? array(root.items) : [root];
    items.forEach((x, i) => add(x, String(i), options?.kind === "audio" && root.video_id ? "audio" : "video"));
    if (root.music)
      add(
        typeof root.music === "string" ? { url: root.music, type: "audio" } : root.music,
        "associated-audio",
        "audio",
        true,
      );
    if (root.audio_url) add({ url: root.audio_url, type: "audio" }, "associated-audio", "audio", true);
  } else if (provider === "apify-easyapi") {
    array(result).forEach((row, i) => {
      const r = object(row);
      if (r.error) return;
      let image = 0;
      for (const media of array(r.medias)) {
        const m = object(media);
        const kind = String(m.type);
        add(
          m,
          kind === "image" ? `${i}:image:${image++}` : `${i}:${kind}`,
          kind === "audio" ? "audio" : kind === "image" ? "image" : "video",
          kind === "audio" && array(r.medias).some((x) => object(x).type === "video"),
        );
      }
    });
  } else {
    (Array.isArray(result) ? result : [result]).forEach((row, i) => {
      const r = object(row);
      const merged = array(r.download);
      for (const m of merged.length ? merged : array(r.formats)) add(m, String(i));
    });
  }
  if (!variants.length)
    throw new MediaFetchError(
      "PROVIDER_RESPONSE_INVALID",
      "No downloadable media found in the provider result.",
      "Check source availability or report provider contract drift.",
    );
  return variants;
}
export function selectVariants(variants: MediaVariant[], options: MediaFetchOptions): MediaVariant[] {
  let candidates = variants.filter(
    (v) =>
      (options.kind === "all" || options.includeAssociatedAudio || !v.associated || options.kind === "audio") &&
      (["auto", "all"].includes(options.kind) || v.kind === options.kind),
  );
  const groups = new Map<string, MediaVariant>();
  for (const v of candidates) {
    const key = `${v.group}:${v.kind}`,
      old = groups.get(key);
    const score = (x: MediaVariant) =>
      options.height && x.height && x.height > options.height
        ? -x.height
        : (x.height ?? 0) + (/hd/.test(x.quality ?? "") ? 1 : 0);
    if (!old || score(v) > score(old)) groups.set(key, v);
  }
  if (!groups.size)
    throw new MediaFetchError(
      "FORMAT_UNAVAILABLE",
      "No media matches the requested kind or quality.",
      "Inspect capabilities or choose a different kind/height.",
    );
  if (groups.size > 1000)
    throw new MediaFetchError(
      "SIZE_LIMIT",
      "Source contains more than 1,000 independent attachments.",
      "Split the source into individual media links.",
    );
  return [...groups.values()];
}
